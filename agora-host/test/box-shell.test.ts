import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ShellRelay, boxRelayCommand, boxRelayLoop, makeHelperPty, operatorShellSpec, readRelayToken, type PtyChild, type PtyOptions, type ShellTransport } from '../src/box-shell.js';
import { boxMode } from '../src/box.js';
import { config, tempDir } from './helpers.js';

const SID = '01J00000000000000000000001';
const TOKEN = `ar_${'0'.repeat(26)}.${'a'.repeat(64)}`;
const HELPER = fileURLToPath(new URL('../../box/agora-pty', import.meta.url));
const unix = process.platform !== 'win32';
const hasPython = unix && spawnSync('/usr/bin/python3', ['-I', '-c', 'import pty, termios']).status === 0;

/** The server's side of the socket: what the relay emits is recorded, what Agora sends is fired in. */
class FakeTransport implements ShellTransport {
    handlers = new Map<string, (p: any) => void>();
    emitted: Array<{ event: string; payload: any }> = [];
    emit(event: string, payload: unknown) { this.emitted.push({ event, payload }); }
    on(event: string, handler: (p: any) => void) { this.handlers.set(event, handler); }
    fire(event: string, payload: unknown) { this.handlers.get(event)?.(payload); }
    of(event: string) { return this.emitted.filter(e => e.event === event).map(e => e.payload); }
    outputBytes() { return this.of('shell:output').reduce((n, p) => n + p.data.length, 0); }
}

/** A shell that does nothing: records what it is told. */
class FakePty implements PtyChild {
    written: Buffer[] = []; sizes: Array<[number, number]> = []; killed = 0; paused = 0; resumed = 0;
    data: (d: Buffer) => void = () => {}; exit: (c: number | null) => void = () => {}; error: (c: string) => void = () => {};
    write(d: Buffer) { this.written.push(d); }
    resize(c: number, r: number) { this.sizes.push([c, r]); }
    kill() { this.killed++; }
    pause() { this.paused++; }
    resume() { this.resumed++; }
    onData(cb: (d: Buffer) => void) { this.data = cb; }
    onExit(cb: (c: number | null) => void) { this.exit = cb; }
    onError(cb: (c: string) => void) { this.error = cb; }
    side: (s: 'operator' | 'agent') => void = () => {};
    onSide(cb: (s: 'operator' | 'agent') => void) { this.side = cb; }
}

function setup(over: { now?: () => number; setTimer?: any; spawn?: (o: PtyOptions) => PtyChild } = {}) {
    const t = new FakeTransport();
    const ptys: FakePty[] = []; const opts: PtyOptions[] = []; const logs: string[] = [];
    const relay = new ShellRelay(t, {
        spawnPty: over.spawn ?? (o => { opts.push(o); const p = new FakePty(); ptys.push(p); return p; }),
        spec: () => ({ env: { TERM: 'xterm-256color' }, cwd: '/home/agent/work/o/r', command: ['/bin/bash', '-i'] }),
        log: c => logs.push(c), now: over.now, setTimer: over.setTimer,
    });
    const open = (extra: object = {}) => t.fire('shell:open', { sessionId: SID, cols: 100, rows: 30, rateBytesPerSecond: 512 * 1024, ...extra });
    return { t, relay, ptys, opts, logs, open };
}

describe('the side event (which side the owner types on)', () => {
    it('is sent to Agora as the helper reports it, with the session id, and anything odd counts as the agent side', () => {
        const { t, ptys, open } = setup();
        open();
        ptys[0].side('operator');
        ptys[0].side('agent');
        ptys[0].side('operator');
        ptys[0].side('Operator' as any);
        ptys[0].side(undefined as any);
        expect(t.of('shell:side')).toEqual([
            { sessionId: SID, side: 'operator' }, { sessionId: SID, side: 'agent' }, { sessionId: SID, side: 'operator' },
            { sessionId: SID, side: 'agent' }, { sessionId: SID, side: 'agent' },
        ]);
    });

    it('is not sent once the shell has ended', () => {
        const { t, ptys, open } = setup();
        open();
        const old = ptys[0];
        t.fire('shell:close', { sessionId: SID });
        old.side('operator');
        expect(t.of('shell:side')).toEqual([]);
    });
});

