import { io, Socket } from 'socket.io-client';
import supertest from 'supertest';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { signEdge } from '../../src/lib/boxes/contract';
import { rotateBoxTokens } from '../../src/lib/boxes/tokens';
import { shellHub } from '../../src/lib/boxes/shell-hub';

/**
 * The terminal in a box (docs/box-terminal.md, docs/planning/box-terminal.md): every refusal of
 * "who may open one", the takeover rule, the audit entries and channel notices, the limits, and
 * that nothing the shell says is ever stored or logged. The box's agora-host is played by a fake
 * socket client that echoes; the real host and a real box are in agora-host's tests and test/boxes.
 */

const EDGE_SECRET = '34'.repeat(32);
process.env.AGORA_EDGE_SECRET = EDGE_SECRET;
const PASSWORD = 'TestPass123!';
const MARKER = 'zq9-secret-terminal-marker-7731';

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
interface Box { id: string; name: string; generation: number; hostToken: string; botToken: string }
interface FakeHost { socket: Socket; opened: any[]; input: Buffer[]; resized: any[]; closed: any[]; echo: boolean }

async function cookieLogin(login: string): Promise<Session> {
    const res = await api.post('/auth/login').set('X-Agora-Session', 'cookie').send({ login, password: PASSWORD });
    expect(res.status).toBe(200);
    const set: string[] = res.headers['set-cookie'];
    const value = (n: string) => set.find(c => c.startsWith(`${n}=`))!.split(';')[0].slice(n.length + 1);
    return { cookie: `agora_session=${value('agora_session')}; agora_csrf=${value('agora_csrf')}`, csrf: value('agora_csrf') };
}

