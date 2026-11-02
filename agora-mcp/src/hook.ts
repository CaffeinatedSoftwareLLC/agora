import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { AgoraMcpConfig } from './config.js';
import { loadStartupConfig } from './invites.js';

/**
 * Claude Code hooks (`agora-mcp hook <stop|session-end>`, docs/claude-code-hooks.md).
 *
 * - Stop: a session still engaged in an open Agora thread (or listening in a channel) is sent
 *   back to `chat_wait` instead of ending its turn, so the thread doesn't go quiet.
 * - SessionEnd: tells Agora the session is gone, so its terminal session ends now instead of
 *   60 s after the socket drops (and at all on /clear, where agora-mcp keeps running).
 *
 * Hooks get no MCP config, only the inherited environment, so this finds the session's Agora
 * registration the way Claude Code does (local, project, user scope) and resolves its
 * credentials with the same code agora-mcp starts with. It never redeems an invite.
 *
 * Everything fails open: any error, timeout or missing config means exit 0 with no output.
 */

/** In every block reason. Its echo in the transcript marks where a continuation started. */
export const STOP_MARKER = '[agora-stop-hook]';

/** Tools that show which channel/thread the session works in. */
const TARGET_TOOLS = new Set(['chat_wait', 'chat_send', 'thread_start', 'chat_read']);
const STOP_BUDGET_MS = 8_000;
const SESSION_END_BUDGET_MS = 2_500;
const SESSION_END_REQUEST_MS = 1_200;
const FETCH_TIMEOUT_MS = 3_000;
const THREAD_PAGES = 5;
const SESSION_END_REASONS = new Set(['clear', 'resume', 'logout', 'prompt_input_exit', 'other']);

export interface HookInput {
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
    hook_event_name?: string;
    permission_mode?: string;
    stop_hook_active?: boolean;
    last_assistant_message?: string;
    reason?: string;
}

export interface HookDeps {
    env: NodeJS.ProcessEnv;
    fetch: typeof fetch;
    homedir: string;
    /** Where saved invite credentials live (tests); default ~/.agora/credentials. */
    credentialDir?: string;
    log?: (message: string) => void;
    /** Overall time limit (tests); default 8 s for Stop, 2.5 s for SessionEnd. */
    budgetMs?: number;
}

// ─── Finding the session's Agora registration ───

export interface McpEntry {
    type?: string;
    command?: string;
    args?: unknown[];
    env?: Record<string, unknown>;
}

/** Path for comparing against `.claude.json` project keys: forward slashes, no trailing slash, drive paths lowercased. */
export function normalizePath(path: string): string {
    let p = path.replace(/\\/g, '/');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    if (/^[A-Za-z]:/.test(p)) {
        p = p.toLowerCase();
        if (p.length === 2) p += '/';
    }
    return p;
}

/** `dir` and each of its ancestors, nearest first, normalized. */
export function ancestors(dir: string): string[] {
    const start = normalizePath(dir);
    const out: string[] = [];
    const parts = start.split('/');
    for (let i = parts.length; i > 0; i--) {
        let candidate = parts.slice(0, i).join('/');
        if (candidate === '') candidate = '/';
        else if (/^[a-z]:$/.test(candidate)) candidate += '/';
        if (!out.includes(candidate)) out.push(candidate);
    }
    return out;
}