describe('the relay with a fake shell', () => {
    it('opens a shell at the size asked, in the profile\'s folder with its environment, and says so', () => {
        const { t, ptys, opts, open, relay, logs } = setup();
        open();
        expect(opts).toEqual([{ cols: 100, rows: 30, cwd: '/home/agent/work/o/r', env: { TERM: 'xterm-256color' }, command: ['/bin/bash', '-i'] }]);
        expect(t.of('shell:opened')).toEqual([{ sessionId: SID }]);
        expect(relay.active).toBe(true);
        expect(ptys).toHaveLength(1);
        // Codes only, never what the shell said
        expect(logs).toEqual(['box_shell_opened']);
    });

    it('passes input to the shell, output to Agora, and a resize to the terminal', () => {
        const { t, ptys, open } = setup();
        open();
        t.fire('shell:input', { sessionId: SID, data: Buffer.from('ls\r') });
        t.fire('shell:input', { sessionId: SID, data: new Uint8Array([3]) });
        expect(ptys[0].written.map(b => b.toString('hex'))).toEqual([Buffer.from('ls\r').toString('hex'), '03']);
        ptys[0].data(Buffer.from('file1\r\n'));
        expect(t.of('shell:output')).toEqual([{ sessionId: SID, data: Buffer.from('file1\r\n') }]);
        t.fire('shell:resize', { sessionId: SID, cols: 120, rows: 40 });
        expect(ptys[0].sizes).toEqual([[120, 40]]);
    });

    it('ignores another session\'s events, bad sizes and non-bytes', () => {
        const { t, ptys, open } = setup();
        open();
        t.fire('shell:input', { sessionId: '01J00000000000000000000002', data: Buffer.from('x') });
        t.fire('shell:input', { sessionId: SID, data: 'a string, not bytes' });
        t.fire('shell:resize', { sessionId: SID, cols: 0, rows: 30 });
        t.fire('shell:resize', { sessionId: SID, cols: 501, rows: 30 });
        t.fire('shell:resize', { sessionId: SID, cols: 80.5, rows: 30 });
        t.fire('shell:close', { sessionId: '01J00000000000000000000002' });
        expect(ptys[0].written).toHaveLength(0);
        expect(ptys[0].sizes).toHaveLength(0);
        expect(ptys[0].killed).toBe(0);
    });

    it('refuses a bad request and a second shell, and starts nothing', () => {
        const { t, ptys, open } = setup();
        open({ cols: 0 });
        open({ sessionId: 'nope' });
        open({ rateBytesPerSecond: 10 });
        expect(ptys).toHaveLength(0);
        expect(t.of('shell:failed')).toEqual([{ sessionId: SID, error: 'bad_size' }, { sessionId: SID, error: 'bad_rate' }]);
        open();
        t.fire('shell:open', { sessionId: '01J00000000000000000000002', cols: 80, rows: 24, rateBytesPerSecond: 65536 });
        expect(ptys).toHaveLength(1);
        expect(t.of('shell:failed').at(-1)).toEqual({ sessionId: '01J00000000000000000000002', error: 'busy' });
    });

    it('a shell that cannot start is reported, not thrown', () => {
        const { t, relay, open, logs } = setup({ spawn: () => { throw new Error('no python'); } });
        open();
        expect(t.of('shell:failed')).toHaveLength(1);
        expect(relay.active).toBe(false);
        expect(logs[0]).toMatch(/^box_shell_failed spawn_failed_/);
    });

    it('Agora closing it kills the shell and says nothing back; the shell exiting says so', () => {
        const a = setup();
        a.open();
        a.t.fire('shell:close', { sessionId: SID });
        expect(a.ptys[0].killed).toBe(1);
        expect(a.t.of('shell:exited')).toHaveLength(0);
        expect(a.relay.active).toBe(false);

        const b = setup();
        b.open();
        b.ptys[0].exit(0);
        expect(b.t.of('shell:exited')).toEqual([{ sessionId: SID }]);
        expect(b.ptys[0].killed).toBe(1);
        // And a new one can start afterwards
        b.open();
        expect(b.ptys).toHaveLength(2);
    });

    it('a helper that fails is reported as a failure', () => {
        const { t, ptys, open } = setup();
        open();
        ptys[0].error('pty_failed');
        expect(t.of('shell:failed')).toEqual([{ sessionId: SID }]);
        expect(ptys[0].killed).toBe(1);
    });

    it('the connection dropping kills the shell: nobody could see or stop it', () => {
        const { relay, ptys, open, t } = setup();
        open();
        relay.closeAll();
        expect(ptys[0].killed).toBe(1);
        expect(t.of('shell:exited')).toHaveLength(0);
    });
});

