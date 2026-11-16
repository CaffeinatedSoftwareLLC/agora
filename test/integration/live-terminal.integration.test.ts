import { EventEmitter } from 'node:events';
import { io, Socket } from 'socket.io-client';
import supertest from 'supertest';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { signEdge } from '../../src/lib/boxes/contract';
import { rotateBoxTokens } from '../../src/lib/boxes/tokens';
import { LiveHub, liveHub, Ring, RING_BYTES, MAX_TURNS_PER_SESSION } from '../../src/lib/boxes/live-hub';
import { generateUlid as ulid } from '../../src/utils/ulid';
import { agentPresence } from '../../src/lib/agent-presence';

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
process.env.AGORA_LIVE_DISPATCH_MS = '100';
process.env.AGORA_LIVE_SYNC_MS = '300';
process.env.AGORA_LIVE_REDELIVER_MS = '700';
process.env.AGORA_LIVE_ESCALATE_MS = '400';
process.env.AGORA_LIVE_UNDELIVERED_MS = '600000';
process.env.AGORA_LIVE_PACE_IGNORE_MS = '600';
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
interface FakeHost { socket: Socket; input: Buffer[]; resized: any[]; desired: any[]; interrupts: number; paced: number; redraws: number }

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
    const host: FakeHost = { socket: null as any, input: [], resized: [], desired: [], interrupts: 0, paced: 0, redraws: 0 };
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
    socket.on('live:redraw', () => host.redraws++);
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

/** The bot's Claude Code Channel connection (agora-mcp --channel-mode): what the server delivers to it, and the acknowledgements it sends. */
async function channelSocket() {
    const s = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: edgeFor(box), auth: { type: 'bot', token: box.botToken, mode: 'channel', client: 'claude-code' } });
    sockets.push(s);
    const deliveries: any[] = [];
    s.on('LiveDeliver', d => deliveries.push(d));
    await connected(s);
    return { s, deliveries };
}
async function postAs(who: { auth: object }, content: string): Promise<string> {
    const r = await api.post(`/channels/${channelId}/messages`).set(who.auth).send({ content });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id.trim();
}
const rows = async (sql: string, params: unknown[] = []) => (await ctx.db.query(sql, params)).rows;
const wakes = async () => Number((await rows(`SELECT wakes_used FROM agent_sessions WHERE id = $1`, [sessionId]))[0].wakes_used);
const botOf = () => botIdOfBox;
const notices = (like = '%') => rows(`SELECT content FROM messages WHERE channel_id = $1 AND system_event = 'agent_session' AND content LIKE $2 ORDER BY id`, [channelId, like]);

