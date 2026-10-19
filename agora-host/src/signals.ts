import { TOOL_RULE, type RateLimit } from './types.js';

/**
 * What a run's output says about denied tools (#73) and rate limits (#87).
 *
 * Claude Code (2.1, `-p --output-format stream-json`) reports both reliably: the result
 * event's `permission_denials` lists each denied tool call, and `rate_limit_event`s carry
 * `rate_limit_info.status` ("rejected" once the limit is hit) and `resetsAt` (epoch seconds).
 *
 * Codex (0.163, `exec --json`) has no denial event: a blocked command is an ordinary failed
 * `command_execution`, so denials are guessed from the command's output text, and a blocked
 * network call often fails with no output at all. Rate limits arrive as `turn.failed` or
 * `error` events whose message is parsed for "try again in/at ...".
 */

export interface Signals { deniedTools: string[]; rateLimit: RateLimit | null }

const MAX_DENIED = 10;
export const RATE_LIMIT_TEXT = /rate.?limit|usage limit|limit reached|hit your (usage )?limit|too many requests|\b429\b/i;

/** The rule that would allow a denied tool call, or null when no safe rule exists. */
export function ruleFor(toolName: unknown, input: unknown): string | null {
    if (typeof toolName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(toolName)) return null;
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (typeof args.command === 'string') {
        // Shell tools: allow the program, not the exact command line
        const program = args.command.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, '') ?? '';
        const base = program.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat)$/i, '');
        return /^[A-Za-z0-9._-]{1,64}$/.test(base) ? `${toolName}(${base}:*)` : null;
    }
    if (toolName === 'WebFetch' && typeof args.url === 'string') {
        try {
            const host = new URL(args.url).hostname;
            if (/^[A-Za-z0-9.-]{1,200}$/.test(host)) return `WebFetch(domain:${host})`;
        } catch { /* fall through to the bare tool */ }
    }
    return toolName;
}

function add(list: string[], rule: string | null) {
    if (rule && TOOL_RULE.test(rule) && !list.includes(rule) && list.length < MAX_DENIED) list.push(rule);
}

function lines(stdout: string): any[] {
    const events: any[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch { /* parseOutput reports invalid output */ }
    }
    return events;
}

const iso = (ms: number) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

/**
 * When a limit resets, from CLI text: "|1792363200" (epoch seconds), "try again in
 * 2 hours 13 minutes", "resets in 45m", "try again at 3:45 PM". Null when it doesn't say.
 */
export function parseReset(text: string, now = Date.now()): string | null {
    const epoch = /\|(\d{10})\b/.exec(text);
    if (epoch) return iso(Number(epoch[1]) * 1000);
    const rel = /(?:try again|resets?|retry) in ((?:\s*(?:and\s*)?\d+(?:\.\d+)?\s*(?:d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b,?)+)/i.exec(text);
    if (rel) {
        const unit: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
        let seconds = 0;
        for (const [, n, u] of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) seconds += Number(n) * (unit[u[0].toLowerCase()] ?? 0);
        if (seconds > 0) return iso(now + seconds * 1000);
    }
    const at = /(?:try again|resets?|retry)(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text)
        ?? /(?:try again|resets?|retry) at (\d{1,2}):(\d{2})()/i.exec(text);
    if (at) {
        let hour = Number(at[1]) % (at[3] ? 12 : 24);
        if (at[3]?.toLowerCase() === 'pm') hour += 12;
        const reset = new Date(now);
        reset.setHours(hour, Number(at[2] ?? 0), 0, 0);
        if (reset.getTime() <= now) reset.setDate(reset.getDate() + 1);
        return iso(reset.getTime());
    }
    return null;
}

function claudeSignals(events: any[], failed: boolean): Signals {
    const deniedTools: string[] = [];
    const result = [...events].reverse().find(e => e?.type === 'result');
    for (const d of Array.isArray(result?.permission_denials) ? result.permission_denials : []) add(deniedTools, ruleFor(d?.tool_name, d?.tool_input));
    // Older or interrupted output: the per-call notices
    if (!result) for (const e of events) if (e?.type === 'system' && e.subtype === 'permission_denied') add(deniedTools, ruleFor(e.tool_name, undefined));

    let rateLimit: RateLimit | null = null;
    if (failed) {
        const limits = events.filter(e => e?.type === 'rate_limit_event' && e.rate_limit_info);
        const rejected = [...limits].reverse().find(e => e.rate_limit_info.status === 'rejected');
        const text = typeof result?.result === 'string' ? result.result : '';
        const flagged = rejected || result?.api_error_status === 429 || events.some(e => e?.error === 'rate_limit')
            || (result?.is_error === true && RATE_LIMIT_TEXT.test(text));
        if (flagged) {
            const resetsAt = Number((rejected ?? limits.at(-1))?.rate_limit_info?.resetsAt);
            rateLimit = { resetAt: (resetsAt > 0 ? iso(resetsAt * 1000) : null) ?? parseReset(text) };
        }
    }
    return { deniedTools, rateLimit };
}

const WRITE_DENIED = /Access to the path .* is denied|Read-only file system|Operation not permitted|\bEACCES\b|\bEPERM\b|Access is denied/i;
const NETWORK_DENIED = /Could not resolve host|getaddrinfo|ENOTFOUND|EAI_AGAIN|Network is unreachable|No such host is known|Unable to connect to the remote server|connect: permission denied/i;

function codexSignals(events: any[], failed: boolean, sandbox: string | undefined): Signals {
    const deniedTools: string[] = [];
    let rateLimit: RateLimit | null = null;
    for (const e of events) {
        const item = e?.type === 'item.completed' ? e.item : null;
        if (item?.type === 'command_execution' && item.status === 'failed' && typeof item.aggregated_output === 'string') {
            if (sandbox === 'read-only' && WRITE_DENIED.test(item.aggregated_output)) add(deniedTools, 'write');
            if (NETWORK_DENIED.test(item.aggregated_output)) add(deniedTools, 'network');
        }
        if (item?.type === 'mcp_tool_call' && item.status === 'failed' && item.server === 'agora'
            && /approv|denied|reject/i.test(JSON.stringify(item.error ?? ''))) add(deniedTools, `mcp__agora__${item.tool}`);
        const message = e?.type === 'turn.failed' ? e.error?.message : e?.type === 'error' ? e.message : null;
        if (failed && typeof message === 'string' && RATE_LIMIT_TEXT.test(message)) rateLimit = { resetAt: parseReset(message) };
    }
    return { deniedTools, rateLimit };
}

export function detectSignals(adapter: 'codex' | 'claude', stdout: string, failed: boolean, sandbox?: string): Signals {
    try {
        const events = lines(stdout);
        return adapter === 'claude' ? claudeSignals(events, failed) : codexSignals(events, failed, sandbox);
    } catch {
        return { deniedTools: [], rateLimit: null };
    }
}
