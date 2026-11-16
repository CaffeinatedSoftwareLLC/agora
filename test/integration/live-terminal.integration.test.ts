import { EventEmitter } from 'node:events';
import { io, Socket } from 'socket.io-client';
import supertest from 'supertest';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { signEdge } from '../../src/lib/boxes/contract';
import { rotateBoxTokens } from '../../src/lib/boxes/tokens';
import { liveHub, Ring, RING_BYTES } from '../../src/lib/boxes/live-hub';

/**
 * Live terminals (docs/planning/live-terminals.md): the mode switch, the session lifecycle, and the hub
 * that joins a box's agora-host to the browsers that watch it: several viewers at once, replay for a late
 * joiner, who may type (the confirmed owner only), held deliveries while the owner has the controls,
 * turns, limits and backpressure. The box's agora-host is played by a fake socket client; the real host
 * and a real box are in agora-host's tests and test/boxes/live-terminal.box.test.ts.
 */

const EDGE_SECRET = '35'.repeat(32);
process.env.AGORA_EDGE_SECRET = EDGE_SECRET;
process.env.AGORA_LIVE_CONTROL_IDLE_MS = '400';
process.env.AGORA_LIVE_CHANNEL_GRACE_MS = '0';
process.env.AGORA_LIVE_ACCESS_RECHECK_MS = '0';
const PASSWORD = 'TestPass123!';
const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40);

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let base: string;
let origin: string;
let api: supertest.Agent;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let director: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
const sockets: Socket[] = [];

interface Session { cookie: string; csrf: string }
interface Box { id: string; name: string; generation: number; hostToken: string; relayToken: string; botToken: string; profileId: string }
interface FakeHost { socket: Socket; input: Buffer[]; resized: any[]; desired: any[]; interrupts: number; paced: number }

async function cookieLogin(login: string): Promise<Session> {
    const res = await api.post('/auth/login').set('X-Agora-Session', 'cookie').send({ login, password: PASSWORD });
    expect(res.status).toBe(200);
    const set: string[] = res.headers['set-cookie'];
    const value = (n: string) => set.find(c => c.startsWith(`${n}=`))!.split(';')[0].slice(n.length + 1);
    return { cookie: `agora_session=${value('agora_session')}; agora_csrf=${value('agora_csrf')}`, csrf: value('agora_csrf') };
}