let ownerSession: Session, directorSession: Session, memberSession: Session;
let box: Box;
let host: FakeHost;
let sessionId: string;
let botIdOfBox = '';

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
    // The box's host has opened its live socket (a live session cannot be started before it has)
    host = await connectHost(box);
    sessionId = await startLive();
    botIdOfBox = (await rows(`SELECT bot_id FROM agent_sessions WHERE id = $1`, [sessionId]))[0].bot_id.trim();
    await until(() => host.desired.some(d => d.sessions.length > 0));
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

    test('a live-mode session is a hosted session that takes part in routing but is never claimed as a per-wake run', async () => {
        const row = (await rows(`SELECT live_mode, native_session_id FROM agent_sessions WHERE id = $1`, [sessionId]))[0];
        expect(row.live_mode).toBe(true);
        expect(row.native_session_id).toMatch(/^[0-9a-f-]{36}$/);
        const post = await api.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: '@alpha please look at the build' });
        expect(post.status).toBe(201);
        // Routing wrote its inbox row, as for any hosted session; the host's claim finds nothing to run
        expect(await rows(`SELECT 1 FROM agent_inbox WHERE session_id = $1 AND reason = 'direct'`, [sessionId])).toHaveLength(1);
        const hostAuth = { Authorization: `AgentHost ${box.hostToken}`, ...edgeFor(box) };
        expect((await api.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth)).status).toBe(204);
        expect(await rows(`SELECT 1 FROM agent_runs WHERE session_id = $1`, [sessionId])).toHaveLength(0);
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
        expect(host.desired.find(d => d.sessions.length)!.sessions).toEqual([expect.objectContaining({ sessionId, channelId, botId: expect.any(String), conversation: row.native_session_id, profile: 'alpha', cols: 120, rows: 32 })]);
        expect(host.desired.find(d => d.sessions.length)!.sessions[0]).not.toHaveProperty('token');
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
        const otherHost = await connectHost(other);
        const otherSession = (await api.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'start', profile: 'gamma', fresh: true })).body.session.id;
        await until(() => otherHost.desired.some(d => d.sessions.length > 0));
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
    test('typing holds deliveries to the agent, going idle releases them in order, and viewers are told', async () => {
        const ch = await channelSocket();
        const o = await watch(ownerSession, sessionId);
        const d = await watch(directorSession, sessionId);
        o.s.emit('live:take', { ack: true });
        await wait(o.s, 'live:taken');
        o.s.emit('live:input', 'a');
        await until(() => d.events.some(e => e.event === 'live:controls' && e.data.held === true));
        expect(d.events.find(e => e.event === 'live:controls')!.data).toMatchObject({ by: 'liveowner', held: true, reason: 'controls' });
        const first = await postAs(owner, '@alpha first while typing');
        const second = await postAs(owner, '@alpha second while typing');
        // Still typing: the keyboard stays active
        for (let i = 0; i < 5; i++) { o.s.emit('live:input', 'b'); await settle(150); }
        // Held on the server: nothing was sent, and no wake counted
        expect(ch.deliveries).toEqual([]);
        expect(await wakes()).toBe(0);
        // 400 ms of idle (AGORA_LIVE_CONTROL_IDLE_MS) and they go, in order
        await until(() => ch.deliveries.length === 2, 6000);
        expect(ch.deliveries.map(x => x.message.id.trim())).toEqual([first, second]);
        await until(() => d.events.some(e => e.event === 'live:controls' && e.data.held === false));
        expect(await wakes()).toBe(2);
    });

    test('leaving the keyboard releases at once', async () => {
        const ch = await channelSocket();
        const o = await watch(ownerSession, sessionId);
        o.s.emit('live:take', { ack: true });
        await wait(o.s, 'live:taken');
        o.s.emit('live:input', 'a');
        await until(() => liveHub()!.isHeld(botOf()));
        await postAs(owner, '@alpha wait for me');
        await settle(300);
        expect(ch.deliveries).toEqual([]);
        o.s.disconnect();
        await until(() => ch.deliveries.length === 1, 2500);
    });
});

