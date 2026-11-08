import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase, setHostKind } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { attachTerminal } from '../../src/lib/terminal-sessions';

/**
 * Provider-terms guardrails (docs/provider-terms.md, src/lib/provider-terms.ts).
 *
 * - The host reports each profile's auth mode; a profile counts as 'subscription' until then.
 * - A subscription profile runs only for the server owner: owner messages, owner /start and
 *   /resume, hand-offs between owner-started sessions, lurk on owner messages, and (the server's
 *   subscription_wakes 'owner_bots', default) the owner's own bots for every reason; the owner
 *   bots cases are in owner-bots.integration.test.ts. Everyone else is refused with a notice. API-key profiles keep the ordinary authority rules on a
 *   box's host; on a machine host (host mode, docs/agent-boxes.md §10) they are owner-only too.
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
let hostId: string;
let otherHostAuth: { Authorization: string };
type Agent = { botId: string; profileId: string; auth: { Authorization: string }; name: string };
let alpha: Agent;
let beta: Agent;

async function makeAgent(name: string, hostId: string): Promise<Agent> {
    const res = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
        .send({ hostModeAck: true, name, adapter: 'claude', hostId, workdirAlias: 'agora', channelId });
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
    hostId = host.body.host.id;
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
    await setHostKind(ctx.db, hostId, 'machine');
    await ctx.db.query(`UPDATE servers SET subscription_wakes = 'owner_bots' WHERE id = $1`, [serverId]);
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

    it('keeps the ordinary rules for an API-key profile on a box host', async () => {
        await setHostKind(ctx.db, hostId, 'box');
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
        await setHostKind(ctx.db, hostId, 'box');
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

describe('subscription profiles: thread mentions (#120)', () => {
    it("a director's @mention in an unbound thread is refused with a notice in that thread; the owner's wakes it", async () => {
        const s = await startSession(alpha);
        await setMode(beta, 'api_key');
        await startSession(beta);
        const parent = await post(beta.auth, 'a thread by another agent');
        const since = mark();
        await reply(director.auth, parent.id, '@alpha check the PR');
        await reply(member.auth, parent.id, '@ALPHA please?');
        expect(await inbox(s)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha'), NOTICE('alpha')]);
        const inThread = await ctx.db.query(`SELECT count(*)::int AS n FROM messages WHERE thread_id = $1 AND system_event = 'agent_session'`, [parent.id]);
        expect(inThread.rows[0].n).toBe(2);
        const mine = await reply(owner.auth, parent.id, '@Alpha check the PR');
        expect(await inbox(s)).toEqual([{ message_id: mine.id, reason: 'direct' }]);
    });

    it("a follow-up without a mention: the owner's wakes it; a director's and a member's are silent, with no notice", async () => {
        const s = await startSession(alpha);
        const parent = await post(alpha.auth, 'Opened the PR, details here');
        const since = mark();
        await reply(director.auth, parent.id, 'merge it');
        await reply(member.auth, parent.id, 'nice work');
        expect(await inbox(s)).toEqual([]);
        expect(await notices(since)).toEqual([]);
        const mine = await reply(owner.auth, parent.id, 'merge it');
        expect(await inbox(s)).toEqual([{ message_id: mine.id, reason: 'direct' }]);
    });

    it("a follow-up from a director wakes an API-key agent on a box host", async () => {
        await setHostKind(ctx.db, hostId, 'box');
        await setMode(alpha, 'api_key');
        const s = await startSession(alpha, director.userId);
        const parent = await post(alpha.auth, 'Opened the PR, details here');
        const since = mark();
        const r = await reply(director.auth, parent.id, 'merge it');
        expect(await inbox(s)).toEqual([{ message_id: r.id, reason: 'direct' }]);
        expect(await notices(since)).toEqual([]);
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

    it('a director can still /start an API-key profile on a box host, not on a machine host', async () => {
        await setMode(alpha, 'api_key');
        const refused = await cmd(director.auth, { command: 'start', profile: 'alpha' });
        expect(refused.status).toBe(403);
        expect(refused.body.error).toBe('subscription_owner_only');
        await setHostKind(ctx.db, hostId, 'box');
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

/**
 * subscription_wakes 'owner_only' (the stricter setting; #361): the owner's own agent in a
 * terminal session (agora-mcp from a CLI on the owner's machine, src/lib/terminal-sessions.ts)
 * hands off like an owner-started session: its START and YIELDs wake an owner-started
 * subscription agent. Only when the terminal was opened with a personal or invite token the plan
 * owner minted, and the post is made with that same token. Its hosted session (if any) is on
 * standby, so the terminal session is the author.
 */