async function makeBox(name: string): Promise<Box> {
    const res = await api.post(`/servers/${serverId}/boxes`).set(owner.auth).send({ name, adapter: 'claude', homeChannelId: channelId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const t = await rotateBoxTokens(ctx.db, res.body.box.id);
    await ctx.db.query(`UPDATE agent_boxes SET state = 'running' WHERE id = $1`, [res.body.box.id]);
    const profileId = (await ctx.db.query(`SELECT profile_id FROM agent_boxes WHERE id = $1`, [res.body.box.id])).rows[0].profile_id.trim();
    return { id: res.body.box.id, name, generation: t.generation, hostToken: t.hostToken, relayToken: t.relayToken, botToken: t.botToken, profileId };
}
const edgeFor = (box: Box, generation = box.generation) => signEdge(EDGE_SECRET, box.id, generation);

function connected(socket: Socket): Promise<void> {
    return new Promise((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', err => reject(new Error(err.message)));
        socket.connect();
    });
}
const refusal = (socket: Socket) => connected(socket).then(() => 'connected', e => (e as Error).message);
const wait = (socket: Socket, name: string, ms = 4000) => new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${name}`)), ms);
    socket.once(name, d => { clearTimeout(t); resolve(d); });
});
const settle = (ms = 150) => new Promise(r => setTimeout(r, ms));
const until = async (fn: () => boolean | Promise<boolean>, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await settle(25); } throw new Error('timed out'); };

/** The box's agora-host: connects with its host token through its own edge and records what Agora tells it. */
async function connectHost(box: Box, opts: { protocol?: number; token?: string; headers?: Record<string, string> } = {}): Promise<FakeHost> {
    const host: FakeHost = { socket: null as any, input: [], resized: [], desired: [], interrupts: 0, paced: 0 };
    const socket = io(base, {
        transports: ['websocket'], autoConnect: false, reconnection: false,
        extraHeaders: opts.headers ?? edgeFor(box),
        auth: { type: 'live', token: opts.token ?? box.hostToken, liveProtocol: opts.protocol ?? 1 },
    });
    sockets.push(socket);
    host.socket = socket;
    socket.on('live:desired', m => host.desired.push(m));
    socket.on('live:input', m => host.input.push(Buffer.from(m.data)));
    socket.on('live:resize', m => host.resized.push(m));
    socket.on('live:interrupt', () => host.interrupts++);
    socket.on('live:pace', () => host.paced++);
    await connected(socket);
    return host;
}

/** A browser watching a live session. */
function viewer(session: Session | null, sessionId: string, o: { origin?: string | null } = {}): Socket {
    const socket = io(base, {
        transports: ['websocket'], autoConnect: false, reconnection: false,
        extraHeaders: { ...(session ? { cookie: session.cookie } : {}), ...(o.origin === null ? {} : { origin: o.origin ?? origin }) } as any,
        auth: { type: 'live-view', sessionId },
    });
    sockets.push(socket);
    return socket;
}
async function watch(session: Session, sessionId: string) {
    const s = viewer(session, sessionId);
    const ready = wait(s, 'live:ready');
    const chunks: Buffer[] = [];
    const events: Array<{ event: string; data: any }> = [];
    s.on('live:output', d => chunks.push(Buffer.from(d)));
    s.onAny((event, data) => events.push({ event, data }));
    await connected(s);
    const hello = await ready;
    return { s, hello, chunks, events, text: () => Buffer.concat(chunks).toString() };
}

const rows = async (sql: string, params: unknown[] = []) => (await ctx.db.query(sql, params)).rows;
const notices = (like = '%') => rows(`SELECT content FROM messages WHERE channel_id = $1 AND system_event = 'agent_session' AND content LIKE $2 ORDER BY id`, [channelId, like]);

let ownerSession: Session, directorSession: Session, memberSession: Session;
let box: Box;
let host: FakeHost;
let sessionId: string;

const startLive = async () => {
    const started = await api.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'start', profile: box.name, fresh: true });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    return started.body.session.id as string;
};

beforeAll(async () => {
    ctx = await setupTestApp();
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (ctx.app.server.address() as any).port;
    base = `http://127.0.0.1:${port}`;
    origin = base;
    api = supertest(base);
});
beforeEach(async () => {
    await cleanDatabase(ctx.db);
    owner = await authedUser(api, 'liveowner');
    member = await authedUser(api, 'livemember');
    director = await authedUser(api, 'livedirector');
    const s = await createServer(api, owner.auth, 'Live');
    serverId = s.serverId; channelId = s.generalChannelId;
    await joinViaInvite(api, owner.auth, member.auth, serverId);
    await joinViaInvite(api, owner.auth, director.auth, serverId);
    const role = await api.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Orchestrator', permissions: (1n << 29n).toString() });
    await api.put(`/servers/${serverId}/members/${director.userId}/roles/${role.body.id}`).set(owner.auth);
    ownerSession = await cookieLogin('liveowner');
    directorSession = await cookieLogin('livedirector');
    memberSession = await cookieLogin('livemember');
    box = await makeBox('alpha');
    const mode = await api.patch(`/servers/${serverId}/agent-profiles/${box.profileId}`).set(owner.auth).send({ sessionMode: 'live' });
    expect(mode.status, JSON.stringify(mode.body)).toBe(200);
    sessionId = await startLive();
    host = await connectHost(box);
    await until(() => host.desired.length > 0);
});
afterEach(async () => {
    for (const s of sockets.splice(0)) s.disconnect();
    await settle(100);
    await liveHub()?.drain();
});
afterAll(async () => { await ctx.close(); });

/** The fake host sends output and state for the session */
const hostSays = (event: string, extra: object = {}) => host.socket.emit(event, { sessionId, ...extra });