describe('output pacing (the owner\'s rate limit)', () => {
    it('sends no more than the rate allows, pauses the shell under a backlog and resumes it', () => {
        vi.useFakeTimers();
        try {
            let clock = 0;
            const timers: Array<{ at: number; fn: () => void }> = [];
            const { t, ptys, open } = setup({
                now: () => clock,
                setTimer: (fn: () => void, ms: number) => { const entry = { at: clock + ms, fn }; timers.push(entry); return { cancel: () => { entry.at = Infinity; } }; },
            });
            const rate = 64 * 1024;
            open({ rateBytesPerSecond: rate });
            const advance = (ms: number) => {
                const end = clock + ms;
                for (;;) {
                    const next = timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
                    if (!next) break;
                    timers.splice(timers.indexOf(next), 1);
                    clock = next.at; next.fn();
                }
                clock = end;
            };
            // A flood: 2 MiB in one go
            for (let i = 0; i < 128; i++) ptys[0].data(Buffer.alloc(16 * 1024, 65));
            expect(t.outputBytes()).toBeLessThanOrEqual(rate);
            expect(ptys[0].paused).toBe(1);
            advance(1000);
            expect(t.outputBytes()).toBeLessThanOrEqual(rate * 2 + 1);
            advance(3000);
            const after4s = t.outputBytes();
            expect(after4s).toBeGreaterThan(rate * 3);
            expect(after4s).toBeLessThanOrEqual(rate * 5 + 1);
            // Every chunk is small, so Ctrl-C input is never stuck behind a big write
            expect(Math.max(...t.of('shell:output').map(p => p.data.length))).toBeLessThanOrEqual(16 * 1024);
            advance(60_000);
            expect(t.outputBytes()).toBe(128 * 16 * 1024);
            expect(ptys[0].resumed).toBe(1);
        } finally { vi.useRealTimers(); }
    });
});