describe('subscription profiles (owner_only): hand-offs from the owner\'s terminal agents', () => {
    let gamma: Agent;
    let admin: Awaited<ReturnType<typeof authedUser>>;
    beforeAll(async () => {
        gamma = await makeAgent('gamma', hostId);
        admin = await authedUser(ctx.request, 'ptadmin');
        await joinViaInvite(ctx.request, owner.auth, admin.auth, serverId);
        const role = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Admins', permissions: (1n << 0n).toString() });
        expect(role.status).toBe(201);
        await ctx.request.put(`/servers/${serverId}/members/${admin.userId}/roles/${role.body.id}`).set(owner.auth);
    });
    beforeEach(async () => {
        await setMode(gamma, 'subscription');
        for (const a of [beta, gamma]) await ctx.db.query('UPDATE users SET bot_owner_id = $2 WHERE id = $1', [a.botId, owner.userId]);
        await ctx.db.query(`UPDATE servers SET subscription_wakes = 'owner_only' WHERE id = $1`, [serverId]);
    });

    type Token = { id: string; auth: { Authorization: string } };
    const tokenOf = (auth: { Authorization: string }): Token => ({ id: auth.Authorization.slice('Bot bot_'.length).split('.')[0], auth });
    /** A personal token for the bot, minted by `by` (its owner, or an Administrator). */
    async function mint(agent: Agent, by: { auth: object }): Promise<Token> {
        const res = await ctx.request.post(`/servers/${serverId}/bots/${agent.botId}/tokens`).set(by.auth).send({ name: 'my terminal' });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return { id: res.body.tokenId, auth: { Authorization: `Bot ${res.body.token}` } };
    }
    /** What the gateway does when agora-mcp connects with presence on this token. */
    const connectTerminal = async (agent: Agent, token: Token) =>
        (await attachTerminal(ctx.db, agent.botId, [channelId], 'mcp', false, token.id)).attached[0].sessionId;
    const START = (...names: string[]) => `[AGORA/v1 MODE=plan STATE=START]\nparticipants: [${names.join(', ')}]\ntask: x`;
    const TURN = (to: string) => `[AGORA/v1 MODE=plan STATE=TURN]\nyour turn\n[YIELD to=${to}]`;
    const boundThread = async (threadId: string) =>
        (await ctx.db.query('SELECT state FROM agent_session_threads WHERE thread_id = $1', [threadId])).rows[0]?.state ?? null;

    it('records who minted a token and what it is for', async () => {
        const mine = await mint(beta, owner);
        const rows = await ctx.db.query(`SELECT id, created_by, purpose FROM bot_tokens WHERE id = ANY($1)`, [[mine.id, tokenOf(beta.auth).id]]);
        const byId = new Map(rows.rows.map((r: any) => [r.id.trim(), { createdBy: r.created_by?.trim(), purpose: r.purpose }]));
        expect(byId.get(mine.id)).toEqual({ createdBy: owner.userId, purpose: 'personal' });
        expect(byId.get(tokenOf(beta.auth).id)).toEqual({ createdBy: owner.userId, purpose: 'host' });
        // An agent invite's token was minted by whoever created the invite
        const invite = await ctx.request.post(`/servers/${serverId}/agent-invites`).set(admin.auth).send({ botId: beta.botId });
        expect(invite.status, JSON.stringify(invite.body)).toBe(201);
        const redeemed = await ctx.request.post('/agent-invites/redeem').send({ code: invite.body.code });
        expect(redeemed.status).toBe(200);
        const row = (await ctx.db.query(`SELECT created_by, purpose FROM bot_tokens WHERE id = $1`,
            [redeemed.body.token.slice('bot_'.length).split('.')[0]])).rows[0];
        expect({ createdBy: row.created_by.trim(), purpose: row.purpose }).toEqual({ createdBy: admin.userId, purpose: 'invite' });
    });

    it('wakes an owner-started subscription agent on its START and YIELDs (protocol, handoff), with no notice', async () => {
        const sa = await startSession(alpha);
        await startSession(beta); // its hosted session goes on standby behind the terminal
        const mine = await mint(beta, owner);
        await connectTerminal(beta, mine);
        const since = mark();
        const start = await post(mine.auth, START('beta', 'alpha'));
        expect(await inbox(sa)).toEqual([{ message_id: start.id, reason: 'protocol' }]);
        expect(await boundThread(start.id)).toBe('open');
        // alpha yields to the terminal agent: nothing to wake (it hears the thread itself)
        await reply(alpha.auth, start.id, TURN('beta'));
        const back = await reply(mine.auth, start.id, TURN('alpha'));
        const waiting = await reply(mine.auth, start.id, '[AGORA/v1 MODE=plan STATE=WAIT]\nneed your review\n[WAIT on=alpha for=review]');
        expect(await inbox(sa)).toEqual([
            { message_id: start.id, reason: 'protocol' }, { message_id: back.id, reason: 'handoff' }, { message_id: waiting.id, reason: 'handoff' },
        ]);
        expect(await notices(since)).toEqual([]);
        // The claim's recheck and the host's rule (authorBot) keep them
        const c = await claim();
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        expect(c.body.session.startedByOwner).toBe(true);
        expect(c.body.inbox.map((i: any) => i.reason)).toEqual(['protocol', 'handoff', 'handoff']);
        // A participant's DONE from its terminal closes the thread
        await reply(mine.auth, start.id, '[AGORA/v1 MODE=plan STATE=DONE]\ndone');
        expect(await boundThread(start.id)).toBe('closed');
    });

    it('routes a YIELD from the terminal agent in a thread a hosted session started, also after it reconnects', async () => {
        const sa = await startSession(alpha);
        const mine = await mint(beta, owner);
        const first = await connectTerminal(beta, mine);
        const start = await post(alpha.auth, START('alpha', 'beta'));
        expect(await boundThread(start.id)).toBe('open');
        const since = mark();
        const back = await reply(mine.auth, start.id, TURN('alpha'));
        await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE id = $1`, [first]);
        expect(await connectTerminal(beta, mine)).not.toBe(first);
        const again = await reply(mine.auth, start.id, TURN('alpha'));
        expect((await inbox(sa)).map(r => [r.message_id, r.reason])).toEqual([[back.id, 'handoff'], [again.id, 'handoff']]);
        expect(await notices(since)).toEqual([]);
    });

    it('a terminal opened with a token an Administrator minted is refused', async () => {
        const sa = await startSession(alpha);
        const adminMinted = await mint(beta, admin);
        await connectTerminal(beta, adminMinted);
        const since = mark();
        const start = await post(adminMinted.auth, START('beta', 'alpha'));
        // Its minter can't direct agents here, so the START is an ordinary post: no thread, no wake
        expect(await boundThread(start.id)).toBeNull();
        await reply(adminMinted.auth, start.id, TURN('alpha'));
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([]);
        // In a thread an owner-started hosted agent opened with it: its YIELD is refused with a notice
        await startSession(gamma);
        const opened = await post(gamma.auth, START('gamma', 'alpha', 'beta'));
        expect(await inbox(sa)).toEqual([{ message_id: opened.id, reason: 'protocol' }]);
        const since2 = mark();
        await reply(adminMinted.auth, opened.id, TURN('alpha'));
        expect(await inbox(sa)).toEqual([{ message_id: opened.id, reason: 'protocol' }]);
        expect(await notices(since2)).toEqual([NOTICE('alpha')]);
    });

    it("a terminal opened with the agent's host token (what hosted runs get) is refused", async () => {
        const sa = await startSession(alpha);
        const host = tokenOf(beta.auth);
        await connectTerminal(beta, host);
        const since = mark();
        const start = await post(host.auth, START('beta', 'alpha'));
        // A host token has only the bot's own authority (none here): an ordinary post, no thread, no wake
        expect(await boundThread(start.id)).toBeNull();
        await reply(host.auth, start.id, TURN('alpha'));
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([]);
        // In a thread an owner-started hosted agent opened with it: its YIELD is refused with a notice
        await startSession(gamma);
        const opened = await post(gamma.auth, START('gamma', 'alpha', 'beta'));
        expect(await inbox(sa)).toEqual([{ message_id: opened.id, reason: 'protocol' }]);
        const since2 = mark();
        await reply(host.auth, opened.id, TURN('alpha'));
        expect(await inbox(sa)).toEqual([{ message_id: opened.id, reason: 'protocol' }]);
        expect(await notices(since2)).toEqual([NOTICE('alpha')]);
    });

    /** The terminal session as the agent strip gets it (/sessions), for `by`. */
    const terminalAs = async (by: { auth: object }) =>
        ((await cmd(by.auth, { command: 'sessions' })).body.sessions as any[]).find(s => s.kind === 'terminal' && s.state === 'live');

    it("the strip says why a terminal doesn't count as its owner: someone else's token, a mixed session, no owner", async () => {
        // Any token nobody else made counts: the agent host's token too
        await connectTerminal(beta, tokenOf(beta.auth));
        expect(await terminalAs(owner)).toMatchObject({ ownerToken: true, ownerTokenReason: null, ownedByYou: true });
        await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE kind = 'terminal'`);
        await connectTerminal(beta, await mint(beta, admin));
        expect(await terminalAs(owner)).toMatchObject({ ownerToken: false, ownerTokenReason: 'other_maker' });
        await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE kind = 'terminal'`);
        const mine = await mint(beta, owner);
        await connectTerminal(beta, mine);
        expect(await terminalAs(owner)).toMatchObject({ ownerToken: true, ownerTokenReason: null, ownedByYou: true });
        // Anyone who sees the session sees whether it counts; only the bot's owner is told it is theirs
        expect(await terminalAs(member)).toMatchObject({ ownerToken: true, ownedByYou: false });
        await connectTerminal(beta, tokenOf(beta.auth));
        expect(await terminalAs(owner)).toMatchObject({ ownerToken: false, ownerTokenReason: 'mixed' });
        await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE kind = 'terminal'`);
        await connectTerminal(beta, mine);
        await ctx.db.query(`UPDATE agent_sessions SET started_by = $1 WHERE kind = 'terminal' AND state = 'live'`, [director.userId]);
        expect(await terminalAs(owner)).toMatchObject({ ownerToken: false, ownerTokenReason: 'started_by_other' });
        await ctx.db.query('UPDATE users SET bot_owner_id = NULL WHERE id = $1', [beta.botId]);
        expect(await terminalAs(owner)).toMatchObject({ ownerToken: false, ownerTokenReason: 'other_bot_owner', ownedByYou: false });
        // Hosted sessions carry none of it
        await startSession(alpha);
        const hosted = ((await cmd(owner.auth, { command: 'sessions' })).body.sessions as any[]).find(s => s.kind === 'hosted');
        expect(hosted).not.toHaveProperty('ownerToken');
        expect(hosted).not.toHaveProperty('ownedByYou');
    });

    it("a token with no recorded maker (made before Agora recorded makers) doesn't count in owner_only; owner bots count it", async () => {
        const sa = await startSession(alpha);
        const mine = await mint(beta, owner);
        // As a token made before migration 090 left it: no maker on record
        await ctx.db.query(`UPDATE bot_tokens SET created_by = NULL, created_at = '2020-01-01T00:00:00Z' WHERE id = $1`, [mine.id]);
        await connectTerminal(beta, mine);
        await startSession(gamma);
        const opened = await post(gamma.auth, START('gamma', 'alpha', 'beta'));
        expect(await inbox(sa)).toEqual([{ message_id: opened.id, reason: 'protocol' }]);
        const since = mark();
        await reply(mine.auth, opened.id, TURN('alpha'));
        expect(await inbox(sa)).toEqual([{ message_id: opened.id, reason: 'protocol' }]);
        expect(await notices(since)).toEqual([NOTICE('alpha')]);
        // The default (owner bots) counts it as the bot's owner
        await ctx.db.query(`UPDATE servers SET subscription_wakes = 'owner_bots' WHERE id = $1`, [serverId]);
        const since2 = mark();
        const back = await reply(mine.auth, opened.id, TURN('alpha'));
        expect(await inbox(sa)).toEqual([{ message_id: opened.id, reason: 'protocol' }, { message_id: back.id, reason: 'handoff' }]);
        expect(await notices(since2)).toEqual([]);
    });

    it("a post with another token while the owner's terminal is live keeps the old rules", async () => {
        const sa = await startSession(alpha);
        const mine = await mint(beta, owner);
        const other = await mint(beta, owner);
        await connectTerminal(beta, mine);
        const start = await post(mine.auth, START('beta', 'alpha'));
        const before = await inbox(sa);
        // In the thread the terminal opened: a YIELD with the second token (or the host's) wakes nothing
        await reply(other.auth, start.id, TURN('alpha'));
        await reply(beta.auth, start.id, TURN('alpha'));
        // A START with it opens no thread
        const fresh = await post(other.auth, START('beta', 'alpha'));
        expect(await inbox(sa)).toEqual(before);
        expect(await boundThread(fresh.id)).toBeNull();
    });

    it('the same bot without a live terminal session (plain API posts) is refused as before', async () => {
        const sa = await startSession(alpha);
        const mine = await mint(beta, owner);
        const terminal = await connectTerminal(beta, mine);
        const start = await post(mine.auth, START('beta', 'alpha'));
        await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE id = $1`, [terminal]);
        const before = await inbox(sa);
        await reply(mine.auth, start.id, TURN('alpha'));
        const fresh = await post(mine.auth, START('beta', 'alpha'));
        expect(await inbox(sa)).toEqual(before);
        expect(await boundThread(fresh.id)).toBeNull();
    });

    it('sockets with two different tokens on one terminal session: no token counts, even when the first reconnects', async () => {
        const sa = await startSession(alpha);
        const mine = await mint(beta, owner);
        const session = await connectTerminal(beta, mine);
        await connectTerminal(beta, tokenOf(beta.auth));
        await connectTerminal(beta, mine);
        const row = (await ctx.db.query('SELECT token_id, token_mixed FROM agent_sessions WHERE id = $1', [session])).rows[0];
        expect(row).toEqual({ token_id: null, token_mixed: true });
        const since = mark();
        await post(mine.auth, START('beta', 'alpha'));
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([]);
    });

    it('a terminal session live before the token was recorded adopts the next attaching token', async () => {
        const sa = await startSession(alpha);
        const mine = await mint(beta, owner);
        // As a session live at deploy: no token recorded
        const session = (await attachTerminal(ctx.db, beta.botId, [channelId], 'mcp', false, null)).attached[0].sessionId;
        expect(await connectTerminal(beta, mine)).toBe(session);
        const row = (await ctx.db.query('SELECT token_id, token_mixed FROM agent_sessions WHERE id = $1', [session])).rows[0];
        expect({ token: row.token_id?.trim(), mixed: row.token_mixed }).toEqual({ token: mine.id, mixed: false });
        const start = await post(mine.auth, START('beta', 'alpha'));
        expect(await inbox(sa)).toEqual([{ message_id: start.id, reason: 'protocol' }]);
    });

    it("an API-key target: a token an Administrator minted doesn't borrow the bot owner's authority to open a thread", async () => {
        await setHostKind(ctx.db, hostId, 'box');
        await setMode(alpha, 'api_key');
        const sa = await startSession(alpha, director.userId);
        // The admin can't direct agents (Administrator doesn't imply DirectAgents); the owner can
        const adminMinted = await mint(beta, admin);
        await connectTerminal(beta, adminMinted);
        const since = mark();
        const refused = await post(adminMinted.auth, START('beta', 'alpha'));
        expect(await boundThread(refused.id)).toBeNull();
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([]);
        // The same bot on a token the owner minted opens it
        await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE kind = 'terminal'`);
        const mine = await mint(beta, owner);
        await connectTerminal(beta, mine);
        const start = await post(mine.auth, START('beta', 'alpha'));
        expect(await inbox(sa)).toEqual([{ message_id: start.id, reason: 'protocol' }]);
    });

    it("another user's bot in a terminal session, on a token its owner minted, is refused with a notice", async () => {
        await ctx.db.query('UPDATE users SET bot_owner_id = $2 WHERE id = $1', [gamma.botId, director.userId]);
        const sa = await startSession(alpha);
        const theirs = await mint(gamma, director);
        await connectTerminal(gamma, theirs);
        const since = mark();
        const start = await post(theirs.auth, START('gamma', 'alpha'));
        expect(await boundThread(start.id)).toBe('open'); // the director may direct agents here
        await reply(theirs.auth, start.id, TURN('alpha'));
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha'), NOTICE('alpha')]);
    });

    it('a target the owner did not start, or a hosted author the owner did not start, is still refused', async () => {
        const sa = await startSession(alpha, director.userId);
        const mine = await mint(beta, owner);
        await connectTerminal(beta, mine);
        const since = mark();
        await post(mine.auth, START('beta', 'alpha'));
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha')]);

        await ctx.db.query('TRUNCATE agent_inbox, agent_session_threads, agent_sessions CASCADE');
        const sa2 = await startSession(alpha);
        await startSession(gamma, director.userId);
        const since2 = mark();
        await post(gamma.auth, START('gamma', 'alpha'));
        expect(await inbox(sa2)).toEqual([]);
        expect(await notices(since2)).toEqual([NOTICE('alpha')]);
    });

    it("an API-key target: a non-director's terminal bot's START wakes nothing; a director's does", async () => {
        await setHostKind(ctx.db, hostId, 'box');
        await setMode(alpha, 'api_key');
        const sa = await startSession(alpha, director.userId);
        // A member without DirectAgents owns the bot from the start
        await ctx.db.query('UPDATE users SET bot_owner_id = $2 WHERE id = $1', [gamma.botId, member.userId]);
        const memberToken = await mint(gamma, member);
        await connectTerminal(gamma, memberToken);
        const since = mark();
        const refused = await post(memberToken.auth, START('gamma', 'alpha'));
        expect(await boundThread(refused.id)).toBeNull();
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([]);

        await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE kind = 'terminal'`);
        await ctx.db.query('UPDATE users SET bot_owner_id = $2 WHERE id = $1', [gamma.botId, director.userId]);
        const directorToken = await mint(gamma, director);
        await connectTerminal(gamma, directorToken);
        const start = await post(directorToken.auth, START('gamma', 'alpha'));
        const back = await reply(directorToken.auth, start.id, TURN('alpha'));
        expect(await inbox(sa)).toEqual([{ message_id: start.id, reason: 'protocol' }, { message_id: back.id, reason: 'handoff' }]);
        expect(await notices(since)).toEqual([]);
    });

    it("a handoff offer from the owner's terminal agent on its token reaches an owner-started subscription agent; others are refused", async () => {
        await startSession(alpha);
        const mine = await mint(beta, owner);
        await connectTerminal(beta, mine);
        const parent = await post(owner.auth, 'Fix the flaky upload test');
        const offerAs = (auth: object) => ctx.request.post(`/channels/${channelId}/handoffs`).set(auth).send({ threadId: parent.id, to: 'alpha', summary: 'x' });
        // The bot's host token while the owner's terminal is live
        const otherToken = await offerAs(beta.auth);
        expect(otherToken.status).toBe(403);
        expect(otherToken.body.error).toBe('plan_owner_only');
        const ok = await offerAs(mine.auth);
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        await ctx.request.post(`/channels/${channelId}/handoffs/${ok.body.offer.id}`).set(owner.auth).send({ action: 'cancel' });

        // A bot the director owns from the start, in a terminal on a token the director minted
        await ctx.db.query('UPDATE users SET bot_owner_id = $2 WHERE id = $1', [gamma.botId, director.userId]);
        const theirs = await mint(gamma, director);
        await connectTerminal(gamma, theirs);
        const refused = await offerAs(theirs.auth);
        expect(refused.status).toBe(403);
        expect(refused.body.error).toBe('plan_owner_only');
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
        const s = await startSession(alpha);
        await post(owner.auth, '@alpha do the thing');
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

/**
 * beta-test-plan §6.1 "Subscription profiles are owner-only": a refusal changes nothing (no
 * session row, no wake, nothing to claim), and a director's approve-once on a subscription
 * agent is kept for the owner's next run.
 */
describe('beta §6.1: subscription refusals leave nothing behind', () => {
    const sessionsOf = async (agent: Agent) =>
        (await ctx.db.query(`SELECT count(*)::int AS n FROM agent_sessions WHERE profile_id = $1`, [agent.profileId])).rows[0].n;

    it('a refused /start creates no session, no wake and no run', async () => {
        const byDirector = await cmd(director.auth, { command: 'start', profile: 'alpha' });
        expect(byDirector.status).toBe(403);
        expect(byDirector.body.error).toBe('subscription_owner_only');
        const byMember = await cmd(member.auth, { command: 'start', profile: 'alpha' });
        expect(byMember.status).toBe(403);
        expect(byMember.body.error).toBe('cannot_direct');
        expect(await sessionsOf(alpha)).toBe(0);
        expect((await ctx.db.query(`SELECT count(*)::int AS n FROM agent_inbox`)).rows[0].n).toBe(0);
        expect((await ctx.db.query(`SELECT count(*)::int AS n FROM agent_runs`)).rows[0].n).toBe(0);
        expect((await claim()).status).toBe(204);
    });

    it('a refused /resume leaves the session shelved and the owner\'s, with no wake', async () => {
        const s = await startSession(alpha);
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved', end_reason = 'user' WHERE id = $1`, [s]);
        const byDirector = await cmd(director.auth, { command: 'resume', sessionId: s });
        expect(byDirector.status).toBe(403);
        expect(byDirector.body.error).toBe('subscription_owner_only');
        const byMember = await cmd(member.auth, { command: 'resume', sessionId: s });
        expect(byMember.status).toBe(403);
        expect(byMember.body.error).toBe('cannot_direct');
        const row = (await ctx.db.query(`SELECT state, started_by FROM agent_sessions WHERE id = $1`, [s])).rows[0];
        expect(row.state).toBe('shelved');
        expect(row.started_by.trim()).toBe(owner.userId);
        expect(await inbox(s)).toEqual([]);
        expect((await claim()).status).toBe(204);
    });

    it('a director\'s approve-once wakes nothing and is granted to the owner\'s next run', async () => {
        const s = await startSession(alpha);
        const id = generateUlid();
        await ctx.db.query(`INSERT INTO agent_tool_requests (id, server_id, session_id, profile_id, tool) VALUES ($1, $2, $3, $4, 'Bash(gh:*)')`,
            [id, serverId, s, alpha.profileId]);
        const res = await ctx.request.post(`/channels/${channelId}/agent-tool-requests/${id}`).set(director.auth).send({ decision: 'once' });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.status).toBe('once');
        expect(await inbox(s)).toEqual([]);
        expect((await claim()).status).toBe(204);

        await post(owner.auth, '@alpha retry the release step');
        const c = await claim();
        expect(c.status).toBe(200);
        expect(c.body.run.grantedTools).toEqual(['Bash(gh:*)']);
    });
});