describe('the mode switch', () => {
    test('is per agent, owner only, offered for boxed Claude Code, and not while a session is live', async () => {
        const got = await api.get(`/servers/${serverId}/agent-profiles`).set(owner.auth);
        expect(got.body.find((p: any) => p.id === box.profileId)).toMatchObject({ sessionMode: 'live', boxed: true });
        // Another box's agent keeps the default
        const other = await makeBox('beta');
        const profile = (await api.get(`/servers/${serverId}/agent-profiles`).set(owner.auth)).body.find((p: any) => p.id === other.profileId);
        expect(profile.sessionMode).toBe('runs');
        // Only the owner
        for (const who of [member, director]) {
            const r = await api.patch(`/servers/${serverId}/agent-profiles/${other.profileId}`).set(who.auth).send({ sessionMode: 'live' });
            expect(r.status).toBe(403);
        }
        // Not while a session is live
        const live = await api.patch(`/servers/${serverId}/agent-profiles/${box.profileId}`).set(owner.auth).send({ sessionMode: 'runs' });
        expect(live.status).toBe(409);
        expect(live.body.error).toBe('end_sessions_before_changing_mode');
        // Not for a profile on a machine host
        const hostRes = await api.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'laptop' });
        const bot = await api.post(`/servers/${serverId}/agents`).set(owner.auth).send({ name: 'machinebot', adapter: 'claude', hostId: hostRes.body.host.id, workdirAlias: 'w', hostModeAck: true });
        if (bot.status === 201) {
            const id = bot.body.profile?.id ?? bot.body.id;
            const r = await api.patch(`/servers/${serverId}/agent-profiles/${id}`).set(owner.auth).send({ sessionMode: 'live' });
            expect(r.status).toBe(409);
            expect(r.body.error).toBe('live_terminal_boxed_claude_only');
        }
        // Validation
        const bad = await api.patch(`/servers/${serverId}/agent-profiles/${other.profileId}`).set(owner.auth).send({ sessionMode: 'both' });
        expect(bad.status).toBe(400);
    });

    test('a live-mode session is a hosted session that takes no runs and hears messages only through its Channel', async () => {
        const row = (await rows(`SELECT live_mode, native_session_id FROM agent_sessions WHERE id = $1`, [sessionId]))[0];
        expect(row.live_mode).toBe(true);
        expect(row.native_session_id).toMatch(/^[0-9a-f-]{36}$/);
        const post = await api.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: '@alpha please look at the build' });
        expect(post.status).toBe(201);
        // No inbox row, no run: the host's claim finds nothing
        expect(await rows(`SELECT 1 FROM agent_inbox WHERE session_id = $1 AND reason <> 'command'`, [sessionId])).toHaveLength(0);
        const hostAuth = { Authorization: `AgentHost ${box.hostToken}`, ...edgeFor(box) };
        expect((await api.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth)).status).toBe(204);
    });

    test('a profile in per-wake mode starts sessions exactly as before', async () => {
        const other = await makeBox('beta');
        const started = await api.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'start', profile: 'beta', fresh: true });
        expect(started.status).toBe(201);
        const row = (await rows(`SELECT live_mode, native_session_id FROM agent_sessions WHERE id = $1`, [started.body.session.id]))[0];
        expect(row).toEqual({ live_mode: false, native_session_id: null });
        expect(other.id).toBeTruthy();
    });

    test('the session sheet says it is live and that tokens are not measured; /compact points at the terminal', async () => {
        const list = await api.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'sessions' });
        const s = list.body.sessions.find((x: any) => x.id === sessionId);
        expect(s).toMatchObject({ liveMode: true, tokensMeasured: false, commands: [], kind: 'hosted' });
        const post = await api.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: '@alpha /compact' });
        expect(post.status).toBe(201);
        await settle();
        const said = await notices('%runs in a live terminal%');
        expect(said.length).toBeGreaterThan(0);
        expect(said[0].content).toMatch(/type \/compact in its terminal/);
        expect(await rows(`SELECT 1 FROM agent_session_commands`)).toHaveLength(0);
    });
});

