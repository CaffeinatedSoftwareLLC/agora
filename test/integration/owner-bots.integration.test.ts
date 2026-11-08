import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase, setHostKind } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { attachTerminal } from '../../src/lib/terminal-sessions';

/**
 * Owner bots (docs/provider-terms.md, src/lib/provider-terms.ts ownerBotOf): with the server's
 * subscription_wakes 'owner_bots' (the default), the plan owner's own bots wake the owner's
 * subscription agents for every reason (direct and @mentions, replies in collaboration and
 * task card threads, START/YIELD/WAIT, handoff offers, lurk), like the owner opening several
 * CLIs on their own account. Their own bot means: users.bot_owner_id is the plan owner, the
 * post's token was made by the owner or by Agora (any purpose), and it isn't a run someone else
 * started. Other people, their bots, the owner's bot on a token someone else made, and runs
 * someone else started are refused with a notice. 'owner_only' is the stricter #361 rule
 * (provider-terms.integration.test.ts covers it in depth).
 */

const DIRECT = (1n << 29n).toString();
const ADMINISTRATOR = (1n << 0n).toString();
const NOTICE = (agent: string) => `${agent} runs on the owner's personal subscription; ask the owner, or configure an API key profile.`;

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let director: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let admin: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let hostAuth: { Authorization: string };
let hostId: string;
type Agent = { botId: string; profileId: string; auth: { Authorization: string }; name: string };
type Token = { id: string; auth: { Authorization: string } };
/** alpha: the owner's subscription agent being woken. beta: the owner's own bot. gamma: the director's bot. */
let alpha: Agent;
let beta: Agent;
let gamma: Agent;

async function makeAgent(name: string): Promise<Agent> {
    const res = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
        .send({ hostModeAck: true, name, adapter: 'claude', hostId, workdirAlias: 'agora', channelId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { botId: res.body.bot.id, profileId: res.body.profile.id, auth: { Authorization: `Bot ${res.body.token}` }, name };
}

async function setMode(agent: Agent, mode: 'subscription' | 'api_key') {
    await ctx.db.query(`UPDATE agent_profiles SET auth_mode = $2, api_key_env = $3, run_approval = false WHERE id = $1`,
        [agent.profileId, mode, mode === 'api_key' ? 'ANTHROPIC_API_KEY' : null]);
}

async function startSession(agent: Agent, startedBy: string | null = owner.userId, extra: { lurk?: string; threadId?: string; parent?: string } = {}): Promise<string> {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by, lurk_mode, thread_id, parent_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, serverId, channelId, agent.botId, agent.profileId, startedBy, extra.lurk ?? null, extra.threadId ?? null, extra.parent ?? null]
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

/** System notices posted since `since` (a message id), oldest first, top level and in threads. */
async function notices(since: string): Promise<string[]> {
    const rows = await ctx.db.query(
        `SELECT content FROM messages WHERE channel_id = $1 AND author_id IS NULL AND system_event = 'agent_session' AND id > $2 ORDER BY id`,
        [channelId, since]);
    return rows.rows.map((r: any) => r.content);
}

/** A personal token for the bot, minted by `by`. */
async function mint(agent: Agent, by: { auth: object }): Promise<Token> {
    const res = await ctx.request.post(`/servers/${serverId}/bots/${agent.botId}/tokens`).set(by.auth).send({ name: 'my terminal' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.tokenId, auth: { Authorization: `Bot ${res.body.token}` } };
}
const tokenOf = (auth: { Authorization: string }): Token => ({ id: auth.Authorization.slice('Bot bot_'.length).split('.')[0], auth });
const connectTerminal = async (agent: Agent, token: Token) =>
    (await attachTerminal(ctx.db, agent.botId, [channelId], 'mcp', false, token.id)).attached[0].sessionId;
/** The server owner lets the bot direct agents in the channel (bot_channel_access.can_direct). */
async function canDirect(agent: Agent) {
    const res = await ctx.db.query('UPDATE bot_channel_access SET can_direct = true WHERE bot_id = $1 AND channel_id = $2', [agent.botId, channelId]);
    expect(res.rowCount).toBe(1);
}

const claim = () => ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
const mark = () => generateUlid();
const START = (...names: string[]) => `[AGORA/v1 MODE=plan STATE=START]\nparticipants: [${names.join(', ')}]\ntask: x`;
const TURN = (to: string) => `[AGORA/v1 MODE=plan STATE=TURN]\nyour turn\n[YIELD to=${to}]`;
const setting = (auth: object, body?: object) => body === undefined
    ? ctx.request.get(`/servers/${serverId}/agent-settings`).set(auth)
    : ctx.request.patch(`/servers/${serverId}/agent-settings`).set(auth).send(body);

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'obowner');
    const server = await createServer(ctx.request, owner.auth, 'Owner Bots');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    director = await authedUser(ctx.request, 'obdirector');
    member = await authedUser(ctx.request, 'obmember');
    admin = await authedUser(ctx.request, 'obadmin');
    for (const u of [director, member, admin]) await joinViaInvite(ctx.request, owner.auth, u.auth, serverId);
    const directRole = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Orchestrator', permissions: DIRECT });
    await ctx.request.put(`/servers/${serverId}/members/${director.userId}/roles/${directRole.body.id}`).set(owner.auth);
    const adminRole = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Admins', permissions: ADMINISTRATOR });
    await ctx.request.put(`/servers/${serverId}/members/${admin.userId}/roles/${adminRole.body.id}`).set(owner.auth);
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 1000, max_bot_hops = 1000, max_thread_bot_hops = 0 WHERE id = $1', [channelId]);

    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
    hostAuth = { Authorization: `AgentHost ${host.body.token}` };
    hostId = host.body.host.id;
    alpha = await makeAgent('alpha');
    beta = await makeAgent('beta');
    gamma = await makeAgent('gamma');
    await canDirect(beta);
    await canDirect(gamma);
});