async function makeBox(name: string, running = true): Promise<Box> {
    const res = await api.post(`/servers/${serverId}/boxes`).set(owner.auth).send({ name, adapter: 'claude', homeChannelId: channelId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const t = await rotateBoxTokens(ctx.db, res.body.box.id);
    if (running) await ctx.db.query(`UPDATE agent_boxes SET state = 'running' WHERE id = $1`, [res.body.box.id]);
    return { id: res.body.box.id, name, generation: t.generation, hostToken: t.hostToken, botToken: t.botToken };
}

const edgeFor = (box: Box, generation = box.generation) => signEdge(EDGE_SECRET, box.id, generation);

/** The box's agora-host: connects as a host through its own edge and echoes input as output. */
async function connectHost(box: Box, opts: { protocol?: number; token?: string; headers?: Record<string, string> } = {}): Promise<FakeHost> {
    const host: FakeHost = { socket: null as any, opened: [], input: [], resized: [], closed: [], echo: true };
    const socket = io(base, {
        transports: ['websocket'], autoConnect: false, reconnection: false,
        extraHeaders: opts.headers ?? edgeFor(box),
        auth: { type: 'host', token: opts.token ?? box.hostToken, shellProtocol: opts.protocol ?? 1 },
    });
    sockets.push(socket);
    host.socket = socket;
    socket.on('shell:open', m => { host.opened.push(m); socket.emit('shell:opened', { sessionId: m.sessionId }); });
    socket.on('shell:input', m => {
        host.input.push(Buffer.from(m.data));
        if (host.echo) socket.emit('shell:output', { sessionId: m.sessionId, data: Buffer.concat([Buffer.from('echo:'), Buffer.from(m.data)]) });
    });
    socket.on('shell:resize', m => host.resized.push(m));
    socket.on('shell:close', m => host.closed.push(m));
    await connected(socket);
    return host;
}

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

function browser(session: Session | null, ticket: string | null, o: { origin?: string | null; extra?: object; headers?: object } = {}): Socket {
    const socket = io(base, {
        transports: ['websocket'], autoConnect: false, reconnection: false,
        extraHeaders: { ...(session ? { cookie: session.cookie } : {}), ...(o.origin === null ? {} : { origin: o.origin ?? origin }), ...(o.headers ?? {}) } as any,
        auth: { type: 'shell', ...(ticket ? { ticket } : {}), ...(o.extra ?? {}) },
    });
    sockets.push(socket);
    return socket;
}

const ticketFor = (box: Box, s: Session, body: object = { password: PASSWORD }, o: { origin?: string | null; csrf?: string | null; cookie?: string | null } = {}) => {
    let r = api.post(`/boxes/${box.id}/terminal/ticket`).set('X-Agora-Session', 'cookie');
    if (o.cookie !== null) r = r.set('Cookie', o.cookie ?? s.cookie);
    if (o.csrf !== null) r = r.set('X-CSRF-Token', o.csrf ?? s.csrf);
    if (o.origin !== null) r = r.set('Origin', o.origin ?? origin);
    return r.send(body);
};
const getTicket = async (box: Box, s: Session) => {
    const r = await ticketFor(box, s);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.ticket as string;
};

/** Open a terminal end to end; returns the browser socket once the shell is ready. */
async function openTerminal(box: Box, s: Session) {
    const socket = browser(s, await getTicket(box, s));
    await connected(socket);
    const ready = wait(socket, 'shell:ready');
    socket.emit('shell:start', { cols: 100, rows: 30 });
    await ready;
    return socket;
}
const rows = async (sql: string, params: unknown[] = []) => (await ctx.db.query(sql, params)).rows;
const audits = (action: string) => rows(`SELECT actor_id, target_id, changes FROM audit_log WHERE action = $1 ORDER BY created_at, id`, [action]);
const notices = () => rows(`SELECT content FROM messages WHERE channel_id = $1 AND system_event = 'agent_session' AND content LIKE '%terminal%' ORDER BY id`, [channelId]);
const sessionRows = () => rows(`SELECT * FROM box_shell_sessions ORDER BY opened_at, id`);

let ownerSession: Session;
let box: Box;
let host: FakeHost;

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
    owner = await authedUser(api, 'termowner');
    member = await authedUser(api, 'termmember');
    director = await authedUser(api, 'termdirector');
    const s = await createServer(api, owner.auth, 'Terminals');
    serverId = s.serverId; channelId = s.generalChannelId;
    await joinViaInvite(api, owner.auth, member.auth, serverId);
    await joinViaInvite(api, owner.auth, director.auth, serverId);
    const role = await api.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Orchestrator', permissions: (1n << 29n).toString() });
    await api.put(`/servers/${serverId}/members/${director.userId}/roles/${role.body.id}`).set(owner.auth);
    ownerSession = await cookieLogin('termowner');
    box = await makeBox('alpha');
    host = await connectHost(box);
});
afterEach(async () => {
    for (const s of sockets.splice(0)) s.disconnect();
    // Let the hub finish what the disconnects set off before the next test truncates the tables
    const hub = shellHub();
    for (let i = 0; i < 40 && hub && hub.liveCount() > 0; i++) await settle(25);
    await hub?.drain();
});
afterAll(async () => { await ctx.close(); });

