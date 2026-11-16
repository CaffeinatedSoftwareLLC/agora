import { createServer, type Server as NetServer } from 'node:net';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import type { Config, LocalProfile } from './config.js';
import { childEnv, repoFreePath } from './adapters.js';
import { BOX_ADAPTERS } from './box-adapters.js';
import { inBox } from './box.js';
import { ensureWorkspace, git } from './workspaces.js';
import { makeHelperPty, PTY_HELPER, type PtyChild, type SpawnPty } from './box-shell.js';

/**
 * Live terminals, box side (docs/planning/live-terminals.md). For an agent in "Live terminal" mode the
 * server names the sessions that should run; this module keeps one interactive Claude Code per session
 * running in a pseudo-terminal, as the AGENT's Unix user (the user this host already runs as), and relays
 * its screen to the server's live hub over its own socket.
 *
 * Who owns the pty, and why: this process (the agent's agora-host, uid 1000). Not the owner's terminal
 * relay: that is another user's process and holds a credential the agent must not be able to read, and
 * the agent's screen may show the agent's own secrets, which would then sit in the operator side's
 * memory. The socket here authenticates with the host token the agent's host already holds (the same
 * boundary as every wake), through the box's edge. The screen's ring buffer lives in this process's
 * memory only.
 *
 * The CLI runs as `claude --dangerously-load-development-channels server:agora` with the Agora MCP in
 * channel mode, so chat messages reach it as Channel pushes. Nothing here ever types a chat message into
 * the terminal: the only bytes written to the pty are the owner's keystrokes from the live hub (and one
 * Escape when a turn passes its run-time limit).
 *
 * Signals (no screen scraping): Claude Code hooks (SessionStart, UserPromptSubmit, PreToolUse,
 * Notification, Stop) call box/agora-live-hook, which hands the event to a Unix socket this process owns.
 * "Waiting on you" is a permission/dialog Notification, or no SessionStart within STARTUP_MS (a startup
 * dialog such as the development-channel warning is showing); the owner answers it in the terminal.
 */

export const LIVE_PROTOCOL = 1;
export const RING_BYTES = 256 * 1024;
/** No SessionStart hook this long after the CLI started: it is showing a dialog (or is stuck) */
export const STARTUP_MS = 25_000;
const RESTART_BACKOFF = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'] as const;
type HookEvent = typeof HOOK_EVENTS[number];
/** The wrapper box/Dockerfile installs (root-owned); it never fails the CLI */
export const HOOK_COMMAND = '/opt/agora/agora-live-hook';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface LiveSpec {
    sessionId: string; channelId: string; channelName: string; botId: string; conversation: string | null; profile: string;
    cols: number; rows: number; model?: string | null; effort?: string | null;
}

export type LiveStateName = 'starting' | 'idle' | 'working' | 'waiting' | 'restarting' | 'stopped';

/** What the manager needs of the socket to Agora */
export interface LiveTransport {
    emit(event: string, payload: unknown): void;
    on(event: string, handler: (payload: any) => void): void;
    readonly connected: boolean;
}

export interface LaunchPlan { command: string[]; env: NodeJS.ProcessEnv; cwd: string; branchCwd: string }

/** A ring of the newest bytes of the screen */
class Ring {
    private chunks: Buffer[] = [];
    private size = 0;
    push(d: Buffer) {
        this.chunks.push(d); this.size += d.length;
        while (this.chunks.length > 1 && this.size - this.chunks[0].length >= RING_BYTES) this.size -= this.chunks.shift()!.length;
        if (this.size > RING_BYTES) { const c = this.chunks[0]; const cut = this.size - RING_BYTES; this.chunks[0] = c.subarray(cut); this.size -= cut; }
    }
    snapshot() { return Buffer.concat(this.chunks); }
}