function readJson(path: string): any {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function entryOf(servers: unknown, name: string): McpEntry | undefined {
    if (!servers || typeof servers !== 'object') return undefined;
    const entry = (servers as Record<string, unknown>)[name];
    return entry && typeof entry === 'object' ? entry as McpEntry : undefined;
}

/**
 * The MCP registration named `name` that a Claude Code session in `cwd` uses, by Claude Code's
 * precedence: local scope (`~/.claude.json` projects, cwd and its ancestors), project scope
 * (`.mcp.json`, cwd up), user scope (top-level `mcpServers`). `.claude.json` lives in
 * CLAUDE_CONFIG_DIR when that is set.
 */
export function findMcpEntry(cwd: string, name: string, deps: Pick<HookDeps, 'env' | 'homedir'>): McpEntry | undefined {
    const configDir = deps.env.CLAUDE_CONFIG_DIR?.trim();
    const claudeJson = readJson(configDir ? join(configDir, '.claude.json') : join(deps.homedir, '.claude.json'));
    const dirs = ancestors(cwd);
    if (claudeJson?.projects && typeof claudeJson.projects === 'object') {
        const projects = new Map<string, any>();
        for (const [key, value] of Object.entries(claudeJson.projects)) projects.set(normalizePath(key), value);
        for (const dir of dirs) {
            const entry = entryOf(projects.get(dir)?.mcpServers, name);
            if (entry) return entry;
        }
    }
    for (const dir of dirs) {
        const entry = entryOf(readJson(join(dir, '.mcp.json'))?.mcpServers, name);
        if (entry) return entry;
    }
    return entryOf(claudeJson?.mcpServers, name);
}

/** Claude Code's `${VAR}` / `${VAR:-default}` expansion in .mcp.json values. */
export function expandVars(value: string, env: NodeJS.ProcessEnv): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, key: string, fallback?: string) => env[key] ?? fallback ?? '');
}

/** Instance, token and default channel of a stdio agora-mcp registration; cached invite credentials only. */
export async function resolveEntryConfig(entry: McpEntry, cwd: string, deps: Pick<HookDeps, 'env' | 'credentialDir'>): Promise<AgoraMcpConfig> {
    if (entry.type && entry.type !== 'stdio') throw new Error(`MCP registration is ${entry.type}, not an agora-mcp process`);
    const env: NodeJS.ProcessEnv = { ...deps.env };
    for (const [key, value] of Object.entries(entry.env ?? {})) {
        if (typeof value === 'string') env[key] = expandVars(value, deps.env);
    }
    const args = (entry.args ?? []).filter((a): a is string => typeof a === 'string').map(a => expandVars(a, deps.env));
    // agora-mcp runs in the session's directory, so a relative --config is relative to it
    const configIndex = args.indexOf('--config');
    if (configIndex !== -1 && args[configIndex + 1] && !isAbsolute(args[configIndex + 1])) {
        args[configIndex + 1] = resolve(cwd, args[configIndex + 1]);
    }
    return loadStartupConfig(args, { env, cachedOnly: true, credentialDir: deps.credentialDir });
}

// ─── Reading the transcript ───

export interface Target { channel?: string; thread?: string }

export interface TranscriptState {
    /** The channel/thread of the latest chat_wait, chat_send, thread_start or chat_read. */
    target?: Target;
    /** The latest Agora action closed the target's thread. */
    closedTarget: boolean;
    /** Line index of the latest target action. */
    targetLine: number;
    /** Line index of the latest stop-hook continuation of ours, or -1. */
    lastContinuation: number;
    /** A chat_wait was called after the latest continuation. */
    waitedSinceContinuation: boolean;
    /** The agent said it is done listening after its latest target action. */
    doneListening: boolean;
}

const DONE_LISTENING = /\bdone listening\b/i;

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(b => (b && typeof b === 'object' && (b as any).type === 'text' && typeof (b as any).text === 'string') ? (b as any).text : '').join('\n');
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The thread ID thread_start reported, e.g. "Thread started in #general (thread: 01J…)". */
function startedThread(result: string): string | undefined {
    return /\(thread: ([0-9A-HJKMNP-TV-Z]{26})\)/.exec(result)?.[1];
}