describe('the operator\'s shell: folder and environment', () => {
    it('is the operator\'s alone: its home, a fixed root-owned PATH, the image\'s rc and git files, the proxy, and nothing of the agent\'s environment', () => {
        const env = {
            PATH: '/home/agent/.npm-global/bin:/usr/bin', HOME: '/home/agent', LANG: 'en_US.UTF-8', CLAUDE_CONFIG_DIR: '/home/agent/.agora/state/x',
            AGORA_HOST_TOKEN: 'ah_secret.value', AGORA_BOT_TOKEN: 'bot_secret.value', AGORA_INSTANCE_URL: 'http://edge:8080', AGORA_RELAY_TOKEN: 'ar_secret.value',
            HTTPS_PROXY: 'http://edge:3128', NO_PROXY: 'edge', ANTHROPIC_API_KEY: 'sk-should-not-leak', GITHUB_TOKEN: 'ghp_nope', BASH_ENV: '/home/agent/evil', LD_PRELOAD: '/tmp/evil.so',
        };
        const spec = operatorShellSpec(env);
        expect(spec.cwd).toBe('/home/operator');
        // bash reads the image's root-owned rc file and no file of any home
        expect(spec.command).toEqual(['/bin/bash', '--noprofile', '--rcfile', '/opt/agora/operator.bashrc', '-i']);
        // Root-owned directories only: nothing the agent can write, no `.`, no empty entry
        expect(spec.env.PATH).toBe('/opt/agora/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
        expect(spec.env.PATH!.split(':').every(p => p.startsWith('/') && !p.startsWith('/home') && !p.startsWith('/tmp'))).toBe(true);
        expect(spec.env).toMatchObject({
            HOME: '/home/operator', USER: 'operator', TERM: 'xterm-256color', LANG: 'en_US.UTF-8', SHELL: '/bin/bash',
            HTTPS_PROXY: 'http://edge:3128', https_proxy: 'http://edge:3128', NO_PROXY: 'edge',
            // git reads the image's file only: hooks and fsmonitor off, no safe.directory
            GIT_CONFIG_GLOBAL: '/opt/agora/operator.gitconfig', GIT_CONFIG_NOSYSTEM: '1',
        });
        const all = JSON.stringify(spec.env);
        for (const secret of ['ah_secret', 'bot_secret', 'ar_secret', 'sk-should-not-leak', 'ghp_nope', 'AGORA_', 'CLAUDE_CONFIG_DIR', '/home/agent', 'BASH_ENV', 'LD_PRELOAD']) expect(all).not.toContain(secret);
    });

    it('the files it names are the image\'s and say what the design says', () => {
        const rc = readFileSync(fileURLToPath(new URL('../../box/operator.bashrc', import.meta.url)), 'utf8');
        expect(rc).toContain('as-agent');
        expect(rc).toContain('agent');
        expect(rc).not.toMatch(/^\s*(\.|source)\s/m);
        const git = readFileSync(fileURLToPath(new URL('../../box/operator.gitconfig', import.meta.url)), 'utf8');
        expect(git).toMatch(/hooksPath\s*=\s*\/dev\/null/);
        expect(git).toMatch(/fsmonitor\s*=\s*false/);
        expect(git).not.toMatch(/^\s*\[safe\]/m);
    });
});

describe('box-relay (the command)', () => {
    const saved = { marker: boxMode.marker };
    afterEach(() => { boxMode.marker = saved.marker; });
    const quiet = () => { const e = vi.spyOn(console, 'error').mockImplementation(() => {}); return () => e.mockRestore(); };

    it('refuses to run as the agent, as root, or outside a box, and starts nothing', async () => {
        const restore = quiet();
        try {
            const loop = vi.fn();
            const env = { AGORA_HOST_IN_BOX: '1', AGORA_INSTANCE_URL: 'http://edge:8080' };
            expect(await boxRelayCommand(['--token-fd', '3'], env, { uid: 1000, loop })).toBe(2);
            expect(await boxRelayCommand(['--token-fd', '3'], env, { uid: 0, loop })).toBe(2);
            boxMode.marker = '/nonexistent/agora-box';
            expect(await boxRelayCommand(['--token-fd', '3'], env, { uid: 1001, loop })).toBe(2);
            expect(loop).not.toHaveBeenCalled();
        } finally { restore(); }
    });

    it('reads the credential from the descriptor it was given, once, and only a well-formed one', async () => {
        const t = await tempDir();
        try {
            const marker = join(t.dir, 'agora-box');
            await writeFile(marker, 'agora-box 7\n');
            boxMode.marker = marker;
            const good = join(t.dir, 'good'); const bad = join(t.dir, 'bad');
            await writeFile(good, `${TOKEN}\n`); await writeFile(bad, 'ah_not_a_relay_token.x');
            const { openSync } = await import('node:fs');
            expect(readRelayToken(openSync(good, 'r'))).toBe(TOKEN);
            expect(() => readRelayToken(openSync(bad, 'r'))).toThrow();
            const restore = quiet();
            try {
                const loop = vi.fn(async () => {});
                const fd = openSync(good, 'r');
                const env = { AGORA_HOST_IN_BOX: '1', AGORA_INSTANCE_URL: 'http://edge:8080' };
                expect(await boxRelayCommand(['--token-fd', String(fd)], env, { uid: 1001, loop })).toBe(0);
                expect(loop).toHaveBeenCalledWith(expect.objectContaining({ instance: 'http://edge:8080', token: TOKEN }));
                // No fd, a bad one, or no instance address
                expect(await boxRelayCommand([], env, { uid: 1001, loop })).toBe(2);
                expect(await boxRelayCommand(['--token-fd', String(openSync(bad, 'r'))], env, { uid: 1001, loop })).toBe(2);
                expect(await boxRelayCommand(['--token-fd', String(openSync(good, 'r'))], { AGORA_HOST_IN_BOX: '1' }, { uid: 1001, loop })).toBe(2);
            } finally { restore(); }
        } finally { await t.cleanup(); }
    });
});

describe('the connection to Agora', () => {
    class FakeSocket extends EventEmitter {
        connected = false; disconnected = 0;
        connect() { return this; }
        disconnect() { this.disconnected++; this.connected = false; queueMicrotask(() => this.emit('disconnect')); return this; }
    }
    const saved = { marker: boxMode.marker, flag: process.env.AGORA_HOST_IN_BOX };
    afterEach(() => {
        boxMode.marker = saved.marker;
        if (saved.flag === undefined) delete process.env.AGORA_HOST_IN_BOX; else process.env.AGORA_HOST_IN_BOX = saved.flag;
    });

    it('does nothing on a machine: no socket, no shell, ever', async () => {
        delete process.env.AGORA_HOST_IN_BOX;
        const connect = vi.fn();
        await boxRelayLoop({ instance: 'http://127.0.0.1:3000', token: TOKEN, signal: new AbortController().signal, log: () => {}, connect: connect as any });
        expect(connect).not.toHaveBeenCalled();
        // The flag alone, with no marker file of the image, is not box mode either
        process.env.AGORA_HOST_IN_BOX = '1';
        boxMode.marker = '/nonexistent/agora-box';
        await boxRelayLoop({ instance: 'http://127.0.0.1:3000', token: TOKEN, signal: new AbortController().signal, log: () => {}, connect: connect as any });
        expect(connect).not.toHaveBeenCalled();
    });

    it('in a box: connects as the relay with its credential and protocol, serves a shell, retries after a refusal and logs each reason once', async () => {
        const t = await tempDir();
        try {
            const marker = join(t.dir, 'agora-box');
            await writeFile(marker, 'agora-box 7\n');
            boxMode.marker = marker; process.env.AGORA_HOST_IN_BOX = '1';
            const sockets: FakeSocket[] = []; const auths: any[] = []; const logs: string[] = [];
            const ctl = new AbortController();
            const spawned: PtyOptions[] = [];
            const loop = boxRelayLoop({ instance: 'http://127.0.0.1:3000/', token: TOKEN,
                signal: ctl.signal, log: c => logs.push(c), retryMinMs: 5, retryMaxMs: 20,
                connect: ((url: string, auth: any) => { auths.push({ url, auth }); const s = new FakeSocket(); sockets.push(s); return s; }) as any,
                spawnPty: o => { spawned.push(o); return new FakePty(); },
            });
            const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise(r => setTimeout(r, 5)); expect(check()).toBe(true); };
            await until(() => sockets.length === 1);
            expect(auths[0]).toEqual({ url: 'http://127.0.0.1:3000', auth: { type: 'relay', token: TOKEN, shellProtocol: 2 } });
            // Refused (an older Agora, or a revoked token): retry, log the reason once
            sockets[0].emit('connect_error', new Error('Invalid token'));
            await until(() => sockets.length === 2);
            sockets[1].emit('connect_error', new Error('Invalid token'));
            await until(() => sockets.length === 3);
            expect(logs.filter(l => l.startsWith('box_shell_unavailable'))).toEqual(['box_shell_unavailable invalid_token']);
            // Connected: a shell request starts a shell
            sockets[2].connected = true; sockets[2].emit('connect');
            sockets[2].emit('shell:open', { sessionId: SID, cols: 90, rows: 20, rateBytesPerSecond: 65536 });
            await until(() => spawned.length === 1);
            expect(spawned[0]).toMatchObject({ cols: 90, rows: 20 });
            ctl.abort();
            await loop;
            expect(sockets[2].disconnected).toBeGreaterThan(0);
        } finally { await t.cleanup(); }
    });
});

