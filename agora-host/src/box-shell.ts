import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { io, type Socket } from 'socket.io-client';
import type { Config, LocalProfile } from './config.js';
import { childEnv } from './adapters.js';
import { BOX_HOME, inBox, scratchDir } from './box.js';
import { errorCode } from './client.js';

/**
 * The terminal in a box, box side (docs/box-terminal.md). Agora asks over a socket, the owner's
 * browser types, and this host starts a shell in a pseudo-terminal inside the box and relays
 * bytes: nothing more. What the shell says is never read, logged or stored here.
 *
 * Boxes only. On a machine agora-host refuses to open a terminal at all: that would be a shell
 * on the owner's own computer, started from a web page. (Allowing it would need an explicit
 * opt-in in the machine's own host config that the server can never switch on.)
 *
 * The shell is the box user's, in the box user's home folder (not the agent's worktree: the owner
 * chooses to `cd` there), with the environment the agent's CLI gets (childEnv: an allowlist, the
 * CLI's state directory, the proxy variables), so `claude`, `codex` and the rest run in it and are
 * logged in as the agent. The image's root-owned CLI directory comes first on its PATH. It does not
 * get the host or bot token: they reach this process by the config file and are not in anyone's
 * environment (an agent that runs on an API key has that provider key there, as its own runs do).
 * The shell shares the box with an autonomous agent that runs as the same user: see docs/box-terminal.md.
 */

/** The terminal protocol this host speaks; the server's SHELL_PROTOCOL is the same number. */
export const SHELL_PROTOCOL = 1;
/** The helper that owns the pseudo-terminal (box/agora-pty, a Python script in the image). */
export const PTY_HELPER = '/opt/agora/agora-pty';
const OUTPUT_CHUNK = 16 * 1024;
const MAX_OUTPUT_BACKLOG = 512 * 1024;
const RESUME_BELOW = 128 * 1024;

/** A running pseudo-terminal: what the relay needs of it, so tests can use a fake shell. */
export interface PtyChild {
    write(data: Buffer): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    /** Stop reading the shell's output (its writes then block: the natural brake for a flood) */
    pause(): void;
    resume(): void;
    onData(cb: (data: Buffer) => void): void;
    onExit(cb: (code: number | null) => void): void;
    onError(cb: (code: string) => void): void;
}
export interface PtyOptions { cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv; command: string[] }
export type SpawnPty = (o: PtyOptions) => PtyChild;

/** What the relay needs of the socket to Agora. */
export interface ShellTransport {
    emit(event: string, payload: unknown): void;
    on(event: string, handler: (payload: any) => void): void;
}

export interface RelayOptions {
    spawnPty: SpawnPty;
    /** The shell's environment and folder, from the profile (shellSpec) */
    spec: () => { env: NodeJS.ProcessEnv; cwd: string; command: string[] };
    log(code: string): void;
    now?(): number;
    setTimer?(fn: () => void, ms: number): { cancel(): void };
}

const defaultTimer = (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; };

/**
 * One terminal at a time. Output is paced to the rate Agora names when it asks for the shell
 * (the owner's limit): the shell is paused while a backlog waits, so `cat bigfile` just takes
 * longer, and Ctrl-C still reaches it. Agora closes a terminal whose host ignores the pace.
 */
