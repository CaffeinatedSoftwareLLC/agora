import { io, Socket } from 'socket.io-client';
import supertest from 'supertest';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { signEdge } from '../../src/lib/boxes/contract';
import { rotateBoxTokens } from '../../src/lib/boxes/tokens';
import { relayFailures, shellHub } from '../../src/lib/boxes/shell-hub';
import { config } from '../../src/config';
import { refreshGatewayAccess } from '../../src/lib/gateway-access';

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
interface Box { id: string; name: string; generation: number; hostToken: string; relayToken: string; botToken: string }
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
    return { id: res.body.box.id, name, generation: t.generation, hostToken: t.hostToken, relayToken: t.relayToken, botToken: t.botToken };
}

const edgeFor = (box: Box, generation = box.generation) => signEdge(EDGE_SECRET, box.id, generation);

/** The box's agora-host: connects as a host through its own edge and echoes input as output. */
async function connectHost(box: Box, opts: { protocol?: number; token?: string; headers?: Record<string, string> } = {}): Promise<FakeHost> {
    const host: FakeHost = { socket: null as any, opened: [], input: [], resized: [], closed: [], echo: true };
    const socket = io(base, {
        transports: ['websocket'], autoConnect: false, reconnection: false,
        extraHeaders: opts.headers ?? edgeFor(box),
        auth: { type: 'relay', token: opts.token ?? box.relayToken, shellProtocol: opts.protocol ?? 2 },
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
    relayFailures.reset();
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
    test('a member, a director and another server\'s owner are answered as if the box did not exist, and the refusal is on record', async () => {
        const notFound = { error: 'box_not_found' };
        for (const who of [member, director]) {
            const s = await cookieLogin(who === member ? 'termmember' : 'termdirector');
            const r = await ticketFor(box, s);
            expect([who === member ? 'member' : 'director', r.status, r.body]).toEqual([who === member ? 'member' : 'director', 404, notFound]);
            expect((await api.get(`/boxes/${box.id}/terminal`).set('Cookie', s.cookie)).status).toBe(404);
            expect((await api.get(`/boxes/${box.id}/terminal/sessions`).set('Cookie', s.cookie)).status).toBe(404);
            expect((await api.delete(`/boxes/${box.id}/terminal`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf)).status).toBe(404);
        }
        const stranger = await authedUser(api, 'termstranger');
        await createServer(api, stranger.auth, 'Elsewhere');
        const s = await cookieLogin('termstranger');
        expect((await ticketFor(box, s)).status).toBe(404);
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

    test('a missing, garbage or ticket-less handshake gets nothing, and writes no audit row (it is counted)', async () => {
        const hub = shellHub()!;
        const before = hub.refusedTickets;
        const auditBefore = (await rows(`SELECT 1 FROM audit_log`)).length;
        for (const t of [null, '', 'x', 'A'.repeat(43), 'A'.repeat(500)]) {
            expect([t, await refusal(browser(ownerSession, t))]).toEqual([t, 'ticket_invalid']);
        }
        expect(await rows(`SELECT 1 FROM box_shell_sessions`)).toHaveLength(0);
        expect(hub.refusedTickets - before).toBe(5);
        expect((await rows(`SELECT 1 FROM audit_log`)).length).toBe(auditBefore);
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
            auth: { type: 'relay', token: o.token ?? fresh.relayToken, shellProtocol: o.protocol ?? 2 },
        });
        const refused = async (o: Parameters<typeof mk>[0]) => { const s = mk(o); sockets.push(s); return refusal(s); };
        expect(await refused({ headers: {} })).toBe('box_token_outside_box');
        expect(await refused({ headers: edgeFor(box) })).toBe('token_not_for_this_box');
        expect(await refused({ headers: signEdge('00'.repeat(32), fresh.id, fresh.generation) })).toBe('bad_edge_signature');
        expect(await refused({ token: 'ar_nope' })).toBe('Malformed relay token');
        expect(await refused({ token: `ar_${fresh.id}.${'0'.repeat(64)}` })).toBe('Invalid relay token');
        expect(await refused({ token: `Bot ${fresh.botToken}` })).toBe('Malformed relay token');
        // The box's HOST token, which the agent can read, is not a terminal credential: not as a relay token...
        expect(await refused({ token: fresh.hostToken })).toBe('Malformed relay token');
        expect(await refused({ token: fresh.hostToken.replace(/^ah_/, 'ar_') })).toBe('Invalid relay token');
        expect(await refused({ protocol: 0 })).toBe('unsupported_protocol');
        // ... and protocol 1 (the first slice, where the host held the terminal) is not served
        expect(await refused({ protocol: 1 })).toBe('unsupported_protocol');
        expect((await rows(`SELECT shell_protocol FROM agent_hosts WHERE box_id = $1`, [fresh.id]))[0].shell_protocol).toBeNull();
        // A machine host (not a box's) is not one
        const machine = await api.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
        expect(await refused({ token: machine.body.token ?? machine.body.hostToken, headers: {} })).toMatch(/Malformed relay token/);
        expect(await refused({})).toBe('connected');
        expect((await rows(`SELECT shell_protocol FROM agent_hosts WHERE box_id = $1`, [fresh.id]))[0].shell_protocol).toBe(2);
    });

    test('failed relay handshakes are throttled per credential id before any hash is checked, without touching other boxes or the audit log', async () => {
        const fresh = await makeBox('throttled');
        const other = await makeBox('bystander');
        const idOf = (b: Box) => b.relayToken.slice(3, b.relayToken.indexOf('.'));
        const mk = (b: Box, token: string) => { const s = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: edgeFor(b), auth: { type: 'relay', token, shellProtocol: 2 } }); sockets.push(s); return s; };
        const guess = `ar_${idOf(fresh)}.${'0'.repeat(64)}`;
        const auditBefore = (await rows(`SELECT count(*)::int AS n FROM audit_log`))[0].n;
        for (let i = 0; i < 5; i++) expect(await refusal(mk(fresh, guess))).toBe('Invalid relay token');
        // From the sixth, nothing is hashed or looked up for this id: not even the right credential gets in until the minute passes
        expect(await refusal(mk(fresh, guess))).toBe('rate_limited');
        expect(await refusal(mk(fresh, fresh.relayToken))).toBe('rate_limited');
        // Another box's relay is not affected, and the garbage left no trace in the audit log
        expect(await refusal(mk(other, other.relayToken))).toBe('connected');
        expect((await rows(`SELECT count(*)::int AS n FROM audit_log`))[0].n).toBe(auditBefore);
        // Unknown ids and malformed tokens are not counted against anyone's box
        for (let i = 0; i < 7; i++) expect(await refusal(mk(other, 'ar_nope'))).toBe('Malformed relay token');
        relayFailures.reset();
        expect(await refusal(mk(fresh, fresh.relayToken))).toBe('connected');
    });

    test('the side event passes from the box\'s relay to the paired browser only, as operator or agent, and nothing else', async () => {
        const hostA = host;
        const term = await openTerminal(box, ownerSession);
        const sessionId = hostA.opened[0].sessionId;
        const seen: any[] = [];
        term.on('shell:side', m => seen.push(m));
        const bystander = await connectHost(await makeBox('other-side'));
        hostA.socket.emit('shell:side', { sessionId, side: 'operator' });
        await settle(150);
        hostA.socket.emit('shell:side', { sessionId, side: 'agent' });
        await settle(150);
        hostA.socket.emit('shell:side', { sessionId, side: 'Operator' });
        await settle(150);
        hostA.socket.emit('shell:side', { sessionId, side: { evil: 1 } });
        await settle(150);
        // Another box's relay, and a wrong session id, cannot speak for this terminal
        bystander.socket.emit('shell:side', { sessionId, side: 'operator' });
        hostA.socket.emit('shell:side', { sessionId: 'X'.repeat(26), side: 'operator' });
        await settle(300);
        expect(seen).toEqual([{ side: 'operator' }, { side: 'agent' }, { side: 'agent' }, { side: 'agent' }]);
        // Not in the channel, not stored
        expect(JSON.stringify(await notices())).not.toContain('side');
        expect(JSON.stringify(await sessionRows())).not.toContain('"side"');
    });

    test('the host token cannot register as a terminal endpoint at all: not as the old host handshake, not as a relay, not on any route', async () => {
        const fresh = await makeBox('hostonly');
        const old = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: edgeFor(fresh), auth: { type: 'host', token: fresh.hostToken, shellProtocol: 2 } });
        sockets.push(old);
        // `type: 'host'` is no terminal handshake any more: it is an ordinary (failed) chat login
        expect(await refusal(old)).toBe('Invalid token');
        expect(hubOf().hostConnected(fresh.id)).toBe(false);
        // The relay credential is not a host token either: it opens no host route
        const res = await api.get('/agent-hosts/@me/box-login').set({ Authorization: `AgentHost ${fresh.relayToken}`, ...edgeFor(fresh) });
        expect(res.status).toBe(401);
        // And it is a different secret
        expect(fresh.relayToken.slice(fresh.relayToken.indexOf('.'))).not.toBe(fresh.hostToken.slice(fresh.hostToken.indexOf('.')));
        // Only the relay credential registered: it is stored hashed, apart from the host token's hash
        const row = (await rows(`SELECT secret_hash, relay_secret_hash FROM agent_hosts WHERE box_id = $1`, [fresh.id]))[0];
        expect(row.relay_secret_hash).toBeTruthy();
        expect(row.relay_secret_hash).not.toBe(row.secret_hash);
        expect(row.relay_secret_hash).not.toContain(fresh.relayToken.slice(fresh.relayToken.indexOf('.') + 1));
    });

    test('a rebuild gives a new relay credential and the old one is dead', async () => {
        const fresh = await makeBox('rebuilt');
        const t = await rotateBoxTokens(ctx.db, fresh.id);
        expect(t.relayToken).not.toBe(fresh.relayToken);
        const s = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: edgeFor(fresh), auth: { type: 'relay', token: fresh.relayToken, shellProtocol: 2 } });
        sockets.push(s);
        expect(await refusal(s)).toBe('Invalid relay token');
    });

    test('an old generation\'s host token is dead after a rebuild', async () => {
        const old = { token: box.relayToken, headers: edgeFor(box) };
        await rotateBoxTokens(ctx.db, box.id);
        const s = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: old.headers, auth: { type: 'relay', token: old.token, shellProtocol: 2 } });
        sockets.push(s);
        expect(await refusal(s)).toBe('Invalid relay token');
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


