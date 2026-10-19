import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { heartbeat, type Notice } from '../../src/lib/agent-runs';

/**
 * ACP agents on agora-host (agora-host src/acp/): gemini profiles, live run progress from
 * heartbeats, and denied tools from ACP permission requests filing the usual approval cards.
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
    owner = await authedUser(ctx.request, 'acpowner');
    const server = await createServer(ctx.request, owner.auth, 'ACP Server');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
    expect(host.status).toBe(201);
    hostId = host.body.host.id;
    hostAuth = { Authorization: `AgentHost ${host.body.token}` };
    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'gemini' });
    botId = bot.body.id;
    expect((await ctx.request.post(`/channels/${channelId}/bots/${botId}`).set(owner.auth)).status).toBe(201);
});

afterAll(async () => { await ctx.close(); });

describe('ACP agents', () => {
    it('creates a gemini profile and records the host\'s API-key report for it', async () => {
        const profile = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
            .send({ name: 'gemini', botId, hostId, adapter: 'gemini', workdirAlias: 'agora', model: null, effort: null });
        expect(profile.status, JSON.stringify(profile.body)).toBe(201);
        expect(profile.body.adapter).toBe('gemini');
        profileId = profile.body.id;
        const report = await ctx.request.post('/agent-hosts/@me/profiles').set(hostAuth)
            .send({ profiles: [{ name: 'gemini', adapter: 'gemini', authMode: 'api_key', apiKeyEnv: 'GEMINI_API_KEY', runApproval: false }] });
        expect(report.body).toEqual({ updated: ['gemini'], unknown: [] });
        const row = await ctx.db.query('SELECT auth_mode, api_key_env FROM agent_profiles WHERE id = $1', [profileId]);
        expect(row.rows[0]).toEqual({ auth_mode: 'api_key', api_key_env: 'GEMINI_API_KEY' });
        expect((await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
            .send({ name: 'other', botId, hostId, adapter: 'acp', workdirAlias: 'agora' })).status).toBe(400);
    });

    it('relays heartbeat progress to the channel without storing it, and files ACP denials as cards', async () => {
        const sessionId = generateUlid();
        await ctx.db.query(
            `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by) VALUES ($1, $2, $3, $4, $5, $6)`,
            [sessionId, serverId, channelId, botId, profileId, owner.userId]
        );
        const sent = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: '@gemini check the build' });
        expect([200, 201]).toContain(sent.status);
        const c = await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        expect(c.body.profile).toMatchObject({ name: 'gemini', adapter: 'gemini', authMode: 'api_key' });
        const url = `/agent-hosts/@me/runs/${c.body.run.id}`;

        const progress = { step: 'git status -s', toolCalls: 2, planDone: 1, planTotal: 3 };
        const hb = await ctx.request.post(`${url}/heartbeat`).set(hostAuth).send({ claimToken: c.body.run.claimToken, progress });
        expect(hb.status).toBe(200);
        expect(hb.body.cancel).toBe(false);
        // A malformed count or an overlong step is rejected
        expect((await ctx.request.post(`${url}/heartbeat`).set(hostAuth)
            .send({ claimToken: c.body.run.claimToken, progress: { ...progress, toolCalls: -1 } })).status).toBe(400);
        expect((await ctx.request.post(`${url}/heartbeat`).set(hostAuth)
            .send({ claimToken: c.body.run.claimToken, progress: { ...progress, step: 'x'.repeat(201) } })).status).toBe(400);

        const notices: Notice[] = [];
        await heartbeat(ctx.db, { id: hostId, serverId }, c.body.run.id, c.body.run.claimToken, notices, null, progress);
        expect(notices).toEqual([{ channelId, eventName: 'AgentRunProgress',
            event: { channelId, sessionId, runId: c.body.run.id, ...progress } }]);
        // The step is the agent's own text: control characters never reach the channel
        const dirty: Notice[] = [];
        await heartbeat(ctx.db, { id: hostId, serverId }, c.body.run.id, c.body.run.claimToken, dirty, null,
            { ...progress, step: 'ls\u001b[2J\u0007\r\nfake‮  step\u0085' });
        expect((dirty[0].event as any).step).toBe('ls [2J fake step');
        const none: Notice[] = [];
        await heartbeat(ctx.db, { id: hostId, serverId }, c.body.run.id, c.body.run.claimToken, none, null);
        expect(none).toEqual([]);

        const done = await ctx.request.post(`${url}/complete`).set(hostAuth).send({ claimToken: c.body.run.claimToken, nativeSessionId: 'sess-1',
            summary: 'Checked', tokensUsed: 42, deniedTools: ['Bash(gh:*)', 'Bash'] });
        expect(done.status, JSON.stringify(done.body)).toBe(200);
        const requests = await ctx.db.query('SELECT tool, status FROM agent_tool_requests WHERE session_id = $1 ORDER BY tool', [sessionId]);
        expect(requests.rows).toEqual([{ tool: 'Bash', status: 'pending' }, { tool: 'Bash(gh:*)', status: 'pending' }]);
        const session = await ctx.db.query('SELECT native_session_id FROM agent_sessions WHERE id = $1', [sessionId]);
        expect(session.rows[0].native_session_id).toBe('sess-1');
    });
});
