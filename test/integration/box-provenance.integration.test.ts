import { io, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { EDGE_HEADERS, signEdge } from '../../src/lib/boxes/contract';
import { rotateBoxTokens } from '../../src/lib/boxes/tokens';

/**
 * Edge provenance in the API's auth step (docs/agent-boxes.md §4.1, src/lib/boxes/provenance.ts):
 * a box credential works only through its own box's edge at its current generation, and through
 * a box's edge only that box's credentials work. REST (bot, host, JWT) and the Socket.IO handshake.
 */

const EDGE_SECRET = 'cd'.repeat(32);
process.env.AGORA_EDGE_SECRET = EDGE_SECRET;

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let port: number;
type Box = { id: string; generation: number; bot: { Authorization: string }; host: { Authorization: string }; botToken: string };
let a: Box;
let b: Box;
const sockets: Socket[] = [];

async function makeBox(name: string): Promise<Box> {
    const res = await ctx.request.post(`/servers/${serverId}/boxes`).set(owner.auth).send({ name, adapter: 'claude', homeChannelId: channelId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const t = await rotateBoxTokens(ctx.db, res.body.box.id);
    return { id: res.body.box.id, generation: t.generation, bot: { Authorization: `Bot ${t.botToken}` }, host: { Authorization: `AgentHost ${t.hostToken}` }, botToken: t.botToken };
}
const edge = (box: Box, generation = box.generation) => signEdge(EDGE_SECRET, box.id, generation);
const refusals = async () => (await ctx.db.query(
    `SELECT target_type, target_id, changes FROM audit_log WHERE action = 'box_provenance_refused' ORDER BY created_at, id`)).rows;
const notices = async () => (await ctx.db.query(
    `SELECT content FROM messages WHERE channel_id = $1 AND system_event = 'agent_session' AND content LIKE 'Box **%' ORDER BY id`, [channelId])).rows;

beforeAll(async () => {
    ctx = await setupTestApp();
    // Any free port: other suites may hold 4999
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    port = (ctx.app.server.address() as any).port;
});
beforeEach(async () => {
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'provowner');
    const s = await createServer(ctx.request, owner.auth, 'Provenance');
    serverId = s.serverId; channelId = s.generalChannelId;
    a = await makeBox('alpha');
    b = await makeBox('beta');
});
afterEach(() => { for (const s of sockets.splice(0)) s.disconnect(); });
afterAll(async () => { await ctx.close(); });

describe('box bot token (REST)', () => {
    test('works only through its own box at its generation', async () => {
        const ok = await ctx.request.get('/bots/@me').set(a.bot).set(edge(a));
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body.username).toBe('alpha');

        expect((await ctx.request.get('/bots/@me').set(a.bot)).body).toEqual({ error: 'box_token_outside_box' });
        expect((await ctx.request.get('/bots/@me').set(a.bot).set(edge(b))).body).toEqual({ error: 'token_not_for_this_box' });
        const forged = { ...edge(a), [EDGE_HEADERS.sig]: '0'.repeat(64) };
        expect((await ctx.request.get('/bots/@me').set(a.bot).set(forged)).body).toEqual({ error: 'bad_edge_signature' });
        const wrongKey = signEdge('ef'.repeat(32), a.id, a.generation);
        expect((await ctx.request.get('/bots/@me').set(a.bot).set(wrongKey)).body).toEqual({ error: 'bad_edge_signature' });
        const stale = signEdge(EDGE_SECRET, a.id, a.generation, Date.now() - 120_000);
        expect((await ctx.request.get('/bots/@me').set(a.bot).set(stale)).status).toBe(403);
        // The same refusals on a write route
        expect((await ctx.request.post(`/channels/${channelId}/messages`).set(a.bot).send({ content: 'hi' })).body).toEqual({ error: 'box_token_outside_box' });

        const rows = await refusals();
        expect(rows.map(r => r.changes.code)).toEqual(['box_token_outside_box', 'token_not_for_this_box', 'bad_edge_signature', 'bad_edge_signature', 'bad_edge_signature', 'box_token_outside_box']);
        expect(rows[0]).toMatchObject({ target_type: 'bot', changes: { credentialBox: a.id, edgeBox: null, method: 'GET', route: '/bots/@me' } });
        expect(rows[1].changes).toMatchObject({ credentialBox: a.id, edgeBox: b.id });
    });

    test('an old generation is dead after a rebuild', async () => {
        const old = { ...a };
        const rotated = await rotateBoxTokens(ctx.db, a.id);
        // The old token is revoked by the rotation itself
        expect((await ctx.request.get('/bots/@me').set(old.bot).set(edge(old))).status).toBe(401);
        // A token still bound to the old generation (not revoked), through the current or the old edge
        await ctx.db.query(`UPDATE bot_tokens SET revoked_at = NULL WHERE box_id = $1 AND box_generation = $2`, [a.id, old.generation]);
        expect((await ctx.request.get('/bots/@me').set(old.bot).set(edge(old))).body).toEqual({ error: 'bad_edge_signature' });
        expect((await ctx.request.get('/bots/@me').set(old.bot).set(edge(old, rotated.generation))).body).toEqual({ error: 'token_not_for_this_box' });
        expect((await ctx.request.get('/bots/@me').set({ Authorization: `Bot ${rotated.botToken}` }).set(edge(old, rotated.generation))).status).toBe(200);
    });

    test('ordinary credentials keep working without edge headers, and never through an edge', async () => {
        const created = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'plainbot' });
        const token = await ctx.request.post(`/servers/${serverId}/bots/${created.body.id}/tokens`).set(owner.auth).send({});
        const plain = { Authorization: `Bot ${token.body.token}` };
        expect((await ctx.request.get('/bots/@me').set(plain)).status).toBe(200);
        expect((await ctx.request.get('/bots/@me').set(plain).set(edge(a))).body).toEqual({ error: 'token_not_for_this_box' });

        expect((await ctx.request.get(`/servers/${serverId}/boxes`).set(owner.auth)).status).toBe(200);
        expect((await ctx.request.get(`/servers/${serverId}/boxes`).set(owner.auth).set(edge(a))).body).toEqual({ error: 'token_not_for_this_box' });
        expect((await ctx.request.get(`/servers/${serverId}/boxes`).set(owner.auth).set({ [EDGE_HEADERS.box]: a.id })).body).toEqual({ error: 'bad_edge_signature' });
        const rows = await refusals();
        expect(rows.find(r => r.target_type === 'user')).toMatchObject({ target_id: owner.userId, changes: { code: 'token_not_for_this_box', edgeBox: a.id } });
        // Unauthenticated routes are untouched
        expect((await ctx.request.get('/health').set(edge(a))).status).toBe(200);
    });

    test('refusals are posted to the box home channel at most once per hour per box', async () => {
        for (let i = 0; i < 3; i++) await ctx.request.get('/bots/@me').set(a.bot);
        await ctx.request.get('/bots/@me').set(b.bot);
        const posted = await notices();
        expect(posted).toHaveLength(2);
        expect(posted[0].content).toContain('Box **alpha**');
        expect(posted[0].content).toContain('box_token_outside_box');
        expect(posted[1].content).toContain('Box **beta**');
        expect(await refusals()).toHaveLength(4);
        // An hour later the next one is posted again
        await ctx.db.query(`UPDATE audit_log SET created_at = NOW() - interval '61 minutes' WHERE action = 'box_provenance_notice'`);
        await ctx.request.get('/bots/@me').set(a.bot);
        expect(await notices()).toHaveLength(3);
    });
});

