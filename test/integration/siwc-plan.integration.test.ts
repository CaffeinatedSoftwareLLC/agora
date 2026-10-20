import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';

/**
 * Codex on a person's own ChatGPT plan (docs/codex-chatgpt-plan.md, src/routes/agent-plans.ts).
 *
 * - Settings → Agents asks the profile's host to connect a ChatGPT plan; the host signs in on
 *   its own machine and reports back. Agora never sees a token.
 * - A 'siwc' profile is bound to the person who connected their plan: only that person's
 *   messages, /start and /resume, and hand-offs between sessions they started wake it. The
 *   same path as 'subscription', with the plan owner in place of the server owner.
 */

const DIRECT = (1n << 29n).toString();
const SIWC_NOTICE = (agent: string) => `${agent} runs on its plan owner's ChatGPT plan; only they can wake it. Ask them, or configure an API key profile.`;

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let director: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let hostAuth: { Authorization: string };
type Agent = { botId: string; profileId: string; auth: { Authorization: string }; name: string };
let codex: Agent;
let helper: Agent;

async function makeAgent(name: string, hostId: string, adapter = 'codex'): Promise<Agent> {
    const res = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
        .send({ name, adapter, hostId, workdirAlias: 'agora', channelId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { botId: res.body.bot.id, profileId: res.body.profile.id, auth: { Authorization: `Bot ${res.body.token}` }, name };
}

async function startSession(agent: Agent, startedBy: string | null): Promise<string> {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, serverId, channelId, agent.botId, agent.profileId, startedBy]
    );
    return id;
}

async function post(auth: object, content: string): Promise<any> {
    const res = await ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    return res.body;
}

async function inbox(sessionId: string): Promise<string[]> {
    const rows = await ctx.db.query(`SELECT reason FROM agent_inbox WHERE session_id = $1 AND acked_at IS NULL ORDER BY id`, [sessionId]);
    return rows.rows.map((r: any) => r.reason);
}

async function notices(since: string): Promise<string[]> {
    const rows = await ctx.db.query(
        `SELECT content FROM messages WHERE channel_id = $1 AND author_id IS NULL AND system_event = 'agent_session' AND id > $2 ORDER BY id`,
        [channelId, since]);
    return rows.rows.map((r: any) => r.content);
}

const plan = (auth: object, profileId: string, action: string) =>
    ctx.request.post(`/servers/${serverId}/agent-profiles/${profileId}/plan`).set(auth).send({ action });
const claim = () => ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
const cmd = (auth: object, body: object) => ctx.request.post(`/channels/${channelId}/agent-commands`).set(auth).send(body);
const bindTo = (userId: string | null) => ctx.db.query(`UPDATE agent_profiles SET plan_owner_id = $2 WHERE id = $1`, [codex.profileId, userId]);

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'swowner');
    const server = await createServer(ctx.request, owner.auth, 'Plan Server');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    director = await authedUser(ctx.request, 'swdirector');
    member = await authedUser(ctx.request, 'swmember');
    await joinViaInvite(ctx.request, owner.auth, director.auth, serverId);
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    const role = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Orchestrator', permissions: DIRECT });
    await ctx.request.put(`/servers/${serverId}/members/${director.userId}/roles/${role.body.id}`).set(owner.auth);
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 1000, max_bot_hops = 1000, max_thread_bot_hops = 0 WHERE id = $1', [channelId]);
    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
    hostAuth = { Authorization: `AgentHost ${host.body.token}` };
    codex = await makeAgent('planbot', host.body.host.id);
    helper = await makeAgent('helper', host.body.host.id, 'claude');
    const report = await ctx.request.post('/agent-hosts/@me/profiles').set(hostAuth).send({ profiles: [
        { name: 'planbot', adapter: 'codex', authMode: 'siwc', apiKeyEnv: null, runApproval: false },
        { name: 'helper', adapter: 'claude', authMode: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY', runApproval: false },
    ] });
    expect(report.body).toEqual({ updated: ['planbot', 'helper'], unknown: [] });
});

afterAll(async () => { await ctx.close(); });