// ─── Security review fixes (PR #393) ───

const hubOf = () => shellHub() as any;

describe('review 1: a second socket with the host token cannot replace the real host', () => {
    test('refused while the real host is connected, audited and announced once; the real host keeps its terminal until the attempt, which closes it', async () => {
        const term = await openTerminal(box, ownerSession);
        const exit = wait(term, 'shell:exit');
        const intruder = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: edgeFor(box), auth: { type: 'relay', token: box.relayToken, shellProtocol: 2 } });
        sockets.push(intruder);
        const stolen: any[] = [];
        intruder.on('shell:input', m => stolen.push(m));
        expect(await refusal(intruder)).toBe('host_already_connected');
        // The owner's terminal is closed with its own reason and the shell told to stop
        expect(await exit).toEqual({ reason: 'host_changed' });
        await settle(300);
        expect(host.socket.connected).toBe(true);
        expect(host.closed).toHaveLength(1);
        expect(stolen).toHaveLength(0);
        expect((await sessionRows())[0].close_reason).toBe('host_changed');
        expect((await audits('box_host_conflict'))).toHaveLength(1);
        const said = (await rows(`SELECT content FROM messages WHERE channel_id = $1 AND content LIKE '%second connection claimed%'`, [channelId]));
        expect(said).toHaveLength(1);
        expect(said[0].content).toContain('host_already_connected');
        // More attempts inside the hour add no second notice (and no second audit row inside the minute)
        for (let i = 0; i < 3; i++) {
            const again = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: edgeFor(box), auth: { type: 'relay', token: box.relayToken, shellProtocol: 2 } });
            sockets.push(again);
            expect(await refusal(again)).toBe('host_already_connected');
        }
        await settle(200);
        expect(await rows(`SELECT content FROM messages WHERE channel_id = $1 AND content LIKE '%second connection claimed%'`, [channelId])).toHaveLength(1);
        expect(await audits('box_host_conflict')).toHaveLength(1);
        // And the real host can still open a terminal afterwards
        const next = await openTerminal(box, ownerSession);
        const out = wait(next, 'shell:output');
        next.emit('shell:input', 'ok\r');
        expect(Buffer.from(await out).toString()).toBe('echo:ok\r');
    });

    test('a genuine reconnect after the old socket went away works, and the terminal that was on the old one is closed as box_disconnected', async () => {
        const term = await openTerminal(box, ownerSession);
        const exit = wait(term, 'shell:exit');
        host.socket.disconnect();
        expect(await exit).toEqual({ reason: 'box_disconnected' });
        await settle();
        const fresh = await connectHost(box);
        expect(fresh.socket.connected).toBe(true);
        expect(await audits('box_host_conflict')).toHaveLength(0);
        const t2 = browser(ownerSession, await getTicket(box, ownerSession));
        await connected(t2);
        const ready = wait(t2, 'shell:ready');
        t2.emit('shell:start', { cols: 80, rows: 24 });
        await ready;
        expect(fresh.opened).toHaveLength(1);
    });

    test('registerHost itself refuses a second connected socket (the race the handshake check can lose)', async () => {
        const hub = hubOf();
        const fake = () => { const e: any = new (require('node:events').EventEmitter)(); e.connected = true; e.disconnect = vi.fn(() => { e.connected = false; }); return e; };
        const info = { hostId: 'H', boxId: box.id, serverId, generation: box.generation };
        const second = fake();
        expect(hub.registerHost(second, info)).toBe(false);
        expect(second.disconnect).toHaveBeenCalled();
        expect(host.socket.connected).toBe(true);
        await hub.drain();
        expect(await audits('box_host_conflict')).toHaveLength(1);
    });
});

