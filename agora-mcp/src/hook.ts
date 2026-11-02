import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { findHookStates, hookStateDir, isClaudeClient, isCodexClient, processRunning, type HookCli, type HookState } from './hook-state.js';

/**
 * Claude Code and Codex CLI hooks (`agora-mcp hook <stop|session-end> [--for codex]`,
 * docs/claude-code-hooks.md). Both CLIs send the same hook input and take the same Stop
 * output; their transcripts differ (parseTranscript, parseRollout).
 *
 * - Stop: a session still engaged in an open Agora thread is sent back to `chat_wait` instead
 *   of ending its turn, so the thread doesn't go quiet.
 * - SessionEnd: tells Agora the session is gone, so its terminal session ends now instead of
 *   60 s after the socket drops (and at all on /clear, where agora-mcp keeps running).
 *
 * Hooks get no MCP config, and agora-mcp never reads the CLI's own files: the agora-mcp server
 * the session started leaves its connection in our own folder (src/hook-state.ts), and the
 * hooks read it from there.
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
/** Only the end of a long transcript is read: the latest Agora calls are what count. */
export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const SESSION_END_REASONS = new Set(['clear', 'resume', 'logout', 'prompt_input_exit', 'other']);

export interface HookInput {
    session_id?: string;
    /** Codex sends null when the session keeps no rollout. */
    transcript_path?: string | null;
    cwd?: string;
    hook_event_name?: string;
    permission_mode?: string;
    stop_hook_active?: boolean;
    last_assistant_message?: string | null;
    reason?: string;
}

export interface HookDeps {
    env: NodeJS.ProcessEnv;
    fetch: typeof fetch;
    /** The CLI running the hook (`--for`); default Claude Code. */
    cli?: HookCli;
    /** The hooks folder (tests); default the user's .agora/hooks. Codex's files are in its `codex/`. */
    stateDir?: string;
    isRunning?: (pid: number) => boolean;
    now?: () => number;
    log?: (message: string) => void;
    /** Overall time limit (tests); default 8 s for Stop, 2.5 s for SessionEnd. */
    budgetMs?: number;
}

// ─── Finding the session's Agora connection ───

/** How recently a SessionEnd accepts a state file whose server has already exited. */
const SESSION_END_FRESH_MS = 5 * 60_000;

/**
 * The project directories to look under (each with its ancestors): for Claude Code,
 * CLAUDE_PROJECT_DIR, then the session's cwd. Codex starts its MCP servers in the session's
 * cwd, and a CLAUDE_PROJECT_DIR in a Codex hook's environment is left over from wherever Codex
 * was started, so only the cwd counts.
 */
function projectDirs(input: HookInput, deps: HookDeps): string[] {
    return [(deps.cli ?? 'claude') === 'claude' ? deps.env.CLAUDE_PROJECT_DIR?.trim() : undefined, input.cwd].filter((d): d is string => !!d);
}

/**
 * The running agora-mcp servers of this session (src/hook-state.ts), started by this CLI.
 * Stop wants a live one; at SessionEnd the server may already be exiting, so a recently
 * refreshed file also counts.
 */
export function sessionStates(input: HookInput, deps: HookDeps, event: 'stop' | 'session-end'): HookState[] {
    const cli = deps.cli ?? 'claude';
    const ours = cli === 'codex' ? isCodexClient : isClaudeClient;
    const running = deps.isRunning ?? processRunning;
    const now = (deps.now ?? Date.now)();
    return findHookStates(projectDirs(input, deps), state => ours(state.client) && (running(state.pid)
        || (event === 'session-end' && now - Date.parse(state.updatedAt) < SESSION_END_FRESH_MS)),
    deps.stateDir !== undefined ? hookStateDir(cli, deps.stateDir) : hookStateDir(cli));
}

/** How each CLI's transcript is read: a cheap check for the server's calls, then the parser. */
const TRANSCRIPTS: Record<HookCli, { mentions: (server: string) => string; parse: (text: string, server: string) => TranscriptState }> = {
    claude: { mentions: server => `mcp__${server}__`, parse: parseTranscript },
    // Codex's JSON is compact; inside a tool's output text the quotes would be escaped
    codex: { mentions: server => `"server":${JSON.stringify(server)}`, parse: parseRollout },
};

// ─── Reading the transcript ───