describe('a second socket refused because the real one is still connected', () => {
    class QuietSocket extends EventEmitter {
        connected = false;
        connect() { return this; }
        disconnect() { queueMicrotask(() => this.emit('disconnect')); return this; }
    }
    const saved = { marker: boxMode.marker, flag: process.env.AGORA_HOST_IN_BOX };
    afterEach(() => {
        boxMode.marker = saved.marker;
        if (saved.flag === undefined) delete process.env.AGORA_HOST_IN_BOX; else process.env.AGORA_HOST_IN_BOX = saved.flag;
    });

    it('is a retry-soon, not a fatal error and not a growing backoff: a genuine reconnect gets in once the server drops the dead socket', async () => {
        const t = await tempDir();
        try {
            const marker = join(t.dir, 'agora-box');
            await writeFile(marker, 'agora-box 7\n');
            boxMode.marker = marker; process.env.AGORA_HOST_IN_BOX = '1';
            const ctl = new AbortController();
            const sockets: QuietSocket[] = [];
            const stamps: number[] = [];
            const loop = boxRelayLoop({ instance: 'http://127.0.0.1:3000/', token: TOKEN,
                signal: ctl.signal, log: () => {}, retryMinMs: 20, retryMaxMs: 10_000,
                connect: (() => { const s = new QuietSocket(); sockets.push(s); stamps.push(Date.now()); return s; }) as any,
            });
            const until = async (check: () => boolean) => { for (let i = 0; i < 600 && !check(); i++) await new Promise(r => setTimeout(r, 5)); expect(check()).toBe(true); };
            for (let i = 0; i < 4; i++) {
                await until(() => sockets.length === i + 1);
                sockets[i].emit('connect_error', new Error('host_already_connected'));
            }
            await until(() => sockets.length === 5);
            // Every retry waited the minimum (20 ms), never 40, 80, 160 ...
            for (let i = 1; i < 5; i++) expect(stamps[i] - stamps[i - 1]).toBeLessThan(120);
            sockets[4].connected = true; sockets[4].emit('connect');
            ctl.abort();
            await loop;
        } finally { await t.cleanup(); }
    });
});