afterAll(async () => { await ctx.close(); });

beforeEach(async () => {
    await ctx.db.query('TRUNCATE agent_handoffs, agent_thread_owners, agent_runs, agent_inbox, agent_batches, agent_session_threads, agent_sessions CASCADE');
    for (const a of [alpha, beta, gamma]) await setMode(a, 'subscription');
    await setHostKind(ctx.db, hostId, 'machine');
    await ctx.db.query(`UPDATE servers SET subscription_wakes = 'owner_bots' WHERE id = $1`, [serverId]);
    await ctx.db.query('UPDATE users SET bot_owner_id = $2 WHERE id = ANY($1)', [[alpha.botId, beta.botId], owner.userId]);
    await ctx.db.query('UPDATE users SET bot_owner_id = $2 WHERE id = $1', [gamma.botId, director.userId]);
});

describe('owner bots wake the owner\'s subscription agents', () => {
    it('the setting defaults to owner_bots', async () => {
        const res = await setting(member.auth);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ subscriptionWakes: 'owner_bots' });
    });

    it('an owner-started hosted session of the owner\'s bot: @mention, a plain reply in a collaboration thread, and a YIELD all wake it; the claim marks them ownerBot', async () => {
        const sa = await startSession(alpha);
        await startSession(beta);
        const since = mark();
        const mention = await post(beta.auth, '@alpha check the build');
        const start = await post(beta.auth, START('beta', 'alpha'));
        const plain = await reply(beta.auth, start.id, 'also look at the flaky upload test');
        const yielded = await reply(beta.auth, start.id, TURN('alpha'));
        expect(await inbox(sa)).toEqual([
            { message_id: mention.id, reason: 'direct' }, { message_id: start.id, reason: 'protocol' },
            { message_id: plain.id, reason: 'direct' }, { message_id: yielded.id, reason: 'handoff' },
        ]);
        expect(await notices(since)).toEqual([]);
        const c = await claim();
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        expect(c.body.session.startedByOwner).toBe(true);
        expect(c.body.inbox.map((i: any) => [i.reason, i.authorBot, i.ownerBot])).toEqual([
            ['direct', true, true], ['protocol', true, true], ['direct', true, true], ['handoff', true, true],
        ]);
        expect(c.body.inbox[0].authority).toBe('director');
    });

    it('an owner bot\'s post wakes a subscription lurker; a director\'s and another person\'s bot\'s don\'t', async () => {
        const sa = await startSession(alpha, owner.userId, { lurk: 'balanced' });
        await startSession(beta);
        await startSession(gamma);
        const since = mark();
        await post(director.auth, 'chatter from a director');
        await post(gamma.auth, 'chatter from the director\'s bot');
        const mine = await post(beta.auth, 'chatter from the owner\'s bot');
        expect(await inbox(sa)).toEqual([{ message_id: mine.id, reason: 'lurk' }]);
        expect(await notices(since)).toEqual([]);
    });

    it('the owner\'s bot on a token with no recorded maker (legacy, or made by Agora) wakes it', async () => {
        const sa = await startSession(alpha);
        const legacy = await mint(beta, owner);
        await ctx.db.query(`UPDATE bot_tokens SET created_by = NULL, created_at = '2020-01-01T00:00:00Z' WHERE id = $1`, [legacy.id]);
        const since = mark();
        const m = await post(legacy.auth, '@alpha run the tests');
        expect(await inbox(sa)).toEqual([{ message_id: m.id, reason: 'direct' }]);
        expect(await notices(since)).toEqual([]);
    });

    it('the owner\'s terminal agent wakes it with an @mention, a START and a YIELD', async () => {
        const sa = await startSession(alpha);
        const mine = await mint(beta, owner);
        await connectTerminal(beta, mine);
        const since = mark();
        const m = await post(mine.auth, '@alpha please review my branch');
        const start = await post(mine.auth, START('beta', 'alpha'));
        const back = await reply(mine.auth, start.id, TURN('alpha'));
        expect(await inbox(sa)).toEqual([
            { message_id: m.id, reason: 'direct' }, { message_id: start.id, reason: 'protocol' }, { message_id: back.id, reason: 'handoff' },
        ]);
        expect(await notices(since)).toEqual([]);
    });

    it('a task card\'s thread: an owner bot\'s message wakes its subscription session', async () => {
        const parent = await post(owner.auth, 'Task: fix the upload test');
        const card = await startSession(alpha, owner.userId, { threadId: parent.id });
        await startSession(beta);
        const since = mark();
        const r = await reply(beta.auth, parent.id, 'here is the stack trace');
        expect(await inbox(card)).toEqual([{ message_id: r.id, reason: 'direct' }]);
        expect(await notices(since)).toEqual([]);
    });

    it('a handoff offer from the owner\'s bot reaches an owner-started subscription agent and can be accepted', async () => {
        const sa = await startSession(alpha);
        await startSession(beta);
        const parent = await post(owner.auth, 'Fix the flaky upload test');
        const offer = await ctx.request.post(`/channels/${channelId}/handoffs`).set(beta.auth).send({ threadId: parent.id, to: 'alpha', summary: 'x' });
        expect(offer.status, JSON.stringify(offer.body)).toBe(201);
        expect((await inbox(sa)).map(r => r.reason)).toEqual(['handoff']);
        const accept = await ctx.request.post(`/channels/${channelId}/handoffs/${offer.body.offer.id}`).set(alpha.auth).send({ action: 'accept' });
        expect(accept.status, JSON.stringify(accept.body)).toBe(200);
    });
});