describe('the host connection', () => {
    test('gets exactly this box\'s live sessions, with the conversation id to resume', async () => {
        const row = (await rows(`SELECT native_session_id FROM agent_sessions WHERE id = $1`, [sessionId]))[0];
        expect(host.desired[0].sessions).toEqual([expect.objectContaining({ sessionId, channelId, botId: expect.any(String), conversation: row.native_session_id, profile: 'alpha', cols: 120, rows: 32 })]);
        expect(host.desired[0].sessions[0]).not.toHaveProperty('token');
        expect(JSON.stringify(host.desired)).not.toContain('bot_');
    });

    test('refuses the relay credential, a missing edge, an old protocol and a second socket', async () => {
        const wrong = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: edgeFor(box), auth: { type: 'live', token: box.relayToken, liveProtocol: 1 } });
        sockets.push(wrong);
        expect(await refusal(wrong)).toBe('Malformed host token');
        const noEdge = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, auth: { type: 'live', token: box.hostToken, liveProtocol: 1 } });
        sockets.push(noEdge);
        expect(await refusal(noEdge)).toBe('box_token_outside_box');
        const old = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: edgeFor(box), auth: { type: 'live', token: box.hostToken, liveProtocol: 0 } });
        sockets.push(old);
        expect(await refusal(old)).toBe('unsupported_protocol');
        const second = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: edgeFor(box), auth: { type: 'live', token: box.hostToken, liveProtocol: 1 } });
        sockets.push(second);
        expect(await refusal(second)).toBe('host_already_connected');
        const bad = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: edgeFor(box), auth: { type: 'live', token: `ah_${box.hostToken.slice(3, 29)}.wrong`, liveProtocol: 1 } });
        sockets.push(bad);
        expect(await refusal(bad)).toBe('Invalid host token');
    });

    test('ignores events about a session that is not this box\'s', async () => {
        const other = await makeBox('gamma');
        await api.patch(`/servers/${serverId}/agent-profiles/${other.profileId}`).set(owner.auth).send({ sessionMode: 'live' });
        const otherSession = (await api.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'start', profile: 'gamma', fresh: true })).body.session.id;
        const otherHost = await connectHost(other);
        await until(() => otherHost.desired.length > 0);
        const w = await watch(ownerSession, otherSession);
        // alpha's host speaks for gamma's session: ignored
        host.socket.emit('live:output', { sessionId: otherSession, data: Buffer.from('forged') });
        host.socket.emit('live:state', { sessionId: otherSession, state: 'working', note: null });
        await settle();
        expect(w.text()).toBe('');
        expect((await rows(`SELECT live_state FROM agent_sessions WHERE id = $1`, [otherSession]))[0].live_state).not.toBe('working');
    });
});

describe('watching', () => {
    test('several viewers see the same screen; a late joiner gets the replay first, then live output', async () => {
        const a = await watch(ownerSession, sessionId);
        expect(a.hello).toMatchObject({ role: 'owner', profile: 'alpha', cols: 120, rows: 32, state: 'starting' });
        hostSays('live:output', { data: Buffer.from('hello ') });
        hostSays('live:output', { data: Buffer.from('world') });
        await until(() => a.text() === 'hello world');
        const b = await watch(directorSession, sessionId);
        expect(b.hello.role).toBe('watcher');
        await until(() => b.events.some(e => e.event === 'live:replay'));
        expect(Buffer.from(b.events.find(e => e.event === 'live:replay')!.data).toString()).toBe('hello world');
        // The replay comes before anything live
        hostSays('live:output', { data: Buffer.from('!') });
        await until(() => a.text() === 'hello world!' && b.text() === '!');
        expect(b.events.map(e => e.event).indexOf('live:replay')).toBeLessThan(b.events.map(e => e.event).indexOf('live:output'));
    });

    test('the session outlives every viewer', async () => {
        const a = await watch(ownerSession, sessionId);
        hostSays('live:output', { data: Buffer.from('kept') });
        await until(() => a.text() === 'kept');
        a.s.disconnect();
        await settle(200);
        expect(liveHub()!.stateOf(sessionId)).not.toBeNull();
        expect(liveHub()!.ringOf(sessionId)!.toString()).toBe('kept');
        expect((await rows(`SELECT state FROM agent_sessions WHERE id = $1`, [sessionId]))[0].state).toBe('live');
        const late = await watch(ownerSession, sessionId);
        await until(() => late.events.some(e => e.event === 'live:replay'));
    });

    test('a plain member, a stranger, a missing cookie, a bad origin and a wrong id get nothing', async () => {
        expect(await refusal(viewer(memberSession, sessionId))).toBe('forbidden');
        const stranger = await authedUser(api, 'livestranger');
        await createServer(api, stranger.auth, 'Elsewhere');
        expect(await refusal(viewer(await cookieLogin('livestranger'), sessionId))).toBe('forbidden');
        expect(await refusal(viewer(null, sessionId))).toBe('Authentication required');
        expect(await refusal(viewer(ownerSession, sessionId, { origin: 'https://evil.example' }))).toBe('origin_not_allowed');
        expect(await refusal(viewer(ownerSession, sessionId, { origin: null }))).toBe('origin_not_allowed');
        expect(await refusal(viewer(ownerSession, '01J00000000000000000000000'))).toBe('forbidden');
        expect(await refusal(viewer(ownerSession, 'not-an-id'))).toBe('forbidden');
        // A bearer token is not a browser session
        const bearer = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: { origin }, auth: { type: 'live-view', sessionId, token: owner.token } });
        sockets.push(bearer);
        expect(await refusal(bearer)).toBe('Authentication required');
        // A bot token never watches
        const bot = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: { ...edgeFor(box), origin }, auth: { type: 'live-view', sessionId, token: box.botToken } });
        sockets.push(bot);
        expect(await refusal(bot)).toBe('Authentication required');
        expect(liveHub()!.refusedViewers).toBeGreaterThanOrEqual(4);
    });

    test('the page route tells the owner and a director who they are, and everyone else nothing', async () => {
        const o = await api.get(`/servers/${serverId}/live-terminals/${sessionId}`).set('Cookie', ownerSession.cookie);
        expect(o.status).toBe(200);
        expect(o.body).toMatchObject({ role: 'owner', canType: true, profile: 'alpha', channelId, tokensMeasured: false, hostConnected: true });
        const d = await api.get(`/servers/${serverId}/live-terminals/${sessionId}`).set('Cookie', directorSession.cookie);
        expect(d.body).toMatchObject({ role: 'watcher', canType: false });
        expect((await api.get(`/servers/${serverId}/live-terminals/${sessionId}`).set('Cookie', memberSession.cookie)).status).toBe(404);
        expect((await api.get(`/servers/${serverId}/live-terminals/01J00000000000000000000000`).set('Cookie', ownerSession.cookie)).status).toBe(404);
        for (const auth of [{ Authorization: `Bot ${box.botToken}`, ...edgeFor(box) }, { Authorization: `AgentHost ${box.hostToken}`, ...edgeFor(box) }]) {
            expect((await api.get(`/servers/${serverId}/live-terminals/${sessionId}`).set(auth)).status).toBe(403);
        }
    });
});