describe('the loop does not keep the host alive', () => {
    class QuietSocket extends EventEmitter {
        connected = false; disconnected = 0;
        connect() { return this; }
        disconnect() { this.disconnected++; queueMicrotask(() => this.emit('disconnect')); return this; }
    }
    const saved = { marker: boxMode.marker, flag: process.env.AGORA_HOST_IN_BOX };
    afterEach(() => {
        boxMode.marker = saved.marker;
        if (saved.flag === undefined) delete process.env.AGORA_HOST_IN_BOX; else process.env.AGORA_HOST_IN_BOX = saved.flag;
    });

    it('returns at once when the host is done, even while it waits to retry for a long time', async () => {
        // The host quits when its token is refused, and a box's restart policy starts it again. A terminal
        // loop that outlived the scheduler would keep the process, and the box, stuck unregistered.
        const t = await tempDir();
        try {
            const marker = join(t.dir, 'agora-box');
            await writeFile(marker, 'agora-box 7\n');
            boxMode.marker = marker; process.env.AGORA_HOST_IN_BOX = '1';
            const ctl = new AbortController();
            const sockets: QuietSocket[] = [];
            const started = Date.now();
            const loop = boxRelayLoop({ instance: 'http://127.0.0.1:3000/', token: TOKEN,
                signal: ctl.signal, log: () => {}, retryMinMs: 60_000, retryMaxMs: 60_000,
                connect: (() => { const s = new QuietSocket(); sockets.push(s); return s; }) as any,
            });
            await new Promise(r => setTimeout(r, 30));
            sockets[0].emit('connect_error', new Error('Invalid relay token'));
            await new Promise(r => setTimeout(r, 30));
            ctl.abort();
            await loop;
            expect(Date.now() - started).toBeLessThan(2000);
            expect(sockets).toHaveLength(1);
        } finally { await t.cleanup(); }
    });
});

