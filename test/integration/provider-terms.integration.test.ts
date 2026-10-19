import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';

/**
 * Provider-terms guardrails (docs/provider-terms.md, src/lib/provider-terms.ts).
 *
 * - The host reports each profile's auth mode; a profile counts as 'subscription' until then.
 * - A subscription profile runs only for the server owner: owner messages, owner /start and
 *   /resume, hand-offs between owner-started sessions, lurk on owner messages. Everyone
 *   else is refused with a notice. API-key profiles keep the ordinary authority rules.
 * - A profile with run approval waits for the owner to approve each wake on a card.
 */

const DIRECT = (1n << 29n).toString();
const NOTICE = (agent: string) => `${agent} runs on the owner's personal subscription; ask the owner, or configure an API key profile.`;

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let director: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let hostAuth: { Authorization: string };
let otherHostAuth: { Authorization: string };
type Agent = { botId: string; profileId: string; auth: { Authorization: string }; name: string };
let alpha: Agent;
let beta: Agent;

async function makeAgent(name: string, hostId: string): Promise<Agent> {
    const res = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
        .send({ name, adapter: 'claude', hostId, workdirAlias: 'agora', channelId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { botId: res.body.bot.id, profileId: res.body.profile.id, auth: { Authorization: `Bot ${res.body.token}` }, name };
}

async function setMode(agent: Agent, mode: 'subscription' | 'api_key', runApproval = false) {
    await ctx.db.query(`UPDATE agent_profiles SET auth_mode = $2, api_key_env = $3, run_approval = $4 WHERE id = $1`,
        [agent.profileId, mode, mode === 'api_key' ? 'ANTHROPIC_API_KEY' : null, runApproval]);
}

async function startSession(agent: Agent, startedBy: string | null = owner.userId, lurk: string | null = null): Promise<string> {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by, lurk_mode) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, serverId, channelId, agent.botId, agent.profileId, startedBy, lurk]
    );
    return id;
}

async function post(auth: object, content: string): Promise<any> {
    const res = await ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    return res.body;
}

async function reply(auth: object, threadId: string, content: string): Promise<any> {
    const res = await ctx.request.post(`/channels/${channelId}/messages/${threadId}/replies`).set(auth).send({ content });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    return res.body;
}

async function inbox(sessionId: string): Promise<Array<{ message_id: string; reason: string }>> {
    const rows = await ctx.db.query(`SELECT message_id, reason FROM agent_inbox WHERE session_id = $1 AND acked_at IS NULL ORDER BY id`, [sessionId]);
    return rows.rows.map((r: any) => ({ message_id: r.message_id.trim(), reason: r.reason }));
}

/** System notices posted since `since` (a message id), oldest first. */
async function notices(since: string): Promise<string[]> {
    const rows = await ctx.db.query(
        `SELECT content FROM messages WHERE channel_id = $1 AND author_id IS NULL AND system_event = 'agent_session' AND id > $2 ORDER BY id`,
        [channelId, since]);
    return rows.rows.map((r: any) => r.content);
}

const claim = () => ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
const cmd = (auth: object, body: object) => ctx.request.post(`/channels/${channelId}/agent-commands`).set(auth).send(body);
const mark = () => generateUlid();

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'ptowner');
    const server = await createServer(ctx.request, owner.auth, 'Terms Server');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    director = await authedUser(ctx.request, 'ptdirector');
    member = await authedUser(ctx.request, 'ptmember');
    await joinViaInvite(ctx.request, owner.auth, director.auth, serverId);
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    const role = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Orchestrator', permissions: DIRECT });
    expect(role.status).toBe(201);
    await ctx.request.put(`/servers/${serverId}/members/${director.userId}/roles/${role.body.id}`).set(owner.auth);
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 1000, max_bot_hops = 1000, max_thread_bot_hops = 0 WHERE id = $1', [channelId]);

    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
    hostAuth = { Authorization: `AgentHost ${host.body.token}` };
    const other = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'laptop' });
    otherHostAuth = { Authorization: `AgentHost ${other.body.token}` };
    alpha = await makeAgent('alpha', host.body.host.id);
    beta = await makeAgent('beta', host.body.host.id);
});