describe('the happy path', () => {
    test('ticket, socket, shell, input, output, resize, close: audit entries and channel notices', async () => {
        const status = await api.get(`/boxes/${box.id}/terminal`).set('Cookie', ownerSession.cookie);
        expect(status.body).toMatchObject({ supported: true, hostConnected: true, running: true, open: null, limits: { idleMinutes: 15, maxHours: 8, rateKbps: 512 } });

        const term = await openTerminal(box, ownerSession);
        expect(host.opened).toHaveLength(1);
        expect(host.opened[0]).toMatchObject({ cols: 100, rows: 30, rateBytesPerSecond: 512 * 1024 });
        expect((await sessionRows())[0]).toMatchObject({ state: 'open', box_id: box.id, opened_by: owner.userId });

        const out = wait(term, 'shell:output');
        term.emit('shell:input', 'ls\r');
        expect(Buffer.from(await out).toString()).toBe('echo:ls\r');
        term.emit('shell:input', Buffer.from([0x03]));
        term.emit('shell:resize', { cols: 120, rows: 40 });
        await settle();
        expect(host.resized).toEqual([{ sessionId: host.opened[0].sessionId, cols: 120, rows: 40 }]);

        // Everyone in the channel sees that a terminal is open, and what it does to wakes
        const open = await notices();
        expect(open).toHaveLength(1);
        expect(open[0].content).toBe(`**termowner** has a terminal open in **alpha**'s box. New wakes for this agent are paused until it closes.`);
        const openAudit = await audits('box_terminal_open');
        expect(openAudit).toHaveLength(1);
        expect(openAudit[0].actor_id.trim()).toBe(owner.userId);
        const state = await api.get(`/boxes/${box.id}/terminal`).set('Cookie', ownerSession.cookie);
        expect(state.body.open).toMatchObject({ openedByName: 'termowner', mine: true });

        const exit = wait(term, 'shell:exit');
        term.emit('shell:close');
        expect(await exit).toEqual({ reason: 'closed_by_owner' });
        await settle();
        expect(host.closed).toHaveLength(1);
        const closed = (await audits('box_terminal_close'))[0].changes;
        expect(closed).toMatchObject({ name: 'alpha', reason: 'closed_by_owner', opened: true, bytesIn: 4, bytesOut: 14 });
        expect(typeof closed.durationSeconds).toBe('number');
        const all = await notices();
        expect(all).toHaveLength(2);
        expect(all[1].content).toMatch(/^\*\*termowner\*\*'s terminal in \*\*alpha\*\*'s box closed after \d+s \(closed by its owner\)\. Wakes for this agent resume\.$/);
        expect((await sessionRows())[0]).toMatchObject({ state: 'closed', close_reason: 'closed_by_owner', bytes_in: '4', bytes_out: '14' });

        // The owner's record
        const list = await api.get(`/boxes/${box.id}/terminal/sessions`).set('Cookie', ownerSession.cookie);
        expect(list.body.sessions[0]).toMatchObject({ openedByName: 'termowner', state: 'closed', closeReason: 'closed_by_owner', bytesIn: 4, bytesOut: 14 });
    });

    test('an open terminal pauses new wakes for the agent and closing resumes them', async () => {
        const hostAuth = { Authorization: `AgentHost ${box.hostToken}`, ...edgeFor(box) };
        const started = await api.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'start', profile: 'alpha', fresh: true });
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        const term = await openTerminal(box, ownerSession);
        const post = await api.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: '@alpha please look at the build' });
        expect(post.status, JSON.stringify(post.body)).toBe(201);
        // The owner has a terminal open: the box's host is offered nothing new
        expect((await api.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth)).status).toBe(204);
        const exit = wait(term, 'shell:exit');
        term.emit('shell:close');
        await exit; await settle();
        // Closed: the wake that waited is claimed
        const claim = await api.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
        expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    });
});

