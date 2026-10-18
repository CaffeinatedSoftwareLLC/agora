import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';

/**
 * Hosted agent permissions (#73): tool presets on profiles, denied tools as approval cards,
 * approve once / always / deny. Rate-limit sleep (#87): a rate-limited run puts the session
 * to sleep, holds its inbox, and delivers everything in one batch on wake.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let hostAuth: { Authorization: string };
let botId: string;
let botAuth: { Authorization: string };
let profileId: string;

async function startSession(): Promise<string> {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, serverId, channelId, botId, profileId, owner.userId]
    );
    return id;
}

async function ask(content: string) {
    const res = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content });
    expect([200, 201]).toContain(res.status);
    return res.body;
}

const claim = () => ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
const runUrl = (c: any, action: string) => `/agent-hosts/@me/runs/${c.body.run.id}/${action}`;
const decide = (requestId: string, decision: string, auth = owner.auth) =>
    ctx.request.post(`/channels/${channelId}/agent-tool-requests/${requestId}`).set(auth).send({ decision });

async function cards() {
    const rows = await ctx.db.query(
        // Only this test's cards: messages outlive the per-test truncate of the agent tables
        `SELECT m.id, m.content, m.system_data FROM messages m JOIN agent_tool_requests r ON r.message_id = m.id
         WHERE m.channel_id = $1 AND m.system_event = 'agent_tool_approval' ORDER BY m.id`, [channelId]);
    return rows.rows;
}

/** Claim, then complete reporting these denied tools. Returns the claim body. */
async function runDenied(tools: string[]) {
    const c = await claim();
    expect(c.status).toBe(200);
    const done = await ctx.request.post(runUrl(c, 'complete')).set(hostAuth).send({ claimToken: c.body.run.claimToken, deniedTools: tools });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return c.body;
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'permowner');
    const server = await createServer(ctx.request, owner.auth, 'Permissions Server');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    member = await authedUser(ctx.request, 'permmember');
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 1000, max_bot_hops = 1000 WHERE id = $1', [channelId]);

    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
    hostAuth = { Authorization: `AgentHost ${host.body.token}` };
    const agent = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
        .send({ name: 'codex', adapter: 'claude', hostId: host.body.host.id, workdirAlias: 'agora', channelId });
    expect(agent.status, JSON.stringify(agent.body)).toBe(201);
    botId = agent.body.bot.id;
    botAuth = { Authorization: `Bot ${agent.body.token}` };
    profileId = agent.body.profile.id;
});

afterAll(async () => { await ctx.close(); });

beforeEach(async () => {
    await ctx.db.query('TRUNCATE agent_tool_requests, agent_runs, agent_inbox, agent_batches, agent_session_threads, agent_sessions CASCADE');
    await ctx.db.query(`UPDATE agent_profiles SET tool_presets = '{}', allowed_tools = '{}' WHERE id = $1`, [profileId]);
});

describe('tool presets on profiles', () => {
    it('stores presets and allowed tools without bumping the generation, and sends them in claims', async () => {
        const before = (await ctx.request.get(`/servers/${serverId}/agent-profiles`).set(owner.auth)).body[0];
        const res = await ctx.request.patch(`/servers/${serverId}/agent-profiles/${profileId}`).set(owner.auth)
            .send({ toolPresets: ['dev', 'research'], allowedTools: ['Bash(cargo:*)', 'network'] });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.toolPresets).toEqual(['dev', 'research']);
        expect(res.body.allowedTools).toEqual(['Bash(cargo:*)', 'network']);
        expect(res.body.generation).toBe(before.generation);

        await startSession();
        await ask('@codex build it');
        const c = await claim();
        expect(c.body.profile.toolPresets).toEqual(['dev', 'research']);
        expect(c.body.profile.allowedTools).toEqual(['Bash(cargo:*)', 'network']);
        expect(c.body.run.grantedTools).toEqual([]);
        expect(c.body.session.wokeFromSleep).toBe(false);
    });

    it('rejects malformed presets and rules, and edits from non-owners', async () => {
        const url = `/servers/${serverId}/agent-profiles/${profileId}`;
        expect((await ctx.request.patch(url).set(owner.auth).send({ allowedTools: ['Bash(a,b)'] })).status).toBe(400);
        expect((await ctx.request.patch(url).set(owner.auth).send({ allowedTools: ['Bash(x) && rm'] })).status).toBe(400);
        expect((await ctx.request.patch(url).set(owner.auth).send({ toolPresets: ['Dev!'] })).status).toBe(400);
        expect((await ctx.request.patch(url).set(member.auth).send({ toolPresets: ['dev'] })).status).toBe(403);
    });
});