describe('delivery: the server routes, the Channel carries', () => {
    test('a mention reaches the live session through the normal inbox, is counted as one wake when sent, and is pinned to the session', async () => {
        const ch = await channelSocket();
        const id = await postAs(owner, '@alpha please look at the build');
        await until(() => ch.deliveries.length === 1);
        const d = ch.deliveries[0];
        expect(d).toMatchObject({ sessionId, channelId, authority: 'owner' });
        expect(d.message).toMatchObject({ id, content: '@alpha please look at the build', authorUsername: 'liveowner' });
        expect(await wakes()).toBe(1);
        // Acknowledged: finished
        ch.s.emit('LiveAck', { sessionId, messageId: id });
        await until(async () => (await rows(`SELECT acked_at FROM agent_inbox WHERE message_id = $1`, [id]))[0].acked_at !== null);
        await settle(400);
        expect(ch.deliveries).toHaveLength(1);
        expect(await wakes()).toBe(1);
        // Only the bot's own session may acknowledge, and only what was sent
        expect(await liveHub()!.ack(botOf(), sessionId, id)).toBe(false);
        expect(await liveHub()!.ack('Z'.repeat(26), sessionId, id)).toBe(false);
    });

    test('a message in a channel the agent is not in, or addressed to another agent, never reaches the CLI', async () => {
        const ch = await channelSocket();
        const other = await api.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: 'elsewhere', channelType: 3 });
        expect(other.status).toBe(201);
        const m1 = await api.post(`/channels/${other.body.id}/messages`).set(owner.auth).send({ content: 'do the thing' });
        expect(m1.status).toBe(201);
        // Addressed to another agent: the server's routing leaves the live agent out
        const invite = await api.post(`/servers/${serverId}/agent-invites`).set(owner.auth).send({ username: 'OtherBot' });
        const redeemed = await api.post('/agent-invites/redeem').send({ code: invite.body.code });
        await api.post(`/channels/${channelId}/bots/${redeemed.body.botId}`).set(owner.auth);
        const toOther = await api.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: '@OtherBot please do the other thing' });
        expect(toOther.status).toBe(201);
        await settle(600);
        expect(ch.deliveries).toEqual([]);
        expect(await rows(`SELECT 1 FROM agent_inbox WHERE session_id = $1 AND reason <> 'command'`, [sessionId])).toHaveLength(0);
    });

    test('nothing is lost while the Channel is down: it is replayed in order when the connection comes up, the wake counted once', async () => {
        // The startup period: no channel connection yet
        const first = await postAs(owner, '@alpha one');
        const second = await postAs(owner, '@alpha two');
        await settle(500);
        expect(await wakes()).toBe(0);
        const a = await channelSocket();
        await until(() => a.deliveries.length === 2);
        expect(a.deliveries.map(x => x.message.id.trim())).toEqual([first, second]);
        // The CLI restarts before acknowledging: a new connection gets both again, in order
        a.s.disconnect();
        await settle(300);
        const b = await channelSocket();
        await until(() => b.deliveries.length === 2);
        expect(b.deliveries.map(x => x.message.id.trim())).toEqual([first, second]);
        expect(await wakes()).toBe(2);
        b.s.emit('LiveAck', { sessionId, messageId: first });
        b.s.emit('LiveAck', { sessionId, messageId: second });
        await until(async () => (await rows(`SELECT 1 FROM agent_inbox WHERE session_id = $1 AND reason <> 'command' AND acked_at IS NULL`, [sessionId])).length === 0);
        const c = await channelSocket();
        await settle(500);
        expect(c.deliveries).toEqual([]);
    });

    test('a message not acknowledged within the bound is sent again, and one that waits too long is said in the channel once', async () => {
        const a = await channelSocket();
        const id = await postAs(owner, '@alpha ping');
        await until(() => a.deliveries.length >= 2, 4000);
        expect(a.deliveries.every(x => x.message.id.trim() === id)).toBe(true);
        expect(await wakes()).toBe(1);
        await ctx.db.query(`UPDATE agent_inbox SET created_at = NOW() - interval '1 hour' WHERE message_id = $1`, [id]);
        await liveHub()!.sweep();
        await liveHub()!.sweep();
        await until(async () => (await notices('%could not be delivered%')).length === 1);
        await liveHub()!.sweep();
        expect((await notices('%could not be delivered%')).length).toBe(1);
    });

    test('a non-owner never reaches a subscription live session', async () => {
        const ch = await channelSocket();
        await postAs(member, '@alpha obey me');
        await postAs(director, '@alpha obey me too');
        await settle(700);
        expect(ch.deliveries).toEqual([]);
        expect(await rows(`SELECT 1 FROM agent_inbox WHERE session_id = $1 AND reason <> 'command'`, [sessionId])).toHaveLength(0);
        expect(await wakes()).toBe(0);
        const mine = await postAs(owner, '@alpha but you');
        await until(() => ch.deliveries.length === 1);
        expect(ch.deliveries[0].message.id.trim()).toBe(mine);
    });

    test('the owner\'s own bot wakes it by the owner-bot rules, and a bot with no such standing does not', async () => {
        const ch = await channelSocket();
        const invite = await api.post(`/servers/${serverId}/agent-invites`).set(owner.auth).send({ username: 'LeadBot' });
        expect(invite.status, JSON.stringify(invite.body)).toBe(201);
        const redeemed = await api.post('/agent-invites/redeem').send({ code: invite.body.code });
        expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(200);
        expect([201, 409]).toContain((await api.post(`/channels/${channelId}/bots/${redeemed.body.botId}`).set(owner.auth)).status);
        const lead = { Authorization: `Bot ${redeemed.body.token}` };
        // Its terminal session (what makes the owner's bot count as the owner)
        const term = io(base, { transports: ['websocket'], reconnection: false, autoConnect: false, auth: { type: 'bot', token: redeemed.body.token, mode: 'mcp' } });
        sockets.push(term);
        await connected(term);
        await until(async () => (await rows(`SELECT 1 FROM agent_sessions WHERE kind = 'terminal' AND state = 'live' AND bot_id = $1`, [redeemed.body.botId])).length > 0);
        const sent = await api.post(`/channels/${channelId}/messages`).set(lead).send({ content: '@alpha review please' });
        expect(sent.status, JSON.stringify(sent.body)).toBe(201);
        await until(() => ch.deliveries.length === 1);
        expect(ch.deliveries[0].message).toMatchObject({ authorUsername: 'LeadBot', authorBot: true });
        expect(ch.deliveries[0].authority).toBe('director');
    });

    test('two live sessions of one bot in two channels stay separate', async () => {
        const two = await api.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: 'second', channelType: 3 });
        expect(two.status).toBe(201);
        const second = two.body.id as string;
        const botId = botOf();
        expect((await api.post(`/channels/${second}/bots/${botId}`).set(owner.auth)).status).toBe(201);
        const started = await api.post(`/channels/${second}/agent-commands`).set(owner.auth).send({ command: 'start', profile: box.name, fresh: true });
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        const secondSession = started.body.session.id as string;
        await until(() => host.desired.some(d => d.sessions.length === 2));
        const ch = await channelSocket();
        const a = await postAs(owner, '@alpha in the first');
        const b = (await api.post(`/channels/${second}/messages`).set(owner.auth).send({ content: '@alpha in the second' })).body.id.trim();
        await until(() => ch.deliveries.length === 2);
        const byId = new Map(ch.deliveries.map(x => [x.message.id.trim(), x]));
        expect(byId.get(a)).toMatchObject({ sessionId, channelId });
        expect(byId.get(b)).toMatchObject({ sessionId: secondSession, channelId: second });
        expect(await rows(`SELECT session_id FROM agent_inbox WHERE message_id = $1`, [a])).toEqual([expect.objectContaining({ session_id: sessionId.padEnd(26) })]);
    });

    test('the wake limit, read at the moment of sending, holds further messages and says so once', async () => {
        await api.patch(`/servers/${serverId}/agent-profiles/${box.profileId}`).set(owner.auth).send({ wakeBudget: 1 });
        const ch = await channelSocket();
        const first = await postAs(owner, '@alpha one');
        await until(() => ch.deliveries.length === 1);
        const second = await postAs(owner, '@alpha two');
        await until(async () => (await notices('%wake limit%')).length === 1);
        await settle(500);
        expect(ch.deliveries.map(x => x.message.id.trim())).toEqual([first]);
        expect(await wakes()).toBe(1);
        expect(liveHub()!.isHeld(botOf())).toBe(true);
        expect((await notices('%wake limit%')).length).toBe(1);
        // Lifting the limit lets the held one go
        await api.patch(`/servers/${serverId}/agent-profiles/${box.profileId}`).set(owner.auth).send({ wakeBudget: null });
        await until(() => ch.deliveries.some(x => x.message.id.trim() === second), 8000);
        expect(await wakes()).toBe(2);
    });
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

    test('a turn is recorded with the branch and commit at both ends; it is "from a message" only if the server delivered that message', async () => {
        const ch = await channelSocket();
        const msg = await postAs(owner, '@alpha go');
        await until(() => ch.deliveries.length === 1);
        hostSays('live:turn', { phase: 'start', messageId: msg, branch: 'agora/alpha/x', sha: SHA1 });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns`)).length === 1);
        hostSays('live:turn', { phase: 'end', signal: 'stop_hook', branch: 'agora/alpha/x', sha: SHA2 });
        await until(async () => (await rows(`SELECT ended_at FROM live_terminal_turns`))[0].ended_at !== null);
        expect((await rows(`SELECT * FROM live_terminal_turns`))[0]).toMatchObject({ source: 'message', message_id: msg.padEnd(26), branch: 'agora/alpha/x', start_sha: SHA1, end_sha: SHA2, end_signal: 'stop_hook', agent_reported_clean: true, unverified_reason: null });
        // A message id the server never delivered to this session is a typed turn, whatever the hook says
        const other = (await api.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'not for the agent' })).body.id.trim();
        hostSays('live:turn', { phase: 'start', messageId: other, branch: 'b', sha: SHA1 });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns`)).length === 2);
        expect((await rows(`SELECT source, message_id FROM live_terminal_turns ORDER BY id DESC LIMIT 1`))[0]).toEqual({ source: 'typed', message_id: null });
        // The turn made no wake of its own: only the delivery did
        expect(await wakes()).toBe(1);
    });

    test('a typed turn is not a wake; a turn with no idle signal or no commit is not agent_reported_clean, with the reason', async () => {
        hostSays('live:turn', { phase: 'start', messageId: null, branch: 'b', sha: SHA1 });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns`)).length === 1);
        hostSays('live:turn', { phase: 'end', signal: 'interrupted', branch: 'b', sha: SHA2 });
        await until(async () => (await rows(`SELECT ended_at FROM live_terminal_turns`))[0].ended_at !== null);
        expect((await rows(`SELECT source, agent_reported_clean, unverified_reason FROM live_terminal_turns`))[0]).toEqual({ source: 'typed', agent_reported_clean: false, unverified_reason: 'no_idle_signal' });
        expect(await wakes()).toBe(0);
        hostSays('live:turn', { phase: 'start', messageId: null, branch: 'b', sha: null });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns`)).length === 2);
        hostSays('live:turn', { phase: 'end', signal: 'stop_hook', branch: 'b', sha: SHA2 });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns WHERE ended_at IS NOT NULL`)).length === 2);
        expect((await rows(`SELECT agent_reported_clean, unverified_reason FROM live_terminal_turns WHERE start_sha IS NULL`))[0]).toEqual({ agent_reported_clean: false, unverified_reason: 'no_commit_read' });
    });

    test('a bad commit or branch is not stored', async () => {
        hostSays('live:turn', { phase: 'start', messageId: 'nope', branch: 'a\u0000b', sha: 'not-a-sha' });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns`)).length === 1);
        expect((await rows(`SELECT branch, start_sha, message_id, source FROM live_terminal_turns`))[0]).toEqual({ branch: null, start_sha: null, message_id: null, source: 'typed' });
    });

    test('concurrent turn starts leave exactly one open row; the rest are closed as superseded', async () => {
        for (let i = 0; i < 6; i++) hostSays('live:turn', { phase: 'start', messageId: null, branch: 'b', sha: SHA1 });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns`)).length === 6);
        await settle(200);
        expect(await rows(`SELECT 1 FROM live_terminal_turns WHERE ended_at IS NULL`)).toHaveLength(1);
        expect(await rows(`SELECT 1 FROM live_terminal_turns WHERE unverified_reason = 'superseded'`)).toHaveLength(5);
    });

    test('a start and its end sent back to back are recorded in order', async () => {
        hostSays('live:turn', { phase: 'start', messageId: null, branch: 'b', sha: SHA1 });
        hostSays('live:turn', { phase: 'end', signal: 'stop_hook', branch: 'b', sha: SHA2 });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns WHERE ended_at IS NOT NULL`)).length === 1);
        expect(await rows(`SELECT 1 FROM live_terminal_turns WHERE ended_at IS NULL`)).toHaveLength(0);
    });

    test('a turn row left open by an earlier life of the server is closed when a hub starts', async () => {
        await ctx.db.query(`INSERT INTO live_terminal_turns (id, session_id, server_id, channel_id, source) SELECT $1, id, server_id, channel_id, 'typed' FROM agent_sessions WHERE id = $2`, [ulid(), sessionId]);
        const fresh = new LiveHub(ctx.db, () => {}, { emitToBot() {}, botChannelConnected: () => false });
        await fresh.start();
        await fresh.stop();
        expect(await rows(`SELECT 1 FROM live_terminal_turns WHERE ended_at IS NULL`)).toHaveLength(0);
        expect((await rows(`SELECT unverified_reason FROM live_terminal_turns`))[0].unverified_reason).toBe('server_restarted');
    });

    test('turn rows are kept per session up to a bound', async () => {
        for (let i = 0; i < MAX_TURNS_PER_SESSION + 3; i++) {
            await ctx.db.query(`INSERT INTO live_terminal_turns (id, session_id, server_id, channel_id, source, ended_at) SELECT $1, id, server_id, channel_id, 'typed', NOW() FROM agent_sessions WHERE id = $2`, [ulid(), sessionId]);
        }
        hostSays('live:turn', { phase: 'start', messageId: null, branch: 'b', sha: SHA1 });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns WHERE ended_at IS NULL`)).length === 1);
        expect((await rows(`SELECT count(*)::int AS n FROM live_terminal_turns`))[0].n).toBe(MAX_TURNS_PER_SESSION);
    });

    test('a box that disconnects mid-turn ends the turn and the state as stopped, and comes back by itself', async () => {
        const w = await watch(ownerSession, sessionId);
        hostSays('live:turn', { phase: 'start', messageId: null, branch: 'b', sha: SHA1 });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns`)).length === 1);
        host.socket.disconnect();
        await until(async () => (await rows(`SELECT end_signal FROM live_terminal_turns`))[0].end_signal === 'host_lost');
        await until(() => w.events.some(e => e.event === 'live:state' && e.data.state === 'stopped' && e.data.note === 'box_disconnected'));
        const again = await connectHost(box);
        await until(() => again.desired.length > 0);
        expect(again.desired[0].sessions[0].sessionId).toBe(sessionId);
    });

    test('a turn past the run-time limit is stopped step by step when the CLI ignores Escape: Escape, Escape, Ctrl-C, restart, one notice each', async () => {
        await api.patch(`/servers/${serverId}/agent-profiles/${box.profileId}`).set(owner.auth).send({ runTimeoutSec: 1 });
        await liveHub()!.sweep();
        hostSays('live:turn', { phase: 'start', messageId: null, branch: 'b', sha: SHA1 });
        await until(async () => (await rows(`SELECT 1 FROM live_terminal_turns`)).length === 1);
        // The agent never reports an end: the steps come from the server's clock alone
        const steps: number[] = [];
        host.socket.on('live:interrupt', m => steps.push(m.step));
        for (let i = 0; i < 40 && steps.length < 4; i++) { await settle(300); await liveHub()!.sweep(); }
        expect(steps).toEqual([1, 2, 3, 4]);
        await liveHub()!.sweep();
        await liveHub()!.sweep();
        expect(steps).toEqual([1, 2, 3, 4]);
        await until(async () => (await notices('%run-time limit%')).length === 4);
        const texts = (await notices('%run-time limit%')).map(n => n.content);
        expect(texts[0]).toMatch(/interrupted \(Escape\)/);
        expect(texts[1]).toMatch(/again \(Escape\)/);
        expect(texts[2]).toMatch(/Ctrl-C/);
        expect(texts[3]).toMatch(/stopped and started again/);
    });

    test('a running terminal with no Channel connection is reported, in the state and in the channel, never typed around', async () => {
        const botId = botOf();
        await until(() => agentPresence.status(botId).status === 'offline');
        const w = await watch(ownerSession, sessionId);
        hostSays('live:state', { state: 'idle', note: null });
        await until(() => liveHub()!.stateOf(sessionId)!.state === 'idle');
        await settle(20);
        await liveHub()!.sweep();
        await until(() => w.events.some(e => e.event === 'live:state' && e.data.note === 'channel_unavailable'));
        await until(async () => (await notices('%Channel is not connected%')).length === 1);
        await liveHub()!.sweep();
        expect((await notices('%Channel is not connected%')).length).toBe(1);
        expect(host.input).toEqual([]);
        // The channel connecting clears it
        await channelSocket();
        await liveHub()!.sweep();
        await until(() => w.events.some(e => e.event === 'live:state' && e.data.note === null && e.data.state === 'idle'));
    });
});