describe('threat 1: someone other than the owner', () => {
    test('a member, a director and another server\'s owner get 403 and the refusal is on record', async () => {
        for (const who of [member, director]) {
            const s = await cookieLogin(who === member ? 'termmember' : 'termdirector');
            const r = await ticketFor(box, s);
            expect([who === member ? 'member' : 'director', r.status, r.body]).toEqual([who === member ? 'member' : 'director', 403, { error: 'forbidden' }]);
            expect((await api.get(`/boxes/${box.id}/terminal`).set('Cookie', s.cookie)).status).toBe(403);
            expect((await api.get(`/boxes/${box.id}/terminal/sessions`).set('Cookie', s.cookie)).status).toBe(403);
            expect((await api.delete(`/boxes/${box.id}/terminal`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf)).status).toBe(403);
        }
        const stranger = await authedUser(api, 'termstranger');
        await createServer(api, stranger.auth, 'Elsewhere');
        const s = await cookieLogin('termstranger');
        expect((await ticketFor(box, s)).status).toBe(403);
        expect((await rows(`SELECT 1 FROM box_shell_tickets`))).toHaveLength(0);
        const refused = await audits('box_terminal_refused');
        expect(refused.length).toBeGreaterThanOrEqual(3);
        expect(refused.every(r => r.changes.code === 'not_owner')).toBe(true);
    });

    test('a bot token and a host token never reach the routes', async () => {
        const bot = { Authorization: `Bot ${box.botToken}`, ...edgeFor(box) };
        const hostAuth = { Authorization: `AgentHost ${box.hostToken}`, ...edgeFor(box) };
        for (const [name, auth] of [['bot', bot], ['host', hostAuth]] as const) {
            for (const [method, path] of [['get', 'terminal'], ['post', 'terminal/ticket'], ['delete', 'terminal'], ['get', 'terminal/sessions']] as const) {
                const r = await (api as any)[method](`/boxes/${box.id}/${path}`).set(auth).send({ password: PASSWORD });
                expect([name, method, path, r.status]).toEqual([name, method, path, 403]);
            }
        }
        // And without the edge, a box credential is refused before it gets that far
        const outside = await api.post(`/boxes/${box.id}/terminal/ticket`).set({ Authorization: `AgentHost ${box.hostToken}` }).send({ password: PASSWORD });
        expect(outside.body).toEqual({ error: 'box_token_outside_box' });
        expect(await rows(`SELECT 1 FROM box_shell_tickets`)).toHaveLength(0);
    });

    test('a bearer token is not a browser session: no ticket', async () => {
        const r = await api.post(`/boxes/${box.id}/terminal/ticket`).set(owner.auth).set('Origin', origin).send({ password: PASSWORD });
        expect(r.status).toBe(403);
        expect(r.body).toEqual({ error: 'cookie_session_required' });
    });

    test('the owner\'s password is asked again, and a wrong one gives no ticket', async () => {
        const wrong = await ticketFor(box, ownerSession, { password: 'not-the-password' });
        expect(wrong.status).toBe(403);
        expect(wrong.body).toEqual({ error: 'reauth_failed' });
        expect((await ticketFor(box, ownerSession, {} as any)).status).toBe(400);
        expect(await rows(`SELECT 1 FROM box_shell_tickets`)).toHaveLength(0);
        expect((await audits('box_terminal_refused')).some(a => a.changes.code === 'reauth_failed')).toBe(true);
    });

    test('a ticket is bound to the browser session that asked: the owner\'s other session and other people can\'t redeem it', async () => {
        const ticket = await getTicket(box, ownerSession);
        const other = await cookieLogin('termowner');
        expect(await refusal(browser(other, ticket))).toBe('ticket_invalid');
        const memberSession = await cookieLogin('termmember');
        expect(await refusal(browser(memberSession, ticket))).toBe('ticket_invalid');
        // Both failed attempts left it unspent: the right session still redeems it
        expect(await refusal(browser(ownerSession, ticket))).toBe('connected');
    });

    test('a ticket is single use, expires, and names exactly one box', async () => {
        const ticket = await getTicket(box, ownerSession);
        const first = browser(ownerSession, ticket);
        await connected(first);
        expect(await refusal(browser(ownerSession, ticket))).toBe('ticket_invalid');

        const other = await makeBox('beta');
        const otherHost = await connectHost(other);
        const t2 = await getTicket(other, ownerSession);
        await ctx.db.query(`UPDATE box_shell_tickets SET expires_at = NOW() - interval '1 second'`);
        expect(await refusal(browser(ownerSession, t2))).toBe('ticket_invalid');

        // A ticket for box B opens B and nothing else: alpha's host never sees it
        const t3 = await getTicket(other, ownerSession);
        const term = browser(ownerSession, t3);
        await connected(term);
        const ready = wait(term, 'shell:ready');
        term.emit('shell:start', { cols: 80, rows: 24 });
        await ready;
        expect(otherHost.opened).toHaveLength(1);
        expect(host.opened).toHaveLength(0);
    });

    test('a missing, garbage or ticket-less handshake gets nothing', async () => {
        for (const t of [null, '', 'x', 'A'.repeat(43), 'A'.repeat(500)]) {
            expect([t, await refusal(browser(ownerSession, t))]).toEqual([t, 'ticket_invalid']);
        }
        expect(await rows(`SELECT 1 FROM box_shell_sessions`)).toHaveLength(0);
    });

    test('ownership is checked again at redemption', async () => {
        const ticket = await getTicket(box, ownerSession);
        // The server changes hands between the ticket and the socket
        await ctx.db.query(`UPDATE servers SET owner_id = $1 WHERE id = $2`, [member.userId, serverId]);
        expect(await refusal(browser(ownerSession, ticket))).toBe('forbidden');
        expect(await rows(`SELECT 1 FROM box_shell_sessions`)).toHaveLength(0);
    });

    test('a ticket does not survive the box being rebuilt', async () => {
        const ticket = await getTicket(box, ownerSession);
        await rotateBoxTokens(ctx.db, box.id);
        expect(await refusal(browser(ownerSession, ticket))).toBe('box_not_ready');
    });

    test('a stopped box and a box whose host is not connected are not ready', async () => {
        const quiet = await makeBox('quiet');
        const r = await ticketFor(quiet, ownerSession);
        expect([r.status, r.body.error]).toEqual([409, 'box_needs_update']);
        const quietHost = await connectHost(quiet);
        quietHost.socket.disconnect();
        await settle();
        expect((await ticketFor(quiet, ownerSession)).body.error).toBe('box_not_ready');
        await ctx.db.query(`UPDATE agent_boxes SET state = 'stopped' WHERE id = $1`, [quiet.id]);
        expect((await ticketFor(quiet, ownerSession)).body.error).toBe('box_not_running');
    });
});

