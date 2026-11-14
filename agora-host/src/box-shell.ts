import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, readFileSync } from 'node:fs';
import { io, type Socket } from 'socket.io-client';
import { inBox, proxyVars } from './box.js';
import { errorCode } from './client.js';
import { HostConfigError } from './terms.js';

/**
 * The owner's terminal in a box, box side (docs/box-terminal.md). Agora asks over a socket, the
 * owner's browser types, and this relay starts a shell in a pseudo-terminal inside the box and
 * relays bytes: nothing more. What the shell says is never read, logged or stored here.
 *
 * This is NOT part of the agent's agora-host. It runs as its own process (`agora-host box-relay`)
 * of its own Unix user, the operator (uid 1001), started by the box's init with a credential that
 * only it holds. The agent (uid 1000) cannot read that credential, signal this process, trace it,
 * read its memory or its environment, or reach the shell's terminal. The shell is the operator's:
 * it has no host token, bot token or provider key and none of the agent's files in its environment,
 * and its PATH is root-owned directories only. To act as the agent it uses `as-agent`.
 *
 * Boxes only. On a machine nothing here runs at all: that would be a shell on the owner's own
 * computer, started from a web page.
 */

/** The terminal protocol this relay speaks; the server's SHELL_PROTOCOL is the same number. */
export const SHELL_PROTOCOL = 2;
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
    /** Which side the owner is typing on, as the helper sees it (it says so about once a second) */
    onSide(cb: (side: 'operator' | 'agent') => void): void;
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
    /** The shell's environment and folder (operatorShellSpec) */
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
        // Which side the owner types on, from the one fact the agent cannot fake (see box/agora-pty). Anything
        // but a plain "operator" is reported as the agent's side. Agora relays it to the owner's page only.
        pty.onSide(side => { if (this.current?.pty === pty) this.transport.emit('shell:side', { sessionId: id, side: side === 'operator' ? 'operator' : 'agent' }); });
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
export const PYTHON = '/usr/bin/python3';
export const AS_AGENT_CLIENT = '/usr/local/bin/as-agent';
export const makeHelperPty = (helper: string, client: string = AS_AGENT_CLIENT): SpawnPty => o => {
    // Absolute interpreter in isolated mode: nothing from PATH, PYTHON* or the current directory is loaded
    const child: ChildProcess = spawn(PYTHON, ['-I', helper, '--client', client, String(o.cols), String(o.rows), o.cwd, '--', ...o.command], {
        cwd: o.cwd, env: o.env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    const sideCbs: Array<(s: 'operator' | 'agent') => void> = [];
    let sideText = '';
    const sideStream = child.stdio[4] as NodeJS.ReadableStream;
    sideStream.on('error', () => {});
    sideStream.on('data', (d: Buffer) => {
        sideText = (sideText + d.toString('latin1')).slice(-256);
        let nl: number;
        while ((nl = sideText.indexOf('\n')) >= 0) {
            const line = sideText.slice(0, nl);
            sideText = sideText.slice(nl + 1);
            if (line === 'S operator') for (const cb of sideCbs) cb('operator');
            else if (line === 'S agent') for (const cb of sideCbs) cb('agent');
        }
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
        onSide: cb => { sideCbs.push(cb); },
    };
};
export const spawnHelperPty: SpawnPty = makeHelperPty(PTY_HELPER);

/** Where the operator's shell gets its startup file and git configuration: root-owned files of the image. */
export const OPERATOR_RC = '/opt/agora/operator.bashrc';
export const OPERATOR_GITCONFIG = '/opt/agora/operator.gitconfig';
/** The operator's account (box/Dockerfile, boxd's tmpfs). */
export const OPERATOR_HOME = '/home/operator';
export const OPERATOR_UID = 1001;
/** Root-owned directories only: nothing the agent can write is on it, and no `.`. */
export const OPERATOR_PATH = '/opt/agora/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * The owner's shell in the box: bash, interactive, as the operator user, in the operator's home.
 * Built from nothing but fixed values, a terminal type and the proxy variables, so the shell has
 * no token, no provider key and nothing from the agent's environment. PATH is root-owned
 * directories only. bash reads the image's root-owned rc file (`--rcfile`, which prints the
 * banner) and no file of any home; git reads the image's root-owned config only, with hooks and
 * fsmonitor off and no `safe.directory`, so it refuses the agent's repositories.
 */
export function operatorShellSpec(source: NodeJS.ProcessEnv = process.env, home = OPERATOR_HOME) {
    const env: NodeJS.ProcessEnv = {
        HOME: home, USER: 'operator', LOGNAME: 'operator', SHELL: '/bin/bash', PATH: OPERATOR_PATH,
        TERM: 'xterm-256color', COLORTERM: 'truecolor',
        LANG: source.LANG && /^[A-Za-z0-9_.@-]{1,40}$/.test(source.LANG) ? source.LANG : 'C.UTF-8',
        GIT_CONFIG_GLOBAL: OPERATOR_GITCONFIG, GIT_CONFIG_NOSYSTEM: '1', NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        ...proxyVars(source),
    };
    return { env, cwd: home, command: ['/bin/bash', '--noprofile', '--rcfile', OPERATOR_RC, '-i'] };
}

// ─── The connection to Agora ───

export interface RelayLoopOptions {
    /** Agora as the box sees it (the edge): http://edge:8080 */
    instance: string;
    /** The relay credential (ar_<hostId>.<secret>); held in memory only */
    token: string;
    signal: AbortSignal;
    log(code: string): void;
    /** For tests: the socket factory, the shell and the delays */
    connect?: (url: string, auth: Record<string, unknown>) => Socket;
    spawnPty?: SpawnPty;
    retryMinMs?: number;
    retryMaxMs?: number;
}

/**
 * Keep a socket to Agora's gateway (through the edge) as this box's terminal relay, and serve
 * terminals on it. Box mode only. A server that doesn't know terminals just refuses the
 * handshake: the loop retries slowly and the agent's runs, which this process has nothing to do
 * with, go on unaffected.
 */
export async function boxRelayLoop(o: RelayLoopOptions): Promise<void> {
    if (!inBox()) return;
    const connect = o.connect ?? ((url, auth) => io(url, { transports: ['websocket'], auth, reconnection: false, forceNew: true, timeout: 15000 }));
    const origin = new URL(o.instance).origin;
    let delay = o.retryMinMs ?? 5000;
    let lastCode = '';
    while (!o.signal.aborted) {
        const socket = connect(origin, { type: 'relay', token: o.token, shellProtocol: SHELL_PROTOCOL });
        const relay = new ShellRelay(socket, { spawnPty: o.spawnPty ?? spawnHelperPty, spec: () => operatorShellSpec(), log: o.log });
        const outcome = await new Promise<'connected-then-lost' | 'refused'>(resolve => {
            let connected = false;
            const abort = () => { socket.disconnect(); resolve('connected-then-lost'); };
            o.signal.addEventListener('abort', abort, { once: true });
            socket.on('connect', () => { connected = true; delay = o.retryMinMs ?? 5000; lastCode = ''; o.log('box_shell_connected'); });
            socket.on('connect_error', (err: Error) => {
                // The server's own fixed codes (Invalid relay token, unsupported_protocol ...); logged once per change
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

/** The relay credential, read once from the descriptor the box's init gave this process alone. */
export function readRelayToken(fd: number): string {
    let text = '';
    try { text = readFileSync(fd, 'utf8').trim(); } finally { try { closeSync(fd); } catch { /* already closed */ } }
    if (!/^ar_[0-9A-HJKMNP-TV-Z]{26}\.[0-9a-f]{64}$/.test(text)) throw new HostConfigError('The relay credential is missing or malformed');
    return text;
}

/**
 * agora-host box-relay --token-fd <n>: the owner's terminal relay (docs/box-terminal.md), run by
 * the box's init as the operator user. It reads no config file and never sees the host token, the
 * bot token or a provider key: the instance address from the environment, the credential from a pipe.
 * Refuses to run as the agent's user, as root, or outside a box.
 */
export async function boxRelayCommand(args: string[], env: NodeJS.ProcessEnv = process.env, o: { uid?: number; signal?: AbortSignal; log?: (c: string) => void; loop?: typeof boxRelayLoop } = {}): Promise<number> {
    const log = o.log ?? (code => console.error(code));
    const uid = o.uid ?? (process.getuid ? process.getuid() : -1);
    if (uid !== OPERATOR_UID) { console.error('box-relay must run as the operator user'); return 2; }
    if (!inBox(env)) { console.error('box-relay runs only in an agent box'); return 2; }
    const i = args.indexOf('--token-fd');
    const fd = i >= 0 ? Number(args[i + 1]) : NaN;
    if (!Number.isInteger(fd) || fd < 3 || fd > 255) { console.error('Usage: agora-host box-relay --token-fd <fd>'); return 2; }
    let token: string;
    try { token = readRelayToken(fd); } catch (err) {
        console.error(err instanceof HostConfigError ? err.message : 'box_relay_token_unreadable');
        return 2;
    }
    const instance = env.AGORA_INSTANCE_URL?.trim();
    if (!instance || !/^https?:\/\//.test(instance)) { console.error('AGORA_INSTANCE_URL is not set'); return 2; }
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    const signal = o.signal ?? ctl.signal;
    await (o.loop ?? boxRelayLoop)({ instance, token, signal, log });
    return 0;
}
