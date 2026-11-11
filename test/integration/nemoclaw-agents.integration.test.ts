import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';

/**
 * NVIDIA NemoClaw agents (adapter "nemoclaw"; agora-host src/nemoclaw.ts, docs/provider-terms.md
 * "NVIDIA NemoClaw"): a machine profile is accepted, and its host reports it as an API key with
 * no key variable (the sandbox holds the key), which is allowed for nemoclaw only. An account
 * login is refused. A box of adapter nemoclaw (OpenClaw itself) takes an NVIDIA key only.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'nemoowner');
    const server = await createServer(ctx.request, owner.auth, 'NemoClaw Server');
    serverId = server.serverId;
    channelId = server.generalChannelId;
});

afterAll(async () => { await ctx.close(); });

describe('NemoClaw agents', () => {
    it('host mode: a nemoclaw profile, reported as an API key without a key variable', async () => {
        const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
        expect(host.status).toBe(201);
        const hostAuth = { Authorization: `AgentHost ${host.body.token}` };
        const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'nemo' });
        const profile = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
            .send({ hostModeAck: true, name: 'nemo', botId: bot.body.id, hostId: host.body.host.id, adapter: 'nemoclaw', workdirAlias: 'agora', model: null, effort: null });
        expect(profile.status, JSON.stringify(profile.body)).toBe(201);
        expect(profile.body).toMatchObject({ adapter: 'nemoclaw', hostMode: true, boxed: false });

        const report = (p: object) => ctx.request.post('/agent-hosts/@me/profiles').set(hostAuth)
            .send({ profiles: [{ name: 'nemo', adapter: 'nemoclaw', runApproval: false, ...p }] });
        const ok = await report({ authMode: 'api_key', apiKeyEnv: null });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body).toEqual({ updated: ['nemo'], unknown: [] });
        const row = await ctx.db.query('SELECT adapter, auth_mode, api_key_env, host_mode FROM agent_profiles WHERE id = $1', [profile.body.id]);
        expect(row.rows[0]).toEqual({ adapter: 'nemoclaw', auth_mode: 'api_key', api_key_env: null, host_mode: true });

        // No account login for NemoClaw, and other adapters still need their key variable
        expect((await report({ authMode: 'subscription', apiKeyEnv: null })).status).toBe(400);
        const codexBot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'codexy' });
        await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
            .send({ hostModeAck: true, name: 'codexy', botId: codexBot.body.id, hostId: host.body.host.id, adapter: 'codex', workdirAlias: 'agora', model: null, effort: null });
        const codex = await ctx.request.post('/agent-hosts/@me/profiles').set(hostAuth)
            .send({ profiles: [{ name: 'codexy', adapter: 'codex', authMode: 'api_key', apiKeyEnv: null, runApproval: false }] });
        expect(codex.status).toBe(400);
    });

    it('in a box: an NVIDIA key only, NVIDIA Endpoints allowed, no Log in', async () => {
        const createBox = (body: object) => ctx.request.post(`/servers/${serverId}/boxes`).set(owner.auth).send({ homeChannelId: channelId, ...body });
        expect((await createBox({ name: 'nemo-sub', adapter: 'nemoclaw', auth: 'subscription' })).body).toMatchObject({ error: 'auth_not_supported' });
        const res = await createBox({ name: 'nemo-box', adapter: 'nemoclaw', auth: 'api_key', apiKey: 'nvapi-test-0123456789abcdef' });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.box).toMatchObject({ adapter: 'nemoclaw', auth: 'api_key' });
        expect(res.body.box.allowedDomains[0]).toBe('integrate.api.nvidia.com');
        expect(res.body.box.allowedDomains.some((d: string) => /openclaw|clawhub|ngc\.nvidia/.test(d))).toBe(false);
        const row = (await ctx.db.query(
            `SELECT b.api_key_env, p.auth_mode, p.api_key_env AS profile_env FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id WHERE b.id = $1`,
            [res.body.box.id])).rows[0];
        expect(row).toEqual({ api_key_env: 'NVIDIA_API_KEY', auth_mode: 'api_key', profile_env: 'NVIDIA_API_KEY' });
        const login = await ctx.request.post(`/boxes/${res.body.box.id}/login`).set(owner.auth);
        expect(login.status).toBe(409);
        expect(login.body).toEqual({ error: 'login_not_supported' });
    });
});