describe('threat 2: cross-site and non-browser handshakes', () => {
    test('a ticket request needs this site\'s Origin and the session\'s CSRF token', async () => {
        for (const [what, o] of [
            ['another origin', { origin: 'https://evil.example' }],
            ['no origin', { origin: null }],
            ['no csrf token', { csrf: null }],
            ['another session\'s csrf token', { csrf: (await cookieLogin('termowner')).csrf }],
            ['a forged csrf token', { csrf: 'nope' }],
        ] as const) {
            const r = await ticketFor(box, ownerSession, { password: PASSWORD }, o as any);
            expect([what, r.status]).toEqual([what, 403]);
        }
        expect(await rows(`SELECT 1 FROM box_shell_tickets`)).toHaveLength(0);
    });

    test('the socket needs the cookie session and this site\'s Origin', async () => {
        const ticket = await getTicket(box, ownerSession);
        expect(await refusal(browser(ownerSession, ticket, { origin: 'https://evil.example' }))).toBe('origin_not_allowed');
        expect(await refusal(browser(ownerSession, ticket, { origin: null }))).toBe('origin_not_allowed');
        expect(await refusal(browser(null, ticket))).toBe('Authentication required');
        // A bearer token in the handshake is not a cookie session
        expect(await refusal(browser(null, ticket, { extra: { token: owner.token }, headers: { authorization: `Bearer ${owner.token}` } }))).toBe('Authentication required');
        // Nor are a bot token or a host token
        expect(await refusal(browser(null, ticket, { extra: { token: box.botToken } }))).toBe('Authentication required');
        expect(await refusal(browser(null, ticket, { extra: { token: box.hostToken } }))).toBe('Authentication required');
        expect(await refusal(browser(ownerSession, ticket))).toBe('connected');
    });

    test('a logged-out session cannot open the socket, and logging out ends an open terminal', async () => {
        const s = await cookieLogin('termowner');
        const ticket = await getTicket(box, s);
        const term = browser(s, ticket);
        await connected(term);
        const ready = wait(term, 'shell:ready');
        term.emit('shell:start', { cols: 80, rows: 24 });
        await ready;
        const gone = wait(term, 'disconnect');
        const out = await api.post('/auth/logout').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).set('Origin', origin);
        expect(out.status).toBeLessThan(300);
        await gone;
        await settle(300);
        expect((await sessionRows())[0]).toMatchObject({ state: 'closed' });
    });

    test('a person\'s login through a box\'s edge is refused (provenance)', async () => {
        const ticket = await getTicket(box, ownerSession);
        expect(await refusal(browser(ownerSession, ticket, { headers: edgeFor(box) }))).toBe('token_not_for_this_box');
    });
});