describe('who may type', () => {
    test('a director who watches cannot send input, resize, take the keyboard or cause any byte to reach the terminal', async () => {
        const d = await watch(directorSession, sessionId);
        d.s.emit('live:take', { ack: true });
        d.s.emit('live:input', 'rm -rf /\r');
        d.s.emit('live:input', Buffer.from('x'));
        d.s.emit('live:resize', { cols: 50, rows: 10 });
        d.s.emit('shell:input', 'x');
        await settle(300);
        expect(host.input).toEqual([]);
        expect(host.resized).toEqual([]);
        expect(liveHub()!.deniedInput).toBeGreaterThanOrEqual(4);
        expect(d.events.some(e => e.event === 'live:taken')).toBe(false);
        expect(liveHub()!.stateOf(sessionId)!.controlsBy).toBeNull();
    });

    test('the owner types only after confirming, and only into the agent\'s terminal; the confirmation is on record', async () => {
        const o = await watch(ownerSession, sessionId);
        o.s.emit('live:input', 'before\r');
        o.s.emit('live:resize', { cols: 80, rows: 24 });
        await settle(200);
        expect(host.input).toEqual([]);
        expect(host.resized).toEqual([]);
        const taken = wait(o.s, 'live:taken');
        o.s.emit('live:take', { ack: true });
        await taken;
        o.s.emit('live:input', 'ls\r');
        o.s.emit('live:resize', { cols: 80, rows: 24 });
        await until(() => host.input.length === 1 && host.resized.length === 1);
        expect(host.input[0].toString()).toBe('ls\r');
        expect(host.resized[0]).toEqual({ sessionId, cols: 80, rows: 24 });
        const audit = await rows(`SELECT actor_id FROM audit_log WHERE action = 'live_terminal_take'`);
        expect(audit).toHaveLength(1);
        expect(audit[0].actor_id.trim()).toBe(owner.userId);
        // The one authoritative size is announced to every viewer
        const d = await watch(directorSession, sessionId);
        expect(d.hello).toMatchObject({ cols: 80, rows: 24 });
    });

    test('a bare take without an acknowledgement does not unlock typing', async () => {
        const o = await watch(ownerSession, sessionId);
        o.s.emit('live:take', {});
        o.s.emit('live:take', { ack: 'yes' });
        o.s.emit('live:input', 'x');
        await settle(200);
        expect(host.input).toEqual([]);
    });

    test('oversized input closes that viewer, not the agent', async () => {
        const o = await watch(ownerSession, sessionId);
        o.s.emit('live:take', { ack: true });
        await wait(o.s, 'live:taken');
        const exit = wait(o.s, 'live:exit');
        o.s.emit('live:input', Buffer.alloc(70 * 1024, 65));
        expect(await exit).toEqual({ reason: 'input_flood' });
        expect(liveHub()!.stateOf(sessionId)).not.toBeNull();
    });
});

