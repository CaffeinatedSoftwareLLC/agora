import { io, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { resetRunStreams, STREAM_LIMITS } from '../../src/lib/run-stream';

/**
 * Live output of a hosted run (docs/live-output.md): the host's stream batches, the channel's
 * socket room, the tail for a late joiner, and what is never stored or sent.
 */
let ctx: Awaited<ReturnType<typeof setupTestApp>>;
type User = Awaited<ReturnType<typeof authedUser>>;
let owner: User;
let outsider: User;
let serverId: string;
let channelId: string;
let hostId: string;
let hostAuth: { Authorization: string };
let otherHostAuth: { Authorization: string };
let foreignHostAuth: { Authorization: string };
let botId: string;
let botAuth: { Authorization: string };
let profileId: string;
let runId: string;
let claimToken: string;
let sessionId: string;
const sockets: Socket[] = [];
const PORT = 4977;

const event = (socket: Socket, name: string, ms = 4000): Promise<any> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${name}`)), ms);
    socket.once(name, data => { clearTimeout(timer); resolve(data); });
});
async function connect(token: string) {
    const socket = io(`http://localhost:${PORT}`, { transports: ['websocket'], auth: { token }, autoConnect: false, reconnection: false });
    sockets.push(socket);
    const ready = event(socket, 'Ready');
    socket.connect();
    await ready;
    return socket;
}
const bearer = (u: User) => u.auth.Authorization.slice('Bearer '.length);
const quiet = (socket: Socket, name: string, ms = 400) => new Promise<boolean>(resolve => {
    const got = () => resolve(false); socket.once(name, got);
    setTimeout(() => { socket.off(name, got); resolve(true); }, ms);
});
const url = () => `/agent-hosts/@me/runs/${runId}/stream`;
const send = (events: unknown[], auth = hostAuth, token = claimToken) => ctx.request.post(url()).set(auth).send({ claimToken: token, events });
const text = (delta: string, message = 'msg_1') => ({ type: 'text', message, delta });
const step = (id: string, state: 'start' | 'ok' | 'failed', label = 'Read src/app.ts') => ({ type: 'step', step: id, state, ...(state === 'start' ? { tool: 'Read', label } : {}) });