describe('the box host\'s socket', () => {
    test('only a box\'s own host, through its own edge, with the protocol', async () => {
        const fresh = await makeBox('gamma');
        const mk = (o: { token?: string; headers?: Record<string, string>; protocol?: number }) => io(base, {
            transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: o.headers ?? edgeFor(fresh),
            auth: { type: 'host', token: o.token ?? fresh.hostToken, shellProtocol: o.protocol ?? 1 },
        });
        const refused = async (o: Parameters<typeof mk>[0]) => { const s = mk(o); sockets.push(s); return refusal(s); };
        expect(await refused({ headers: {} })).toBe('box_token_outside_box');
        expect(await refused({ headers: edgeFor(box) })).toBe('token_not_for_this_box');
        expect(await refused({ headers: signEdge('00'.repeat(32), fresh.id, fresh.generation) })).toBe('bad_edge_signature');
        expect(await refused({ token: 'ah_nope' })).toBe('Malformed host token');
        expect(await refused({ token: `ah_${fresh.id}.${'0'.repeat(64)}` })).toBe('Invalid host token');
        expect(await refused({ token: `Bot ${fresh.botToken}` })).toBe('Malformed host token');
        expect(await refused({ protocol: 0 })).toBe('unsupported_protocol');
        expect((await rows(`SELECT shell_protocol FROM agent_hosts WHERE box_id = $1`, [fresh.id]))[0].shell_protocol).toBeNull();
        // A machine host (not a box's) is not one
        const machine = await api.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
        expect(await refused({ token: machine.body.token ?? machine.body.hostToken, headers: {} })).toMatch(/box_hosts_only|Invalid host token/);
        expect(await refused({})).toBe('connected');
        expect((await rows(`SELECT shell_protocol FROM agent_hosts WHERE box_id = $1`, [fresh.id]))[0].shell_protocol).toBe(1);
    });

    test('an old generation\'s host token is dead after a rebuild', async () => {
        const old = { token: box.hostToken, headers: edgeFor(box) };
        await rotateBoxTokens(ctx.db, box.id);
        const s = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: old.headers, auth: { type: 'host', token: old.token, shellProtocol: 1 } });
        sockets.push(s);
        expect(await refusal(s)).toBe('Invalid host token');
    });

    test('a host can only speak for its own terminal', async () => {
        const term = await openTerminal(box, ownerSession);
        const other = await makeBox('delta');
        const intruder = await connectHost(other);
        const sessionId = host.opened[0].sessionId;
        const seen: any[] = [];
        term.on('shell:output', d => seen.push(d));
        intruder.socket.emit('shell:output', { sessionId, data: Buffer.from('forged') });
        intruder.socket.emit('shell:exited', { sessionId });
        await settle(300);
        expect(seen).toHaveLength(0);
        expect((await sessionRows())[0].state).toBe('open');
    });
});

describe('takeover: one terminal per box', () => {
    test('a second open asks first, then takes over and the first is told', async () => {
        const first = await openTerminal(box, ownerSession);
        const second = await ticketFor(box, ownerSession);
        expect(second.status).toBe(409);
        expect(second.body).toMatchObject({ error: 'terminal_in_use', openedByName: 'termowner' });
        expect(second.body.ticket).toBeUndefined();

        const told = wait(first, 'shell:exit');
        const again = await ticketFor(box, ownerSession, { password: PASSWORD, takeover: true });
        expect(again.status, JSON.stringify(again.body)).toBe(200);
        expect(await told).toEqual({ reason: 'taken_over' });
        const next = browser(ownerSession, again.body.ticket);
        await connected(next);
        const ready = wait(next, 'shell:ready');
        next.emit('shell:start', { cols: 80, rows: 24 });
        await ready;
        const all = await sessionRows();
        expect(all.map(r => [r.state, r.close_reason])).toEqual([['closed', 'taken_over'], ['open', null]]);
        // Takeover still needs the password
        const noPw = await ticketFor(box, ownerSession, { password: 'wrong', takeover: true });
        expect(noPw.status).toBe(403);
        expect((await sessionRows())[1].state).toBe('open');
    });

    test('two tickets racing for one box: the database lets one terminal open', async () => {
        const t1 = await getTicket(box, ownerSession);
        const t2 = await getTicket(box, ownerSession);
        const a = browser(ownerSession, t1), b = browser(ownerSession, t2);
        const results = await Promise.all([refusal(a), refusal(b)]);
        expect(results.sort()).toEqual(['connected', 'terminal_in_use']);
    });
});