export interface LiveOptions {
    config: Config;
    spawnPty?: SpawnPty;
    /** A worktree for the session, and its branch */
    workspace?: (local: LocalProfile, spec: LiveSpec) => Promise<{ cwd: string; branch: string }>;
    /** Branch and commit of a worktree, read from git (never from the CLI) */
    readHead?: (cwd: string) => Promise<{ branch: string | null; sha: string | null }>;
    runtimeDir?: string;
    log(code: string): void;
    startupMs?: number;
    backoff?: readonly number[];
    setTimer?: (fn: () => void, ms: number) => { cancel(): void };
    hookCommand?: string;
    /** Tests: skip the Unix socket the hooks talk to (events are fed with hook()) */
    hookSocket?: boolean;
}

const defaultTimer = (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; };

export async function defaultReadHead(cwd: string): Promise<{ branch: string | null; sha: string | null }> {
    const branch = (await git(cwd, ['symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim() || null;
    const sha = (await git(cwd, ['rev-parse', 'HEAD']).catch(() => '')).trim();
    return { branch, sha: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : null };
}

/** The Claude Code settings file that wires the hooks (hooks only; no permission or model settings). */
export function hookSettings(hookCommand = HOOK_COMMAND): object {
    return {
        hooks: Object.fromEntries(HOOK_EVENTS.map(e => [e, [{ hooks: [{ type: 'command', command: `${hookCommand} ${e}`, timeout: 5 }] }]])),
        // Unattended start: the bypass-permissions confirmation is the box's decision, not the owner's per start
        skipDangerousModePermissionPrompt: true,
    };
}

/** `message_id` of a prompt that arrived as an Agora Channel push; null for anything else (typed text). */
export function channelMessageId(prompt: unknown): string | null {
    if (typeof prompt !== 'string') return null;
    const m = /^\s*<channel source="agora"[^>]*?\smessage_id="([0-9A-HJKMNP-TV-Z]{26})"/.exec(prompt.slice(0, 4000));
    return m ? m[1] : null;
}

class LiveRun {
    state: LiveStateName = 'stopped';
    note: string | null = null;
    ring = new Ring();
    pty: PtyChild | null = null;
    wanted = true;
    confirmed = false;
    fastFailures = 0;
    restarts = 0;
    startedAt = 0;
    restartTimer: { cancel(): void } | null = null;
    startupTimer: { cancel(): void } | null = null;
    paceTimer: ReturnType<typeof setTimeout> | null = null;
    hookServer: NetServer | null = null;
    hookPath = '';
    plan: LaunchPlan | null = null;
    turnOpen = false;
    /** A hook has fired since this start of the CLI (the startup watchdog's signal) */
    confirmedThisRun = false;
    constructor(public spec: LiveSpec) {}
}

export class LiveManager {
    private runs = new Map<string, LiveRun>();
    private socket: LiveTransport | null = null;
    private readonly spawnPty: SpawnPty;
    private readonly runtimeDir: string;
    private readonly timer: NonNullable<LiveOptions['setTimer']>;

    constructor(private o: LiveOptions) {
        this.spawnPty = o.spawnPty ?? makeHelperPty(PTY_HELPER);
        this.runtimeDir = o.runtimeDir ?? (existsSync('/run/agora') ? '/run/agora' : tmpdir());
        this.timer = o.setTimer ?? defaultTimer;
    }

    sessionIds(): string[] { return [...this.runs.keys()]; }
    stateOf(id: string): { state: LiveStateName; note: string | null } | null { const r = this.runs.get(id); return r ? { state: r.state, note: r.note } : null; }

    /** Wire a connected transport. Called again after a reconnect: running sessions are re-announced. */
    attach(socket: LiveTransport): void {
        this.socket = socket;
        socket.on('live:desired', (m: { sessions?: unknown }) => { void this.reconcile(Array.isArray(m?.sessions) ? m.sessions : []).catch(() => this.o.log('live_reconcile_failed')); });
        socket.on('live:input', (m: { sessionId?: unknown; data?: unknown }) => {
            const r = typeof m?.sessionId === 'string' ? this.runs.get(m.sessionId) : undefined;
            if (r?.pty && m.data instanceof Uint8Array && m.data.byteLength > 0 && m.data.byteLength <= 1 << 20) r.pty.write(Buffer.from(m.data));
        });
        socket.on('live:resize', (m: { sessionId?: unknown; cols?: unknown; rows?: unknown }) => {
            const r = typeof m?.sessionId === 'string' ? this.runs.get(m.sessionId) : undefined;
            const cols = Number(m?.cols), rows = Number(m?.rows);
            if (r && Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && cols <= 500 && rows >= 1 && rows <= 200) {
                r.spec.cols = cols; r.spec.rows = rows; r.pty?.resize(cols, rows);
            }
        });
        // Over its run-time limit: one Escape interrupts the turn. Not a chat message, not a dialog answer.
        socket.on('live:interrupt', (m: { sessionId?: unknown }) => { const r = typeof m?.sessionId === 'string' ? this.runs.get(m.sessionId) : undefined; r?.pty?.write(Buffer.from('\x1b')); });
        socket.on('live:pace', (m: { sessionId?: unknown; ms?: unknown }) => {
            const r = typeof m?.sessionId === 'string' ? this.runs.get(m.sessionId) : undefined;
            const ms = Math.min(Math.max(Number(m?.ms) || 0, 0), 2000);
            if (!r?.pty || !ms || r.paceTimer) return;
            r.pty.pause();
            r.paceTimer = setTimeout(() => { r.paceTimer = null; r.pty?.resume(); }, ms);
            r.paceTimer.unref?.();
        });
        for (const r of this.runs.values()) {
            this.send('live:state', { sessionId: r.spec.sessionId, state: r.state, note: r.note });
            const snap = r.ring.snapshot();
            if (snap.length) this.send('live:replay', { sessionId: r.spec.sessionId, data: snap });
        }
    }
    detach(): void { this.socket = null; }

    private send(event: string, payload: unknown): void { if (this.socket?.connected) this.socket.emit(event, payload); }

    private setState(r: LiveRun, state: LiveStateName, note: string | null = null): void {
        if (r.state === state && r.note === note) return;
        r.state = state; r.note = note;
        this.send('live:state', { sessionId: r.spec.sessionId, state, note });
    }

    /** Start what the server wants and is not running; stop what it no longer wants. */
    async reconcile(want: unknown[]): Promise<void> {
        const specs: LiveSpec[] = [];
        for (const w of want) {
            const s = w as Partial<LiveSpec>;
            if (!s || typeof s.sessionId !== 'string' || !ID.test(s.sessionId) || typeof s.channelId !== 'string' || !ID.test(s.channelId) || typeof s.botId !== 'string' || !ID.test(s.botId)
                || typeof s.profile !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(s.profile)) continue;
            specs.push({
                sessionId: s.sessionId, channelId: s.channelId, channelName: typeof s.channelName === 'string' ? s.channelName.slice(0, 100) : '', botId: s.botId,
                conversation: typeof s.conversation === 'string' && UUID.test(s.conversation) ? s.conversation.toLowerCase() : null, profile: s.profile,
                cols: Number.isInteger(s.cols) && s.cols! >= 1 && s.cols! <= 500 ? s.cols! : 120, rows: Number.isInteger(s.rows) && s.rows! >= 1 && s.rows! <= 200 ? s.rows! : 32,
                model: typeof s.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(s.model) ? s.model : null,
                effort: typeof s.effort === 'string' && /^[a-z]{1,10}$/.test(s.effort) ? s.effort : null,
            });
        }
        const keep = new Set(specs.map(s => s.sessionId));
        for (const [id, r] of [...this.runs]) if (!keep.has(id)) await this.stop(id);
        for (const spec of specs) {
            const existing = this.runs.get(spec.sessionId);
            if (existing) { existing.spec = { ...existing.spec, ...spec, cols: existing.spec.cols, rows: existing.spec.rows }; continue; }
            const run = new LiveRun(spec);
            run.confirmed = await this.loadConfirmed(spec);
            this.runs.set(spec.sessionId, run);
            await this.launch(run);
        }
    }

    async stop(id: string): Promise<void> {
        const r = this.runs.get(id);
        if (!r) return;
        r.wanted = false;
        r.restartTimer?.cancel(); r.startupTimer?.cancel();
        if (r.paceTimer) clearTimeout(r.paceTimer);
        r.pty?.kill();
        r.hookServer?.close();
        if (r.hookPath) await unlink(r.hookPath).catch(() => {});
        this.runs.delete(id);
    }
    async stopAll(): Promise<void> { for (const id of [...this.runs.keys()]) await this.stop(id); }

    private async plan(r: LiveRun): Promise<LaunchPlan> {
        const { config } = this.o;
        const local = config.profiles[r.spec.profile];
        const token = config.botTokens[r.spec.botId];
        if (!local || local.adapter !== 'claude' || !token) throw new Error('live_profile_unavailable');
        await mkdir(local.stateDir, { recursive: true, mode: 0o700 });
        const ws = this.o.workspace ? await this.o.workspace(local, r.spec)
            : await ensureWorkspace(local, { session: { id: r.spec.sessionId }, profile: { name: r.spec.profile } }).then(w => ({ cwd: w.cwd, branch: w.branch }));
        const dir = join(local.stateDir, `live-${r.spec.sessionId.slice(-10)}`);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const mcpFile = join(dir, 'mcp.json'), settingsFile = join(dir, 'settings.json');
        r.hookPath = join(this.runtimeDir, `live-${r.spec.sessionId.slice(-10)}.sock`);
        // The MCP server in channel mode: pushes arrive as Channel events. The subscription default (--auth subscription)
        // lets only the owner instruct the session; an API-key profile also lets directors.
        const server = { command: config.mcp.executable, args: [config.mcp.entrypoint, '--channel-mode', '--auth', local.auth === 'api_key' ? 'api_key' : 'subscription'] };
        await writeFile(mcpFile, JSON.stringify({ mcpServers: { agora: server } }), { mode: 0o600 });
        await writeFile(settingsFile, JSON.stringify(hookSettings(this.o.hookCommand)), { mode: 0o600 });
        const env: NodeJS.ProcessEnv = { ...childEnv(local), AGORA_INSTANCE: config.instance, AGORA_BOT_TOKEN: token, AGORA_DEFAULT_CHANNEL: r.spec.channelId,
            AGORA_LIVE_HOOK_SOCK: r.hookPath, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
        await repoFreePath(env, [ws.cwd, local.workdir]);
        const box = inBox() ? BOX_ADAPTERS.claude : null;
        const resume = r.confirmed || r.fastFailures % 2 === 1;
        const conversation = r.spec.conversation;
        const command = [local.executable,
            ...(box ? [...box.yeet.args, ...box.yeet.noOpenWeb, ...box.quiet.args] : []),
            '--strict-mcp-config', '--mcp-config', mcpFile, '--settings', settingsFile,
            '--dangerously-load-development-channels', 'server:agora',
            ...(r.spec.model ? ['--model', r.spec.model] : []),
            ...(r.spec.effort ? ['--effort', r.spec.effort] : []),
            ...(conversation ? [resume ? '--resume' : '--session-id', conversation] : [])];
        return { command, env, cwd: ws.cwd, branchCwd: ws.cwd };
    }

    private async launch(r: LiveRun): Promise<void> {
        if (!r.wanted) return;
        try {
            r.plan = await this.plan(r);
            if (this.o.hookSocket !== false) await this.listenForHooks(r);
        } catch (err) {
            this.o.log(`live_start_failed ${(err as Error)?.message?.replace(/[^A-Za-z0-9_ ]/g, '').slice(0, 60)}`);
            this.setState(r, 'stopped', 'exited');
            this.scheduleRestart(r);
            return;
        }
        this.setState(r, r.restarts > 0 ? 'restarting' : 'starting', null);
        r.startedAt = Date.now();
        const plan = r.plan!;
        const pty = this.spawnPty({ cols: r.spec.cols, rows: r.spec.rows, cwd: plan.cwd, env: plan.env, command: plan.command });
        r.pty = pty;
        pty.onData(d => {
            r.ring.push(Buffer.from(d));
            this.send('live:output', { sessionId: r.spec.sessionId, data: Buffer.from(d) });
        });
        pty.onError(code => this.o.log(`live_pty_error ${code}`));
        pty.onExit(code => {
            if (r.pty !== pty) return;
            r.pty = null;
            r.startupTimer?.cancel();
            if (r.hookServer) { r.hookServer.close(); r.hookServer = null; }
            if (!r.wanted) return;
            this.send('live:exited', { sessionId: r.spec.sessionId, code });
            r.fastFailures = Date.now() - r.startedAt < 10_000 ? r.fastFailures + 1 : 0;
            r.turnOpen = false;
            this.setState(r, 'restarting', 'exited');
            this.scheduleRestart(r);
        });
        // A startup dialog (development-channel warning, trust folder, an update prompt) keeps the CLI from
        // reaching its first hook: nothing is typed for the owner; the session says it is waiting on them
        r.confirmedThisRun = false;
        r.startupTimer = this.timer(() => { if (r.wanted && !r.confirmedThisRun) this.setState(r, 'waiting', 'no_signal'); }, this.o.startupMs ?? STARTUP_MS);
    }

    private scheduleRestart(r: LiveRun): void {
        if (!r.wanted) return;
        const table = this.o.backoff ?? RESTART_BACKOFF;
        const delay = table[Math.min(r.restarts, table.length - 1)];
        r.restarts++;
        r.restartTimer = this.timer(() => { r.restartTimer = null; void this.launch(r); }, delay);
    }

    // ─── Hooks ───

    private async listenForHooks(r: LiveRun): Promise<void> {
        if (r.hookServer) return;
        await unlink(r.hookPath).catch(() => {});
        const server = createServer(conn => {
            let buf = '';
            conn.setEncoding('utf8');
            conn.on('data', d => {
                buf += d;
                if (buf.length > 128 * 1024) { conn.destroy(); return; }
                const nl = buf.indexOf('\n');
                if (nl < 0) return;
                const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
                try { const m = JSON.parse(line); void this.onHook(r, m?.event, m?.payload).catch(() => {}); } catch { /* not ours */ }
                conn.end();
            });
            conn.on('error', () => {});
        });
        await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(r.hookPath, () => res()); });
        await chmod(r.hookPath, 0o600).catch(() => {});
        r.hookServer = server;
    }

    /** A hook event for a session, as the hook socket delivers it (tests call this directly). */
    async hook(sessionId: string, event: unknown, payload: unknown): Promise<void> {
        const r = this.runs.get(sessionId);
        if (r) await this.onHook(r, event, payload);
    }

    /** One hook event from the CLI. The CLI is the agent's own program: this is its report, not proof. */
    private async onHook(r: LiveRun, event: unknown, payload: any): Promise<void> {
        if (!HOOK_EVENTS.includes(event as HookEvent)) return;
        const id = r.spec.sessionId;
        switch (event as HookEvent) {
            case 'SessionStart':
                r.confirmed = true; r.confirmedThisRun = true; r.fastFailures = 0; r.restarts = 0;
                r.startupTimer?.cancel();
                await this.rememberConfirmed(r);
                if (!r.turnOpen) this.setState(r, 'idle', null);
                break;
            case 'UserPromptSubmit': {
                r.confirmedThisRun = true;
                r.startupTimer?.cancel();
                // A prompt that arrived as an Agora Channel push names its message; anything else was typed
                const messageId = channelMessageId(payload?.prompt);
                if (r.turnOpen) await this.endTurn(r, 'interrupted');
                r.turnOpen = true;
                this.setState(r, 'working', null);
                const head = await (this.o.readHead ?? defaultReadHead)(r.plan!.branchCwd).catch(() => ({ branch: null, sha: null }));
                this.send('live:turn', { sessionId: id, phase: 'start', messageId, source: messageId ? 'message' : 'typed', branch: head.branch, sha: head.sha });
                break;
            }
            case 'PreToolUse':
                if (r.state === 'waiting') this.setState(r, 'working', null);
                break;
            case 'Notification':
                // Only a dialog that needs the owner counts; the idle reminder does not
                if (payload?.notification_type === 'permission_prompt' || payload?.notification_type === 'elicitation_dialog') this.setState(r, 'waiting', 'notification');
                break;
            case 'Stop':
                await this.endTurn(r, 'stop_hook');
                this.setState(r, 'idle', null);
                break;
            case 'SessionEnd':
                break;
        }
    }

    private async endTurn(r: LiveRun, signal: 'stop_hook' | 'interrupted'): Promise<void> {
        if (!r.turnOpen) return;
        r.turnOpen = false;
        const head = await (this.o.readHead ?? defaultReadHead)(r.plan!.branchCwd).catch(() => ({ branch: null, sha: null }));
        this.send('live:turn', { sessionId: r.spec.sessionId, phase: 'end', signal, branch: head.branch, sha: head.sha });
    }

    // A restart resumes the conversation only if it ever started: remembered in the state directory, beside the session's files
    private async rememberConfirmed(r: LiveRun): Promise<void> {
        const local = this.o.config.profiles[r.spec.profile];
        if (!local) return;
        await writeFile(join(local.stateDir, `live-${r.spec.sessionId.slice(-10)}`, 'started'), '1', { mode: 0o600 }).catch(() => {});
    }
    async loadConfirmed(spec: LiveSpec): Promise<boolean> {
        const local = this.o.config.profiles[spec.profile];
        if (!local) return false;
        return (await readFile(join(local.stateDir, `live-${spec.sessionId.slice(-10)}`, 'started'), 'utf8').catch(() => '')) === '1';
    }
}

// ─── The connection to Agora ───

export interface LiveLoopOptions {
    /** Agora as the box sees it (the edge) */
    instance: string;
    /** The host token; held in memory */
    token: string;
    config: Config;
    signal: AbortSignal;
    log(code: string): void;
    connect?: (url: string, auth: Record<string, unknown>) => Socket;
    manager?: LiveManager;
    retryMinMs?: number;
    retryMaxMs?: number;
}

/**
 * Keep a socket to Agora's gateway as this box's live-terminal host, and serve sessions on it. Box mode
 * only. A server that doesn't know live terminals refuses the handshake: the loop retries slowly and
 * the per-wake runs, which this has nothing to do with, go on unaffected. Sessions keep running while
 * the connection is down; they are re-announced when it comes back.
 */
export async function liveLoop(o: LiveLoopOptions): Promise<void> {
    if (!inBox()) return;
    const connect = o.connect ?? ((url, auth) => io(url, { transports: ['websocket'], auth, reconnection: false, forceNew: true, timeout: 15000 }));
    const manager = o.manager ?? new LiveManager({ config: o.config, log: o.log });
    const origin = new URL(o.instance).origin;
    let delay = o.retryMinMs ?? 5000;
    let lastCode = '';
    while (!o.signal.aborted) {
        const socket = connect(origin, { type: 'live', token: o.token, liveProtocol: LIVE_PROTOCOL });
        const outcome = await new Promise<'lost' | 'refused'>(resolve => {
            let connected = false;
            const abort = () => { socket.disconnect(); resolve('lost'); };
            o.signal.addEventListener('abort', abort, { once: true });
            socket.on('connect', () => { connected = true; delay = o.retryMinMs ?? 5000; lastCode = ''; o.log('live_connected'); manager.attach(socket as unknown as LiveTransport); });
            socket.on('connect_error', (err: Error) => {
                const code = /^[A-Za-z0-9_ ]{1,60}$/.test(err.message) ? err.message.toLowerCase().replace(/ /g, '_') : 'connect_failed';
                if (code !== lastCode) { lastCode = code; o.log(`live_unavailable ${code}`); }
                socket.disconnect(); resolve('refused');
            });
            socket.on('disconnect', () => resolve(connected ? 'lost' : 'refused'));
        });
        manager.detach();
        socket.disconnect();
        if (o.signal.aborted) break;
        await new Promise<void>(r => { const t = setTimeout(r, delay); o.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
        delay = lastCode === 'host_already_connected' ? (o.retryMinMs ?? 5000) : outcome === 'refused' ? Math.min(delay * 2, o.retryMaxMs ?? 5 * 60 * 1000) : (o.retryMinMs ?? 5000);
    }
    await manager.stopAll();
}
