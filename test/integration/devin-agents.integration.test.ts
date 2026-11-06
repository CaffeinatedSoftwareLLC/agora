import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';

/**
 * Devin agents (adapter "devin", `devin acp` on the owner's own Devin login; docs/provider-terms.md
 * "Devin"): a host-mode profile is accepted and reported as a subscription (owner-only), and a
 * box of adapter devin signs in only with the owner's login, through the box login relay.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'devinowner');
    const server = await createServer(ctx.request, owner.auth, 'Devin Server');
    serverId = server.serverId;
    channelId = server.generalChannelId;
});

afterAll(async () => { await ctx.close(); });

describe('Devin agents', () => {
    it('host mode: a devin profile on a machine, reported as a subscription', async () => {
        const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
        expect(host.status).toBe(201);
        const hostAuth = { Authorization: `AgentHost ${host.body.token}` };
        const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'devin' });
        const profile = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
            .send({ hostModeAck: true, name: 'devin', botId: bot.body.id, hostId: host.body.host.id, adapter: 'devin', workdirAlias: 'agora', model: null, effort: null });
        expect(profile.status, JSON.stringify(profile.body)).toBe(201);
        expect(profile.body).toMatchObject({ adapter: 'devin', authMode: 'subscription', hostMode: true, boxed: false });
        const report = await ctx.request.post('/agent-hosts/@me/profiles').set(hostAuth)
            .send({ profiles: [{ name: 'devin', adapter: 'devin', authMode: 'subscription', apiKeyEnv: null, runApproval: false }] });
        expect(report.body).toEqual({ updated: ['devin'], unknown: [] });
        // A host that reports a Devin profile on an API key is refused: the terms allow none
        const keyed = await ctx.request.post('/agent-hosts/@me/profiles').set(hostAuth)
            .send({ profiles: [{ name: 'devin', adapter: 'devin', authMode: 'api_key', apiKeyEnv: 'WINDSURF_API_KEY', runApproval: false }] });
        expect(keyed.status).toBe(400);
        const row = await ctx.db.query('SELECT adapter, auth_mode, host_mode FROM agent_profiles WHERE id = $1', [profile.body.id]);
        expect(row.rows[0]).toEqual({ adapter: 'devin', auth_mode: 'subscription', host_mode: true });
    });

    it('in a box: the owner\'s login by default, an API key refused, Log in relayed', async () => {
        const createBox = (body: object) => ctx.request.post(`/servers/${serverId}/boxes`).set(owner.auth).send({ homeChannelId: channelId, ...body });
        expect((await createBox({ name: 'devin-key', adapter: 'devin', auth: 'api_key', apiKey: 'windsurf-token-1234567890' })).body)
            .toMatchObject({ error: 'auth_not_supported' });
        const res = await createBox({ name: 'devin-box', adapter: 'devin' });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.box).toMatchObject({ adapter: 'devin', auth: 'subscription', loginState: 'none' });
        expect(res.body.box.allowedDomains).toEqual(['api.devin.ai', 'app.devin.ai', 'server.codeium.com', 'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org']);
        const row = (await ctx.db.query(
            `SELECT b.api_key_env, b.api_key_enc, p.auth_mode, p.api_key_env AS profile_env FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id WHERE b.id = $1`,
            [res.body.box.id])).rows[0];
        // No key anywhere: boxd sets nothing, the login stays in the box's home volume
        expect(row).toEqual({ api_key_env: null, api_key_enc: null, auth_mode: 'subscription', profile_env: null });
        const login = await ctx.request.post(`/boxes/${res.body.box.id}/login`).set(owner.auth);
        expect(login.status, JSON.stringify(login.body)).toBeLessThan(300);
        expect(login.body.login).toMatchObject({ status: 'requested' });
    });
});