beforeEach(async () => {
    await ctx.db.query('TRUNCATE agent_plan_connections, agent_tool_requests, agent_runs, agent_inbox, agent_batches, agent_session_threads, agent_sessions CASCADE');
    await bindTo(null);
});

describe('connecting a ChatGPT plan', () => {
    it('accepts siwc only for codex profiles', async () => {
        const res = await ctx.request.post('/agent-hosts/@me/profiles').set(hostAuth).send({ profiles: [
            { name: 'helper', adapter: 'claude', authMode: 'siwc', apiKeyEnv: null, runApproval: false },
        ] });
        expect(res.status).toBe(400);
    });

    it('lets only the owner or the host registrant ask, and the host runs the sign-in and reports back', async () => {
        expect((await plan(member.auth, codex.profileId, 'connect')).status).toBe(403);
        expect((await plan(director.auth, codex.profileId, 'connect')).status).toBe(403);
        expect((await plan(owner.auth, helper.profileId, 'connect')).body).toEqual({ error: 'siwc_codex_only' });

        const asked = await plan(owner.auth, codex.profileId, 'connect');
        expect(asked.status).toBe(200);
        expect(asked.body).toMatchObject({ profileId: codex.profileId, status: 'requested', planOwnerId: null });

        // A report from the host's start doesn't swallow a request it hasn't picked up yet
        await ctx.request.post('/agent-hosts/@me/plans/planbot').set(hostAuth).send({ status: 'scope_missing' });
        expect((await ctx.request.get(`/servers/${serverId}/agent-plans`).set(owner.auth)).body[0].status).toBe('requested');

        const req = await ctx.request.get('/agent-hosts/@me/plan-requests/next').set(hostAuth);
        expect(req.status).toBe(200);
        expect(req.body).toEqual({ profile: 'planbot', action: 'connect', requestedBy: owner.userId });
        expect((await ctx.request.get('/agent-hosts/@me/plan-requests/next').set(hostAuth)).status).toBe(204);
        expect((await ctx.request.get(`/servers/${serverId}/agent-plans`).set(owner.auth)).body[0].status).toBe('in_progress');

        const done = await ctx.request.post('/agent-hosts/@me/plans/planbot').set(hostAuth)
            .send({ status: 'connected', accountLabel: 'eryk@example.com' });
        expect(done.body).toEqual({ planOwnerId: owner.userId });
        const plans = (await ctx.request.get(`/servers/${serverId}/agent-plans`).set(owner.auth)).body;
        expect(plans).toEqual([expect.objectContaining({ profileId: codex.profileId, status: 'connected', accountLabel: 'eryk@example.com', error: null, planOwnerId: owner.userId })]);
        const profiles = (await ctx.request.get(`/servers/${serverId}/agent-profiles`).set(owner.auth)).body;
        expect(profiles.find((p: any) => p.name === 'planbot')).toMatchObject({ authMode: 'siwc', planOwnerId: owner.userId });
        expect((await ctx.request.get(`/servers/${serverId}/agent-plans`).set(member.auth)).status).toBe(403);
    });

    it('records a failed sign-in by its code, and a disconnect clears the binding', async () => {
        await plan(owner.auth, codex.profileId, 'connect');
        await ctx.request.get('/agent-hosts/@me/plan-requests/next').set(hostAuth);
        await ctx.request.post('/agent-hosts/@me/plans/planbot').set(hostAuth).send({ status: 'failed', error: 'consent_declined' });
        expect((await ctx.request.get(`/servers/${serverId}/agent-plans`).set(owner.auth)).body[0]).toMatchObject({ status: 'failed', error: 'consent_declined', planOwnerId: null });
        // Bad input never reaches the database
        expect((await ctx.request.post('/agent-hosts/@me/plans/planbot').set(hostAuth).send({ status: 'failed', error: 'Not A Code' })).status).toBe(400);

        // A sign-in from the host's CLI with no request open binds the host's registrant
        expect((await ctx.request.post('/agent-hosts/@me/plans/planbot').set(hostAuth).send({ status: 'connected' })).body).toEqual({ planOwnerId: owner.userId });

        await plan(owner.auth, codex.profileId, 'disconnect');
        const req = await ctx.request.get('/agent-hosts/@me/plan-requests/next').set(hostAuth);
        expect(req.body.action).toBe('disconnect');
        await ctx.request.post('/agent-hosts/@me/plans/planbot').set(hostAuth).send({ status: 'disconnected' });
        const profiles = (await ctx.request.get(`/servers/${serverId}/agent-profiles`).set(owner.auth)).body;
        expect(profiles.find((p: any) => p.name === 'planbot').planOwnerId).toBeNull();
    });
});

