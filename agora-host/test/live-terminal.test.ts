import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configSchema, type Config } from '../src/config.js';
import { LiveManager, channelMessageId, hookSettings, trustFolder, HOOK_EVENTS, type LiveSpec, type LiveTransport } from '../src/live-terminal.js';
import type { PtyChild, PtyOptions } from '../src/box-shell.js';
import { tempDir } from './helpers.js';

const SID = '01J00000000000000000000001';
const CH = '01J00000000000000000000002';
const BOT = '01J00000000000000000000003';
const MSG = '01J00000000000000000000004';
const CONV = '12345678-1234-1234-1234-123456789abc';
const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40);

class FakeTransport implements LiveTransport {
    handlers = new Map<string, (p: any) => void>();
    emitted: Array<{ event: string; payload: any }> = [];
    connected = true;
    emit(event: string, payload: unknown) { this.emitted.push({ event, payload }); }
    on(event: string, handler: (p: any) => void) { this.handlers.set(event, handler); }
    fire(event: string, payload: unknown) { this.handlers.get(event)?.(payload); }
    of(event: string) { return this.emitted.filter(e => e.event === event).map(e => e.payload); }
}
class FakePty implements PtyChild {
    written: Buffer[] = []; sizes: Array<[number, number]> = []; killed = 0; paused = 0; resumed = 0;
    data: (d: Buffer) => void = () => {}; exit: (c: number | null) => void = () => {};
    write(d: Buffer) { this.written.push(d); }
    resize(c: number, r: number) { this.sizes.push([c, r]); }
    kill() { this.killed++; }
    pause() { this.paused++; }
    resume() { this.resumed++; }
    onData(cb: (d: Buffer) => void) { this.data = cb; }
    onExit(cb: (c: number | null) => void) { this.exit = cb; }
    onError() {}
    onSide() {}
}

let dir: string, cleanup: () => Promise<void>;
beforeEach(async () => { ({ dir, cleanup } = await tempDir()); });
afterEach(async () => { await cleanup(); });

function cfg(auth: 'subscription' | 'api_key' = 'subscription'): Config {
    return configSchema.parse({ instance: 'http://edge:8080', hostToken: 'ah_host.secret',
        mcp: { executable: process.execPath, entrypoint: join(dir, 'mcp.js') },
        profiles: { cc: { adapter: 'claude', executable: process.execPath, workdir: dir, workdirAlias: 'w', stateDir: join(dir, 'state'), auth,
            ...(auth === 'api_key' ? { apiKeyEnv: 'ANTHROPIC_API_KEY' } : {}) } },
        botTokens: { [BOT]: 'bot_selected.secret' } });
}
const spec = (over: Partial<LiveSpec> = {}) => ({ sessionId: SID, channelId: CH, channelName: 'general', botId: BOT, conversation: CONV, profile: 'cc', cols: 120, rows: 32, ...over });
const flush = async () => { await new Promise(r => setTimeout(r, 600)); };

function setup(over: { auth?: 'subscription' | 'api_key' } = {}) {
    const t = new FakeTransport(); const ptys: FakePty[] = []; const opts: PtyOptions[] = []; const logs: string[] = [];
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    let sha = SHA1;
    const m = new LiveManager({
        config: cfg(over.auth), runtimeDir: dir, hookSocket: false, log: c => logs.push(c),
        spawnPty: o => { opts.push(o); const p = new FakePty(); ptys.push(p); return p; },
        workspace: async () => ({ cwd: dir, branch: `agora/cc/${SID}` }),
        readHead: async () => ({ branch: `agora/cc/${SID}`, sha }),
        setTimer: (fn, ms) => { const e = { fn, ms, cancelled: false }; timers.push(e); return { cancel: () => { e.cancelled = true; } }; },
    });
    m.attach(t);
    return { m, t, ptys, opts, logs, timers, setSha: (s: string) => { sha = s; } };
}