/** What the session's transcript (JSONL) says about its Agora work. `server` is the MCP server name. */
export function parseTranscript(text: string, server: string): TranscriptState {
    const prefix = `mcp__${server}__`;
    const uses: { line: number; tool: string; input: any; id?: string }[] = [];
    const results = new Map<string, { error: boolean; text: string }>();
    const assistantText: { line: number; text: string }[] = [];
    let lastContinuation = -1;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let entry: any;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        // A subagent's work is not this session's
        if (entry?.isSidechain === true) continue;
        const content = entry?.message?.content;
        if (entry?.type === 'assistant' && Array.isArray(content)) {
            for (const block of content) {
                if (block?.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith(prefix)) {
                    uses.push({ line: i, tool: block.name.slice(prefix.length), input: block.input ?? {}, id: block.id });
                }
            }
            const said = textOf(content);
            if (said) assistantText.push({ line: i, text: said });
            continue;
        }
        if (Array.isArray(content)) {
            let toolResult = false;
            for (const block of content) {
                if (block?.type !== 'tool_result') continue;
                toolResult = true;
                if (typeof block.tool_use_id === 'string') {
                    results.set(block.tool_use_id, { error: block.is_error === true, text: textOf(block.content) });
                }
            }
            // A tool result can quote anything (this file, say); only feedback counts
            if (toolResult) continue;
        }
        // Claude Code records a blocked Stop as a user line "Stop hook feedback: … <reason>"
        if (entry?.type !== 'assistant' && textOf(content).includes(STOP_MARKER)) lastContinuation = i;
    }

    const state: TranscriptState = { closedTarget: false, targetLine: -1, lastContinuation, waitedSinceContinuation: false, doneListening: false };
    let lastAction: { tool: string; target: Target } | undefined;
    for (const use of uses) {
        const result = use.id ? results.get(use.id) : undefined;
        // A failed call didn't happen
        if (result?.error) continue;
        if (use.tool === 'chat_wait' && use.line > lastContinuation && lastContinuation >= 0) state.waitedSinceContinuation = true;
        const channel = str(use.input.channel);
        if (TARGET_TOOLS.has(use.tool)) {
            const thread = use.tool === 'thread_start' ? (result ? startedThread(result.text) : undefined) : str(use.input.thread);
            state.target = { channel, thread };
            state.targetLine = use.line;
            lastAction = { tool: use.tool, target: state.target };
        } else if (use.tool === 'thread_close') {
            const thread = str(use.input.thread);
            if (!thread) continue;
            // Reopening a thread is joining it again
            if (use.input.reopen === true) {
                state.target = { channel, thread };
                state.targetLine = use.line;
            }
            lastAction = { tool: use.input.reopen === true ? 'thread_reopen' : 'thread_close', target: { channel, thread } };
        }
    }
    state.closedTarget = lastAction?.tool === 'thread_close' && !!state.target?.thread && lastAction.target.thread === state.target.thread;
    state.doneListening = assistantText.some(a => a.line > state.targetLine && DONE_LISTENING.test(a.text));
    return state;
}

// ─── Talking to Agora ───

class Agora {
    constructor(private config: AgoraMcpConfig, private deps: HookDeps) {}

    async get<T>(path: string): Promise<{ status: number; body: T | undefined }> {
        return this.send<T>('GET', path, undefined, FETCH_TIMEOUT_MS);
    }