describe.skipIf(!hasPython)('the real pseudo-terminal (box/agora-pty, Python\'s pty)', () => {
    const run = (command: string[], cwd = '/tmp', env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TERM: 'xterm' }) => {
        const pty = makeHelperPty(HELPER)({ cols: 90, rows: 20, cwd, env, command });
        let out = '';
        const exited = new Promise<number | null>(resolve => pty.onExit(resolve));
        pty.onData(d => { out += d.toString('utf8'); });
        return { pty, out: () => out, exited };
    };
    const until = async (check: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 20)); expect(check()).toBe(true); };

    it('runs a command with a real terminal of the size asked and reports its exit status', async () => {
        const r = run(['/bin/sh', '-c', 'stty size; [ -t 0 ] && echo tty; exit 7']);
        expect(await r.exited).toBe(7);
        expect(r.out()).toContain('20 90');
        expect(r.out()).toContain('tty');
    });

    it('carries input to the shell and output back, and follows a resize', async () => {
        const r = run(['/bin/sh']);
        await until(() => r.out().length > 0 || true);
        r.pty.write(Buffer.from('echo hello-$((6*7))\n'));
        await until(() => r.out().includes('hello-42'));
        r.pty.resize(132, 43);
        await new Promise(res => setTimeout(res, 100));
        r.pty.write(Buffer.from('stty size\n'));
        await until(() => r.out().includes('43 132'));
        r.pty.write(Buffer.from('exit 0\n'));
        expect(await r.exited).toBe(0);
    });

    it('Ctrl-C reaches the foreground job even while it floods output', async () => {
        // An interactive bash, as the box runs: it has job control, so ^C stops the job and not the shell
        const r = run(['/bin/bash', '--norc', '--noprofile', '-i']);
        r.pty.write(Buffer.from('yes flood-line\n'));
        await until(() => r.out().includes('flood-line'));
        // Nobody is reading: the shell's writes block, as under the owner's rate limit
        r.pty.pause();
        await new Promise(res => setTimeout(res, 300));
        r.pty.write(Buffer.from([3]));
        r.pty.resume();
        const mark = r.out().length;
        r.pty.write(Buffer.from('echo $((20+22))-after-interrupt\n'));
        await until(() => /42-after-interrupt/.test(r.out().slice(mark)), 5000).catch(e => { throw new Error(`${e.message} after ${r.out().length - mark} bytes, tail=${JSON.stringify(r.out().slice(-300))}`); });
        r.pty.write(Buffer.from('exit\n'));
        expect(await r.exited).toBe(0);
    }, 15_000);

    it('killing it ends the shell and what the shell started', async () => {
        const r = run(['/bin/sh', '-c', 'sleep 300 & echo started; wait']);
        await until(() => r.out().includes('started'));
        r.pty.kill();
        await r.exited;
        const left = spawnSync('pgrep', ['-f', 'sleep 300']);
        expect(left.status).not.toBe(0);
    });

    it('a command that does not exist is an error code from the helper or the shell, not a hang', async () => {
        const r = run(['/nonexistent/command']);
        expect(await r.exited).toBe(127);
    });

    describe('which side the owner is typing on (the foreground process group of the terminal)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agora-side-'));
        // Stands in for /usr/local/bin/as-agent: the helper looks for this path among the first arguments of a foreground process
        const CLIENT = join(dir, 'as-agent');
        writeFileSync(CLIENT, `import sys, time
sys.stdout.write('operator@box:~$ ')
sys.stdout.flush()
time.sleep(float(sys.argv[1]) if len(sys.argv) > 1 else 2)
`);
        const runSide = (command: string[]) => {
            const pty = makeHelperPty(HELPER, CLIENT)({ cols: 90, rows: 20, cwd: '/tmp', env: { PATH: process.env.PATH, TERM: 'xterm' }, command });
            const sides: string[] = [];
            let out = '';
            pty.onSide(s => sides.push(s));
            pty.onData(d => { out += d.toString('utf8'); });
            pty.onExit(() => {});
            return { pty, sides, out: () => out };
        };
        const last = (sides: string[]) => sides[sides.length - 1];

        it('says operator in the operator own shell, agent while an as-agent client is in the foreground (even if it draws the operator prompt and stays open), and operator again when it ends', async () => {
            const r = runSide(['/bin/bash', '--norc', '--noprofile', '-i']);
            await until(() => last(r.sides) === 'operator');
            r.pty.write(Buffer.from(`/usr/bin/python3 -I ${CLIENT} 2
`));
            await until(() => last(r.sides) === 'agent');
            // It has drawn a copy of the operator's prompt, and keeps the session open: still the agent's side
            await until(() => r.out().includes('operator@box:~$ '));
            await new Promise(res => setTimeout(res, 800));
            expect(last(r.sides)).toBe('agent');
            // Only the helper's own report that the client left turns it back
            await until(() => last(r.sides) === 'operator', 6000);
            r.pty.write(Buffer.from('exit' + String.fromCharCode(10)));
            r.pty.kill();
        }, 20_000);

        it('a client run in a pipeline, a subshell or by exec is still the agent side', async () => {
            const r = runSide(['/bin/bash', '--norc', '--noprofile', '-i']);
            await until(() => last(r.sides) === 'operator');
            r.pty.write(Buffer.from(`(/usr/bin/python3 -I ${CLIENT} 1.5 | cat)
`));
            await until(() => last(r.sides) === 'agent');
            await until(() => last(r.sides) === 'operator', 6000);
            r.pty.write(Buffer.from(`exec /usr/bin/python3 -I ${CLIENT} 1.5
`));
            await until(() => last(r.sides) === 'agent');
            r.pty.kill();
        }, 20_000);

        it('where the kernel does not answer for the pty master (gVisor), a client anywhere in the shell\'s tree counts as the agent side, and a process outside the tree does not', () => {
            const script = `
import importlib.machinery, os, subprocess, sys, time
mod = importlib.machinery.SourceFileLoader('agora_pty', sys.argv[1]).load_module()
def no_answer(_fd): raise OSError(25, 'ENOTTY')
os.tcgetpgrp = no_answer
client = sys.argv[2]
out = {}
idle = subprocess.Popen(['sleep', '20'])
out['none'] = mod.foreground_side(None, client, idle.pid)
stranger = subprocess.Popen(['/usr/bin/python3', '-I', client, '4'])
time.sleep(0.5)
# a client runs, but not in the idle shell's tree
out['outside'] = mod.foreground_side(None, client, idle.pid)
shell = subprocess.Popen(['/bin/sh', '-c', '/usr/bin/python3 -I ' + client + ' 4; true'])
time.sleep(0.7)
out['inside'] = mod.foreground_side(None, client, shell.pid)
shell.kill(); stranger.kill(); idle.kill()
print(out)
`;
            const r = spawnSync('/usr/bin/python3', ['-I', '-c', script, HELPER, join(dir, 'as-agent')], { encoding: 'utf8' });
            expect(r.stderr).toBe('');
            expect(/\{.*\}/.exec(r.stdout)![0]).toBe("{'none': 'operator', 'outside': 'operator', 'inside': 'agent'}");
        });

        it('reports the agent side the moment as-agent writes its mark, before any scan could see the process, and keeps the mark off the screen', async () => {
            const r = runSide(['/bin/bash', '--norc', '--noprofile', '-i']);
            await until(() => last(r.sides) === 'operator');
            // Not a process the scan would call a client: only the mark can have moved the display. The mark is cut in two reads.
            r.pty.write(Buffer.from(`printf '\033]7777;agora'; sleep 0.1; printf -- '-as-agent\007'; echo done-$((6*7))\n`));
            await until(() => r.sides.includes('agent'), 3000);
            await until(() => r.out().includes('done-42'));
            expect(r.out()).not.toContain(String.fromCharCode(27) + ']7777');
            expect(r.out()).not.toContain(String.fromCharCode(7));
            // A forged mark only ever moves toward agent: with nothing running as the client, the scan brings it back
            await until(() => last(r.sides) === 'operator', 3000);
            r.pty.kill();
        }, 15_000);

        it('a background client does not make the shell the agent side, and the report repeats about once a second', async () => {
            const r = runSide(['/bin/bash', '--norc', '--noprofile', '-i']);
            await until(() => last(r.sides) === 'operator');
            r.pty.write(Buffer.from(`/usr/bin/python3 -I ${CLIENT} 3 &
`));
            const n = r.sides.length;
            await until(() => r.sides.length >= n + 2, 4000);
            expect(r.sides.slice(n)).not.toContain('agent');
            r.pty.kill();
        }, 15_000);
    });

    it('the shell does not inherit the resize pipe (fd 3), while resizing still works', async () => {
        const r = run(['/bin/sh', '-c', 'if [ -e /proc/self/fd/3 ] || [ -e /dev/fd/3 ]; then echo fd3-open; else echo fd3-closed; fi; read x; stty size']);
        await until(() => r.out().includes('fd3-'));
        expect(r.out()).toContain('fd3-closed');
        r.pty.resize(101, 33);
        await new Promise(res => setTimeout(res, 150));
        r.pty.write(Buffer.from('\n'));
        await r.exited;
        expect(r.out()).toContain('33 101');
    });

    it('the operator\'s shell, as specified: bash with the image\'s rc file, its prompt and banner, in the folder asked', async () => {
        const t = await tempDir();
        try {
            await mkdir(join(t.dir, 'home'), { recursive: true });
            const rc = join(t.dir, 'rc');
            await writeFile(rc, readFileSync(fileURLToPath(new URL('../../box/operator.bashrc', import.meta.url))));
            const spec = operatorShellSpec({ PATH: '/usr/bin:/bin' }, join(t.dir, 'home'));
            const command = [...spec.command.slice(0, 3), rc, '-i'];
            const r = run(command, spec.cwd, { ...spec.env, GIT_CONFIG_GLOBAL: '/dev/null' });
            await until(() => r.out().includes('as-agent'));
            expect(r.out()).toContain('your own account');
            r.pty.write(Buffer.from('pwd; echo "git=$GIT_CONFIG_NOSYSTEM"; exit\n'));
            await r.exited;
            expect(r.out()).toContain(join(t.dir, 'home'));
            expect(r.out()).toContain('git=1');
        } finally { await t.cleanup(); }
    });

    it('starts in the folder asked', async () => {
        const t = await tempDir();
        try {
            await mkdir(join(t.dir, 'work'), { recursive: true });
            const r = run(['/bin/sh', '-c', 'pwd'], join(t.dir, 'work'));
            await r.exited;
            expect(r.out()).toContain(join(t.dir, 'work'));
        } finally { await t.cleanup(); }
    });
});