describe('denied tools become approval cards', () => {
    it('posts one card per new denied tool, never for allowed or already pending ones', async () => {
        await ctx.db.query(`UPDATE agent_profiles SET allowed_tools = '{WebSearch}' WHERE id = $1`, [profileId]);
        await startSession();
        await ask('@codex one');
        await runDenied(['Bash(gh:*)', 'WebSearch', 'Bash(gh:*)']);
        let posted = await cards();
        expect(posted).toHaveLength(1);
        expect(posted[0].system_data).toMatchObject({ kind: 'agent_tool_approval', tool: 'Bash(gh:*)', status: 'pending', profile: 'codex' });
        expect(posted[0].content).toContain('`Bash(gh:*)`');

        await ask('@codex two');
        await runDenied(['Bash(gh:*)']);
        posted = await cards();
        expect(posted).toHaveLength(1);
    });

    it('rejects malformed denied tools from the host', async () => {
        await startSession();
        await ask('@codex go');
        const c = await claim();
        const bad = await ctx.request.post(runUrl(c, 'complete')).set(hostAuth).send({ claimToken: c.body.run.claimToken, deniedTools: ['Bash(x),Edit'] });
        expect(bad.status).toBe(400);
    });

    it('approve once wakes the agent and grants the rule to its next run only', async () => {
        const sessionId = await startSession();
        await ask('@codex open a PR');
        await runDenied(['Bash(gh:*)']);
        const card = (await cards())[0];
        const requestId = card.system_data.requestId;

        // Members without authority and bots can't approve
        expect((await decide(requestId, 'once', member.auth)).status).toBe(403);
        expect((await decide(requestId, 'once', botAuth)).status).toBe(403);

        const ok = await decide(requestId, 'once');
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body.status).toBe('once');
        expect((await decide(requestId, 'once')).status).toBe(409);

        const updated = (await cards())[0];
        expect(updated.system_data.status).toBe('once');
        expect(updated.content).toContain('approved');

        // The approval notice is the agent's next batch, and the grant rides along
        const c = await claim();
        expect(c.status).toBe(200);
        expect(c.body.session.id).toBe(sessionId);
        expect(c.body.inbox[0].content).toContain('Retry the step');
        expect(c.body.run.grantedTools).toEqual(['Bash(gh:*)']);
        expect(c.body.profile.allowedTools).toEqual([]);
        // A retry of the same batch keeps the grant
        await ctx.request.post(runUrl(c, 'fail')).set(hostAuth).send({ claimToken: c.body.run.claimToken, error: 'crash', retryable: true });
        const retry = await claim();
        expect(retry.body.run.grantedTools).toEqual(['Bash(gh:*)']);
        await ctx.request.post(runUrl(retry, 'complete')).set(hostAuth).send({ claimToken: retry.body.run.claimToken });

        await ask('@codex next');
        const later = await claim();
        expect(later.body.run.grantedTools).toEqual([]);
    });

    it('always allowing is owner-only and adds the rule to the profile', async () => {
        await startSession();
        await ask('@codex search');
        await runDenied(['WebFetch(domain:example.com)']);
        const requestId = (await cards())[0].system_data.requestId;

        const ok = await decide(requestId, 'always');
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        const profile = (await ctx.request.get(`/servers/${serverId}/agent-profiles`).set(owner.auth)).body[0];
        expect(profile.allowedTools).toEqual(['WebFetch(domain:example.com)']);
        const c = await claim();
        expect(c.body.profile.allowedTools).toEqual(['WebFetch(domain:example.com)']);
        expect(c.body.run.grantedTools).toEqual([]);
    });

    it('deny closes the card without waking the agent; expired cards cannot be approved', async () => {
        await startSession();
        await ask('@codex try');
        await runDenied(['Bash(rm:*)', 'Bash(curl:*)']);
        const [first, second] = (await cards()).map((c: any) => c.system_data.requestId);
        const denied = await decide(first, 'deny');
        expect(denied.body.status).toBe('denied');
        expect((await claim()).status).toBe(204);

        await ctx.db.query(`UPDATE agent_tool_requests SET created_at = NOW() - INTERVAL '25 hours' WHERE id = $1`, [second]);
        expect((await decide(second, 'once')).status).toBe(410);
    });

    it('returns 404 for a request from another channel', async () => {
        expect((await decide(generateUlid(), 'once')).status).toBe(404);
    });
});

