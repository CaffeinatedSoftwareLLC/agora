import { io, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { sweepStaleTerminals } from '../../src/lib/terminal-sessions';

/**
 * Terminal sessions (#112, src/lib/terminal-sessions.ts): an agent connected from its user's
 * own terminal through agora-mcp with presence is a lightweight session. One responder per
 * bot, reservations, working state, the /start warning, and unchanged authority.
 */

process.env.AGORA_TERMINAL_GRACE_MS = '300';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let hostId: string;
interface Agent { id: string; name: string; token: string; auth: { Authorization: string } }
let claude: Agent;
const sockets: Socket[] = [];

function event(socket: Socket, name: string, match: (v: any) => boolean = () => true): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off(name, on); reject(new Error(`Missing ${name}`)); }, 3000);
        const on = (value: any) => { if (!match(value)) return; clearTimeout(timer); socket.off(name, on); resolve(value); };
        socket.on(name, on);
    });
}

/** agora-mcp's presence socket: resolves once Agora has attached the terminal session. */
async function connectTerminal(agent: Agent, mode: 'mcp' | 'channel' = 'mcp') {
    const socket = io('http://localhost:4999', {
        transports: ['websocket'], reconnection: false, autoConnect: false,
        auth: { type: 'bot', token: agent.token, mode },
    });
    sockets.push(socket);
    const attached = event(socket, 'TerminalSession');
    socket.connect();
    const { sessions } = await attached;
    return { socket, sessionId: sessions.find((s: any) => s.channelId === channelId).sessionId as string };
}

