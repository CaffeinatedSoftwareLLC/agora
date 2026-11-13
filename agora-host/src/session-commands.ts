import { spawn, type ChildProcess } from 'node:child_process';
import type { Config } from './config.js';
import { childEnv, repoFreePath, siwcDir } from './adapters.js';
import { accessToken } from './siwc/session.js';
import { PROVIDER_ARGS } from './siwc/appserver.js';
import { BOX_ADAPTERS } from './box-adapters.js';
import { CODEX_BOX_QUIET, inBox } from './box.js';
import { killTree } from './process.js';
import { ensureWorkspace } from './workspaces.js';

/**
 * Commands sent to an agent from Agora (`@claude /compact`, docs/agent-commands.md). A command
 * is run on the agent's own conversation between wakes, as the CLI's own command: never as chat
 * text the model reads. Only the commands in SESSION_COMMAND_TABLE ever run; nothing from the
 * message reaches a shell or the CLI's argument list but the fixed command word.
 *
 * Evidence (Claude Code 2.1.322, codex-cli 0.166.0, docs/planning/agent-commands.md):
 * - `claude -p` with the prompt `/compact` (or `/context`) on a resumed conversation runs the
 *   command itself: stream-json shows `compact_boundary` with token counts for compact, and a
 *   `<synthetic>` assistant message for context. An unknown `/word` goes to the model as text,
 *   which is why only table commands are ever sent.
 * - `codex exec resume ... "/compact"` sends the text to the model. The app server protocol has
 *   `thread/compact/start` (item type `contextCompaction`), so compact for Codex goes through it.
 */
export const COMMAND_NAMES = ['compact', 'context', 'clear'] as const;
export type SessionCommandName = typeof COMMAND_NAMES[number];

/**
 * adapter -> the commands this host runs for it. `clear` needs nothing from the CLI: the server
 * forgets the conversation id and the next wake starts a fresh one. Everything else is "not
 * supported"; the server mirrors this table for the notice and the session sheet's menu.
 */
export const SESSION_COMMAND_TABLE: Readonly<Record<string, readonly SessionCommandName[]>> = {
    claude: ['compact', 'context', 'clear'],
    codex: ['compact', 'clear'],
    gemini: ['clear'],
    opencode: ['clear'],
    omp: ['clear'],
    devin: ['clear'],
};

export interface SessionCommand {
    id: string; claimToken: string; sessionId: string; profile: string; adapter: string; workdirAlias: string;
    nativeSessionId: string | null; command: SessionCommandName; arg: string | null;
}
export interface CommandResult {
    error?: string; message?: string; tokensBefore?: number; tokensAfter?: number;
    contextTokens?: number; contextWindow?: number; text?: string;
}
export interface Outcome { success: boolean; result: CommandResult }

const NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (error: string, message?: string): Outcome => ({ success: false, result: { error, ...(message ? { message: message.slice(0, 300) } : {}) } });
const OUTPUT_LIMIT = 8 * 1024 * 1024;
export const COMMAND_TIMEOUT_MS = 120000;

/** What to start: a program, its arguments, folder and environment (as a wake's launch has). */
export interface CommandLaunch { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string }
export type SpawnFn = typeof spawn;

// ─── Claude: `claude -p` with the slash command as the prompt ───

/** The headless arguments of a wake, without MCP, schema or tool lists: a command makes no model turn. */
export function claudeCommandArgs(nativeSessionId: string, boxed = inBox()): string[] {
    const policy = boxed ? [...BOX_ADAPTERS.claude.yeet.args, ...BOX_ADAPTERS.claude.yeet.noOpenWeb, ...BOX_ADAPTERS.claude.quiet.args]
        : ['--permission-mode', 'manual', '--permission-prompts', 'none'];
    return ['-p', '--output-format', 'stream-json', '--verbose', ...policy, '--resume', nativeSessionId];
}

/** "72.2k" and "1m" as numbers. */
export function tokenCount(text: string): number | null {
    const m = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(text.trim());
    if (!m) return null;
    const n = Number(m[1]) * (m[2].toLowerCase() === 'k' ? 1e3 : m[2].toLowerCase() === 'm' ? 1e6 : 1);
    return Number.isSafeInteger(Math.round(n)) ? Math.round(n) : null;
}

