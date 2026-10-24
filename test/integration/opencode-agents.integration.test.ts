import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';

/**
 * opencode agents on agora-host (adapter "opencode", ACP on an OpenRouter key): a profile
 * needs a model, and a run refused for lack of credit shelves its session with a notice.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let hostId: string;
let hostAuth: { Authorization: string };
let profileId: string;
let botId: string;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'ocowner');
    const server = await createServer(ctx.request, owner.auth, 'opencode Server');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
    expect(host.status).toBe(201);
    hostId = host.body.host.id;
    hostAuth = { Authorization: `AgentHost ${host.body.token}` };
    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'qwen' });
    botId = bot.body.id;
    expect((await ctx.request.post(`/channels/${channelId}/bots/${botId}`).set(owner.auth)).status).toBe(201);
});

afterAll(async () => { await ctx.close(); });

describe('opencode agents', () => {
    it('creates an opencode profile only with a model, and still rejects an unknown adapter', async () => {
        const base = { name: 'qwen', botId, hostId, adapter: 'opencode', workdirAlias: 'agora', effort: null };
        const noModel = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth).send({ ...base, model: null });
        expect(noModel.status).toBe(400);
        expect(noModel.body.error).toContain('needs a model');

        const profile = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth).send({ ...base, model: 'qwen/qwen3-coder' });
        expect(profile.status, JSON.stringify(profile.body)).toBe(201);
        expect(profile.body).toMatchObject({ adapter: 'opencode', model: 'qwen/qwen3-coder', authMode: 'subscription' });
        profileId = profile.body.id;

        // Clearing the model of an opencode profile is refused; changing it is not
        expect((await ctx.request.patch(`/servers/${serverId}/agent-profiles/${profileId}`).set(owner.auth).send({ model: null })).status).toBe(400);
        const changed = await ctx.request.patch(`/servers/${serverId}/agent-profiles/${profileId}`).set(owner.auth).send({ model: 'openrouter/qwen/qwen3-coder' });
        expect(changed.status).toBe(200);
        expect(changed.body.model).toBe('openrouter/qwen/qwen3-coder');

        // The one-step create applies the same rule
        expect((await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
            .send({ name: 'deepseek', adapter: 'opencode', hostId, workdirAlias: 'agora' })).status).toBe(400);

        const report = await ctx.request.post('/agent-hosts/@me/profiles').set(hostAuth)
            .send({ profiles: [{ name: 'qwen', adapter: 'opencode', authMode: 'api_key', apiKeyEnv: 'OPENROUTER_API_KEY_QWEN', runApproval: false }] });
        expect(report.body).toEqual({ updated: ['qwen'], unknown: [] });
        const row = await ctx.db.query('SELECT adapter, auth_mode, api_key_env FROM agent_profiles WHERE id = $1', [profileId]);
        // One OpenRouter key per agent: OPENROUTER_API_KEY_<NAME> on the host
        expect(row.rows[0]).toEqual({ adapter: 'opencode', auth_mode: 'api_key', api_key_env: 'OPENROUTER_API_KEY_QWEN' });

        expect((await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
            .send({ ...base, name: 'other', adapter: 'openrouter', model: 'qwen/qwen3-coder' })).status).toBe(400);
        expect((await ctx.request.post('/agent-hosts/@me/profiles').set(hostAuth)
            .send({ profiles: [{ name: 'qwen', adapter: 'openrouter', authMode: 'api_key', apiKeyEnv: 'OPENROUTER_API_KEY', runApproval: false }] })).status).toBe(400);
        // The database refuses one too, whatever the route allows
        await expect(ctx.db.query(`UPDATE agent_profiles SET adapter = 'openrouter' WHERE id = $1`, [profileId])).rejects.toThrow(/agent_profiles_adapter_check/);
    });

    it('shelves the session with a credit notice when the OpenRouter key is out of credit', async () => {
        const sessionId = generateUlid();
        await ctx.db.query(
            `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by) VALUES ($1, $2, $3, $4, $5, $6)`,
            [sessionId, serverId, channelId, botId, profileId, owner.userId]
        );
        const sent = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: '@qwen fix the build' });
        expect([200, 201]).toContain(sent.status);
        const c = await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        expect(c.body.profile).toMatchObject({ name: 'qwen', adapter: 'opencode', model: 'openrouter/qwen/qwen3-coder', authMode: 'api_key' });

        const failed = await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/fail`).set(hostAuth).send({
            claimToken: c.body.run.claimToken, error: 'credit_exhausted', retryable: false, tokensUsed: null,
            message: 'The provider refused the run: its API key is out of credit or has used up its credit limit.' });
        expect(failed.status, JSON.stringify(failed.body)).toBe(200);

        const session = await ctx.db.query('SELECT state, end_reason FROM agent_sessions WHERE id = $1', [sessionId]);
        expect(session.rows[0]).toEqual({ state: 'shelved', end_reason: 'budget' });
        const run = await ctx.db.query('SELECT status, error FROM agent_runs WHERE id = $1', [c.body.run.id]);
        expect(run.rows[0]).toEqual({ status: 'failed', error: 'credit_exhausted' });
        const notices = (await ctx.db.query(`SELECT content FROM messages WHERE channel_id = $1 AND content LIKE '%qwen%' ORDER BY created_at`, [channelId]))
            .rows.map(r => r.content);
        expect(notices).toContain(`Session for qwen shelved: its OpenRouter key is out of credit or has used up its credit limit. `
            + `Raise the key's limit at https://openrouter.ai/settings/keys or wait for it to reset, then /resume ${sessionId}.`);
        // Not the generic failure notice, and nothing is retried
        expect(notices.some(n => n.includes("couldn't handle its last wake"))).toBe(false);
        expect((await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth)).status).toBe(204);
    });
});