async function until<T>(check: () => Promise<T | undefined | null | false>, what: string, ms = 4000): Promise<T> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const v = await check();
        if (v) return v;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for ${what}`);
}

const sessionRow = async (id: string) => (await ctx.db.query('SELECT * FROM agent_sessions WHERE id = $1', [id])).rows[0];
const command = (auth: object, body: object) => ctx.request.post(`/channels/${channelId}/agent-commands`).set(auth).send(body);
async function post(auth: object, content: string) {
    const res = await ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    return res.body;
}
async function inbox(sessionId: string): Promise<string[]> {
    return (await ctx.db.query(`SELECT message_id FROM agent_inbox WHERE session_id = $1 AND reason = 'direct' ORDER BY id`, [sessionId]))
        .rows.map((r: any) => r.message_id.trim());
}
async function startHosted(): Promise<string> {
    const res = await command(owner.auth, { command: 'start', profile: claude.name });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.session.id;
}
async function notices(text: string): Promise<number> {
    return Number((await ctx.db.query(`SELECT count(*) FROM messages WHERE channel_id = $1 AND system_event = 'agent_session' AND content LIKE $2`,
        [channelId, `%${text}%`])).rows[0].count);
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await ctx.app.listen({ port: 4999, host: '127.0.0.1' });
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'termowner');
    member = await authedUser(ctx.request, 'termmember');
    const server = await createServer(ctx.request, owner.auth, 'Terminals');
    serverId = server.serverId; channelId = server.generalChannelId;
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'terminal-host' });
    hostId = host.body.host.id;
    const res = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
        .send({ name: 'termclaude', hostId, adapter: 'claude', workdirAlias: 'agora', channelId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    claude = { id: res.body.bot.id, name: 'termclaude', token: res.body.token, auth: { Authorization: `Bot ${res.body.token}` } };
});
afterEach(async () => {
    for (const s of sockets.splice(0)) s.disconnect();
    // Let grace timers of this test run out before the next one starts
    await until(async () => (await ctx.db.query(`SELECT 1 FROM agent_sessions WHERE kind = 'terminal' AND state = 'live'`)).rows.length === 0,
        'terminal sessions to end');
    await ctx.db.query('TRUNCATE agent_sessions, messages CASCADE');
});
afterAll(async () => { await ctx.close(); });

describe('terminal session lifecycle', () => {
    test('presence attaches a terminal session, listed by /sessions; it ends after the grace period', async () => {
        const { socket, sessionId } = await connectTerminal(claude);
        const row = await sessionRow(sessionId);
        expect(row).toMatchObject({ kind: 'terminal', state: 'live', profile_id: null, terminal_mode: 'mcp' });

        const listed = await command(member.auth, { command: 'sessions' });
        expect(listed.body.sessions).toEqual([expect.objectContaining({
            id: sessionId, kind: 'terminal', profile: 'termclaude', state: 'live', running: false,
            tokenBudget: null, budgetEnforced: false, usageKnown: false, toolCalls: 0, terminalMode: 'mcp',
        })]);

        socket.disconnect();
        const ended = await until(async () => { const r = await sessionRow(sessionId); return r.state === 'ended' && r; }, 'session end');
        expect(ended.end_reason).toBe('disconnected');
        // Ended terminal sessions are left out of the list
        expect((await command(member.auth, { command: 'sessions' })).body.sessions).toEqual([]);
    });

    test('a reconnect within the grace period keeps the same session', async () => {
        const first = await connectTerminal(claude);
        first.socket.disconnect();
        const second = await connectTerminal(claude);
        expect(second.sessionId).toBe(first.sessionId);
        await new Promise(r => setTimeout(r, 500));
        expect((await sessionRow(first.sessionId)).state).toBe('live');
    });

    test('a bot socket without presence (a hosted run, --no-presence) makes no terminal session', async () => {
        const socket = io('http://localhost:4999', { transports: ['websocket'], reconnection: false, autoConnect: false, auth: { type: 'bot', token: claude.token } });
        sockets.push(socket);
        const ready = event(socket, 'BotReady');
        socket.connect();
        await ready;
        await new Promise(r => setTimeout(r, 200));
        expect((await ctx.db.query(`SELECT 1 FROM agent_sessions WHERE kind = 'terminal'`)).rows).toEqual([]);
    });

    test('the sweep ends a terminal session nobody heartbeats (its API process went away)', async () => {
        const { socket, sessionId } = await connectTerminal(claude);
        await ctx.db.query(`UPDATE agent_sessions SET seen_at = NOW() - interval '10 minutes' WHERE id = $1`, [sessionId]);
        const ended = await sweepStaleTerminals(ctx.db, 60_000);
        expect(ended.map(n => n.event.sessionId)).toEqual([sessionId]);
        expect((await sessionRow(sessionId)).end_reason).toBe('disconnected');
        socket.disconnect();
    });

    test('working/idle and tool calls from agora-mcp feed the session and the working indicator', async () => {
        const { socket, sessionId } = await connectTerminal(claude);
        const watcher = io('http://localhost:4999', { transports: ['websocket'], reconnection: false, autoConnect: false, auth: { token: owner.token } });
        sockets.push(watcher);
        const ready = event(watcher, 'Ready');
        watcher.connect();
        await ready;

        const working = event(watcher, 'AgentSessionUpdate', e => e.sessionId === sessionId && e.running);
        socket.emit('Activity', { working: true, toolCalls: 2 });
        expect(await working).toMatchObject({ kind: 'terminal', running: true, toolCalls: 2, state: 'live' });
        const listed = (await command(owner.auth, { command: 'sessions' })).body.sessions[0];
        expect(listed).toMatchObject({ running: true, toolCalls: 2, usageKnown: false, tokensUsed: 0 });

        const idle = event(watcher, 'AgentSessionUpdate', e => e.sessionId === sessionId && !e.running);
        socket.emit('Activity', { working: false, toolCalls: 2 });
        await idle;
        socket.emit('Activity', { working: 'yes' });
        await new Promise(r => setTimeout(r, 100));
        expect((await sessionRow(sessionId)).working).toBe(false);
    });
});

describe('single responder', () => {
    test('a thread @mention while the terminal is live wakes no hosted run (#120); the terminal hears it', async () => {
        const hostedId = await startHosted();
        await connectTerminal(claude);
        const parent = await post(member.auth, 'a question in a thread');
        const res = await ctx.request.post(`/channels/${channelId}/messages/${parent.id}/replies`).set(owner.auth).send({ content: `@${claude.name.toUpperCase()} take a look` });
        expect(res.status).toBe(201);
        expect(res.body.mentions).toEqual([claude.id]);
        expect(await inbox(hostedId)).not.toContain(res.body.id);
        expect(await notices('has no live session')).toBe(0);
    });

    test('a live terminal session keeps @mentions out of the hosted inbox; after presence drops, hosted works again', async () => {
        const hostedId = await startHosted();
        const { socket } = await connectTerminal(claude);
        // The one-time notice, posted when both exist
        expect(await notices('is connected from a terminal')).toBe(1);

        const m1 = await post(owner.auth, `@${claude.name} run the tests`);
        expect(await inbox(hostedId)).not.toContain(m1.id);
        await post(owner.auth, `@${claude.name} again`);
        expect(await inbox(hostedId)).toEqual([]);
        expect(await notices('is connected from a terminal')).toBe(1);

        socket.disconnect();
        await until(async () => (await ctx.db.query(`SELECT 1 FROM agent_sessions WHERE kind = 'terminal' AND state = 'live'`)).rows.length === 0, 'terminal end');
        const m3 = await post(owner.auth, `@${claude.name} your turn`);
        expect(await inbox(hostedId)).toEqual([m3.id]);
    });

    test('an unmentioned post does not wake the only hosted agent while another agent is connected from a terminal', async () => {
        const res = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
            .send({ name: 'termcodex', hostId, adapter: 'codex', workdirAlias: 'agora', channelId });
        const codex: Agent = { id: res.body.bot.id, name: 'termcodex', token: res.body.token, auth: { Authorization: `Bot ${res.body.token}` } };
        const hostedId = await startHosted();
        const m1 = await post(owner.auth, 'anyone there?');
        expect(await inbox(hostedId)).toEqual([m1.id]);
        await connectTerminal(codex);
        await post(owner.auth, 'anyone there now?');
        expect(await inbox(hostedId)).toEqual([m1.id]);
    });
});

describe('/start while connected from a terminal', () => {
    test('warns, keeps the terminal, or starts the hosted session on standby', async () => {
        const { sessionId } = await connectTerminal(claude);
        const asked = await command(owner.auth, { command: 'start', profile: claude.name });
        expect(asked.status).toBe(409);
        expect(asked.body).toMatchObject({ error: 'terminal_connected', message: 'termclaude is already connected from a terminal.', session: { id: sessionId, kind: 'terminal' } });

        const kept = await command(owner.auth, { command: 'start', profile: claude.name, onLive: 'keep' });
        expect(kept.status).toBe(200);
        expect(kept.body).toMatchObject({ action: 'kept_terminal', session: { id: sessionId } });
        expect((await ctx.db.query(`SELECT 1 FROM agent_sessions WHERE kind = 'hosted'`)).rows).toEqual([]);

        const standby = await command(owner.auth, { command: 'start', profile: claude.name, onLive: 'standby' });
        expect(standby.status, JSON.stringify(standby.body)).toBe(201);
        expect(standby.body.session.kind).toBe('hosted');
        expect(await notices('is connected from a terminal')).toBe(1);

        // Terminal sessions are not ended, resumed or budgeted through commands
        expect((await command(owner.auth, { command: 'end', sessionId })).body).toEqual({ error: 'terminal_session' });
        expect((await command(owner.auth, { command: 'budget', sessionId, tokenBudget: 5 })).status).toBe(404);
        expect((await command(owner.auth, { command: 'resume', sessionId })).status).toBe(400);
    });
});

describe('reservations', () => {
    test('a terminal session holds reservations (no hosted session needed); they are released when it ends', async () => {
        expect((await ctx.request.post(`/channels/${channelId}/file-reservations`).set(claude.auth).send({ action: 'reserve', paths: ['a.ts'] })).body)
            .toEqual({ error: 'no_live_session' });
        const { socket, sessionId } = await connectTerminal(claude);
        const reserved = await ctx.request.post(`/channels/${channelId}/file-reservations`).set(claude.auth).send({ action: 'reserve', paths: ['src/a.ts'] });
        expect(reserved.status, JSON.stringify(reserved.body)).toBe(201);
        expect(reserved.body.reservation).toMatchObject({ sessionId, holder: 'termclaude (terminal)', paths: ['src/a.ts'] });
        const listed = await ctx.request.get(`/channels/${channelId}/file-reservations`).set(owner.auth);
        expect(listed.body.reservations).toEqual([expect.objectContaining({ id: reserved.body.reservation.id, sessionId })]);

        // A hosted session of another agent conflicts with it as usual
        const res = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
            .send({ name: 'termother', hostId, adapter: 'codex', workdirAlias: 'agora', channelId });
        const other = { Authorization: `Bot ${res.body.token}` };
        expect((await command(owner.auth, { command: 'start', profile: 'termother' })).status).toBe(201);
        const conflict = await ctx.request.post(`/channels/${channelId}/file-reservations`).set(other).send({ action: 'reserve', paths: ['src/'] });
        expect(conflict.status).toBe(409);
        expect(conflict.body.holder).toMatchObject({ sessionId, profile: 'termclaude (terminal)' });

        socket.disconnect();
        await until(async () => (await ctx.db.query('SELECT released_at FROM agent_file_reservations WHERE id = $1', [reserved.body.reservation.id])).rows[0].released_at,
            'reservation release');
    });

    test('with a hosted session on standby, the terminal session holds the reservation', async () => {
        await startHosted();
        const { sessionId } = await connectTerminal(claude);
        const reserved = await ctx.request.post(`/channels/${channelId}/file-reservations`).set(claude.auth).send({ action: 'reserve', paths: ['b.ts'] });
        expect(reserved.body.reservation.sessionId).toBe(sessionId);
    });
});

describe('authority is unchanged', () => {
    test('a member without authority still wakes nothing, and a connected terminal agent cannot direct', async () => {
        const hostedId = await startHosted();
        await connectTerminal(claude);
        await post(member.auth, `@${claude.name} do something`);
        expect(await inbox(hostedId)).toEqual([]);
        expect(await notices('is connected from a terminal')).toBe(1);

        // Being connected from a terminal gives the bot no authority to start agents
        const res = await command(claude.auth, { command: 'start', profile: claude.name });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('cannot_direct');
    });
});