describe('a host that misbehaves', () => {
    test('a flood of control events drops the host and is counted; the session itself stays', async () => {
        const before = liveHub()!.hostFloods;
        for (let i = 0; i < 200; i++) hostSays('live:state', { state: i % 2 ? 'idle' : 'working', note: null });
        await until(() => liveHub()!.hostFloods > before);
        await until(() => !host.socket.connected);
        expect(liveHub()!.stateOf(sessionId)).not.toBeNull();
        expect((await rows(`SELECT state FROM agent_sessions WHERE id = $1`, [sessionId]))[0].state).toBe('live');
    });

    test('"waiting on you" is said at most once per ten minutes however often the host flips', async () => {
        for (let i = 0; i < 8; i++) { hostSays('live:state', { state: 'waiting', note: 'notification' }); hostSays('live:state', { state: 'idle', note: null }); await settle(30); }
        await until(async () => (await notices('%waiting on you%')).length >= 1);
        await settle(300);
        expect((await notices('%waiting on you%')).length).toBe(1);
    });

    test('a host that keeps ignoring "slow down" is dropped', async () => {
        for (let i = 0; i < 12; i++) hostSays('live:output', { data: Buffer.alloc(200 * 1024, 66) });
        await until(() => host.paced > 0);
        for (let i = 0; i < 12; i++) { await settle(120); hostSays('live:output', { data: Buffer.alloc(200 * 1024, 66) }); }
        await until(() => !host.socket.connected, 8000);
    });

    test('an old-generation host socket is dropped at the next check, and the box\'s live sessions show stopped', async () => {
        const w = await watch(ownerSession, sessionId);
        await ctx.db.query(`UPDATE agent_boxes SET generation = generation + 1 WHERE id = $1`, [box.id]);
        await liveHub()!.sweep();
        await until(() => !host.socket.connected);
        await until(() => w.events.some(e => e.event === 'live:state' && e.data.state === 'stopped'));
    });

    test('a revoked host token is dropped at the next check', async () => {
        await ctx.db.query(`UPDATE agent_hosts SET revoked_at = NOW() WHERE box_id = $1`, [box.id]);
        await liveHub()!.sweep();
        await until(() => !host.socket.connected);
    });
});