describe('rate-limited agents sleep and replay (#87)', () => {
    it('sleeps the session, holds new messages and delivers them in one batch on wake', async () => {
        const sessionId = await startSession();
        const first = await ask('@codex first task');
        const c = await claim();
        const resetAt = new Date(Date.now() + 2 * 3600_000).toISOString();
        const failed = await ctx.request.post(runUrl(c, 'fail')).set(hostAuth)
            .send({ claimToken: c.body.run.claimToken, error: 'rate_limited', retryable: true, rateLimit: { resetAt } });
        expect(failed.body).toEqual({ ok: true, sleeping: true });

        const s = (await ctx.db.query(`SELECT sleeping_until, wakes_used FROM agent_sessions WHERE id = $1`, [sessionId])).rows[0];
        expect(Math.abs(new Date(s.sleeping_until).getTime() - Date.parse(resetAt))).toBeLessThan(1000);
        expect(s.wakes_used).toBe(0);
        const notice = await ctx.db.query(`SELECT content FROM messages WHERE channel_id = $1 AND content LIKE '%rate limit%'`, [channelId]);
        expect(notice.rows[0].content).toContain('sleeping for about 2 h');

        // Held while asleep
        const second = await ask('@codex second task');
        expect((await claim()).status).toBe(204);
        const listed = await ctx.request.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'sessions' });
        expect(listed.body.sessions[0].sleepingUntil).toBeTruthy();

        // The limit resets: one batch with both messages
        await ctx.db.query(`UPDATE agent_sessions SET sleeping_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [sessionId]);
        const woke = await claim();
        expect(woke.status).toBe(200);
        expect(woke.body.session.wokeFromSleep).toBe(true);
        expect(woke.body.run.attempt).toBe(1);
        expect(woke.body.inbox.map((m: any) => m.messageId)).toEqual([first.id, second.id]);
        const after = (await ctx.db.query(`SELECT sleeping_until FROM agent_sessions WHERE id = $1`, [sessionId])).rows[0];
        expect(after.sleeping_until).toBeNull();
        const done = await ctx.request.post(runUrl(woke, 'complete')).set(hostAuth).send({ claimToken: woke.body.run.claimToken });
        expect(done.status).toBe(200);
        expect((await claim()).status).toBe(204);
    });

    it('defaults the sleep when the reset time is unknown, and wake wakes it early', async () => {
        const sessionId = await startSession();
        await ask('@codex task');
        const c = await claim();
        await ctx.request.post(runUrl(c, 'fail')).set(hostAuth).send({ claimToken: c.body.run.claimToken, error: 'rate_limited', retryable: true, rateLimit: { resetAt: null } });
        const s = (await ctx.db.query(`SELECT sleeping_until FROM agent_sessions WHERE id = $1`, [sessionId])).rows[0];
        const minutes = (new Date(s.sleeping_until).getTime() - Date.now()) / 60000;
        expect(minutes).toBeGreaterThan(28); expect(minutes).toBeLessThan(31);

        expect((await ctx.request.post(`/channels/${channelId}/agent-commands`).set(member.auth).send({ command: 'wake', sessionId })).status).toBe(403);
        const woken = await ctx.request.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'wake', sessionId });
        expect(woken.status, JSON.stringify(woken.body)).toBe(200);
        expect(woken.body.action).toBe('woken');
        const again = await claim();
        expect(again.status).toBe(200);
        expect(again.body.session.wokeFromSleep).toBe(true);
        expect((await ctx.request.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'wake', sessionId })).status).toBe(409);
    });

    it('an ordinary failure still retries and then gives up', async () => {
        const sessionId = await startSession();
        await ask('@codex task');
        const c = await claim();
        await ctx.request.post(runUrl(c, 'fail')).set(hostAuth).send({ claimToken: c.body.run.claimToken, error: 'cli_failed', retryable: true });
        const s = (await ctx.db.query(`SELECT sleeping_until FROM agent_sessions WHERE id = $1`, [sessionId])).rows[0];
        expect(s.sleeping_until).toBeNull();
        const retry = await claim();
        expect(retry.body.run.attempt).toBe(2);
    });
});