describe('connect request states (#115)', () => {
    const plans = async () => (await ctx.request.get(`/servers/${serverId}/agent-plans`).set(owner.auth)).body;

    it("refuses to ask the host for a profile it doesn't run as siwc", async () => {
        await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'subscription' WHERE id = $1`, [codex.profileId]);
        try {
            const res = await plan(owner.auth, codex.profileId, 'connect');
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ error: 'siwc_not_configured' });
            expect(await plans()).toEqual([]);
        } finally {
            await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'siwc' WHERE id = $1`, [codex.profileId]);
        }
    });

    it('times out a request the host never picks up, and the host then gets nothing', async () => {
        expect((await plan(owner.auth, codex.profileId, 'connect')).body.status).toBe('requested');
        await ctx.db.query(`UPDATE agent_plan_connections SET requested_at = NOW() - interval '3 minutes' WHERE profile_id = $1`, [codex.profileId]);
        expect(await plans()).toEqual([expect.objectContaining({ status: 'failed', error: 'request_timed_out', planOwnerId: null })]);
        expect((await ctx.request.get('/agent-hosts/@me/plan-requests/next').set(hostAuth)).status).toBe(204);
    });

    it('times out a request at claim time too', async () => {
        await plan(owner.auth, codex.profileId, 'connect');
        await ctx.db.query(`UPDATE agent_plan_connections SET requested_at = NOW() - interval '3 minutes' WHERE profile_id = $1`, [codex.profileId]);
        expect((await ctx.request.get('/agent-hosts/@me/plan-requests/next').set(hostAuth)).status).toBe(204);
        expect((await plans())[0]).toMatchObject({ status: 'failed', error: 'request_timed_out' });
    });

    it('times out a sign-in left open in the browser; a late success still binds whoever asked', async () => {
        await plan(owner.auth, codex.profileId, 'connect');
        expect((await ctx.request.get('/agent-hosts/@me/plan-requests/next').set(hostAuth)).status).toBe(200);
        expect((await plans())[0].status).toBe('in_progress');
        await ctx.db.query(`UPDATE agent_plan_connections SET updated_at = NOW() - interval '11 minutes' WHERE profile_id = $1`, [codex.profileId]);
        expect((await plans())[0]).toMatchObject({ status: 'failed', error: 'sign_in_timeout' });
        const late = await ctx.request.post('/agent-hosts/@me/plans/planbot').set(hostAuth).send({ status: 'connected', accountLabel: 'eryk@example.com' });
        expect(late.body).toEqual({ planOwnerId: owner.userId });
        expect((await plans())[0]).toMatchObject({ status: 'connected', error: null });
    });

    it('leaves a fresh request alone', async () => {
        await plan(owner.auth, codex.profileId, 'connect');
        expect((await plans())[0].status).toBe('requested');
    });
});