describe('viewers', () => {
    test('a person holds at most five pages open on one session', async () => {
        const open: Awaited<ReturnType<typeof watch>>[] = [];
        for (let i = 0; i < 5; i++) open.push(await watch(directorSession, sessionId));
        expect(await refusal(viewer(directorSession, sessionId))).toBe('too_many_viewers');
        // Someone else still can
        await watch(ownerSession, sessionId);
        expect(open).toHaveLength(5);
    });

    test('a viewer whose cookie session was revoked is dropped at the next check, with the account check the gateway uses', async () => {
        const d = await watch(directorSession, sessionId);
        await ctx.db.query(`UPDATE users SET token_version = token_version + 1 WHERE id = $1`, [director.userId]);
        await liveHub()!.sweep();
        expect(await wait(d.s, 'live:exit')).toEqual({ reason: 'access_changed' });
    });

    test('a suspended person is dropped too', async () => {
        const d = await watch(directorSession, sessionId);
        await ctx.db.query(`UPDATE users SET account_status = 'suspended' WHERE id = $1`, [director.userId]);
        await liveHub()!.sweep();
        expect(await wait(d.s, 'live:exit')).toEqual({ reason: 'access_changed' });
    });

    test('a new viewer makes the CLI redraw, at most every few seconds', async () => {
        const before = host.redraws;
        await watch(ownerSession, sessionId);
        await until(() => host.redraws > before);
        const mid = host.redraws;
        await watch(directorSession, sessionId);
        await settle(300);
        expect(host.redraws).toBe(mid);
    });

    test('typing waits for the confirmation to be on record', async () => {
        const o = await watch(ownerSession, sessionId);
        o.s.emit('live:take', { ack: true });
        await wait(o.s, 'live:taken');
        expect((await rows(`SELECT 1 FROM audit_log WHERE action = 'live_terminal_take'`)).length).toBe(1);
    });
});