/** Read `claude -p --output-format stream-json` output for a compact or context command. */
export function parseClaudeCommand(command: 'compact' | 'context', stdout: string, exitCode: number | null): Outcome {
    let boundary: any = null, compactResult: string | null = null, resultText: string | null = null, isError = false;
    const assistants: Array<{ model: string; text: string }> = [];
    for (const line of stdout.split('\n')) {
        if (!line.startsWith('{')) continue;
        let e: any;
        try { e = JSON.parse(line); } catch { continue; }
        if (e?.type === 'system' && e.subtype === 'compact_boundary') boundary = e.compact_metadata ?? {};
        else if (e?.type === 'system' && e.subtype === 'status' && typeof e.compact_result === 'string') compactResult = e.compact_result;
        else if (e?.type === 'assistant') {
            const text = (Array.isArray(e.message?.content) ? e.message.content : []).filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n');
            assistants.push({ model: String(e.message?.model ?? ''), text });
        } else if (e?.type === 'result') { isError = !!e.is_error; if (typeof e.result === 'string') resultText = e.result; }
    }
    if (command === 'compact') {
        if (boundary && compactResult !== 'failed') {
            const n = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
            const before = n(boundary.pre_tokens), after = n(boundary.post_tokens);
            return { success: true, result: { ...(before !== undefined ? { tokensBefore: before } : {}), ...(after !== undefined ? { tokensAfter: after } : {}) } };
        }
        // e.g. "Not enough messages to compact." is the CLI's own answer, a local command result
        const said = assistants.find(a => a.model === '<synthetic>')?.text || resultText || '';
        return fail('compact_failed', said);
    }
    const local = assistants.find(a => a.model === '<synthetic>');
    // A model that answered means the CLI didn't take the word as a command
    if (!local && assistants.length) return fail('not_a_command');
    if (!local || isError || (exitCode !== 0 && exitCode !== null)) return fail('context_failed');
    const m = /\*\*Tokens:\*\*\s*([\d.]+[km]?)\s*\/\s*([\d.]+[km]?)/i.exec(local.text);
    const used = m ? tokenCount(m[1]) : null, window = m ? tokenCount(m[2]) : null;
    return { success: true, result: { text: local.text.slice(0, 1500),
        ...(used !== null ? { contextTokens: used } : {}), ...(window !== null ? { contextWindow: window } : {}) } };
}

/** Run a child to its end, collecting stdout (capped); the whole tree is killed at the timeout or abort. */
export async function runCollect(launch: CommandLaunch, timeoutMs: number, signal?: AbortSignal, spawnFn: SpawnFn = spawn): Promise<{ stdout: string; code: number | null; error?: 'spawn_failed' | 'timeout' | 'aborted' | 'output_limit' }> {
    const child = spawnFn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcess;
    let stdout = '', size = 0, closed = false, error: 'spawn_failed' | 'timeout' | 'aborted' | 'output_limit' | undefined;
    let notify!: () => void;
    const closedEvent = new Promise<void>(r => { notify = r; });
    const stop = (why: 'timeout' | 'aborted' | 'output_limit') => { error ??= why; if (!closed && child.pid) void killTree(child, () => closed, closedEvent).catch(() => {}); };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const onAbort = () => stop('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const code = await new Promise<number | null>(resolve => {
        child.on('error', () => { error ??= 'spawn_failed'; closed = true; notify(); resolve(null); });
        child.stdout!.setEncoding('utf8');
        child.stdout!.on('data', (chunk: string) => { size += Buffer.byteLength(chunk); if (size <= OUTPUT_LIMIT) stdout += chunk; else stop('output_limit'); });
        // Never forwarded: a CLI may echo secrets or user content
        child.stderr!.resume(); child.stdin!.on('error', () => {});
        child.on('close', c => { closed = true; notify(); resolve(c); });
        child.stdin!.end(launch.stdin);
    });
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    return { stdout, code, ...(error ? { error } : {}) };
}

export async function runClaudeCommand(command: 'compact' | 'context', launch: CommandLaunch, signal?: AbortSignal, spawnFn?: SpawnFn, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Outcome> {
    const out = await runCollect(launch, timeoutMs, signal, spawnFn);
    if (out.error) return fail(out.error === 'spawn_failed' ? 'spawn_failed' : out.error === 'timeout' ? 'timeout' : out.error === 'aborted' ? 'aborted' : 'output_limit');
    return parseClaudeCommand(command, out.stdout, out.code);
}

// ─── Codex: `thread/compact/start` over `codex app-server` ───

/**
 * Compact a Codex thread. Observed on codex-cli 0.166.0: initialize, `thread/resume`, then
 * `thread/compact/start` answers `{}` and the work shows as a turn: `turn/started`, item
 * `contextCompaction` started and completed, `turn/completed` (status `completed`). The token
 * counts in `thread/tokenUsage/updated` are per model request, not the size of the conversation,
 * so no before/after numbers are reported.
 */
export async function runCodexCompact(launch: CommandLaunch & { threadId: string }, signal?: AbortSignal, spawnFn: SpawnFn = spawn, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Outcome> {
    const child = spawnFn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcess;
    let closed = false, nextId = 1, buffer = '', size = 0;
    let notifyClosed!: () => void;
    const closedEvent = new Promise<void>(r => { notifyClosed = r; });
    const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
    let compacted = false;
    let finish!: (o: Outcome) => void;
    const done = new Promise<Outcome>(r => { finish = r; });
    const write = (msg: unknown) => { if (!child.stdin!.destroyed) child.stdin!.write(`${JSON.stringify(msg)}\n`); };
    const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); write({ id, method, params }); });
    child.on('error', () => { closed = true; notifyClosed(); finish(fail('spawn_failed')); });
    child.on('close', () => { closed = true; notifyClosed(); for (const p of pending.values()) p.reject(new Error('app_server_exited')); pending.clear(); finish(fail('app_server_exited')); });
    child.stderr!.resume(); child.stdin!.on('error', () => {});
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { finish(fail('output_limit')); return; }
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let msg: any;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id !== undefined && msg.method === undefined) {
                const p = pending.get(msg.id); if (!p) continue; pending.delete(msg.id);
                if (msg.error) p.reject(Object.assign(new Error('rpc_error'), { rpc: msg.error })); else p.resolve(msg.result);
            } else if (msg.id !== undefined && typeof msg.method === 'string') {
                // A server request (approval, input): a compaction asks for none; refuse so nothing waits
                write({ id: msg.id, error: { code: -32601, message: 'not supported' } });
            } else if (msg.method === 'item/completed' && msg.params?.threadId === launch.threadId && msg.params?.item?.type === 'contextCompaction') {
                compacted = true;
            } else if (msg.method === 'turn/completed' && msg.params?.threadId === launch.threadId && started) {
                finish(compacted && msg.params?.turn?.status === 'completed' ? { success: true, result: {} } : fail('compact_failed'));
            }
        }
    });
    let started = false;
    const stop = (o: Outcome) => finish(o);
    const timer = setTimeout(() => stop(fail('timeout')), timeoutMs);
    const onAbort = () => stop(fail('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    void (async () => {
        try {
            await request('initialize', { clientInfo: { name: 'agora-host', title: 'agora-host', version: '0.1.0' }, capabilities: null });
            write({ method: 'initialized', params: {} });
            const thread = await request('thread/resume', { threadId: launch.threadId, excludeTurns: true, cwd: launch.cwd });
            if (thread?.thread?.id !== launch.threadId) throw new Error('bad_thread');
            started = true;
            await request('thread/compact/start', { threadId: launch.threadId });
        } catch (err: any) { finish(fail(err?.message === 'bad_thread' ? 'no_conversation' : 'app_server_failed')); }
    })();
    const outcome = await done;
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    if (!closed && child.pid) await killTree(child, () => closed, closedEvent).catch(() => {});
    return outcome;
}