afterAll(async () => { await ctx.close(); });

beforeEach(async () => {
    await ctx.db.query('TRUNCATE agent_run_approvals, agent_tool_requests, agent_runs, agent_inbox, agent_batches, agent_session_threads, agent_sessions CASCADE');
    await setMode(alpha, 'subscription');
    await setMode(beta, 'subscription');
});

describe('host reports auth modes', () => {
    it('defaults to subscription, stores what the host reports, and shows it on profiles', async () => {
        await ctx.db.query(`UPDATE agent_profiles SET auth_reported_at = NULL WHERE server_id = $1`, [serverId]);
        let profiles = (await ctx.request.get(`/servers/${serverId}/agent-profiles`).set(owner.auth)).body;
        expect(profiles.find((p: any) => p.name === 'alpha')).toMatchObject({ authMode: 'subscription', apiKeyEnv: null, runApproval: false, authReportedAt: null });

        const res = await ctx.request.post('/agent-hosts/@me/profiles').set(hostAuth).send({ profiles: [
            { name: 'alpha', adapter: 'claude', authMode: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY', runApproval: false },
            { name: 'beta', adapter: 'claude', authMode: 'subscription', apiKeyEnv: null, runApproval: true },
            { name: 'ghost', adapter: 'codex', authMode: 'subscription', runApproval: false },
        ] });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toEqual({ updated: ['alpha', 'beta'], unknown: ['ghost'] });
        profiles = (await ctx.request.get(`/servers/${serverId}/agent-profiles`).set(member.auth)).body;
        expect(profiles.find((p: any) => p.name === 'alpha')).toMatchObject({ authMode: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY', runApproval: false });
        expect(profiles.find((p: any) => p.name === 'beta')).toMatchObject({ authMode: 'subscription', apiKeyEnv: null, runApproval: true });
        expect(profiles.find((p: any) => p.name === 'beta').authReportedAt).toBeTruthy();
    });

    it('ignores profiles of another host, an adapter mismatch, and bad input', async () => {
        const other = await ctx.request.post('/agent-hosts/@me/profiles').set(otherHostAuth).send({ profiles: [
            { name: 'alpha', adapter: 'claude', authMode: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY', runApproval: false },
        ] });
        expect(other.body).toEqual({ updated: [], unknown: ['alpha'] });
        const mismatch = await ctx.request.post('/agent-hosts/@me/profiles').set(hostAuth).send({ profiles: [
            { name: 'alpha', adapter: 'codex', authMode: 'api_key', apiKeyEnv: 'CODEX_API_KEY', runApproval: false },
        ] });
        expect(mismatch.body).toEqual({ updated: [], unknown: ['alpha'] });
        const noEnv = await ctx.request.post('/agent-hosts/@me/profiles').set(hostAuth).send({ profiles: [
            { name: 'alpha', adapter: 'claude', authMode: 'api_key', runApproval: false },
        ] });
        expect(noEnv.status).toBe(400);
        const badEnv = await ctx.request.post('/agent-hosts/@me/profiles').set(hostAuth).send({ profiles: [
            { name: 'alpha', adapter: 'claude', authMode: 'api_key', apiKeyEnv: 'sk-ant-not-a-name', runApproval: false },
        ] });
        expect(badEnv.status).toBe(400);
        expect((await ctx.request.post('/agent-hosts/@me/profiles').set(owner.auth).send({ profiles: [] })).status).toBe(403);
    });
});

describe('subscription profiles: direct messages', () => {
    it('wakes for the owner\'s mention and carries the auth mode in the claim', async () => {
        const s = await startSession(alpha);
        const m = await post(owner.auth, '@alpha check the build');
        expect(await inbox(s)).toEqual([{ message_id: m.id, reason: 'direct' }]);
        const c = await claim();
        expect(c.status).toBe(200);
        expect(c.body.profile).toMatchObject({ authMode: 'subscription', runApproval: false });
        expect(c.body.session.startedByOwner).toBe(true);
        expect(c.body.run.ownerApproved).toBe(false);
        expect(c.body.inbox).toEqual([expect.objectContaining({ authority: 'owner', authorBot: false })]);
    });

    it('refuses a director\'s mention with a notice, and a member\'s', async () => {
        const s = await startSession(alpha);
        const since = mark();
        await post(director.auth, '@alpha deploy it');
        await post(member.auth, '@alpha please?');
        expect(await inbox(s)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha'), NOTICE('alpha')]);
        expect((await claim()).status).toBe(204);
    });

    it('refuses a director\'s message to the only live agent, and in a bound thread', async () => {
        const sa = await startSession(alpha);
        const since = mark();
        await post(director.auth, 'anyone there?');
        expect(await inbox(sa)).toEqual([]);
        const sb = await startSession(beta);
        const start = await post(beta.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [beta, alpha]\ntask: x');
        await reply(director.auth, start.id, 'both of you: focus on tests');
        expect((await inbox(sa)).map(r => r.message_id)).toEqual([start.id]);
        expect(await inbox(sb)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha'), NOTICE('alpha'), NOTICE('beta')]);
    });

    it('keeps the ordinary rules for an API-key profile', async () => {
        await setMode(alpha, 'api_key');
        const s = await startSession(alpha, director.userId);
        const since = mark();
        const m = await post(director.auth, '@alpha deploy it');
        await post(member.auth, '@alpha please?');
        expect(await inbox(s)).toEqual([{ message_id: m.id, reason: 'direct' }]);
        expect(await notices(since)).toEqual([]);
        const c = await claim();
        expect(c.body.profile.authMode).toBe('api_key');
        expect(c.body.session.startedByOwner).toBe(false);
    });

    it('drops a director\'s pending wake at claim when the profile became subscription', async () => {
        await setMode(alpha, 'api_key');
        const s = await startSession(alpha);
        await post(director.auth, '@alpha deploy it');
        expect(await inbox(s)).toHaveLength(1);
        await setMode(alpha, 'subscription');
        expect((await claim()).status).toBe(204);
        expect(await inbox(s)).toEqual([]);
    });

    it('refuses work in a session someone else started, with a notice at claim', async () => {
        await setMode(alpha, 'api_key');
        const s = await startSession(alpha, director.userId);
        await post(owner.auth, '@alpha hello');
        await setMode(alpha, 'subscription');
        const since = mark();
        expect((await claim()).status).toBe(204);
        expect(await inbox(s)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha')]);
    });
});

describe('subscription profiles: commands', () => {
    it('only the owner can /start or /resume it; a director gets subscription_owner_only', async () => {
        const refused = await cmd(director.auth, { command: 'start', profile: 'alpha' });
        expect(refused.status).toBe(403);
        expect(refused.body).toMatchObject({ error: 'subscription_owner_only' });
        expect(refused.body.message).toMatch(/owner's personal subscription/);

        const started = await cmd(owner.auth, { command: 'start', profile: 'alpha' });
        expect(started.status).toBe(201);
        expect(started.body.session).toMatchObject({ authMode: 'subscription' });
        const c = await claim();
        expect(c.status).toBe(200);
        expect(c.body.inbox).toEqual([expect.objectContaining({ reason: 'command' })]);
        await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/complete`).set(hostAuth).send({ claimToken: c.body.run.claimToken, summary: 'hi' });

        await cmd(owner.auth, { command: 'end', profile: 'alpha' });
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved', end_reason = 'user' WHERE id = $1`, [started.body.session.id]);
        const resume = await cmd(director.auth, { command: 'resume', sessionId: started.body.session.id });
        expect(resume.status).toBe(403);
        expect(resume.body.error).toBe('subscription_owner_only');
        expect((await cmd(owner.auth, { command: 'resume', sessionId: started.body.session.id })).status).toBe(200);
    });

    it('an owner resume makes a director-started session the owner\'s', async () => {
        const s = await startSession(alpha, director.userId);
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved', end_reason = 'user' WHERE id = $1`, [s]);
        expect((await cmd(owner.auth, { command: 'resume', sessionId: s })).status).toBe(200);
        const c = await claim();
        expect(c.status).toBe(200);
        expect(c.body.session.startedByOwner).toBe(true);
    });

    it('a director can still /start an API-key profile', async () => {
        await setMode(alpha, 'api_key');
        expect((await cmd(director.auth, { command: 'start', profile: 'alpha' })).status).toBe(201);
    });
});

describe('subscription profiles: agent hand-offs', () => {
    it('routes hand-offs between sessions the owner started', async () => {
        const sa = await startSession(alpha);
        const sb = await startSession(beta);
        const start = await post(beta.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [beta, alpha]\ntask: x');
        expect(await inbox(sa)).toEqual([{ message_id: start.id, reason: 'protocol' }]);
        const yieldBack = await reply(alpha.auth, start.id, '[AGORA/v1 MODE=plan STATE=TURN]\nyour turn\n[YIELD to=beta]');
        expect((await inbox(sb)).map(r => [r.message_id, r.reason])).toEqual([[yieldBack.id, 'handoff']]);
    });

    it('refuses a hand-off from a session the owner didn\'t start', async () => {
        await setMode(beta, 'api_key');
        const sa = await startSession(alpha);
        await startSession(beta, director.userId);
        const since = mark();
        await post(beta.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [beta, alpha]\ntask: x');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha')]);
    });
});

describe('subscription profiles: lurk', () => {
    it('wakes a lurker only for the owner\'s messages, silently skipping others', async () => {
        const s = await startSession(alpha, owner.userId, 'balanced');
        await startSession(beta);
        const since = mark();
        await post(member.auth, 'chatter from a member');
        await post(director.auth, 'chatter from a director');
        const mine = await post(owner.auth, 'chatter from the owner');
        expect(await inbox(s)).toEqual([{ message_id: mine.id, reason: 'lurk' }]);
        expect(await notices(since)).toEqual([]);
    });
});

describe('subscription profiles: tool approvals', () => {
    async function pendingRequest(sessionId: string): Promise<string> {
        const id = generateUlid();
        await ctx.db.query(`INSERT INTO agent_tool_requests (id, server_id, session_id, profile_id, tool) VALUES ($1, $2, $3, $4, 'Bash(gh:*)')`,
            [id, serverId, sessionId, alpha.profileId]);
        return id;
    }
    it('a director\'s approve-once grants without waking; the owner\'s wakes', async () => {
        const s = await startSession(alpha);
        const byDirector = await ctx.request.post(`/channels/${channelId}/agent-tool-requests/${await pendingRequest(s)}`).set(director.auth).send({ decision: 'once' });
        expect(byDirector.status, JSON.stringify(byDirector.body)).toBe(200);
        expect(await inbox(s)).toEqual([]);
        await ctx.db.query(`UPDATE agent_tool_requests SET tool = 'Bash(npm:*)' WHERE session_id = $1`, [s]);
        const byOwner = await ctx.request.post(`/channels/${channelId}/agent-tool-requests/${await pendingRequest(s)}`).set(owner.auth).send({ decision: 'once' });
        expect(byOwner.status).toBe(200);
        expect((await inbox(s)).map(r => r.reason)).toEqual(['command']);
    });
});

describe('host refusals', () => {
    it('reports a terms refusal as a notice, without retrying', async () => {
        const s = await startSession(alpha);
        await post(owner.auth, '@alpha go');
        const c = await claim();
        const since = mark();
        const fail = await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/fail`).set(hostAuth)
            .send({ claimToken: c.body.run.claimToken, error: 'subscription_owner_only', message: 'Agent run did not complete', retryable: false });
        expect(fail.status).toBe(200);
        expect(await notices(since)).toEqual([NOTICE('alpha')]);
        expect(await inbox(s)).toEqual([]);
        expect((await claim()).status).toBe(204);
    });
});

describe('run approval', () => {
    async function cards() {
        const rows = await ctx.db.query(
            `SELECT m.id, m.content, m.system_data FROM messages m JOIN agent_run_approvals a ON a.message_id = m.id
             WHERE m.channel_id = $1 AND m.system_event = 'agent_run_approval' ORDER BY m.id`, [channelId]);
        return rows.rows;
    }
    const decide = (approvalId: string, decision: string, auth = owner.auth) =>
        ctx.request.post(`/channels/${channelId}/agent-run-approvals/${approvalId}`).set(auth).send({ decision });

    it('posts one card per waiting wake and starts only after the owner approves', async () => {
        await setMode(alpha, 'subscription', true);
        const s = await startSession(alpha);
        await post(owner.auth, '@alpha summarise the thread');
        expect((await claim()).status).toBe(204);
        expect((await claim()).status).toBe(204);
        let posted = await cards();
        expect(posted).toHaveLength(1);
        expect(posted[0].system_data).toMatchObject({ kind: 'agent_run_approval', profile: 'alpha', status: 'pending', sessionId: s });
        expect(posted[0].content).toContain('summarise the thread');
        const approvalId = posted[0].system_data.approvalId;

        expect((await decide(approvalId, 'approve', director.auth)).status).toBe(403);
        expect((await decide(approvalId, 'approve', member.auth)).status).toBe(403);
        expect((await decide(approvalId, 'approve', alpha.auth)).status).toBe(403);
        const ok = await decide(approvalId, 'approve');
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body.status).toBe('approved');
        expect((await decide(approvalId, 'deny')).status).toBe(409);
        posted = await cards();
        expect(posted[0].system_data.status).toBe('approved');

        const c = await claim();
        expect(c.status).toBe(200);
        expect(c.body.run.ownerApproved).toBe(true);
        expect(c.body.profile.runApproval).toBe(true);

        // A retry of the same batch keeps its approval
        await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/fail`).set(hostAuth)
            .send({ claimToken: c.body.run.claimToken, error: 'cli_failed', retryable: true });
        const retry = await claim();
        expect(retry.status).toBe(200);
        expect(retry.body.run.ownerApproved).toBe(true);
        await ctx.request.post(`/agent-hosts/@me/runs/${retry.body.run.id}/complete`).set(hostAuth)
            .send({ claimToken: retry.body.run.claimToken, summary: 'done' });

        // The next wake needs a new approval
        await post(owner.auth, '@alpha and again');
        expect((await claim()).status).toBe(204);
        expect(await cards()).toHaveLength(2);
    });

    it('a denial drops the waiting work', async () => {
        await setMode(alpha, 'api_key', true);
        const s = await startSession(alpha, director.userId);
        await post(director.auth, '@alpha do the thing');
        expect((await claim()).status).toBe(204);
        const [card] = await cards();
        const res = await decide(card.system_data.approvalId, 'deny');
        expect(res.body.status).toBe('denied');
        expect(await inbox(s)).toEqual([]);
        expect((await claim()).status).toBe(204);
        expect((await cards())[0].system_data.status).toBe('denied');
    });

    it('an unanswered card expires and a new one is posted', async () => {
        await setMode(alpha, 'subscription', true);
        await startSession(alpha);
        await post(owner.auth, '@alpha hello');
        expect((await claim()).status).toBe(204);
        await ctx.db.query(`UPDATE agent_run_approvals SET created_at = NOW() - interval '25 hours'`);
        expect((await claim()).status).toBe(204);
        const posted = await cards();
        expect(posted.map((c: any) => c.system_data.status)).toEqual(['expired', 'pending']);
        expect((await decide(posted[0].system_data.approvalId, 'approve')).status).toBe(409);
    });
});