async function newHost(serverOf = serverId, name = 'pc') {
    const host = await ctx.request.post(`/servers/${serverOf}/agent-hosts`).set(owner.auth).send({ name });
    expect(host.status).toBe(201);
    return { id: host.body.host.id as string, auth: { Authorization: `AgentHost ${host.body.token}` } };
}
async function claimRun() {
    const sent = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: '@streamer check the build' });
    expect([200, 201]).toContain(sent.status);
    const c = await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    runId = c.body.run.id; claimToken = c.body.run.claimToken;
    return c.body;
}
/** Ends the claimed run through the real route, so the session's batch is released as it would be. */
async function endRun() {
    await ctx.db.query(`UPDATE agent_runs SET lease_until = NOW() + interval '1 minute' WHERE id = $1 AND status = 'claimed'`, [runId]);
    const r = await ctx.request.post(`/agent-hosts/@me/runs/${runId}/fail`).set(hostAuth).send({ claimToken, error: 'cli_failed', message: 'x', tokensUsed: 0, retryable: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const messageCount = async () => Number((await ctx.db.query('SELECT COUNT(*) FROM messages WHERE channel_id = $1', [channelId])).rows[0].count);

beforeAll(async () => {
    ctx = await setupTestApp();
    await ctx.app.listen({ host: '127.0.0.1', port: PORT });
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'rsowner');
    outsider = await authedUser(ctx.request, 'rsoutsider');
    const server = await createServer(ctx.request, owner.auth, 'Stream Server');
    serverId = server.serverId; channelId = server.generalChannelId;
    const host = await newHost(); hostId = host.id; hostAuth = host.auth;
    otherHostAuth = (await newHost(serverId, 'other pc')).auth;
    const foreign = await createServer(ctx.request, outsider.auth, 'Foreign');
    const fh = await ctx.request.post(`/servers/${foreign.serverId}/agent-hosts`).set(outsider.auth).send({ name: 'foreign' });
    foreignHostAuth = { Authorization: `AgentHost ${fh.body.token}` };
    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'streamer' });
    botId = bot.body.id;
    const token = await ctx.request.post(`/servers/${serverId}/bots/${botId}/tokens`).set(owner.auth).send({});
    botAuth = { Authorization: `Bot ${token.body.token}` };
    expect((await ctx.request.post(`/channels/${channelId}/bots/${botId}`).set(owner.auth)).status).toBe(201);
    const profile = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
        .send({ hostModeAck: true, name: 'streamer', botId, hostId, adapter: 'claude', workdirAlias: 'agora', model: null, effort: null });
    expect(profile.status, JSON.stringify(profile.body)).toBe(201);
    profileId = profile.body.id;
    expect(profile.body.showLiveOutput).toBe(true);
    sessionId = generateUlid();
    await ctx.db.query(`INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [sessionId, serverId, channelId, botId, profileId, owner.userId]);
});
afterAll(async () => { for (const s of sockets) s.close(); await ctx.close(); });
beforeEach(() => resetRunStreams());

describe('live output of a hosted run', () => {
    it('is on by default and the claim says so; the owner can turn it off for one agent, and the route then sends nothing', async () => {
        const claim = await claimRun();
        expect(claim.profile.liveOutput).toBe(true);
        const socket = await connect(bearer(owner));
        const off = await ctx.request.patch(`/servers/${serverId}/agent-profiles/${profileId}`).set(owner.auth).send({ showLiveOutput: false });
        expect(off.status).toBe(200); expect(off.body.showLiveOutput).toBe(false);
        const refused = await send([text('hello')]);
        expect(refused.status).toBe(200); expect(refused.body).toEqual({ ok: true, enabled: false });
        expect(await quiet(socket, 'AgentRunStream')).toBe(true);
        expect((await ctx.request.get(`/channels/${channelId}/agent-run-streams`).set(owner.auth)).body.streams).toEqual([]);
        // A non-owner cannot change the setting
        expect((await ctx.request.patch(`/servers/${serverId}/agent-profiles/${profileId}`).set(outsider.auth).send({ showLiveOutput: true })).status).toBeGreaterThanOrEqual(403);
        await ctx.request.patch(`/servers/${serverId}/agent-profiles/${profileId}`).set(owner.auth).send({ showLiveOutput: true });
        const done = await ctx.request.post(`/agent-hosts/@me/runs/${runId}/complete`).set(hostAuth).send({ claimToken, nativeSessionId: 'n', summary: 'ok', tokensUsed: 1 });
        expect(done.status).toBe(200);
    });

    it('refuses everyone but the host that claimed the run, while it is claimed', async () => {
        await claimRun();
        const body = { claimToken, events: [text('x')] };
        // another host of the same server, a host of another server
        expect((await ctx.request.post(url()).set(otherHostAuth).send(body)).status).toBe(404);
        expect((await ctx.request.post(url()).set(foreignHostAuth).send(body)).status).toBe(404);
        // the right host with a wrong or stale claim token
        expect((await send([text('x')], hostAuth, 'rt_wrong_token_value')).status).toBe(409);
        // a bot, a person, and no one
        const bot = await ctx.request.post(url()).set(botAuth).send(body);
        expect(bot.status).toBe(403); expect(bot.body.error).toBe('This endpoint needs a host token');
        expect((await ctx.request.post(url()).set(owner.auth).send(body)).status).toBe(403);
        expect((await ctx.request.post(url()).send(body)).status).toBe(403);
        // nothing of that reached the tail
        expect((await ctx.request.get(`/channels/${channelId}/agent-run-streams`).set(owner.auth)).body.streams).toEqual([]);
        // the real host works; after the run is over the same call is refused
        expect((await send([text('x')])).status).toBe(200);
        const done = await ctx.request.post(`/agent-hosts/@me/runs/${runId}/complete`).set(hostAuth).send({ claimToken, nativeSessionId: 'n', summary: 'ok', tokensUsed: 1 });
        expect(done.status).toBe(200);
        const late = await send([text('too late')]);
        expect(late.status).toBe(409); expect(late.body.error).toBe('already_finished');
        // an expired lease is refused as well
        await claimRun();
        await ctx.db.query(`UPDATE agent_runs SET lease_until = NOW() - interval '1 second' WHERE id = $1`, [runId]);
        expect((await send([text('x')])).status).toBe(409);
        await endRun();
    });

    it('enforces the batch limits', async () => {
        await claimRun();
        expect((await send(Array.from({ length: STREAM_LIMITS.maxEvents + 1 }, (_, i) => step(`s${i}`, 'start')))).status).toBe(400);
        expect((await send(Array.from({ length: STREAM_LIMITS.maxEvents }, (_, i) => step(`s${i}`, 'start')))).status).toBe(200);
        expect((await send([])).status).toBe(400);
        expect((await send([text('x'.repeat(STREAM_LIMITS.maxDelta + 1))])).status).toBe(400);
        expect((await send([text('x'.repeat(STREAM_LIMITS.maxDelta))])).status).toBe(200);
        expect((await send([step('s', 'start', 'x'.repeat(STREAM_LIMITS.maxLabel + 1))])).status).toBe(400);
        expect((await send([{ type: 'thinking', message: 'm', delta: 'x' }])).status).toBe(400);
        expect((await send([{ type: 'step', step: 's', state: 'weird' }])).status).toBe(400);
        // a body over 128 KB is refused before it is parsed
        const big = await ctx.request.post(url()).set(hostAuth).send({ claimToken, events: Array.from({ length: 30 }, () => text('y'.repeat(STREAM_LIMITS.maxDelta))) });
        expect(big.status).toBe(413);
        // the server keeps at most maxSteps steps per run
        const tail = (await ctx.request.get(`/channels/${channelId}/agent-run-streams`).set(owner.auth)).body.streams[0];
        expect(tail.steps).toHaveLength(STREAM_LIMITS.maxSteps);
        await endRun();
    });

    it('emits to the channel room only, gives a late joiner the tail, stores nothing, and ends with the run', async () => {
        await claimRun();
        const before = await messageCount();
        const viewer = await connect(bearer(owner));
        const stranger = await connect(bearer(outsider));
        const got = event(viewer, 'AgentRunStream');
        const none = quiet(stranger, 'AgentRunStream', 600);
        const r = await send([text('Looking at '), text('the build.'), step('t1', 'start', 'Read src/app.ts')]);
        expect(r.status).toBe(200); expect(r.body).toEqual({ ok: true, enabled: true });
        const first = await got;
        expect(first).toMatchObject({ channelId, sessionId, runId, threadId: null, profile: 'streamer', seq: 1 });
        expect(first.events).toEqual([
            { type: 'text', message: 'msg_1', delta: 'Looking at ', replace: true },
            { type: 'text', message: 'msg_1', delta: 'the build.' },
            { type: 'step', step: 't1', state: 'start', tool: 'Read', label: 'Read src/app.ts' },
        ]);
        expect(await none).toBe(true);

        const second = event(viewer, 'AgentRunStream');
        await send([step('t1', 'ok'), step('t2', 'start', 'Ran npm test'), text('Tests pass.', 'msg_2')]);
        expect((await second).seq).toBe(2);

        // a person who opens the channel now sees the tail: the current message and the steps
        const tail = await ctx.request.get(`/channels/${channelId}/agent-run-streams`).set(owner.auth);
        expect(tail.status).toBe(200);
        expect(tail.body.streams).toEqual([{ sessionId, runId, threadId: null, profile: 'streamer', seq: 2, text: 'Tests pass.', textTruncated: false,
            steps: [{ step: 't1', tool: 'Read', label: 'Read src/app.ts', state: 'ok' }, { step: 't2', tool: 'Read', label: 'Ran npm test', state: 'running' }] }]);
        // someone who cannot view the channel gets neither the tail nor an answer
        expect((await ctx.request.get(`/channels/${channelId}/agent-run-streams`).set(outsider.auth)).status).toBe(403);
        expect((await ctx.request.get(`/channels/${channelId}/agent-run-streams`)).status).toBe(401);

        // nothing was written to the messages table
        expect(await messageCount()).toBe(before);

        // the run ends: the viewers are told, and the tail is gone
        const end = event(viewer, 'AgentRunStreamEnd');
        const done = await ctx.request.post(`/agent-hosts/@me/runs/${runId}/complete`).set(hostAuth).send({ claimToken, nativeSessionId: 'n', summary: 'ok', tokensUsed: 1 });
        expect(done.status).toBe(200);
        expect(await end).toEqual({ channelId, sessionId, runId });
        expect((await ctx.request.get(`/channels/${channelId}/agent-run-streams`).set(owner.auth)).body.streams).toEqual([]);
        // (the only new message is the system notice a run that posted nothing always gets)
        const streamed = await ctx.db.query(`SELECT 1 FROM messages WHERE content LIKE '%Tests pass.%' OR content LIKE '%Looking at%'`);
        expect(streamed.rows).toHaveLength(0);
    });

    it('ends a failed run too, and a cancelled one when the host learns of it', async () => {
        await claimRun();
        await send([text('working')]);
        const viewer = await connect(bearer(owner));
        const end = event(viewer, 'AgentRunStreamEnd');
        const failed = await ctx.request.post(`/agent-hosts/@me/runs/${runId}/fail`).set(hostAuth).send({ claimToken, error: 'cli_failed', message: 'x', tokensUsed: 0, retryable: false });
        expect(failed.status).toBe(200);
        expect((await end).runId).toBe(runId);
        expect((await ctx.request.get(`/channels/${channelId}/agent-run-streams`).set(owner.auth)).body.streams).toEqual([]);
        // a run that is claimed no longer, even with a leftover tail, is not given to a late joiner
        await claimRun();
        await send([text('again')]);
        await ctx.db.query(`UPDATE agent_runs SET lease_until = NOW() - interval '1 second' WHERE id = $1`, [runId]);
        expect((await ctx.request.get(`/channels/${channelId}/agent-run-streams`).set(owner.auth)).body.streams).toEqual([]);
        await endRun();
    });

    it('cleans text and labels like a message: escape sequences and private keys, even when a key spans batches', async () => {
        await claimRun();
        const viewer = await connect(bearer(owner));
        await send([text('hello \u001b]0;title\u0007world \u001b[31mred\u001b[0m')]);
        await send([text(' -----BEGIN RSA PRIVATE KEY-----\nMIIEow')]);
        await send([text('SECRETSECRET\n-----END RSA PRIVATE KEY----- after')]);
        await send([step('t1', 'start', 'Ran\u001b[2J\u0007\r\nfake‮  step')]);
        const tail = (await ctx.request.get(`/channels/${channelId}/agent-run-streams`).set(owner.auth)).body.streams[0];
        expect(tail.text).toContain('hello world red');
        expect(tail.text).toContain('[private key redacted]');
        expect(tail.text).not.toContain('MIIEow'); expect(tail.text).not.toContain('SECRETSECRET'); expect(tail.text).not.toContain('\u001b');
        expect(tail.text.endsWith('after')).toBe(true);
        expect(tail.steps[0].label).toBe('Ran [2J fake step');
        // what the viewers were sent never held the key body either
        const seen: any[] = [];
        viewer.on('AgentRunStream', e => seen.push(e));
        await send([text('more text')]);
        await new Promise(r => setTimeout(r, 200));
        expect(JSON.stringify(seen)).not.toContain('SECRETSECRET');
        await endRun();
    });

    it('keeps the end of a very long message for a late joiner and says it is cut', async () => {
        await claimRun();
        for (let i = 0; i < 6; i++) await send([text(`${i}`.repeat(STREAM_LIMITS.maxDelta), 'long')]);
        const tail = (await ctx.request.get(`/channels/${channelId}/agent-run-streams`).set(owner.auth)).body.streams[0];
        expect(tail.text).toHaveLength(STREAM_LIMITS.tailChars);
        expect(tail.textTruncated).toBe(true);
        expect(tail.text.endsWith('5'.repeat(100))).toBe(true);
        await endRun();
    });
});