describe('review 3: the widget\'s automatic replies are not owner activity', () => {
    test('periodic replies do not keep an idle terminal alive; real input does; both reach the shell', async () => {
        const hub = hubOf();
        const term = await openTerminal(box, ownerSession);
        const stale = () => { for (const l of hub.live.values()) l.lastInputMs = Date.now() - 16 * 60_000; };
        stale();
        term.emit('shell:reply', '\x1b[?1;2c');
        term.emit('shell:reply', '\x1b[I');
        await settle(200);
        expect(host.input.map(b => b.toString())).toEqual(['\x1b[?1;2c', '\x1b[I']);
        const idle = wait(term, 'shell:exit');
        await hub.sweep();
        expect(await idle).toEqual({ reason: 'idle_timeout' });
        await settle();

        const second = await openTerminal(box, ownerSession);
        stale();
        second.emit('shell:input', 'ls\r');
        await settle(200);
        await hub.sweep();
        await settle(100);
        expect((await sessionRows())[1].state).toBe('open');
    });

    test('replies obey the same size limit, and only the paired browser can send them', async () => {
        const term = await openTerminal(box, ownerSession);
        const exit = wait(term, 'shell:exit');
        term.emit('shell:reply', Buffer.alloc(70 * 1024, 66));
        expect(await exit).toEqual({ reason: 'input_flood' });
        // A host socket sending the browser's event does nothing
        const t2 = await openTerminal(box, ownerSession);
        const before = host.input.length;
        host.socket.emit('shell:reply', { sessionId: host.opened.at(-1).sessionId, data: Buffer.from('forged') });
        await settle(200);
        expect(host.input.length).toBe(before);
        t2.disconnect();
    });

    test('a terminal open for an hour posts one "still open" notice, then waits another hour', async () => {
        const hub = hubOf();
        await openTerminal(box, ownerSession);
        for (const l of hub.live.values()) { l.openedAtMs = Date.now() - 3_600_000; l.nextReminderMs = Date.now() - 1; }
        await hub.sweep();
        await hub.sweep();
        await hub.drain();
        const still = (await notices()).filter(n => n.content.includes('It is still open; wakes for **alpha** are paused'));
        expect(still).toHaveLength(1);
        expect(still[0].content).toContain('has been open for 1 h');
    });
});