describe('the plan owner rule', () => {
    it("applies in threads too (#120): only the plan owner's @mention in a thread wakes it", async () => {
        await bindTo(owner.userId);
        const session = await startSession(codex, owner.userId);
        await startSession(helper, owner.userId);
        const parent = await post(helper.auth, 'thread started by another agent');
        const since = generateUlid();
        const r1 = await ctx.request.post(`/channels/${channelId}/messages/${parent.id}/replies`).set(director.auth).send({ content: '@PlanBot check the PR' });
        expect(r1.status).toBe(201);
        expect(await inbox(session)).toEqual([]);
        expect(await notices(since)).toEqual([SIWC_NOTICE('planbot')]);
        const r2 = await ctx.request.post(`/channels/${channelId}/messages/${parent.id}/replies`).set(owner.auth).send({ content: '@planbot check the PR' });
        expect(r2.status).toBe(201);
        expect(await inbox(session)).toEqual(['direct']);
        const thread = await ctx.db.query('SELECT thread_id FROM agent_inbox WHERE session_id = $1', [session]);
        expect(thread.rows[0].thread_id.trim()).toBe(parent.id);
    });

    it('wakes nobody before a plan is connected, with a notice saying so', async () => {
        const session = await startSession(codex, owner.userId);
        const since = generateUlid();
        await post(owner.auth, `@planbot hello`);
        expect(await inbox(session)).toEqual([]);
        expect(await notices(since)).toEqual([expect.stringContaining("planbot isn't connected to a ChatGPT plan yet")]);
    });

    it('wakes for the plan owner only, and the claim carries the binding', async () => {
        await bindTo(owner.userId);
        const session = await startSession(codex, owner.userId);
        let since = generateUlid();
        await post(director.auth, `@planbot please run`);
        expect(await inbox(session)).toEqual([]);
        expect(await notices(since)).toEqual([SIWC_NOTICE('planbot')]);

        await post(owner.auth, `@planbot please run`);
        expect(await inbox(session)).toEqual(['direct']);
        const c = await claim();
        expect(c.status).toBe(200);
        expect(c.body.profile).toMatchObject({ name: 'planbot', authMode: 'siwc', planOwnerId: owner.userId });
        expect(c.body.session.startedByOwner).toBe(true);
        expect(JSON.stringify(c.body)).not.toMatch(/access_token|refresh_token/);

        // The host's refusal codes become plain notices, never retried
        since = generateUlid();
        await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/fail`).set(hostAuth)
            .send({ claimToken: c.body.run.claimToken, error: 'siwc_not_eligible', message: 'Agent run did not complete', retryable: false });
        expect((await notices(since)).join('\n')).toContain('subscription_sharing_user_not_eligible');
    });

    it('follows the person who connected the plan, not the server owner', async () => {
        // The director connected their own plan to this profile
        await bindTo(director.userId);
        const session = await startSession(codex, director.userId);
        let since = generateUlid();
        await post(owner.auth, `@planbot do it`);
        expect(await inbox(session)).toEqual([]);
        expect(await notices(since)).toEqual([SIWC_NOTICE('planbot')]);
        await post(director.auth, `@planbot do it`);
        expect(await inbox(session)).toEqual(['direct']);

        // A session the plan owner didn't start gets no work
        await ctx.db.query('UPDATE agent_sessions SET started_by = $2 WHERE id = $1', [session, owner.userId]);
        since = generateUlid();
        expect((await claim()).status).toBe(204);
        expect(await notices(since)).toEqual([SIWC_NOTICE('planbot')]);
    });

    it('lets only the plan owner /start or /resume it', async () => {
        await bindTo(director.userId);
        const refused = await cmd(owner.auth, { command: 'start', profile: 'planbot' });
        expect(refused.status).toBe(403);
        expect(refused.body.error).toBe('plan_owner_only');
        const started = await cmd(director.auth, { command: 'start', profile: 'planbot' });
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        expect(started.body.session.authMode).toBe('siwc');
        await cmd(director.auth, { command: 'end', profile: 'planbot' });
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved' WHERE id = $1`, [started.body.session.id]);
        expect((await cmd(owner.auth, { command: 'resume', sessionId: started.body.session.id })).status).toBe(403);
        expect((await cmd(director.auth, { command: 'resume', sessionId: started.body.session.id })).status).toBe(200);
    });

    it('takes hand-offs only between sessions the plan owner started', async () => {
        await bindTo(owner.userId);
        const planSession = await startSession(codex, owner.userId);
        const helperSession = await startSession(helper, director.userId);
        const since = generateUlid();
        await post(helper.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [helper, planbot]\ntask: x');
        expect(await inbox(planSession)).toEqual([]);
        expect(await notices(since)).toEqual([SIWC_NOTICE('planbot')]);
        await ctx.db.query('UPDATE agent_sessions SET started_by = $2 WHERE id = $1', [helperSession, owner.userId]);
        await post(helper.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [helper, planbot]\ntask: y');
        expect(await inbox(planSession)).toEqual(['protocol']);
    });
});

/**
 * beta-test-plan §6.1 "siwc is plan-owner-only" and "siwc tokens stay on the host": refusals
 * carry plan_owner_only and change nothing; someone else's approve-once doesn't wake the agent
 * and is kept for the plan owner's next run; a token in a host report never reaches the DB.
 */
describe('beta §6.1: plan-owner refusals leave nothing behind', () => {
    const sessions = async () =>
        (await ctx.db.query(`SELECT count(*)::int AS n FROM agent_sessions WHERE profile_id = $1`, [codex.profileId])).rows[0].n;

    it('a refused /start creates no session and nothing to claim; a refused /resume says plan_owner_only and changes nothing', async () => {
        await bindTo(director.userId);
        const refused = await cmd(owner.auth, { command: 'start', profile: 'planbot' });
        expect(refused.status).toBe(403);
        expect(refused.body.error).toBe('plan_owner_only');
        expect(await sessions()).toBe(0);
        expect((await claim()).status).toBe(204);

        const s = await startSession(codex, director.userId);
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved', end_reason = 'user' WHERE id = $1`, [s]);
        const resume = await cmd(owner.auth, { command: 'resume', sessionId: s });
        expect(resume.status).toBe(403);
        expect(resume.body.error).toBe('plan_owner_only');
        const row = (await ctx.db.query(`SELECT state, started_by FROM agent_sessions WHERE id = $1`, [s])).rows[0];
        expect(row.state).toBe('shelved');
        expect(row.started_by.trim()).toBe(director.userId);
        expect(await inbox(s)).toEqual([]);
        expect((await claim()).status).toBe(204);
    });

    it("someone else's approve-once wakes nothing and is granted to the plan owner's next run", async () => {
        await bindTo(owner.userId);
        const s = await startSession(codex, owner.userId);
        const id = generateUlid();
        await ctx.db.query(`INSERT INTO agent_tool_requests (id, server_id, session_id, profile_id, tool) VALUES ($1, $2, $3, $4, 'Bash(gh:*)')`,
            [id, serverId, s, codex.profileId]);
        const res = await ctx.request.post(`/channels/${channelId}/agent-tool-requests/${id}`).set(director.auth).send({ decision: 'once' });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(await inbox(s)).toEqual([]);
        expect((await claim()).status).toBe(204);
        await post(owner.auth, '@planbot retry it');
        const c = await claim();
        expect(c.status).toBe(200);
        expect(c.body.run.grantedTools).toEqual(['Bash(gh:*)']);
    });

    it('a host report carrying a token is stripped to status and email: no token reaches the database', async () => {
        const res = await ctx.request.post('/agent-hosts/@me/plans/planbot').set(hostAuth)
            .send({ status: 'connected', accountLabel: 'eryk@example.com', access_token: 'at_CANARY_siwc', refresh_token: 'rt_CANARY_siwc' });
        // Fastify's schema drops properties the body schema doesn't list (additionalProperties: false)
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toEqual({ planOwnerId: owner.userId });
        const rows = await ctx.db.query(`SELECT row_to_json(c)::text AS j FROM agent_plan_connections c`);
        expect(rows.rows.map((r: any) => r.j).join('\n')).not.toMatch(/CANARY_siwc/);
        const profile = await ctx.db.query(`SELECT row_to_json(p)::text AS j FROM agent_profiles p WHERE id = $1`, [codex.profileId]);
        expect(profile.rows[0].j).not.toMatch(/CANARY_siwc/);
        const plans = await ctx.request.get(`/servers/${serverId}/agent-plans`).set(owner.auth);
        expect(JSON.stringify(plans.body)).not.toMatch(/CANARY_siwc/);
    });
});