describe('everyone else is refused', () => {
    it('another person\'s bot, even in a session the owner started: @mention, START and YIELD get a notice', async () => {
        const sa = await startSession(alpha);
        await startSession(gamma);
        const since = mark();
        await post(gamma.auth, '@alpha deploy it');
        const start = await post(gamma.auth, START('gamma', 'alpha'));
        await reply(gamma.auth, start.id, TURN('alpha'));
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha'), NOTICE('alpha'), NOTICE('alpha')]);
        // The same in a terminal on its owner's own token
        const theirs = await mint(gamma, director);
        await connectTerminal(gamma, theirs);
        const since2 = mark();
        await post(theirs.auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since2)).toEqual([NOTICE('alpha')]);
    });

    it('the owner\'s bot on a token an Administrator minted is refused, in a terminal or not', async () => {
        const sa = await startSession(alpha);
        const adminMinted = await mint(beta, admin);
        const since = mark();
        await post(adminMinted.auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha')]);
        await connectTerminal(beta, adminMinted);
        await startSession(gamma);
        const since2 = mark();
        await post(adminMinted.auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since2)).toEqual([NOTICE('alpha')]);
    });

    it('the owner\'s bot in a hosted run a director started is refused, and so is a subtask under it; its owner\'s terminal still counts', async () => {
        const sa = await startSession(alpha);
        const directors = await startSession(beta, director.userId);
        const since = mark();
        await post(beta.auth, '@alpha deploy it');
        await post(beta.auth, START('beta', 'alpha'));
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha'), NOTICE('alpha')]);

        // A subtask's session carries its parent's starter (routes/subtasks.ts)
        await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE id = $1`, [directors]);
        const parentSession = await startSession(gamma, director.userId);
        const brief = await post(owner.auth, 'subtask thread');
        await startSession(beta, director.userId, { threadId: brief.id, parent: parentSession });
        const since2 = mark();
        await post(beta.auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since2)).toEqual([NOTICE('alpha')]);

        // The owner's own terminal on the owner's token is its own source: it counts
        const mine = await mint(beta, owner);
        await connectTerminal(beta, mine);
        const m = await post(mine.auth, '@alpha now you');
        expect(await inbox(sa)).toEqual([{ message_id: m.id, reason: 'direct' }]);
    });

    it('a terminal session shared by two tokens (mixed) doesn\'t count', async () => {
        const sa = await startSession(alpha);
        const mine = await mint(beta, owner);
        await connectTerminal(beta, mine);
        await connectTerminal(beta, tokenOf(beta.auth));
        const since = mark();
        await post(mine.auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha')]);
    });

    it('a target someone else started gets nothing from the owner\'s bot', async () => {
        const sa = await startSession(alpha, director.userId);
        await startSession(beta);
        const since = mark();
        await post(beta.auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha')]);
    });

    it('handoff offers: another person\'s bot and an Administrator-minted token are refused; accepting rechecks who started the sender', async () => {
        const sa = await startSession(alpha);
        const sb = await startSession(beta);
        await startSession(gamma);
        const parent = await post(owner.auth, 'Fix the flaky upload test');
        const offerAs = (auth: object) => ctx.request.post(`/channels/${channelId}/handoffs`).set(auth).send({ threadId: parent.id, to: 'alpha', summary: 'x' });
        const theirs = await offerAs(gamma.auth);
        expect(theirs.status).toBe(403);
        expect(theirs.body.error).toBe('plan_owner_only');
        const adminMinted = await offerAs((await mint(beta, admin)).auth);
        expect(adminMinted.status).toBe(403);
        expect(adminMinted.body.error).toBe('plan_owner_only');
        expect(await inbox(sa)).toEqual([]);

        const ok = await offerAs(beta.auth);
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        await ctx.db.query('UPDATE agent_sessions SET started_by = $2 WHERE id = $1', [sb, director.userId]);
        const accept = await ctx.request.post(`/channels/${channelId}/handoffs/${ok.body.offer.id}`).set(alpha.auth).send({ action: 'accept' });
        expect(accept.status).toBe(403);
        expect(accept.body.error).toBe('plan_owner_only');
    });
});

describe('the subscription_wakes setting', () => {
    it('only the server owner changes it, with an audit entry; bad values are refused', async () => {
        expect((await setting(director.auth, { subscriptionWakes: 'owner_only' })).status).toBe(403);
        expect((await setting(admin.auth, { subscriptionWakes: 'owner_only' })).status).toBe(403);
        expect((await setting(beta.auth, { subscriptionWakes: 'owner_only' })).status).toBe(403);
        expect((await setting(owner.auth, { subscriptionWakes: 'everyone' })).status).toBe(400);
        expect((await setting(owner.auth, {})).status).toBe(400);
        const res = await setting(owner.auth, { subscriptionWakes: 'owner_only' });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toEqual({ subscriptionWakes: 'owner_only' });
        expect((await setting(member.auth)).body).toEqual({ subscriptionWakes: 'owner_only' });
        const audit = await ctx.db.query(`SELECT actor_id, changes FROM audit_log WHERE action = 'agent_settings_update' AND server_id = $1`, [serverId]);
        expect(audit.rows.map((r: any) => ({ actor: r.actor_id.trim(), ...r.changes }))).toEqual([
            { actor: owner.userId, subscriptionWakes: 'owner_only', previous: 'owner_bots' },
        ]);
    });

    it('owner_only: only the owner\'s own message wakes it directly; owner bots get a notice; #361 hand-offs still work', async () => {
        expect((await setting(owner.auth, { subscriptionWakes: 'owner_only' })).status).toBe(200);
        const sa = await startSession(alpha);
        await startSession(beta);
        const since = mark();
        await post(beta.auth, '@alpha check the build');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha')]);
        const mine = await post(owner.auth, '@alpha check the build');
        expect(await inbox(sa)).toEqual([{ message_id: mine.id, reason: 'direct' }]);
        // Hand-offs between sessions the owner started (#361) still route
        const start = await post(beta.auth, START('beta', 'alpha'));
        expect((await inbox(sa)).map(r => r.reason)).toEqual(['direct', 'protocol']);
        const c = await claim();
        expect(c.status).toBe(200);
        expect(c.body.inbox.map((i: any) => [i.messageId, i.ownerBot])).toEqual([[mine.id, false], [start.id, false]]);
    });

    it('switching to owner_only drops an owner bot\'s pending direct wake at claim', async () => {
        const sa = await startSession(alpha);
        await startSession(beta);
        await post(beta.auth, '@alpha check the build');
        expect(await inbox(sa)).toHaveLength(1);
        expect((await setting(owner.auth, { subscriptionWakes: 'owner_only' })).status).toBe(200);
        expect((await claim()).status).toBe(204);
        expect(await inbox(sa)).toEqual([]);
    });

    it('an API-key target on a box host is unchanged: another person\'s bot still wakes it, in either setting', async () => {
        await setHostKind(ctx.db, hostId, 'box');
        await setMode(alpha, 'api_key');
        const sa = await startSession(alpha, director.userId);
        await startSession(gamma, director.userId);
        const since = mark();
        const m = await post(gamma.auth, '@alpha deploy it');
        expect(await setting(owner.auth, { subscriptionWakes: 'owner_only' })).toMatchObject({ status: 200 });
        const m2 = await post(gamma.auth, '@alpha and again');
        expect(await inbox(sa)).toEqual([{ message_id: m.id, reason: 'direct' }, { message_id: m2.id, reason: 'direct' }]);
        expect(await notices(since)).toEqual([]);
        const c = await claim();
        expect(c.status).toBe(200);
        expect(c.body.inbox[0]).not.toHaveProperty('ownerBot');
    });
});