describe('review 4: refusals cannot flood the audit log, and a box is not an existence oracle', () => {
    test('a non-owner hammering the four routes leaves one audit row; a missing box and another\'s box answer alike', async () => {
        const s = await cookieLogin('termmember');
        for (let i = 0; i < 6; i++) {
            await ticketFor(box, s);
            await api.get(`/boxes/${box.id}/terminal`).set('Cookie', s.cookie);
            await api.get(`/boxes/${box.id}/terminal/sessions`).set('Cookie', s.cookie);
            await api.delete(`/boxes/${box.id}/terminal`).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
        }
        expect((await audits('box_terminal_refused')).filter(a => a.changes.code === 'not_owner')).toHaveLength(1);
        // After the minute, the next refusal is written again
        await ctx.db.query(`UPDATE audit_log SET created_at = NOW() - interval '2 minutes' WHERE action = 'box_terminal_refused'`);
        await api.get(`/boxes/${box.id}/terminal`).set('Cookie', s.cookie);
        expect((await audits('box_terminal_refused')).filter(a => a.changes.code === 'not_owner')).toHaveLength(2);

        const theirs = await api.get(`/boxes/${box.id}/terminal`).set('Cookie', s.cookie);
        const nothing = await api.get(`/boxes/${'Z'.repeat(26)}/terminal`).set('Cookie', s.cookie);
        expect([nothing.status, nothing.body]).toEqual([theirs.status, theirs.body]);
        expect(theirs.status).toBe(404);
        // The owner's own wrong-password refusals are throttled the same way
        for (let i = 0; i < 4; i++) await ticketFor(box, ownerSession, { password: 'wrong' });
        expect((await audits('box_terminal_refused')).filter(a => a.changes.code === 'reauth_failed')).toHaveLength(1);
    });
});