describe('limits and endings', () => {
    test('the browser disappearing ends the shell', async () => {
        const term = await openTerminal(box, ownerSession);
        term.disconnect();
        await settle(300);
        expect(host.closed).toHaveLength(1);
        expect((await sessionRows())[0]).toMatchObject({ state: 'closed', close_reason: 'browser_gone' });
        expect((await notices())).toHaveLength(2);
    });

    test('the box restarting (its host socket dropping) ends the terminal', async () => {
        const term = await openTerminal(box, ownerSession);
        const exit = wait(term, 'shell:exit');
        host.socket.disconnect();
        expect(await exit).toEqual({ reason: 'box_disconnected' });
        await settle();
        expect((await sessionRows())[0].close_reason).toBe('box_disconnected');
    });

    test('a rebuilt box ends it at the next check', async () => {
        const term = await openTerminal(box, ownerSession);
        const exit = wait(term, 'shell:exit');
        await ctx.db.query(`UPDATE agent_boxes SET generation = generation + 1 WHERE id = $1`, [box.id]);
        const hub = shellHub() as any;
        for (let i = 0; i < 3; i++) await hub.sweep();
        expect(await exit).toEqual({ reason: 'box_changed' });
    });

    test('idle for the owner\'s limit, and open longer than the owner\'s maximum', async () => {
        const hub = shellHub() as any;
        const a = await openTerminal(box, ownerSession);
        const idle = wait(a, 'shell:exit');
        for (const l of hub.live.values()) l.lastInputMs = Date.now() - 16 * 60_000;
        await hub.sweep();
        expect(await idle).toEqual({ reason: 'idle_timeout' });
        await settle();

        const b = await openTerminal(box, ownerSession);
        const max = wait(b, 'shell:exit');
        for (const l of hub.live.values()) l.openedAtMs = Date.now() - 9 * 3_600_000;
        await hub.sweep();
        expect(await max).toEqual({ reason: 'max_duration' });
    });

    test('output faster than the owner\'s limit closes it; the limit is the owner\'s to change', async () => {
        const patch = await api.patch(`/boxes/${box.id}`).set(owner.auth).send({ terminalRateKbps: 16, terminalIdleMinutes: 5, terminalMaxHours: 2 });
        expect(patch.status, JSON.stringify(patch.body)).toBe(200);
        expect(patch.body.box).toMatchObject({ terminalRateKbps: 16, terminalIdleMinutes: 5, terminalMaxHours: 2 });
        const term = await openTerminal(box, ownerSession);
        expect(host.opened[0].rateBytesPerSecond).toBe(16 * 1024);
        const exit = wait(term, 'shell:exit');
        for (let i = 0; i < 8; i++) host.socket.emit('shell:output', { sessionId: host.opened[0].sessionId, data: Buffer.alloc(32 * 1024, 65) });
        expect(await exit).toEqual({ reason: 'output_flood' });
        await settle();
        expect((await audits('box_terminal_close'))[0].changes.reason).toBe('output_flood');
    });

    test('input too big or too fast closes it', async () => {
        const term = await openTerminal(box, ownerSession);
        const exit = wait(term, 'shell:exit');
        term.emit('shell:input', Buffer.alloc(70 * 1024, 66));
        expect(await exit).toEqual({ reason: 'input_flood' });
    });

    test('a browser that never says its size, and the limits\' bounds', async () => {
        for (const bad of [{ terminalRateKbps: 1 }, { terminalRateKbps: 9000 }, { terminalIdleMinutes: 0 }, { terminalIdleMinutes: 241 }, { terminalMaxHours: 25 }]) {
            expect([bad, (await api.patch(`/boxes/${box.id}`).set(owner.auth).send(bad)).status]).toEqual([bad, 400]);
        }
        expect((await api.patch(`/boxes/${box.id}`).set(member.auth).send({ terminalRateKbps: 32 })).status).toBe(403);
        const term = browser(ownerSession, await getTicket(box, ownerSession));
        await connected(term);
        const exit = wait(term, 'shell:exit');
        term.emit('shell:start', { cols: 100000, rows: 0 });
        expect(await exit).toEqual({ reason: 'no_start' });
    });

    test('a restart of Agora leaves no terminal marked open', async () => {
        await ctx.db.query(
            `INSERT INTO box_shell_sessions (id, box_id, server_id, opened_by, generation, state, started_at) VALUES ('01HZZZZZZZZZZZZZZZZZZZZZZ9', $1, $2, $3, 1, 'open', NOW())`,
            [box.id, serverId, owner.userId]);
        const { ShellHub } = await import('../../src/lib/boxes/shell-hub');
        const hub = new ShellHub(ctx.db, () => {});
        await hub.start();
        await hub.stop();
        expect((await sessionRows())[0]).toMatchObject({ state: 'closed', close_reason: 'server_restarted' });
        expect((await audits('box_terminal_close'))[0].changes.reason).toBe('server_restarted');
    });

    test('the owner can close an open terminal from Settings', async () => {
        const term = await openTerminal(box, ownerSession);
        const exit = wait(term, 'shell:exit');
        const r = await api.delete(`/boxes/${box.id}/terminal`).set('Cookie', ownerSession.cookie).set('X-CSRF-Token', ownerSession.csrf);
        expect(r.status).toBe(204);
        expect(await exit).toEqual({ reason: 'closed_by_owner' });
    });
});