/** The transcript, or its last `maxBytes` from the first whole line on. */
export function readTranscriptTail(path: string, maxBytes = TRANSCRIPT_TAIL_BYTES): string {
    const fd = openSync(path, 'r');
    try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, maxBytes);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        const text = buffer.toString('utf8');
        return length < size ? text.slice(text.indexOf('\n') + 1) : text;
    } finally {
        closeSync(fd);
    }
}

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

/** Text blocks: Claude's and MCP's `text`, Codex's `input_text` / `output_text`. */
const TEXT_BLOCKS = new Set(['text', 'input_text', 'output_text']);

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(b => (b && typeof b === 'object' && TEXT_BLOCKS.has((b as any).type) && typeof (b as any).text === 'string') ? (b as any).text : '').join('\n');
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The thread ID thread_start reported, e.g. "Thread started in #general (thread: 01J…)". */
function startedThread(result: string): string | undefined {
    return /\(thread: ([0-9A-HJKMNP-TV-Z]{26})\)/.exec(result)?.[1];
}

/** One Agora tool call, from either CLI's transcript. */
interface AgoraCall { line: number; tool: string; input: any; result?: { error: boolean; text: string } }

/** What a transcript says, before the rules are applied. */
interface Collected { calls: AgoraCall[]; assistantText: { line: number; text: string }[]; lastContinuation: number }

/** What the session's transcript (Claude Code's JSONL) says about its Agora work. `server` is the MCP server name. */
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
    return summarize({ calls: uses.map(u => ({ line: u.line, tool: u.tool, input: u.input, result: u.id ? results.get(u.id) : undefined })),
        assistantText, lastContinuation });
}

/** A Codex MCP result (`CallToolResult`): its text, and whether it is an error. */
function codexResult(result: any, failed: boolean): { error: boolean; text: string } {
    return { error: failed || result?.isError === true, text: textOf(result?.content) };
}

function codexArguments(value: unknown): any {
    if (typeof value === 'string') { try { return JSON.parse(value) ?? {}; } catch { return {}; } }
    return value && typeof value === 'object' ? value : {};
}

/**
 * What a Codex CLI rollout (JSONL, `transcript_path` in its hook input) says about the
 * session's Agora work. Codex records a finished MCP call as an `item_completed` event with an
 * `McpToolCall` item (`server`, `tool`, `arguments`, `status`, `result`), or, in a rollout with
 * legacy history, as an `mcp_tool_call_end` event (`invocation`, `result: { Ok | Err }`). Both
 * are recorded whether the model called the tool directly or from a code-mode script, and the
 * script's own text and output are never read. A blocked Stop comes back as a user message
 * (`<hook_prompt …>reason</hook_prompt>`); what the agent says is an assistant message.
 * Subagents keep their own rollouts.
 */
export function parseRollout(text: string, server: string): TranscriptState {
    const calls: AgoraCall[] = [];
    const assistantText: { line: number; text: string }[] = [];
    let lastContinuation = -1;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let entry: any;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        const payload = entry?.payload;
        if (!payload || typeof payload !== 'object') continue;
        if (entry.type === 'event_msg') {
            const item = payload.item;
            if (payload.type === 'item_completed' && item?.type === 'McpToolCall' && item.server === server && typeof item.tool === 'string') {
                calls.push({ line: i, tool: item.tool, input: codexArguments(item.arguments),
                    result: codexResult(item.result, item.status === 'failed' || !!item.error) });
            } else if (payload.type === 'mcp_tool_call_end' && payload.invocation?.server === server && typeof payload.invocation.tool === 'string') {
                const result = payload.result;
                calls.push({ line: i, tool: payload.invocation.tool, input: codexArguments(payload.invocation.arguments),
                    result: codexResult(result?.Ok, !result || 'Err' in result) });
            }
            continue;
        }
        if (entry.type !== 'response_item' || payload.type !== 'message') continue;
        const said = textOf(payload.content);
        if (payload.role === 'assistant') { if (said) assistantText.push({ line: i, text: said }); }
        else if (payload.role === 'user' && said.includes(STOP_MARKER)) lastContinuation = i;
    }
    return summarize({ calls, assistantText, lastContinuation });
}