    async send<T>(method: string, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: T | undefined }> {
        const res = await this.deps.fetch(`${this.config.instance.replace(/\/+$/, '')}${path}`, {
            method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
            // The token is bound to the client that uses it (#39); a Claude Code session is `claude-code`
            headers: { Authorization: `Bot ${this.config.token}`, 'X-Agora-Client': 'claude-code',
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const parsed = res.headers.get('content-type')?.includes('application/json') ? await res.json().catch(() => undefined) as T : undefined;
        return { status: res.status, body: parsed };
    }
}

interface BotMe { channels?: { id: string; name: string }[] }
interface ThreadRow { id: string; lastReplyAt: string }

/** Is the thread open? Pages the channel's open threads, then looks at a reply-less thread directly. */
async function threadOpen(agora: Agora, channelId: string, threadId: string): Promise<boolean> {
    let before: string | undefined;
    for (let page = 0; page < THREAD_PAGES; page++) {
        const res = await agora.get<ThreadRow[]>(`/channels/${channelId}/threads?limit=10${before ? `&before=${encodeURIComponent(before)}` : ''}`);
        if (res.status !== 200 || !Array.isArray(res.body)) throw new Error(`thread list ${res.status}`);
        if (res.body.some(t => t.id === threadId)) return true;
        if (res.body.length < 10) break;
        before = res.body[res.body.length - 1].lastReplyAt;
    }
    // Open threads are listed once they have a reply; a thread the agent just started has none
    const replies = await agora.get<unknown[]>(`/channels/${channelId}/messages/${encodeURIComponent(threadId)}/replies?limit=1`);
    return replies.status === 200 && Array.isArray(replies.body) && replies.body.length === 0;
}

// ─── The hooks ───

export interface StopDecision { decision: 'block'; reason: string }

export function stopReason(channelName: string, thread: string | undefined, server: string): string {
    const call = thread
        ? `mcp__${server}__chat_wait(channel="${channelName}", thread="${thread}", until="turn", timeout=600)`
        : `mcp__${server}__chat_wait(channel="${channelName}", until="turn", timeout=600)`;
    const where = thread ? `thread ${thread} in #${channelName} is still open` : `you are working in #${channelName}`;
    const finish = thread
        ? `If the work in this thread is finished, close it with mcp__${server}__thread_close(channel="${channelName}", thread="${thread}") and stop. `
        : '';
    return `${STOP_MARKER} The Agora ${where}, so keep listening instead of ending your turn: call ${call} and answer what arrives. `
        + `${finish}If you are done listening, say "done listening" and stop. `
        + '(The human can turn this off with AGORA_STOP_HOOK=off.)';
}

/** The Stop hook's decision: a block, or undefined to let the turn end. */
export async function decideStop(input: HookInput, deps: HookDeps): Promise<StopDecision | undefined> {
    const log = deps.log ?? (() => {});
    if (deps.env.AGORA_STOP_HOOK?.trim().toLowerCase() === 'off') return undefined;
    if (!input.transcript_path || !input.cwd) return undefined;
    const server = deps.env.AGORA_HOOK_SERVER?.trim() || 'agora';
    let transcript: string;
    try { transcript = readFileSync(input.transcript_path, 'utf8'); } catch { log('no transcript'); return undefined; }
    const state = parseTranscript(transcript, server);
    if (!state.target) { log('no Agora activity in this session'); return undefined; }
    if (state.closedTarget) { log('the thread was closed'); return undefined; }
    if (state.doneListening || (input.last_assistant_message && DONE_LISTENING.test(input.last_assistant_message))) {
        log('the agent is done listening'); return undefined;
    }
    // The agent ignored the last reminder: don't nag. If it listened, keep the loop going.
    if (input.stop_hook_active && !state.waitedSinceContinuation) { log('continuation without chat_wait'); return undefined; }

    const entry = findMcpEntry(input.cwd, server, deps);
    if (!entry) { log(`no "${server}" MCP registration for ${input.cwd}`); return undefined; }
    const config = await resolveEntryConfig(entry, input.cwd, deps);
    const wanted = state.target.channel ?? config.defaultChannel;
    if (!wanted) { log('no channel'); return undefined; }
    const agora = new Agora(config, deps);
    const me = await agora.get<BotMe>('/bots/@me');
    if (me.status !== 200 || !Array.isArray(me.body?.channels)) { log(`/bots/@me ${me.status}`); return undefined; }
    const channel = me.body!.channels!.find(c => c.id === wanted) ?? me.body!.channels!.find(c => c.name === wanted);
    if (!channel) { log(`channel ${wanted} not found`); return undefined; }
    const thread = state.target.thread;
    if (thread && !await threadOpen(agora, channel.id, thread)) { log('thread closed or not found'); return undefined; }
    return { decision: 'block', reason: stopReason(channel.name, thread, server) };
}

/** The SessionEnd hook: end this bot's terminal session in Agora now. */
export async function sessionEnd(input: HookInput, deps: HookDeps): Promise<void> {
    const log = deps.log ?? (() => {});
    if (!input.cwd) return;
    const server = deps.env.AGORA_HOOK_SERVER?.trim() || 'agora';
    const entry = findMcpEntry(input.cwd, server, deps);
    if (!entry) { log(`no "${server}" MCP registration for ${input.cwd}`); return; }
    const config = await resolveEntryConfig(entry, input.cwd, deps);
    const reason = input.reason && SESSION_END_REASONS.has(input.reason) ? input.reason : undefined;
    const res = await new Agora(config, deps).send('POST', '/bots/@me/terminal-sessions/end', reason ? { reason } : {}, SESSION_END_REQUEST_MS);
    log(`terminal-sessions/end ${res.status}`);
}

/** Run a hook on its stdin text; returns what to print on stdout (nothing to allow). Never throws. */
export async function runHook(event: string, stdin: string, deps: HookDeps): Promise<string | undefined> {
    const log = deps.log ?? (() => {});
    const budget = deps.budgetMs ?? (event === 'stop' ? STOP_BUDGET_MS : SESSION_END_BUDGET_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const input = JSON.parse(stdin) as HookInput;
        if (!input || typeof input !== 'object') return undefined;
        const work = (async () => {
            if (event === 'stop') {
                const decision = await decideStop(input, deps);
                return decision ? JSON.stringify(decision) : undefined;
            }
            if (event === 'session-end') { await sessionEnd(input, deps); return undefined; }
            log(`unknown hook ${event}`);
            return undefined;
        })();
        const timeout = new Promise<undefined>(res => { timer = setTimeout(() => { log('timed out'); res(undefined); }, budget); });
        return await Promise.race([work, timeout]);
    } catch (error) {
        log(`failed open: ${(error as Error)?.message ?? error}`);
        return undefined;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** `agora-mcp hook <stop|session-end>`: reads the hook input on stdin, prints a decision, exits 0. */
export async function hookMain(event: string | undefined): Promise<void> {
    const debug = process.env.AGORA_HOOK_DEBUG === '1';
    const log = debug ? (m: string) => process.stderr.write(`agora-mcp hook ${event}: ${m}\n`) : undefined;
    try {
        const stdin = await new Promise<string>((res) => {
            let data = '';
            const done = () => res(data);
            const timer = setTimeout(done, 2_000);
            timer.unref();
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', chunk => { data += chunk; });
            process.stdin.on('end', () => { clearTimeout(timer); done(); });
            process.stdin.on('error', () => { clearTimeout(timer); done(); });
        });
        // Every request shares one signal, so whatever is still in flight when the hook is done
        // is cancelled and the process can end on its own
        const stop = new AbortController();
        const hookFetch = ((url: string | URL | Request, init?: RequestInit) =>
            fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, stop.signal]) : stop.signal })) as typeof fetch;
        const out = await runHook(event ?? '', stdin, { env: process.env, fetch: hookFetch, homedir: homedir(), log });
        stop.abort();
        if (out) await new Promise<void>(res => process.stdout.write(out + '\n', () => res()));
    } catch (error) {
        log?.(`failed open: ${(error as Error)?.message ?? error}`);
    }
    // No process.exit() here: on Windows, exiting while fetch's sockets close can abort Node with
    // a libuv assertion (a non-zero exit, which Claude Code reports as a hook error). The event
    // loop drains on its own; the unref'd timer only fires if something still holds it open.
    process.exitCode = 0;
    process.stdin.destroy();
    setTimeout(() => process.exit(0), 3_000).unref();
}