describe('review 5: a host socket from an older generation does not count', () => {
    test('after a rebuild the old socket is not "connected", gets no ticket, and is dropped by the next checks', async () => {
        const hub = hubOf();
        const t = await rotateBoxTokens(ctx.db, box.id);
        expect(hub.hostConnected(box.id, box.generation)).toBe(true);
        expect(hub.hostConnected(box.id, t.generation)).toBe(false);
        expect((await ticketFor(box, ownerSession)).body.error).toBe('box_not_ready');
        const gone = wait(host.socket, 'disconnect');
        for (let i = 0; i < 3; i++) await hub.sweep();
        await gone;
        expect(hub.hostConnected(box.id)).toBe(false);
    });

    test('the rebuilt box\'s own host replaces the stale socket instead of being refused', async () => {
        const t = await rotateBoxTokens(ctx.db, box.id);
        await ctx.db.query(`UPDATE agent_boxes SET state = 'running' WHERE id = $1`, [box.id]);
        const rebuilt = await connectHost({ ...box, generation: t.generation, hostToken: t.hostToken, relayToken: t.relayToken, botToken: t.botToken });
        expect(rebuilt.socket.connected).toBe(true);
        expect(hubOf().hostConnected(box.id, t.generation)).toBe(true);
        expect(await audits('box_host_conflict')).toHaveLength(0);
    });

    test('a terminal attached with a stale host would not be paired to it', async () => {
        const hub = hubOf();
        const t = await rotateBoxTokens(ctx.db, box.id);
        await ctx.db.query(`UPDATE agent_boxes SET state = 'running' WHERE id = $1`, [box.id]);
        const closes: string[] = [];
        const fakeBrowser: any = new (require('node:events').EventEmitter)();
        fakeBrowser.connected = true; fakeBrowser.emit2 = fakeBrowser.emit;
        const emitted: string[] = [];
        const emit = fakeBrowser.emit.bind(fakeBrowser);
        fakeBrowser.emit = (e: string, ...a: any[]) => { emitted.push(e); if (e === 'shell:exit') closes.push(a[0].reason); return emit(e, ...a); };
        fakeBrowser.disconnect = () => {};
        const info = { sessionId: '01HZZZZZZZZZZZZZZZZZZZZZZ8', boxId: box.id, serverId, userId: owner.userId, generation: t.generation, limits: { idleMinutes: 15, maxHours: 8, rateKbps: 512 } };
        await ctx.db.query(`INSERT INTO box_shell_sessions (id, box_id, server_id, opened_by, generation) VALUES ($1, $2, $3, $4, $5)`, [info.sessionId, box.id, serverId, owner.userId, t.generation]);
        hub.attachBrowser(fakeBrowser, info, Date.now() + 60_000);
        await settle(100);
        expect(closes).toEqual(['box_not_ready']);
        expect(host.opened).toHaveLength(0);
    });
});

