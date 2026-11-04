import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';

/**
 * Host mode (docs/agent-boxes.md §10): a profile on a machine host runs unboxed, so it is
 * owner-only whatever its auth. Creating one needs the owner's hostModeAck, and the database
 * forces host_mode from the host's kind (migration 081), so no machine-host profile can keep
 * the pre-box rules that let a director wake an api_key agent.
 */

const DIRECT = (1n << 29n).toString();

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let director: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let hostId: string;
let otherHostId: string;

const cmd = (auth: object, body: object) => ctx.request.post(`/channels/${channelId}/agent-commands`).set(auth).send(body);
const say = (auth: object, content: string) => ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content });
const directInbox = async (sessionId: string) =>
    (await ctx.db.query(`SELECT 1 FROM agent_inbox WHERE session_id = $1 AND reason = 'direct'`, [sessionId])).rows.length;
const profileRow = async (id: string) =>
    (await ctx.db.query(`SELECT host_mode, host_mode_ack_at, host_mode_ack_by FROM agent_profiles WHERE id = $1`, [id])).rows[0];
const useApiKey = (profileId: string) =>
    ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'api_key', api_key_env = 'ANTHROPIC_API_KEY' WHERE id = $1`, [profileId]);

async function makeBot(name: string): Promise<string> {
    const res = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: name });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id;
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'hmowner');
    const server = await createServer(ctx.request, owner.auth, 'Host Mode');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    director = await authedUser(ctx.request, 'hmdirector');
    await joinViaInvite(ctx.request, owner.auth, director.auth, serverId);
    const role = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Orchestrator', permissions: DIRECT });
    await ctx.request.put(`/servers/${serverId}/members/${director.userId}/roles/${role.body.id}`).set(owner.auth);
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 1000, max_bot_hops = 1000 WHERE id = $1', [channelId]);
    hostId = (await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' })).body.host.id;
    otherHostId = (await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'laptop' })).body.host.id;
});

afterAll(async () => { await ctx.close(); });

beforeEach(async () => {
    await ctx.db.query('TRUNCATE agent_runs, agent_inbox, agent_batches, agent_session_threads, agent_sessions CASCADE');
});

describe('creating a machine-host profile needs hostModeAck', () => {
    test('POST /agents: omitted or false is 400; true stores host mode with the acknowledgement', async () => {
        const create = (name: string, extra: object) => ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
            .send({ name, adapter: 'claude', hostId, workdirAlias: 'agora', channelId, ...extra });

        const omitted = await create('noack', {});
        expect(omitted.status).toBe(400);
        expect(omitted.body.error).toMatch(/hostModeAck: true/);
        expect((await create('falseack', { hostModeAck: false })).status).toBe(400);
        // Nothing was created by the refused calls
        expect((await ctx.db.query(`SELECT 1 FROM users WHERE username IN ('noack', 'falseack')`)).rows).toHaveLength(0);

        const ok = await create('acked', { hostModeAck: true });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect(ok.body.profile).toMatchObject({ hostMode: true, boxed: false });
        const row = await profileRow(ok.body.profile.id);
        expect(row.host_mode).toBe(true);
        expect(row.host_mode_ack_at).not.toBeNull();
        expect(row.host_mode_ack_by.trim()).toBe(owner.userId);
    });

    test('POST /agent-profiles: omitted or false is 400; true stores host mode', async () => {
        const botId = await makeBot('profbot');
        const create = (extra: object) => ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
            .send({ name: 'profbot', botId, hostId, adapter: 'codex', workdirAlias: 'agora', ...extra });

        const omitted = await create({});
        expect(omitted.status).toBe(400);
        expect(omitted.body.error).toMatch(/hostModeAck: true/);
        expect((await create({ hostModeAck: false })).status).toBe(400);
        const ok = await create({ hostModeAck: true });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect(ok.body).toMatchObject({ hostMode: true, boxed: false });
        expect((await profileRow(ok.body.id)).host_mode).toBe(true);
    });

    test('PATCH that moves a profile to another machine host needs the ack too', async () => {
        const botId = await makeBot('moverbot');
        const created = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
            .send({ name: 'moverbot', botId, hostId, adapter: 'codex', workdirAlias: 'agora', hostModeAck: true });
        const patch = (body: object) => ctx.request.patch(`/servers/${serverId}/agent-profiles/${created.body.id}`).set(owner.auth).send(body);

        expect((await patch({ hostId: otherHostId })).status).toBe(400);
        expect((await patch({ hostId: otherHostId, hostModeAck: false })).status).toBe(400);
        // Other edits don't need it
        expect((await patch({ model: 'gpt-5' })).status).toBe(200);
        const moved = await patch({ hostId: otherHostId, hostModeAck: true });
        expect(moved.status, JSON.stringify(moved.body)).toBe(200);
        expect(moved.body).toMatchObject({ hostMode: true, hostId: otherHostId });
    });
});

describe('a machine-host api_key profile is owner-only', () => {
    test("a director's /start and @mention are refused; the owner's work", async () => {
        const res = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
            .send({ name: 'keyed', adapter: 'claude', hostId, workdirAlias: 'agora', channelId, hostModeAck: true });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        await useApiKey(res.body.profile.id);

        const refused = await cmd(director.auth, { command: 'start', profile: 'keyed' });
        expect(refused.status).toBe(403);
        expect(refused.body.error).toBe('subscription_owner_only');

        const started = await cmd(owner.auth, { command: 'start', profile: 'keyed' });
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        expect(started.body.session).toMatchObject({ hostMode: true, boxed: false, authMode: 'api_key' });
        const sessionId = started.body.session.id;

        await say(director.auth, '@keyed deploy it');
        expect(await directInbox(sessionId)).toBe(0);
        await say(owner.auth, '@keyed deploy it');
        expect(await directInbox(sessionId)).toBe(1);
    });

    test('a profile row written with host_mode = false on a machine host is still host mode (trigger)', async () => {
        const botId = await makeBot('rawbot');
        await ctx.db.query(`INSERT INTO bot_channel_access (bot_id, channel_id, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [botId, channelId, owner.userId]);
        const profileId = generateUlid();
        await ctx.db.query(
            `INSERT INTO agent_profiles (id, server_id, name, bot_id, host_id, adapter, workdir_alias, created_by, auth_mode, api_key_env, host_mode)
             VALUES ($1, $2, 'rawbot', $3, $4, 'claude', 'agora', $5, 'api_key', 'ANTHROPIC_API_KEY', false)`,
            [profileId, serverId, botId, hostId, owner.userId]
        );
        expect((await profileRow(profileId)).host_mode).toBe(true);
        // Clearing the flag later doesn't stick either
        await ctx.db.query(`UPDATE agent_profiles SET host_mode = false WHERE id = $1`, [profileId]);
        expect((await profileRow(profileId)).host_mode).toBe(true);

        const refused = await cmd(director.auth, { command: 'start', profile: 'rawbot' });
        expect(refused.status).toBe(403);
        expect(refused.body.error).toBe('subscription_owner_only');
        const started = await cmd(owner.auth, { command: 'start', profile: 'rawbot' });
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        await say(director.auth, '@rawbot look');
        expect(await directInbox(started.body.session.id)).toBe(0);
    });

    test("a box host's profile is never host mode, so the ordinary api_key rules apply", async () => {
        const botId = await makeBot('boxbot');
        await ctx.db.query(`INSERT INTO bot_channel_access (bot_id, channel_id, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [botId, channelId, owner.userId]);
        const boxHostId = generateUlid();
        await ctx.db.query(
            `INSERT INTO agent_hosts (id, server_id, name, secret_hash, created_by, kind) VALUES ($1, $2, 'box-boxbot', 'x', $3, 'box')`,
            [boxHostId, serverId, owner.userId]
        );
        const profileId = generateUlid();
        await ctx.db.query(
            `INSERT INTO agent_profiles (id, server_id, name, bot_id, host_id, adapter, workdir_alias, created_by, auth_mode, api_key_env, host_mode)
             VALUES ($1, $2, 'boxbot', $3, $4, 'claude', 'work', $5, 'api_key', 'ANTHROPIC_API_KEY', true)`,
            [profileId, serverId, botId, boxHostId, owner.userId]
        );
        expect((await profileRow(profileId)).host_mode).toBe(false);
        const started = await cmd(director.auth, { command: 'start', profile: 'boxbot' });
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        expect(started.body.session).toMatchObject({ hostMode: false, boxed: true });
    });
});