describe('the owner has the controls', () => {
    const botSocket = async () => {
        const s = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: edgeFor(box), auth: { type: 'bot', token: box.botToken, mode: 'channel', client: 'claude-code' } });
        sockets.push(s);
        const holds: any[] = [];
        s.on('ChannelHold', h => holds.push(h));
        await connected(s);
        return { s, holds };
    };

    test('typing holds deliveries to the agent, going idle releases them, and viewers are told', async () => {
        const bot = await botSocket();
        const o = await watch(ownerSession, sessionId);
        const d = await watch(directorSession, sessionId);
        o.s.emit('live:take', { ack: true });
        await wait(o.s, 'live:taken');
        o.s.emit('live:input', 'a');
        await until(() => bot.holds.some(h => h.held === true));
        expect(bot.holds.find(h => h.held)).toMatchObject({ held: true, sessionId, reason: 'controls' });
        await until(() => d.events.some(e => e.event === 'live:controls' && e.data.held === true));
        expect(d.events.find(e => e.event === 'live:controls')!.data).toMatchObject({ by: 'liveowner', held: true });
        // 400 ms of idle (AGORA_LIVE_CONTROL_IDLE_MS) and the hold lifts
        await until(() => bot.holds.some(h => h.held === false), 5000);
        await until(() => d.events.some(e => e.event === 'live:controls' && e.data.held === false));
    });

    test('leaving the keyboard releases at once', async () => {
        const bot = await botSocket();
        const o = await watch(ownerSession, sessionId);
        o.s.emit('live:take', { ack: true });
        await wait(o.s, 'live:taken');
        o.s.emit('live:input', 'a');
        await until(() => bot.holds.some(h => h.held));
        o.s.disconnect();
        await until(() => bot.holds.some(h => h.held === false), 1000);
    });

    test('a channel that connects while the owner has the controls is told to hold', async () => {
        const o = await watch(ownerSession, sessionId);
        o.s.emit('live:take', { ack: true });
        await wait(o.s, 'live:taken');
        o.s.emit('live:input', 'a');
        await until(() => liveHub()!.isHeld(sessionBot()));
        const bot = await botSocket();
        await until(() => bot.holds.some(h => h.held === true));
    });
    const sessionBot = () => (globalThis as any).__liveBot as string;
    beforeEach(async () => { (globalThis as any).__liveBot = (await rows(`SELECT bot_id FROM agent_sessions WHERE id = $1`, [sessionId]))[0].bot_id.trim(); });
});