describe('starting and the mode switch', () => {
    const end = () => api.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'end', profile: box.name });
    const start = () => api.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'start', profile: box.name, fresh: true });

    test('/start is refused with the reason when the box is on an image without live terminals, has no connected host, or is not running', async () => {
        await end();
        await ctx.db.query(`UPDATE agent_hosts SET live_protocol = NULL WHERE box_id = $1`, [box.id]);
        const old = await start();
        expect(old.status).toBe(409);
        expect(old.body).toMatchObject({ error: 'live_terminal_unavailable' });
        expect(old.body.message).toMatch(/older than live terminals|has not connected/);
        await ctx.db.query(`UPDATE agent_hosts SET live_protocol = 1 WHERE box_id = $1`, [box.id]);
        await ctx.db.query(`UPDATE agent_boxes SET state = 'stopped' WHERE id = $1`, [box.id]);
        const stopped = await start();
        expect(stopped.status).toBe(409);
        expect(stopped.body.message).toMatch(/box is not running/);
        await ctx.db.query(`UPDATE agent_boxes SET state = 'running' WHERE id = $1`, [box.id]);
        expect((await start()).status).toBe(201);
    });

    test('flipping the mode leaves thread-scoped sessions alone and moves the channel one only when it is resumed in the new mode', async () => {
        const thread = (await api.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'a thread root' })).body.id.trim();
        await end();
        await ctx.db.query(
            `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by, state, kind, thread_id, live_mode)
             SELECT $1, server_id, channel_id, bot_id, profile_id, started_by, 'shelved', 'hosted', $2, false FROM agent_sessions WHERE id = $3`, [ulid(), thread, sessionId]);
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved' WHERE id = $1`, [sessionId]);
        const flip = await api.patch(`/servers/${serverId}/agent-profiles/${box.profileId}`).set(owner.auth).send({ sessionMode: 'runs' });
        expect(flip.status, JSON.stringify(flip.body)).toBe(200);
        expect((await rows(`SELECT live_mode FROM agent_sessions WHERE thread_id IS NOT NULL`))[0].live_mode).toBe(false);
        expect((await rows(`SELECT live_mode FROM agent_sessions WHERE id = $1`, [sessionId]))[0].live_mode).toBe(false);
        const back = await api.patch(`/servers/${serverId}/agent-profiles/${box.profileId}`).set(owner.auth).send({ sessionMode: 'live' });
        expect(back.status).toBe(200);
        expect((await rows(`SELECT live_mode FROM agent_sessions WHERE thread_id IS NOT NULL`))[0].live_mode).toBe(false);
        expect((await rows(`SELECT live_mode FROM agent_sessions WHERE id = $1`, [sessionId]))[0].live_mode).toBe(true);
    });

    test('a task or subtask session of a live agent is an ordinary per-wake session in its own thread, and is not put on standby', async () => {
        const thread = (await api.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'task root' })).body.id.trim();
        const id = ulid();
        await ctx.db.query(
            `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by, state, kind, thread_id, live_mode)
             SELECT $1, server_id, channel_id, bot_id, profile_id, started_by, 'live', 'hosted', $2, false FROM agent_sessions WHERE id = $3`, [id, thread, sessionId]);
        const reply = await api.post(`/channels/${channelId}/messages/${thread}/replies`).set(owner.auth).send({ content: '@alpha work on this task' });
        expect(reply.status, JSON.stringify(reply.body)).toBe(201);
        await until(async () => (await rows(`SELECT 1 FROM agent_inbox WHERE session_id = $1 AND reason <> 'command'`, [id])).length === 1);
        // ... and the host's normal claim finds it (a per-wake run), while the live session is still skipped
        const hostAuth = { Authorization: `AgentHost ${box.hostToken}`, ...edgeFor(box) };
        const claim = await api.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
        expect(claim.status, JSON.stringify(claim.body)).toBe(200);
        expect(claim.body.session.id).toBe(id);
    });

    test('the host asks whether it should open its live socket at all', async () => {
        const hostAuth = { Authorization: `AgentHost ${box.hostToken}`, ...edgeFor(box) };
        expect((await api.get('/agent-hosts/@me/live').set(hostAuth)).body).toEqual({ enabled: true });
        await end();
        await api.patch(`/servers/${serverId}/agent-profiles/${box.profileId}`).set(owner.auth).send({ sessionMode: 'runs' });
        expect((await api.get('/agent-hosts/@me/live').set(hostAuth)).body).toEqual({ enabled: false });
    });
});

describe('ending', () => {
    test('/end stops the terminal: viewers are told, the host is told to stop, and no one can watch it any more', async () => {
        const w = await watch(ownerSession, sessionId);
        const end = await api.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'end', profile: 'alpha' });
        expect(end.status, JSON.stringify(end.body)).toBe(200);
        await liveHub()!.sweep();
        await until(() => w.events.some(e => e.event === 'live:exit'));
        expect(w.events.find(e => e.event === 'live:exit')!.data).toEqual({ reason: 'session_ended' });
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