export class ShellRelay {
    private current: { id: string; pty: PtyChild; ended: boolean } | null = null;
    private queue: Buffer[] = [];
    private queued = 0;
    private tokens = 0;
    private rate = 0;
    private lastRefill = 0;
    private timer: { cancel(): void } | null = null;
    private paused = false;
    private readonly now: () => number;
    private readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };

    constructor(private transport: ShellTransport, private o: RelayOptions) {
        this.now = o.now ?? Date.now;
        this.setTimer = o.setTimer ?? defaultTimer;
        transport.on('shell:open', m => this.open(m));
        transport.on('shell:input', m => { if (this.mine(m?.sessionId) && m.data instanceof Uint8Array) this.current!.pty.write(Buffer.from(m.data)); });
        transport.on('shell:resize', m => {
            if (!this.mine(m?.sessionId)) return;
            if (Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols >= 1 && m.cols <= 500 && m.rows >= 1 && m.rows <= 200) this.current!.pty.resize(m.cols, m.rows);
        });
        transport.on('shell:close', m => { if (this.mine(m?.sessionId)) this.end(false); });
    }

    private mine(id: unknown): boolean { return !!this.current && !this.current.ended && typeof id === 'string' && id === this.current.id; }

    /** Is a shell running? */
    get active(): boolean { return !!this.current && !this.current.ended; }

    /** Agora asked for a shell. */
    private open(m: { sessionId?: unknown; cols?: unknown; rows?: unknown; rateBytesPerSecond?: unknown }): void {
        const id = typeof m?.sessionId === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(m.sessionId) ? m.sessionId : null;
        if (!id) return;
        const fail = (code: string) => { this.o.log(`box_shell_failed ${code}`); this.transport.emit('shell:failed', { sessionId: id, error: code }); };
        // One terminal per box; Agora enforces it too
        if (this.active) return fail('busy');
        const cols = m.cols, rows = m.rows, rate = m.rateBytesPerSecond;
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 1 || (cols as number) > 500 || (rows as number) < 1 || (rows as number) > 200) return fail('bad_size');
        if (!Number.isInteger(rate) || (rate as number) < 1024 || (rate as number) > 64 * 1024 * 1024) return fail('bad_rate');
        let pty: PtyChild;
        try {
            const spec = this.o.spec();
            pty = this.o.spawnPty({ cols: cols as number, rows: rows as number, cwd: spec.cwd, env: spec.env, command: spec.command });
        } catch (err) { return fail(`spawn_failed_${errorCode(err)}`); }
        this.current = { id, pty, ended: false };
        this.queue = []; this.queued = 0; this.paused = false;
        this.rate = rate as number; this.tokens = this.rate; this.lastRefill = this.now();
        pty.onData(data => this.output(data));
        pty.onError(code => { if (this.current?.pty === pty) { this.o.log(`box_shell_failed ${code}`); this.end(true, 'failed'); } });
        pty.onExit(() => { if (this.current?.pty === pty) this.end(true); });
        this.o.log('box_shell_opened');
        this.transport.emit('shell:opened', { sessionId: id });
    }

    private output(data: Buffer): void {
        if (!this.active) return;
        this.queue.push(data); this.queued += data.length;
        if (this.queued > MAX_OUTPUT_BACKLOG && !this.paused) { this.paused = true; this.current!.pty.pause(); }
        this.pump();
    }

    /** Send what the pace allows; wait for the rest. */
    private pump(): void {
        if (!this.active) return;
        if (this.timer) { this.timer.cancel(); this.timer = null; }
        const t = this.now();
        this.tokens = Math.min(this.rate, this.tokens + ((t - this.lastRefill) / 1000) * this.rate);
        this.lastRefill = t;
        while (this.queued > 0 && this.tokens >= 1) {
            const head = this.queue[0];
            const take = Math.min(head.length, OUTPUT_CHUNK, Math.floor(this.tokens));
            const chunk = take === head.length ? this.queue.shift()! : head.subarray(0, take);
            if (take !== head.length) this.queue[0] = head.subarray(take);
            this.queued -= chunk.length; this.tokens -= chunk.length;
            this.transport.emit('shell:output', { sessionId: this.current!.id, data: chunk });
        }
        if (this.paused && this.queued < RESUME_BELOW) { this.paused = false; this.current!.pty.resume(); }
        // The rate is at least 1 KiB/s, so 20 ms always earns a byte
        if (this.queued > 0) this.timer = this.setTimer(() => this.pump(), 20);
    }

    /** The shell ended (it exited, or Agora asked): kill what is left, say so if Agora didn't ask. */
    private end(announce: boolean, outcome: 'exited' | 'failed' = 'exited'): void {
        const cur = this.current;
        if (!cur || cur.ended) return;
        cur.ended = true;
        if (this.timer) { this.timer.cancel(); this.timer = null; }
        this.queue = []; this.queued = 0;
        try { cur.pty.kill(); } catch { /* already gone */ }
        this.current = null;
        if (announce) this.transport.emit(outcome === 'exited' ? 'shell:exited' : 'shell:failed', { sessionId: cur.id });
        this.o.log('box_shell_closed');
    }

    /** The connection to Agora dropped: nobody can see or stop this shell any more. */
    closeAll(): void { this.end(false); }
}