describe('box host token (REST)', () => {
    test('the same rule on /agent-hosts/@me/*', async () => {
        const url = '/agent-hosts/@me/box-login';
        expect((await ctx.request.get(url).set(a.host).set(edge(a))).status).toBe(204);
        expect((await ctx.request.get(url).set(a.host)).body).toEqual({ error: 'box_token_outside_box' });
        expect((await ctx.request.get(url).set(a.host).set(edge(b))).body).toEqual({ error: 'token_not_for_this_box' });
        expect((await ctx.request.get(url).set(a.host).set({ ...edge(a), [EDGE_HEADERS.sig]: 'f'.repeat(64) })).body).toEqual({ error: 'bad_edge_signature' });

        await ctx.db.query(`UPDATE agent_boxes SET generation = generation + 1 WHERE id = $1`, [a.id]);
        expect((await ctx.request.get(url).set(a.host).set(edge(a))).body).toEqual({ error: 'bad_edge_signature' });
        const rows = await refusals();
        expect(rows.every(r => r.target_type === 'agent_host')).toBe(true);
        expect(rows).toHaveLength(4);
    });

    test('a machine host is refused through an edge and is not a box host', async () => {
        const created = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'laptop' });
        const host = { Authorization: `AgentHost ${created.body.token}` };
        expect((await ctx.request.get('/agent-hosts/@me/runs/next').set(host)).status).toBe(204);
        expect((await ctx.request.get('/agent-hosts/@me/runs/next').set(host).set(edge(a))).body).toEqual({ error: 'token_not_for_this_box' });
        expect((await ctx.request.get('/agent-hosts/@me/box-login').set(host)).body).toEqual({ error: 'box_hosts_only' });
    });
});

describe('Socket.IO handshake', () => {
    function handshake(token: string, headers: Record<string, string> = {}, bot = true): Promise<'ready' | string> {
        const socket = io(`http://127.0.0.1:${port}`, {
            transports: ['websocket'], reconnection: false, extraHeaders: headers,
            auth: { token, ...(bot ? { type: 'bot' } : {}) },
        });
        sockets.push(socket);
        return new Promise(resolve => {
            socket.once(bot ? 'BotReady' : 'Ready', () => resolve('ready'));
            socket.once('connect_error', (err: Error) => resolve(err.message));
        });
    }

    test('a box bot token connects only through its own box', async () => {
        expect(await handshake(a.botToken)).toBe('box_token_outside_box');
        expect(await handshake(a.botToken, edge(b))).toBe('token_not_for_this_box');
        expect(await handshake(a.botToken, { ...edge(a), [EDGE_HEADERS.sig]: '0'.repeat(64) })).toBe('bad_edge_signature');
        expect(await handshake(a.botToken, edge(a))).toBe('ready');
        expect(await handshake(owner.token, edge(a), false)).toBe('token_not_for_this_box');
        expect(await handshake(owner.token, {}, false)).toBe('ready');
        const rows = await refusals();
        expect(rows.map(r => r.changes.route)).toEqual(['socket.io', 'socket.io', 'socket.io', 'socket.io']);
        // One notice per box: alpha (its token outside it), beta (alpha's token through beta's edge)
        expect((await notices()).map(n => n.content.slice(0, 12))).toEqual(['Box **alpha*', 'Box **beta**']);
    });
});