// ─── Running a claimed command ───

export interface CommandDeps {
    /** Where the command runs and with what environment; tests replace it. */
    launch?: (config: Config, cmd: SessionCommand) => Promise<CommandLaunch>;
    spawn?: SpawnFn;
    timeoutMs?: number;
}

/** The program, folder and environment the profile's own wakes use. No MCP and no schema: a command makes no model turn. */
async function defaultLaunch(config: Config, cmd: SessionCommand): Promise<CommandLaunch & { args: string[] }> {
    const local = config.profiles[cmd.profile];
    if (!local || local.adapter !== cmd.adapter || local.workdirAlias !== cmd.workdirAlias) throw new Error('unmapped_profile');
    if (cmd.nativeSessionId && !NATIVE_ID.test(cmd.nativeSessionId)) throw new Error('invalid_native_session_id');
    const workspace = await ensureWorkspace(local, { session: { id: cmd.sessionId }, profile: { name: cmd.profile } });
    const env = childEnv(local);
    await repoFreePath(env, [workspace.cwd, workspace.workdir, local.workdir]);
    const boxed = inBox();
    if (local.adapter === 'claude') {
        return { executable: local.executable, args: claudeCommandArgs(cmd.nativeSessionId ?? '', boxed), cwd: workspace.cwd, env, stdin: `/${cmd.command}` };
    }
    // codex: app-server with no MCP servers (a compaction needs none); a ChatGPT plan adds its provider and token
    let args = ['app-server', '--listen', 'stdio://', '-c', 'mcp_servers={}', ...(boxed ? CODEX_BOX_QUIET : [])];
    if (local.auth === 'siwc') {
        const token = await accessToken({ dir: siwcDir(config), profile: cmd.profile });
        env.ACCESS_TOKEN = token.accessToken;
        args = [...args, ...PROVIDER_ARGS];
    }
    return { executable: local.executable, args, cwd: workspace.cwd, env, stdin: '' };
}

/** Run one claimed command. Never throws: a failure is a short code the server turns into a notice. */
export async function executeSessionCommand(config: Config, cmd: SessionCommand, signal?: AbortSignal, deps: CommandDeps = {}): Promise<Outcome> {
    if (cmd.arg !== null) return fail('bad_argument');
    if (!(SESSION_COMMAND_TABLE[cmd.adapter] ?? []).includes(cmd.command)) return fail('unsupported');
    // The server forgets the conversation; nothing to run on this machine
    if (cmd.command === 'clear') return { success: true, result: {} };
    if (cmd.nativeSessionId === null) return fail('no_conversation');
    let launch: CommandLaunch;
    try { launch = await (deps.launch ?? defaultLaunch)(config, cmd); }
    catch (err) {
        const code = err instanceof Error ? err.message : '';
        return fail(/^[a-z][a-z_]{0,100}$/.test(code) ? code : 'launch_failed');
    }
    try {
        if (cmd.adapter === 'claude') return await runClaudeCommand(cmd.command as 'compact' | 'context', launch, signal, deps.spawn, deps.timeoutMs);
        return await runCodexCompact({ ...launch, threadId: cmd.nativeSessionId }, signal, deps.spawn, deps.timeoutMs);
    } catch { return fail('command_failed'); }
}