/** The decision rules' view of a transcript (both CLIs). */
function summarize({ calls, assistantText, lastContinuation }: Collected): TranscriptState {
    const state: TranscriptState = { closedTarget: false, targetLine: -1, lastContinuation, waitedSinceContinuation: false, doneListening: false };
    let lastAction: { tool: string; target: Target } | undefined;
    for (const use of calls) {
        const result = use.result;
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
    constructor(private config: HookState, private deps: HookDeps) {}

    async get<T>(path: string): Promise<{ status: number; body: T | undefined; headers: Headers }> {
        return this.send<T>('GET', path, undefined, FETCH_TIMEOUT_MS);
    }

    async send<T>(method: string, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: T | undefined; headers: Headers }> {
        const res = await this.deps.fetch(`${this.config.instance.replace(/\/+$/, '')}${path}`, {
            method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
            // The token is bound to the client that uses it (#39): the one that started agora-mcp
            headers: { Authorization: `Bot ${this.config.token}`, 'X-Agora-Client': this.config.client,
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const parsed = res.headers.get('content-type')?.includes('application/json') ? await res.json().catch(() => undefined) as T : undefined;
        return { status: res.status, body: parsed, headers: res.headers };
    }
}

interface BotMe { channels?: { id: string; name: string }[] }
interface ThreadRow { id: string; lastReplyAt: string }

/**
 * Is the thread open? Agora answers on the thread's replies (`X-Agora-Thread-State`). A server
 * without that header is asked for its open threads instead; a thread not found there, with no
 * replies yet or closed, can't be told apart, so it counts as not open: an unknown state lets
 * the turn end.
 */
async function threadOpen(agora: Agora, channelId: string, threadId: string): Promise<boolean> {
    const replies = await agora.get<unknown[]>(`/channels/${channelId}/messages/${encodeURIComponent(threadId)}/replies?limit=1`);
    if (replies.status !== 200) return false;
    const state = replies.headers.get('x-agora-thread-state');
    if (state === 'open' || state === 'closed') return state === 'open';
    let before: string | undefined;
    for (let page = 0; page < THREAD_PAGES; page++) {
        const res = await agora.get<ThreadRow[]>(`/channels/${channelId}/threads?limit=10${before ? `&before=${encodeURIComponent(before)}` : ''}`);
        if (res.status !== 200 || !Array.isArray(res.body)) return false;
        if (res.body.some(t => t.id === threadId)) return true;
        if (res.body.length < 10) break;
        before = res.body[res.body.length - 1].lastReplyAt;
    }
    return false;
}

// ─── The hooks ───

export interface StopDecision { decision: 'block'; reason: string }

export function stopReason(channelName: string, thread: string, server: string): string {
    return `${STOP_MARKER} The Agora thread ${thread} in #${channelName} is still open, so keep listening instead of ending your turn: `
        + `call mcp__${server}__chat_wait(channel="${channelName}", thread="${thread}", until="turn", timeout=600) and answer what arrives. `
        + `If the work in this thread is finished, close it with mcp__${server}__thread_close(channel="${channelName}", thread="${thread}") and stop. `
        + 'If you are done listening, say "done listening" and stop. '
        + '(The human can turn this off with AGORA_STOP_HOOK=off.)';
}

/** `AGORA_HOOKS=off` turns both hooks off (agora-host sets it for hosted runs); `AGORA_STOP_HOOK=off` only Stop. */
function hooksOff(env: NodeJS.ProcessEnv): boolean {
    return env.AGORA_HOOKS?.trim().toLowerCase() === 'off';
}

/** The Stop hook's decision: a block, or undefined to let the turn end. */
export async function decideStop(input: HookInput, deps: HookDeps): Promise<StopDecision | undefined> {
    const log = deps.log ?? (() => {});
    if (hooksOff(deps.env) || deps.env.AGORA_STOP_HOOK?.trim().toLowerCase() === 'off') { log('turned off'); return undefined; }
    if (!input.transcript_path) return undefined;
    const servers = sessionStates(input, deps, 'stop');
    if (servers.length === 0) { log('no running agora-mcp for this project'); return undefined; }
    let transcript: string;
    try { transcript = readTranscriptTail(input.transcript_path); } catch { log('no transcript'); return undefined; }
    const reader = TRANSCRIPTS[deps.cli ?? 'claude'];
    // Most sessions never use Agora: skip parsing
    const used = servers.filter(s => transcript.includes(reader.mentions(s.server)));
    if (used.length === 0) { log('no Agora activity in this session'); return undefined; }
    // With more than one Agora server, the one the session used last
    let config: HookState | undefined;
    let state: TranscriptState | undefined;
    for (const name of new Set(used.map(s => s.server))) {
        const parsed = reader.parse(transcript, name);
        if (parsed.target && (!state || parsed.targetLine > state.targetLine)) { state = parsed; config = used.find(s => s.server === name); }
    }
    if (!state?.target || !config) { log('no Agora activity in this session'); return undefined; }
    // Each agora-mcp process has its own state file. Two live ones under this server name with
    // different bots (two sessions in this project): which is this session's can't be told, and
    // the wrong token would act as the other bot, so the turn ends. The same bot is fine.
    const chosen = config.server;
    if (new Set(used.filter(s => s.server === chosen).map(s => s.token)).size > 1) {
        log(`more than one bot for ${chosen} in this project; leaving the turn alone`); return undefined;
    }
    // Only an open thread holds the session: in a channel there is nothing to close, so a
    // session (or a `claude -p` run) that once posted there would never be let go
    if (!state.target.thread) { log('no thread'); return undefined; }
    if (state.closedTarget) { log('the thread was closed'); return undefined; }
    if (state.doneListening || (input.last_assistant_message && DONE_LISTENING.test(input.last_assistant_message))) {
        log('the agent is done listening'); return undefined;
    }
    // The agent ignored the last reminder: don't nag. If it listened, keep the loop going.
    if (input.stop_hook_active && !state.waitedSinceContinuation) { log('continuation without chat_wait'); return undefined; }

    const wanted = state.target.channel ?? config.defaultChannel;
    if (!wanted) { log('no channel'); return undefined; }
    const agora = new Agora(config, deps);
    const me = await agora.get<BotMe>('/bots/@me');
    if (me.status !== 200 || !Array.isArray(me.body?.channels)) { log(`/bots/@me ${me.status}`); return undefined; }
    const channel = me.body!.channels!.find(c => c.id === wanted) ?? me.body!.channels!.find(c => c.name === wanted);
    if (!channel) { log(`channel ${wanted} not found`); return undefined; }
    const thread = state.target.thread;
    if (!await threadOpen(agora, channel.id, thread)) { log('thread closed or not found'); return undefined; }
    return { decision: 'block', reason: stopReason(channel.name, thread, config.server) };
}

/**
 * The SessionEnd hook: end the terminal session of this session's agora-mcp now. Conservative,
 * since the server's disconnect grace period covers anything skipped: only with exactly one
 * candidate state file for the project, live or just exited (each agora-mcp process has its
 * own, so a second session there makes two), and only if this session's transcript shows it
 * used that server.
 */
export async function sessionEnd(input: HookInput, deps: HookDeps): Promise<void> {
    const log = deps.log ?? (() => {});
    if (hooksOff(deps.env)) { log('turned off'); return; }
    const servers = sessionStates(input, deps, 'session-end');
    if (servers.length !== 1) { log(`${servers.length} agora-mcp state files for this project; leaving it to the grace period`); return; }
    const [server] = servers;
    if (!input.transcript_path) return;
    let transcript: string;
    try { transcript = readTranscriptTail(input.transcript_path); } catch { log('no transcript'); return; }
    if (!transcript.includes(TRANSCRIPTS[deps.cli ?? 'claude'].mentions(server.server))) { log('this session did not use Agora'); return; }
    const reason = input.reason && SESSION_END_REASONS.has(input.reason) ? input.reason : undefined;
    const res = await new Agora(server, deps).send('POST', '/bots/@me/terminal-sessions/end', reason ? { reason } : {}, SESSION_END_REQUEST_MS);
    log(`${server.server}: terminal-sessions/end ${res.status}`);
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

/** `--for <cli>` after the event: the CLI running the hook (default claude), or null if unknown. */
export function hookCliArg(args: string[]): HookCli | null {
    const at = args.indexOf('--for');
    if (at < 0) return 'claude';
    const name = args[at + 1]?.trim().toLowerCase();
    return name === 'claude' || name === 'codex' ? name : null;
}

/** `agora-mcp hook <stop|session-end> [--for codex]`: reads the hook input on stdin, prints a decision, exits 0. */
export async function hookMain(event: string | undefined, args: string[] = []): Promise<void> {
    const debug = process.env.AGORA_HOOK_DEBUG === '1';
    const log = debug ? (m: string) => process.stderr.write(`agora-mcp hook ${event}: ${m}\n`) : undefined;
    const cli = hookCliArg(args);
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
        const out = cli ? await runHook(event ?? '', stdin, { env: process.env, fetch: hookFetch, log, cli }) : undefined;
        if (!cli) log?.(`unknown --for ${args[args.indexOf('--for') + 1] ?? ''}; failing open`);
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