describe('starting a session', () => {
    it('runs the interactive CLI with the channel flag, a fresh conversation id and the Agora MCP in channel mode', async () => {
        const { m, t, opts } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        expect(opts).toHaveLength(1);
        const cmd = opts[0].command;
        expect(cmd).toContain('--dangerously-load-development-channels');
        expect(cmd[cmd.indexOf('--dangerously-load-development-channels') + 1]).toBe('server:agora');
        expect(cmd).toContain('--strict-mcp-config');
        expect(cmd.slice(-2)).toEqual(['--session-id', CONV]);
        // The command is the interactive CLI: never headless
        expect(cmd).not.toContain('-p');
        const mcp = JSON.parse(await readFile(cmd[cmd.indexOf('--mcp-config') + 1], 'utf8'));
        expect(mcp.mcpServers.agora.args).toEqual([join(dir, 'mcp.js'), '--channel-mode', '--auth', 'subscription']);
        // The bot token is in the CLI's environment only, never in a file or on the command line
        expect(opts[0].env.AGORA_BOT_TOKEN).toBe('bot_selected.secret');
        expect(JSON.stringify(mcp)).not.toContain('bot_selected');
        expect(cmd.join(' ')).not.toContain('bot_selected');
        expect(opts[0].env.AGORA_DEFAULT_CHANNEL).toBe(CH);
        expect(opts[0].env.AGORA_HOOKS).toBe('off');
        expect(m.sessionIds()).toEqual([SID]);
        expect(t.of('live:state')[0]).toMatchObject({ state: 'starting' });
    });

    it('lets directors instruct only a session on an API key', async () => {
        process.env.ANTHROPIC_API_KEY = 'k';
        const { t, opts } = setup({ auth: 'api_key' });
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        const mcp = JSON.parse(await readFile(opts[0].command[opts[0].command.indexOf('--mcp-config') + 1], 'utf8'));
        expect(mcp.mcpServers.agora.args.slice(-2)).toEqual(['--auth', 'api_key']);
    });

    it('wires the hooks for the states and nothing else', () => {
        const s = hookSettings('/x/hook') as any;
        expect(Object.keys(s.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
        expect(s.hooks.Stop[0].hooks[0].command).toBe('/x/hook Stop');
    });

    it('ignores malformed sessions', async () => {
        const { m, t, opts } = setup();
        t.fire('live:desired', { sessions: [spec({ sessionId: 'nope' }), spec({ profile: '../x' }), { ...spec(), botId: 5 }, null, 7] });
        await flush();
        expect(opts).toHaveLength(0);
        expect(m.sessionIds()).toEqual([]);
    });

    it('refuses a bot it has no token for', async () => {
        const { m, t, opts, logs } = setup();
        t.fire('live:desired', { sessions: [spec({ botId: '01J00000000000000000000009' })] });
        await flush();
        expect(opts).toHaveLength(0);
        expect(logs.some(l => l.startsWith('live_start_failed'))).toBe(true);
        expect(m.stateOf(SID)?.state).toBe('stopped');
    });
});

describe('states and turns come from hooks', () => {
    it('SessionStart is idle; a pushed message starts a turn naming its message; Stop ends it with both commits', async () => {
        const { m, t, setSha } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        await m.hook(SID, 'SessionStart', {});
        expect(m.stateOf(SID)).toEqual({ state: 'idle', note: null });
        await m.hook(SID, 'UserPromptSubmit', { prompt: `<channel source="agora" channel="general" channel_id="${CH}" message_id="${MSG}" author="eryk" authority="owner">\ndo it\n</channel>` });
        expect(m.stateOf(SID)?.state).toBe('working');
        setSha(SHA2);
        await m.hook(SID, 'Stop', {});
        expect(m.stateOf(SID)?.state).toBe('idle');
        expect(t.of('live:turn')).toEqual([
            { sessionId: SID, phase: 'start', messageId: MSG, source: 'message', branch: `agora/cc/${SID}`, sha: SHA1 },
            { sessionId: SID, phase: 'end', signal: 'stop_hook', branch: `agora/cc/${SID}`, sha: SHA2 },
        ]);
    });

    it('a prompt the owner typed is a typed turn, whatever it claims', async () => {
        const { m, t } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        await m.hook(SID, 'UserPromptSubmit', { prompt: 'hello <channel source="agora" message_id="' + MSG + '">' });
        expect(t.of('live:turn')[0]).toMatchObject({ messageId: null, source: 'typed' });
        expect(channelMessageId('<channel source="other" message_id="' + MSG + '">')).toBeNull();
        expect(channelMessageId(42)).toBeNull();
    });

    it('a permission dialog is waiting on you, and the next tool use is working again; the idle reminder is not', async () => {
        const { m, t } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        await m.hook(SID, 'SessionStart', {});
        await m.hook(SID, 'Notification', { notification_type: 'idle_prompt' });
        expect(m.stateOf(SID)?.state).toBe('idle');
        await m.hook(SID, 'Notification', { notification_type: 'permission_prompt' });
        expect(m.stateOf(SID)).toEqual({ state: 'waiting', note: 'notification' });
        await m.hook(SID, 'PreToolUse', {});
        expect(m.stateOf(SID)?.state).toBe('working');
    });

    it('a new prompt before Stop ends the old turn as interrupted', async () => {
        const { m, t } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        await m.hook(SID, 'UserPromptSubmit', { prompt: 'a' });
        await m.hook(SID, 'UserPromptSubmit', { prompt: 'b' });
        expect(t.of('live:turn').map(x => x.phase + (x.signal ?? ''))).toEqual(['start', 'endinterrupted', 'start']);
    });

    it('never writes a chat message into the terminal', async () => {
        const { m, t, ptys } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        await m.hook(SID, 'SessionStart', {});
        await m.hook(SID, 'UserPromptSubmit', { prompt: `<channel source="agora" message_id="${MSG}">x</channel>` });
        await m.hook(SID, 'Stop', {});
        expect(ptys[0].written).toEqual([]);
    });

    it('ignores unknown events and events for sessions it does not run', async () => {
        const { m, t } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        await m.hook(SID, 'Bogus', {});
        await m.hook('01J0000000000000000000000X', 'Stop', {});
        expect(m.stateOf(SID)?.state).toBe('starting');
    });
});

describe('a startup dialog', () => {
    it('is reported as waiting on you when no hook has fired, and not typed at', async () => {
        const { m, t, ptys, timers } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        timers.find(x => x.ms === 25_000)!.fn();
        expect(m.stateOf(SID)).toEqual({ state: 'waiting', note: 'no_signal' });
        expect(ptys[0].written).toEqual([]);
        await m.hook(SID, 'SessionStart', {});
        expect(m.stateOf(SID)).toEqual({ state: 'idle', note: null });
    });

    it('is cancelled by the first hook', async () => {
        const { m, t, timers } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        await m.hook(SID, 'SessionStart', {});
        expect(timers.find(x => x.ms === 25_000)!.cancelled).toBe(true);
    });
});

describe('supervision', () => {
    it('restarts after the CLI exits and resumes the conversation once it had started', async () => {
        const { m, t, ptys, opts, timers } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        await m.hook(SID, 'SessionStart', {});
        ptys[0].exit(0);
        expect(t.of('live:exited')).toEqual([{ sessionId: SID, code: 0 }]);
        expect(m.stateOf(SID)).toEqual({ state: 'restarting', note: 'exited' });
        timers.filter(x => !x.cancelled && x.ms === 1000)[0].fn();
        await flush();
        expect(opts).toHaveLength(2);
        expect(opts[1].command.slice(-2)).toEqual(['--resume', CONV]);
    });

    it('a start that dies at once is retried as a resumed conversation', async () => {
        const { t, ptys, opts, timers } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        ptys[0].exit(1);
        timers.filter(x => !x.cancelled && x.ms === 1000)[0].fn();
        await flush();
        expect(opts[1].command.slice(-2)).toEqual(['--resume', CONV]);
    });

    it('stops a session the server no longer wants, and does not restart it', async () => {
        const { m, t, ptys, timers } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        t.fire('live:desired', { sessions: [] });
        await flush();
        expect(ptys[0].killed).toBe(1);
        ptys[0].exit(0);
        expect(m.sessionIds()).toEqual([]);
        expect(timers.filter(x => x.ms === 1000)).toHaveLength(0);
    });

    it('keeps a running session when the desired list repeats', async () => {
        const { t, ptys } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        expect(ptys).toHaveLength(1);
    });
});

describe('the pty', () => {
    it('relays output and keeps a ring for a reconnect', async () => {
        const { m, t, ptys } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        ptys[0].data(Buffer.from('hello '));
        ptys[0].data(Buffer.from('world'));
        expect(Buffer.concat(t.of('live:output').map(p => p.data)).toString()).toBe('hello world');
        const t2 = new FakeTransport();
        m.attach(t2);
        // Re-announced once Agora has said what it wants on the new connection, not before
        expect(t2.of('live:replay')).toEqual([]);
        t2.fire('live:desired', { sessions: [spec()] });
        await flush();
        expect(t2.of('live:replay')[0].data.toString()).toBe('hello world');
        expect(t2.of('live:state')[0]).toMatchObject({ sessionId: SID, state: 'starting' });
    });

    it('bounds the ring', async () => {
        const { m, t, ptys } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        for (let i = 0; i < 40; i++) ptys[0].data(Buffer.alloc(16 * 1024, 65));
        const t2 = new FakeTransport();
        m.attach(t2);
        t2.fire('live:desired', { sessions: [spec()] });
        await flush();
        expect(t2.of('live:replay')[0].data.length).toBeLessThanOrEqual(256 * 1024);
    });

    it("writes the owner's keystrokes, resizes, and interrupts with one Escape", async () => {
        const { t, ptys } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        t.fire('live:input', { sessionId: SID, data: Buffer.from('ls\r') });
        t.fire('live:input', { sessionId: 'nope', data: Buffer.from('x') });
        t.fire('live:input', { sessionId: SID, data: 'a string is not bytes' });
        t.fire('live:resize', { sessionId: SID, cols: 80, rows: 24 });
        t.fire('live:resize', { sessionId: SID, cols: 0, rows: 24 });
        t.fire('live:interrupt', { sessionId: SID });
        expect(ptys[0].written.map(b => b.toString())).toEqual(['ls\r', '\x1b']);
        expect(ptys[0].sizes).toEqual([[80, 24]]);
    });

    it('pauses the terminal when the server asks it to slow down, once', async () => {
        const { t, ptys } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        t.fire('live:pace', { sessionId: SID, ms: 50 });
        t.fire('live:pace', { sessionId: SID, ms: 50 });
        expect(ptys[0].paused).toBe(1);
        await new Promise(r => setTimeout(r, 80));
        expect(ptys[0].resumed).toBe(1);
    });

    it('does not send while the socket is down', async () => {
        const { t, ptys } = setup();
        t.fire('live:desired', { sessions: [spec()] });
        await flush();
        t.connected = false;
        ptys[0].data(Buffer.from('x'));
        expect(t.of('live:output')).toEqual([]);
    });
});

describe('the trust-folder question', () => {
  it('is answered in the CLI configuration, merged into what is there, and never by typing', async () => {
    const state = join(dir, 'trust-state');
    await mkdir(state, { recursive: true });
    await writeFile(join(state, '.claude.json'), JSON.stringify({ oauthAccount: { a: 1 }, projects: { '/other': { x: 1 } } }));
    await trustFolder(state, '/home/agent/wt');
    const after = JSON.parse(await readFile(join(state, '.claude.json'), 'utf8'));
    expect(after).toEqual({ oauthAccount: { a: 1 }, projects: { '/other': { x: 1 }, '/home/agent/wt': { hasTrustDialogAccepted: true } } });
  });
  it('creates the file when there is none, and leaves a file it cannot read as an object alone', async () => {
    const state = join(dir, 'trust-state-2');
    await mkdir(state, { recursive: true });
    await trustFolder(state, '/w');
    expect(JSON.parse(await readFile(join(state, '.claude.json'), 'utf8'))).toEqual({ projects: { '/w': { hasTrustDialogAccepted: true } } });
    await writeFile(join(state, '.claude.json'), 'not json');
    await trustFolder(state, '/w');
    expect(await readFile(join(state, '.claude.json'), 'utf8')).toBe('not json');
    await writeFile(join(state, '.claude.json'), '[1]');
    await trustFolder(state, '/w');
    expect(await readFile(join(state, '.claude.json'), 'utf8')).toBe('[1]');
  });
});