describe('review 6: ownership changes close an open terminal at once', () => {
    test('the gateway\'s access refresh (run after authorization changes commit) ends it without waiting for the sweep', async () => {
        const term = await openTerminal(box, ownerSession);
        const exit = wait(term, 'shell:exit');
        await ctx.db.query(`UPDATE servers SET owner_id = $1 WHERE id = $2`, [member.userId, serverId]);
        await refreshGatewayAccess((ctx.app as any).io, ctx.db);
        expect(await exit).toEqual({ reason: 'access_changed' });
    });
});

describe('review 7: the Origin\'s scheme must match the request\'s', () => {
    const httpsOrigin = () => origin.replace('http:', 'https:');

    test('the ticket route and the socket refuse https Origin on a plain-http request, and take it behind a trusted proxy that says https', async () => {
        const s = ownerSession;
        const refused = await ticketFor(box, s, { password: PASSWORD }, { origin: httpsOrigin() });
        expect([refused.status, refused.body]).toEqual([403, { error: 'origin_not_allowed' }]);
        expect(await refusal(browser(s, await getTicket(box, s), { origin: httpsOrigin() }))).toBe('origin_not_allowed');
        // Same host, right scheme: fine
        expect((await ticketFor(box, s)).status).toBe(200);

        const saved = config.trustProxy;
        (config as any).trustProxy = true;
        try {
            const viaProxy = await ticketFor(box, s, { password: PASSWORD }, { origin: httpsOrigin() }).set('X-Forwarded-Proto', 'https');
            expect(viaProxy.status, JSON.stringify(viaProxy.body)).toBe(200);
            // The proxy says https but the Origin says http: refused
            const wrong = await ticketFor(box, s).set('X-Forwarded-Proto', 'https');
            expect(wrong.body).toEqual({ error: 'origin_not_allowed' });
            const sock = browser(s, viaProxy.body.ticket, { origin: httpsOrigin(), headers: { 'x-forwarded-proto': 'https' } });
            expect(await refusal(sock)).toBe('connected');
        } finally {
            (config as any).trustProxy = saved;
        }
        // Without trusting the proxy, the header is ignored
        const ignored = await ticketFor(box, s, { password: PASSWORD }, { origin: httpsOrigin() }).set('X-Forwarded-Proto', 'https');
        expect(ignored.status).toBe(403);
    });
});

describe('review 8: a browser that stops reading cannot make the hub queue without bound', () => {
    test('the terminal is closed with browser_stalled once the buffered bytes pass the cap', async () => {
        await api.patch(`/boxes/${box.id}`).set(owner.auth).send({ terminalRateKbps: 8192 });
        const hub = hubOf();
        hub.maxBrowserBuffer = 256 * 1024;
        const term = await openTerminal(box, ownerSession);
        // The client stops reading its TCP socket: the server's writes pile up
        const raw = (term.io.engine as any).transport?.ws?._socket;
        expect(raw).toBeTruthy();
        raw.pause();
        const sid = host.opened[0].sessionId;
        const chunk = Buffer.alloc(32 * 1024, 65);
        let closed = false;
        for (let i = 0; i < 1500 && !closed; i++) {
            host.socket.emit('shell:output', { sessionId: sid, data: chunk });
            if (i % 25 === 0) { await settle(15); closed = (await sessionRows())[0].state === 'closed'; }
        }
        await settle(300);
        expect((await sessionRows())[0]).toMatchObject({ state: 'closed', close_reason: 'browser_stalled' });
        raw.resume();
    }, 30_000);
});