describe('threat 4: the shell\'s bytes are not kept', () => {
    test('nothing typed or printed is in any table or any log line', async () => {
        const written: string[] = [];
        const spies = [
            vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { written.push(String(c)); return true; }),
            vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { written.push(String(c)); return true; }),
        ];
        const logs = ['log', 'info', 'warn', 'error', 'debug'].map(m => vi.spyOn(console, m as any).mockImplementation((...a: any[]) => { written.push(a.map(String).join(' ')); }));
        try {
            const term = await openTerminal(box, ownerSession);
            const out = wait(term, 'shell:output');
            term.emit('shell:input', `echo ${MARKER}\r`);
            expect(Buffer.from(await out).toString()).toContain(MARKER);
            host.socket.emit('shell:output', { sessionId: host.opened[0].sessionId, data: Buffer.from(`printed ${MARKER}`) });
            await settle();
            const exit = wait(term, 'shell:exit');
            term.emit('shell:close');
            await exit; await settle();
        } finally {
            for (const s of [...spies, ...logs]) s.mockRestore();
        }
        expect(written.join('\n')).not.toContain(MARKER);
        const tables = (await rows(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).map(r => r.tablename);
        for (const t of tables) {
            const hit = await rows(`SELECT 1 FROM "${t}" x WHERE x::text LIKE $1 LIMIT 1`, [`%${MARKER}%`]);
            expect([t, hit.length]).toEqual([t, 0]);
        }
    });

    test('terminal output goes to the one browser and never to a room', async () => {
        const watcher = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, auth: { token: member.token } });
        sockets.push(watcher);
        const heard: string[] = [];
        watcher.onAny((name: string, ...args: any[]) => { heard.push(name + JSON.stringify(args).slice(0, 200)); });
        await connected(watcher);
        await settle(200);
        heard.length = 0;
        const term = await openTerminal(box, ownerSession);
        const out = wait(term, 'shell:output');
        term.emit('shell:input', `x${MARKER}\r`);
        await out;
        await settle(200);
        expect(heard.join('\n')).not.toContain(MARKER);
        // The channel did hear that a terminal opened (a notice), and nothing but that
        expect(heard.some(h => h.startsWith('Message') && h.includes('terminal'))).toBe(true);
        expect(heard.some(h => h.startsWith('shell:'))).toBe(false);
    });
});

describe('the owner\'s view of the box', () => {
    test('Settings sees the limits on the box and a box that needs its update', async () => {
        const list = await api.get(`/servers/${serverId}/boxes`).set(owner.auth);
        expect(list.body.boxes[0]).toMatchObject({ terminalIdleMinutes: 15, terminalMaxHours: 8, terminalRateKbps: 512 });
        const old = await makeBox('oldbox');
        const st = await api.get(`/boxes/${old.id}/terminal`).set('Cookie', ownerSession.cookie);
        expect(st.body).toMatchObject({ supported: false, hostConnected: false });
    });
});