// ─── The real pseudo-terminal: box/agora-pty ───

/** Start `agora-pty` (Python's pty module) with the control pipe on fd 3. The path is the image's; tests pass the repo's copy. */
export const makeHelperPty = (helper: string): SpawnPty => o => {
    const child: ChildProcess = spawn('python3', [helper, String(o.cols), String(o.rows), o.cwd, '--', ...o.command], {
        cwd: o.cwd, env: o.env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const dataCbs: Array<(d: Buffer) => void> = [], exitCbs: Array<(c: number | null) => void> = [], errCbs: Array<(c: string) => void> = [];
    let exited = false;
    child.stdout!.on('data', (d: Buffer) => { for (const cb of dataCbs) cb(d); });
    // The helper writes a fixed error code to stderr if it can't start (never what the shell said)
    let errText = '';
    child.stderr!.on('data', (d: Buffer) => { if (errText.length < 64) errText += d.toString('utf8').slice(0, 64); });
    child.stdin!.on('error', () => {});
    (child.stdio[3] as NodeJS.WritableStream).on('error', () => {});
    child.once('error', () => { for (const cb of errCbs) cb('helper_spawn_failed'); });
    child.once('close', code => {
        exited = true;
        const known = /^(bad_arguments|pty_failed)\s*$/m.exec(errText);
        if (known) for (const cb of errCbs) cb(known[1]);
        for (const cb of exitCbs) cb(code);
    });
    const stdout = child.stdout!;
    return {
        write: d => { if (!exited) child.stdin!.write(d); },
        resize: (c, r) => { if (!exited) (child.stdio[3] as NodeJS.WritableStream).write(`R ${c} ${r}\n`); },
        kill: () => {
            if (exited) return;
            // Closing the helper's stdin hangs the shell up; the signal is for a helper stuck before that
            try { child.stdin!.end(); } catch { /* closed */ }
            try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
            setTimeout(() => { if (!exited) { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } } }, 3000).unref();
        },
        pause: () => stdout.pause(),
        resume: () => stdout.resume(),
        onData: cb => { dataCbs.push(cb); },
        onExit: cb => { exitCbs.push(cb); },
        onError: cb => { errCbs.push(cb); },
    };
};
export const spawnHelperPty: SpawnPty = makeHelperPty(PTY_HELPER);

/**
 * The shell and where it starts, for this box's one profile: bash, interactive, in the box user's
 * home folder (neutral ground: the agent's worktree can hold hooks and files the agent wrote), with
 * the same environment the agent's CLI gets plus a terminal type. One line on open says where the
 * agent's workspace is. `/opt/agora/bin` (root-owned: the image's own claude, codex ...) is FIRST on
 * the PATH, ahead of the agent-writable ~/.npm-global/bin and ~/.local/bin, so a name the agent
 * could shadow resolves to the image's copy. Only this shell's environment changes; the agent's
 * own runs resolve tools as before.
 */
export function shellSpec(config: Config, source: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync) {
    const local: LocalProfile = Object.values(config.profiles)[0]!;
    const env = childEnv(local, source);
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.LANG = source.LANG && /^[A-Za-z0-9_.@-]{1,40}$/.test(source.LANG) ? source.LANG : 'C.UTF-8';
    env.SHELL = '/bin/bash';
    env.HOME ??= BOX_HOME;
    // The image's CLI links (claude, codex, devin ...) are in /opt/agora/bin, which only root can write
    if (inBox(source)) env.PATH = ['/opt/agora/bin', ...(env.PATH ?? '').split(':').filter(p => p && p !== '/opt/agora/bin')].join(':');
    const workspace = [local.workdir, scratchDir(env.HOME)].find(p => exists(p)) ?? env.HOME;
    env.AGORA_WORKSPACE = workspace;
    const cwd = exists(env.HOME) ? env.HOME : '/';
    // Non-login: a login shell's /etc/profile would replace the PATH the image set (npm and pip installs live in the home folder)
    const banner = 'printf \'\\033[33magora: this shell is in the same box, as the same user, as the agent. The agent workspace is %s (you start in your home folder; cd there on purpose).\\033[0m\\n\' "$AGORA_WORKSPACE"; exec /bin/bash -i';
    return { env, cwd, command: ['/bin/bash', '-c', banner] };
}

// ─── The connection to Agora ───

export interface ShellLoopOptions {
    signal: AbortSignal;
    log(code: string): void;
    /** For tests: the socket factory, the relay's shell and the delays */
    connect?: (url: string, auth: Record<string, unknown>) => Socket;
    spawnPty?: SpawnPty;
    retryMinMs?: number;
    retryMaxMs?: number;
}

/**
 * Keep a socket to Agora's gateway (through the edge) as this box's host, and serve terminals on it.
 * Box mode only. A server that doesn't know terminals just refuses the handshake: the loop retries
 * slowly and the runs go on unaffected.
 */
export async function boxShellLoop(config: Config, o: ShellLoopOptions): Promise<void> {
    if (!inBox() || Object.keys(config.profiles).length !== 1) return;
    const connect = o.connect ?? ((url, auth) => io(url, { transports: ['websocket'], auth, reconnection: false, forceNew: true, timeout: 15000 }));
    const origin = new URL(config.instance).origin;
    let delay = o.retryMinMs ?? 5000;
    let lastCode = '';
    while (!o.signal.aborted) {
        const socket = connect(origin, { type: 'host', token: config.hostToken, shellProtocol: SHELL_PROTOCOL });
        const relay = new ShellRelay(socket, { spawnPty: o.spawnPty ?? spawnHelperPty, spec: () => shellSpec(config), log: o.log });
        const outcome = await new Promise<'connected-then-lost' | 'refused'>(resolve => {
            let connected = false;
            const abort = () => { socket.disconnect(); resolve('connected-then-lost'); };
            o.signal.addEventListener('abort', abort, { once: true });
            socket.on('connect', () => { connected = true; delay = o.retryMinMs ?? 5000; lastCode = ''; o.log('box_shell_connected'); });
            socket.on('connect_error', (err: Error) => {
                // The server's own fixed codes (Invalid host token, unsupported_protocol ...); logged once per change
                const code = /^[A-Za-z0-9_ ]{1,60}$/.test(err.message) ? err.message.toLowerCase().replace(/ /g, '_') : 'connect_failed';
                if (code !== lastCode) { lastCode = code; o.log(`box_shell_unavailable ${code}`); }
                socket.disconnect(); resolve('refused');
            });
            socket.on('disconnect', () => resolve(connected ? 'connected-then-lost' : 'refused'));
        });
        relay.closeAll();
        socket.disconnect();
        if (o.signal.aborted) return;
        await new Promise<void>(r => { const t = setTimeout(r, delay); o.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
        // A second-socket refusal means the server still holds the old socket (until its ping timeout): try again soon, not after a long backoff
        delay = lastCode === 'host_already_connected' ? (o.retryMinMs ?? 5000)
            : outcome === 'refused' ? Math.min(delay * 2, o.retryMaxMs ?? 5 * 60 * 1000) : (o.retryMinMs ?? 5000);
    }
}