describe('state, turns and limits', () => {
    test('the box\'s states are kept, shown to viewers, and "waiting on you" says so in the channel', async () => {
        const w = await watch(ownerSession, sessionId);
        hostSays('live:state', { state: 'idle', note: null });
        await until(() => w.events.some(e => e.event === 'live:state' && e.data.state === 'idle'));
        hostSays('live:state', { state: 'waiting', note: 'no_signal' });
        await until(async () => (await rows(`SELECT live_state, live_note FROM agent_sessions WHERE id = $1`, [sessionId]))[0].live_note === 'no_signal');
        expect((await rows(`SELECT live_state FROM agent_sessions WHERE id = $1`, [sessionId]))[0].live_state).toBe('waiting');
        await until(async () => (await notices('%waiting on you%')).length === 1);
        // Fixed codes only: an invented state or note is ignored
        hostSays('live:state', { state: 'working', note: 'secret screen text' });
        await until(() => liveHub()!.stateOf(sessionId)!.state === 'working');
        expect(liveHub()!.stateOf(sessionId)!.note).toBeNull();
        hostSays('live:state', { state: 'exploding' });
        await settle(100);
        expect(liveHub()!.stateOf(sessionId)!.state).toBe('working');
    });

    test('a message turn is recorded with the branch and commit at both ends, and counts as one wake', async () => {
        const msg = (await api.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: '@alpha go' })).body.id as string;
        hostSays('live:turn', { phase: 'start', messageId: msg.trim(), branch: 'agora/alpha/x', sha: SHA1 });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns`)).length === 1);
        hostSays('live:turn', { phase: 'end', signal: 'stop_hook', branch: 'agora/alpha/x', sha: SHA2 });
        await until(async () => (await rows(`SELECT ended_at FROM live_terminal_turns`))[0].ended_at !== null);
        const turn = (await rows(`SELECT * FROM live_terminal_turns`))[0];
        expect(turn).toMatchObject({ source: 'message', message_id: msg.padEnd(26), branch: 'agora/alpha/x', start_sha: SHA1, end_sha: SHA2, end_signal: 'stop_hook', verified: true, unverified_reason: null });
        expect((await rows(`SELECT wakes_used FROM agent_sessions WHERE id = $1`, [sessionId]))[0].wakes_used).toBe(1);
    });

    test('a typed turn is not a wake; a turn with no idle signal or no commit is recorded as unverified, with the reason', async () => {
        hostSays('live:turn', { phase: 'start', messageId: null, branch: 'b', sha: SHA1 });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns`)).length === 1);
        hostSays('live:turn', { phase: 'end', signal: 'interrupted', branch: 'b', sha: SHA2 });
        await until(async () => (await rows(`SELECT ended_at FROM live_terminal_turns`))[0].ended_at !== null);
        expect((await rows(`SELECT source, verified, unverified_reason FROM live_terminal_turns`))[0]).toEqual({ source: 'typed', verified: false, unverified_reason: 'no_idle_signal' });
        expect((await rows(`SELECT wakes_used FROM agent_sessions WHERE id = $1`, [sessionId]))[0].wakes_used).toBe(0);
        hostSays('live:turn', { phase: 'start', messageId: null, branch: 'b', sha: null });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns`)).length === 2);
        hostSays('live:turn', { phase: 'end', signal: 'stop_hook', branch: 'b', sha: SHA2 });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns WHERE ended_at IS NOT NULL`)).length === 2);
        expect((await rows(`SELECT verified, unverified_reason FROM live_terminal_turns WHERE start_sha IS NULL`))[0]).toEqual({ verified: false, unverified_reason: 'no_commit_read' });
    });

    test('a bad commit or branch is not stored', async () => {
        hostSays('live:turn', { phase: 'start', messageId: 'nope', branch: 'a\u0000b', sha: 'not-a-sha' });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns`)).length === 1);
        expect((await rows(`SELECT branch, start_sha, message_id, source FROM live_terminal_turns`))[0]).toEqual({ branch: null, start_sha: null, message_id: null, source: 'typed' });
    });

    test('a box that disconnects mid-turn ends the turn as unverified and the state as stopped', async () => {
        const w = await watch(ownerSession, sessionId);
        hostSays('live:turn', { phase: 'start', messageId: null, branch: 'b', sha: SHA1 });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns`)).length === 1);
        host.socket.disconnect();
        await until(async () => (await rows(`SELECT end_signal FROM live_terminal_turns`))[0].end_signal === 'host_lost');
        await until(() => w.events.some(e => e.event === 'live:state' && e.data.state === 'stopped' && e.data.note === 'box_disconnected'));
        // It comes back by itself: the same session is offered again, and the screen is kept
        const again = await connectHost(box);
        await until(() => again.desired.length > 0);
        expect(again.desired[0].sessions[0].sessionId).toBe(sessionId);
    });

    test('the wake limit holds further messages and says so', async () => {
        await api.patch(`/servers/${serverId}/agent-profiles/${box.profileId}`).set(owner.auth).send({ wakeBudget: 1 });
        const bot = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: edgeFor(box), auth: { type: 'bot', token: box.botToken, mode: 'channel', client: 'claude-code' } });
        sockets.push(bot);
        const holds: any[] = [];
        bot.on('ChannelHold', h => holds.push(h));
        await connected(bot);
        const msg = (await api.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: '@alpha go' })).body.id as string;
        hostSays('live:turn', { phase: 'start', messageId: msg.trim(), branch: 'b', sha: SHA1 });
        await until(() => holds.some(h => h.held === true));
        expect(holds.find(h => h.held)).toMatchObject({ reason: 'wake_limit' });
        expect((await notices('%wake limit%')).length).toBe(1);
    });

    test('a turn past the run-time limit is interrupted once, and the channel is told', async () => {
        await api.patch(`/servers/${serverId}/agent-profiles/${box.profileId}`).set(owner.auth).send({ runTimeoutSec: 1 });
        await liveHub()!.sweep();
        hostSays('live:turn', { phase: 'start', messageId: null, branch: 'b', sha: SHA1 });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns`)).length === 1);
        await settle(1200);
        await liveHub()!.sweep();
        await liveHub()!.sweep();
        await until(() => host.interrupts === 1);
        await settle(200);
        expect(host.interrupts).toBe(1);
        expect((await notices('%run-time limit%')).length).toBe(1);
    });

    test('a running terminal with no Channel connection is reported, in the state and in the channel, never typed around', async () => {
        const w = await watch(ownerSession, sessionId);
        hostSays('live:state', { state: 'idle', note: null });
        await until(() => liveHub()!.stateOf(sessionId)!.state === 'idle');
        await settle(20);
        await liveHub()!.sweep();
        await until(() => w.events.some(e => e.event === 'live:state' && e.data.note === 'channel_unavailable'));
        expect((await notices('%Channel is not connected%')).length).toBe(1);
        await liveHub()!.sweep();
        expect((await notices('%Channel is not connected%')).length).toBe(1);
        expect(host.input).toEqual([]);
        // The channel connecting clears it
        const bot = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: edgeFor(box), auth: { type: 'bot', token: box.botToken, mode: 'channel', client: 'claude-code' } });
        sockets.push(bot);
        await connected(bot);
        await liveHub()!.sweep();
        await until(() => w.events.some(e => e.event === 'live:state' && e.data.note === null && e.data.state === 'idle'));
    });
});

describe('ending', () => {
    test('/end stops the terminal: viewers are told, the host is told to stop, and no one can watch it any more', async () => {
        const w = await watch(ownerSession, sessionId);
        const end = await api.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'end', profile: 'alpha' });
        expect(end.status, JSON.stringify(end.body)).toBe(200);
        await liveHub()!.sweep();
        expect(await wait(w.s, 'live:exit')).toEqual({ reason: 'session_ended' });
        await until(() => host.desired.length >= 2);
        expect(host.desired[host.desired.length - 1].sessions).toEqual([]);
        expect(await refusal(viewer(ownerSession, sessionId))).toBe('forbidden');
    });

    test('a viewer whose access was removed is dropped at the next check', async () => {
        const d = await watch(directorSession, sessionId);
        await ctx.db.query(`DELETE FROM member_roles WHERE user_id = $1`, [director.userId]).catch(() => {});
        await api.delete(`/servers/${serverId}/members/${director.userId}`).set(owner.auth);
        await liveHub()!.sweep();
        expect(await wait(d.s, 'live:exit')).toEqual({ reason: 'access_changed' });
    });
});

describe('backpressure and the ring', () => {
    test('a viewer that stops reading is dropped; the others and the agent are not held up', async () => {
        const a = await watch(ownerSession, sessionId);
        // A viewer whose transport queue is full: attached through the hub with a stand-in socket
        const slow: any = new EventEmitter();
        Object.assign(slow, { id: 'slow-1', connected: true, conn: { writeBuffer: [{ data: Buffer.alloc(8 * 1024 * 1024) }] }, emitted: [] as string[],
            emit(event: string) { slow.emitted.push(event); return true; }, disconnect() { slow.connected = false; return slow; } });
        liveHub()!.attachViewer(slow, { sessionId, userId: director.userId, username: 'livedirector', role: 'watcher', sessionEndsMs: Date.now() + 60_000 });
        hostSays('live:output', { data: Buffer.from('one') });
        hostSays('live:output', { data: Buffer.from('two') });
        await until(() => a.text() === 'onetwo');
        expect(slow.emitted).toContain('live:exit');
        expect(slow.emitted.filter((e: string) => e === 'live:output')).toHaveLength(0);
        expect(liveHub()!.stateOf(sessionId)!.viewers).toBe(1);
    });

    test('the host is told to slow down when it floods, and the ring stays bounded', async () => {
        for (let i = 0; i < 20; i++) hostSays('live:output', { data: Buffer.alloc(200 * 1024, 66) });
        await until(() => host.paced > 0);
        expect(liveHub()!.ringOf(sessionId)!.length).toBeLessThanOrEqual(RING_BYTES);
    });

    test('Ring keeps the newest bytes, cut inside one chunk if need be', () => {
        const r = new Ring(10);
        r.push(Buffer.from('abcdef'));
        r.push(Buffer.from('ghijkl'));
        expect(r.snapshot().toString()).toBe('cdefghijkl');
        r.push(Buffer.from('0123456789ABCDEF'));
        expect(r.snapshot().toString()).toBe('6789ABCDEF');
        r.clear();
        expect(r.length).toBe(0);
    });

    test('nothing the terminal printed is in the database or the audit log', async () => {
        hostSays('live:output', { data: Buffer.from('zq9-live-secret-marker-7731') });
        await settle(200);
        const tables = ['audit_log', 'messages', 'live_terminal_turns', 'agent_sessions'];
        for (const t of tables) expect(JSON.stringify(await rows(`SELECT * FROM ${t}`))).not.toContain('zq9-live-secret-marker');
    });
});
