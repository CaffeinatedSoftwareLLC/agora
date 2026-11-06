import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';

/**
 * oh-my-pi agents on agora-host (adapter "omp", ACP on an OpenRouter key only): the database
 * accepts the adapter (migration 088), a profile needs a model, the host reports it as api_key,
 * and on a machine host it is still owner-only (host mode, docs/agent-boxes.md §10).
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => { ctx = await setupTestApp(); await cleanDatabase(ctx.db); });
afterAll(async () => { await ctx.close(); });

describe('omp agents', () => {
    it('creates an omp profile only with a model; the host reports it on its OpenRouter key; owner-only on a machine', async () => {
        const owner = await authedUser(ctx.request, 'ompowner');
        const { serverId } = await createServer(ctx.request, owner.auth, 'omp Server');
        const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
        expect(host.status).toBe(201);
        const hostAuth = { Authorization: `AgentHost ${host.body.token}` };
        const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'pi' });
        const base = { name: 'pi', botId: bot.body.id, hostId: host.body.host.id, adapter: 'omp', workdirAlias: 'agora', effort: null };

        const noModel = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth).send({ hostModeAck: true, ...base, model: null });
        expect(noModel.status).toBe(400);
        expect(noModel.body.error).toContain('needs a model');
        const profile = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth).send({ hostModeAck: true, ...base, model: 'qwen/qwen3-coder' });
        expect(profile.status, JSON.stringify(profile.body)).toBe(201);
        expect(profile.body).toMatchObject({ adapter: 'omp', model: 'qwen/qwen3-coder' });
        expect((await ctx.request.patch(`/servers/${serverId}/agent-profiles/${profile.body.id}`).set(owner.auth).send({ model: null })).status).toBe(400);

        const report = await ctx.request.post('/agent-hosts/@me/profiles').set(hostAuth)
            .send({ profiles: [{ name: 'pi', adapter: 'omp', authMode: 'api_key', apiKeyEnv: 'OPENROUTER_API_KEY_PI', runApproval: false }] });
        expect(report.body).toEqual({ updated: ['pi'], unknown: [] });
        const row = (await ctx.db.query('SELECT adapter, auth_mode, api_key_env, host_mode FROM agent_profiles WHERE id = $1', [profile.body.id])).rows[0];
        expect(row).toEqual({ adapter: 'omp', auth_mode: 'api_key', api_key_env: 'OPENROUTER_API_KEY_PI', host_mode: true });
        // The database knows the adapter, and still refuses an unknown one
        await expect(ctx.db.query(`UPDATE agent_profiles SET adapter = 'omp2' WHERE id = $1`, [profile.body.id])).rejects.toThrow(/agent_profiles_adapter_check/);
    });
});
