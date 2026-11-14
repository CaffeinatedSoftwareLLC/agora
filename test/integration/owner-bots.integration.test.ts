import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase, setHostKind } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { attachTerminal } from '../../src/lib/terminal-sessions';
import { generateBotToken } from '../../src/auth/bot-tokens';
import { ownerOnlyNotice, startedByNotice } from '../../src/lib/provider-terms';

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
/** delta: another of the owner's bots, without can_direct (no extra setup). */
let delta: Agent;

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

/** Bot-triggered notices are deduplicated for ten minutes: forget the earlier ones to see the same notice again. */
const forgetNotices = () => ctx.db.query(`DELETE FROM messages WHERE channel_id = $1 AND author_id IS NULL AND system_event = 'agent_session'`, [channelId]);
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
    delta = await makeAgent('delta');
    await canDirect(beta);
    await canDirect(gamma);
});

afterAll(async () => { await ctx.close(); });

beforeEach(async () => {
    // Bot-triggered notices are deduplicated for ten minutes (channel, thread, text): each test starts without earlier ones
    await ctx.db.query(`DELETE FROM messages WHERE channel_id = $1 AND author_id IS NULL AND system_event = 'agent_session'`, [channelId]);
    await ctx.db.query('TRUNCATE agent_handoffs, agent_thread_owners, agent_runs, agent_inbox, agent_batches, agent_session_threads, agent_sessions CASCADE');
    for (const a of [alpha, beta, gamma, delta]) await setMode(a, 'subscription');
    await setHostKind(ctx.db, hostId, 'machine');
    await ctx.db.query(`UPDATE servers SET subscription_wakes = 'owner_bots' WHERE id = $1`, [serverId]);
    await ctx.db.query('UPDATE users SET bot_owner_id = $2 WHERE id = ANY($1)', [[alpha.botId, beta.botId, delta.botId], owner.userId]);
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

/**
 * The owner's own bots need no extra setup: without can_direct they still address the owner's
 * plan-owned agents (@mention, task card thread, the sole agent here). Every other target keeps
 * the plain authority rule.
 */
describe('owner bots without can_direct', () => {
    it('an @mention wakes an owner-started subscription agent, and the claim keeps it (ownerBot, no authority)', async () => {
        const sa = await startSession(alpha);
        await startSession(delta);
        const since = mark();
        const m = await post(delta.auth, '@alpha please review');
        expect(await inbox(sa)).toEqual([{ message_id: m.id, reason: 'direct' }]);
        expect(await notices(since)).toEqual([]);
        const c = await claim();
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        expect(c.body.inbox).toEqual([expect.objectContaining({ messageId: m.id, reason: 'direct', authorBot: true, authority: null, ownerBot: true })]);
    });

    it('a task card thread and the sole live agent are reached too; an @mention in an ordinary thread as well', async () => {
        // A personal token: an agent host token counts only with an owner-only hosted run behind it
        const mine = await mint(delta, owner);
        const parent = await post(owner.auth, 'Task: fix the upload test');
        const card = await startSession(alpha, owner.userId, { threadId: parent.id });
        const r = await reply(mine.auth, parent.id, 'here is the stack trace');
        expect(await inbox(card)).toEqual([{ message_id: r.id, reason: 'direct' }]);

        // delta posts with no session of its own: alpha's channel session is the only agent live here
        const sa = await startSession(alpha);
        const sole = await post(mine.auth, 'anyone there?');
        expect(await inbox(sa)).toEqual([{ message_id: sole.id, reason: 'direct' }]);
        const inThread = await reply(mine.auth, sole.id, '@alpha this one');
        expect((await inbox(sa)).map(x => x.message_id)).toEqual([sole.id, inThread.id]);
    });

    it('a plain reply in an ordinary thread still wakes nobody (no bot-to-bot chains)', async () => {
        const sa = await startSession(alpha);
        await startSession(delta);
        const parent = await post(alpha.auth, 'Opened the PR, details here');
        await reply(delta.auth, parent.id, 'looks good to me');
        expect(await inbox(sa)).toEqual([]);
    });

    it("an API-key agent is reached too: a bot that counts as the owner has the owner's authority for the post, and the claim marks it", async () => {
        await setHostKind(ctx.db, hostId, 'box');
        await setMode(alpha, 'api_key');
        const sa = await startSession(alpha);
        await startSession(delta);
        const mine = await mint(delta, owner);
        const since = mark();
        const m = await post(mine.auth, '@alpha please review');
        expect(await inbox(sa)).toEqual([{ message_id: m.id, reason: 'direct' }]);
        expect(await notices(since)).toEqual([]);
        // The post keeps its own stamp: agents are never shown [OWNER] or [DIRECTOR] for it
        const stamp = await ctx.db.query('SELECT author_could_direct FROM messages WHERE id = $1', [m.id]);
        expect(stamp.rows[0].author_could_direct).toBe(false);
        const c = await claim();
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        expect(c.body.inbox.map((i: any) => [i.authorBot, i.authority, i.ownerBot])).toEqual([[true, null, true]]);
    });

    it('owner_only: no reach without can_direct', async () => {
        await ctx.db.query(`UPDATE servers SET subscription_wakes = 'owner_only' WHERE id = $1`, [serverId]);
        const sa = await startSession(alpha);
        await startSession(delta);
        await post(delta.auth, '@alpha please review');
        expect(await inbox(sa)).toEqual([]);
    });

    it("another person's bot without can_direct reaches nothing; with it, it is refused with a notice", async () => {
        const sa = await startSession(alpha);
        await startSession(gamma);
        await ctx.db.query('UPDATE bot_channel_access SET can_direct = false WHERE bot_id = $1 AND channel_id = $2', [gamma.botId, channelId]);
        const since = mark();
        await post(gamma.auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([]);
        await canDirect(gamma);
        await post(gamma.auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha')]);
    });
});

describe('everyone else is refused', () => {
    it('another person\'s bot in a session they started: @mention, START and YIELD get a notice', async () => {
        const sa = await startSession(alpha);
        await startSession(gamma, director.userId);
        const since = mark();
        await post(gamma.auth, '@alpha deploy it');
        const start = await post(gamma.auth, START('gamma', 'alpha'));
        await reply(gamma.auth, start.id, TURN('alpha'));
        expect(await inbox(sa)).toEqual([]);
        // The same refusal is said once in the channel and once in the thread (bot notices are deduplicated per place for ten minutes)
        expect(await notices(since)).toEqual([NOTICE('alpha'), NOTICE('alpha')]);
        // The same in a terminal on its owner's own token
        const theirs = await mint(gamma, director);
        await connectTerminal(gamma, theirs);
        await forgetNotices();
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
        expect(await notices(since)).toEqual(["beta is obowner's bot, but its messages don't count as obowner's, so they can't wake alpha: this token was made by obadmin, not obowner; obowner should make a new personal token for the bot (Settings → Agents) and connect with it."]);
        await connectTerminal(beta, adminMinted);
        await startSession(gamma);
        await forgetNotices();
        const since2 = mark();
        await post(adminMinted.auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since2)).toEqual(["beta is obowner's bot, but its messages don't count as obowner's, so they can't wake alpha: this token was made by obadmin, not obowner; obowner should make a new personal token for the bot (Settings → Agents) and connect with it."]);
    });

    it('the owner\'s bot in a hosted run a director started is refused, and so is a subtask under it; its owner\'s terminal still counts', async () => {
        const sa = await startSession(alpha);
        const directors = await startSession(beta, director.userId);
        const since = mark();
        await post(beta.auth, '@alpha deploy it');
        await post(beta.auth, START('beta', 'alpha'));
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha')]);

        // A subtask's session carries its parent's starter (routes/subtasks.ts)
        await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE id = $1`, [directors]);
        const parentSession = await startSession(gamma, director.userId);
        const brief = await post(owner.auth, 'subtask thread');
        await startSession(beta, director.userId, { threadId: brief.id, parent: parentSession });
        await forgetNotices();
        const since2 = mark();
        await post(beta.auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since2)).toEqual([NOTICE('alpha')]);

        // Its agent host token in a terminal (any token can open one) is still that run's: refused
        const hostTerminal = await connectTerminal(beta, tokenOf(beta.auth));
        await forgetNotices();
        const since3 = mark();
        await post(beta.auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since3)).toEqual([NOTICE('alpha')]);
        await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE id = $1`, [hostTerminal]);

        // The owner's own terminal on the owner's personal token is its own source: it counts
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
        expect(await notices(since)).toEqual(["beta is obowner's bot, but its messages don't count as obowner's, so they can't wake alpha: two different tokens share this bot's terminal session; close the terminal and reconnect with only the new token."]);
    });

    it('a target someone else started gets nothing from the owner\'s bot', async () => {
        const sa = await startSession(alpha, director.userId);
        await startSession(beta);
        const since = mark();
        await post(beta.auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([startedByNotice('alpha', 'obowner', 'obdirector')]);
    });

    it('handoff offers: another person\'s bot in its own session is refused; accepting rechecks who started the sender', async () => {
        const sa = await startSession(alpha);
        const sb = await startSession(beta);
        await startSession(gamma, director.userId);
        const parent = await post(owner.auth, 'Fix the flaky upload test');
        const offerAs = (auth: object) => ctx.request.post(`/channels/${channelId}/handoffs`).set(auth).send({ threadId: parent.id, to: 'alpha', summary: 'x' });
        const theirs = await offerAs(gamma.auth);
        expect(theirs.status).toBe(403);
        expect(theirs.body.error).toBe('plan_owner_only');
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
        expect(await notices(since)).toEqual([ownerOnlyNotice('beta', 'alpha', 'obowner')]);
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

/** A token of the bot with this purpose and maker, as the server makes them (model agents, boxes). */
async function tokenWith(agent: Agent, purpose: 'model' | 'box' | 'host' | 'invite', createdBy: string | null): Promise<Token> {
    const { tokenId, secretHash, raw } = await generateBotToken();
    await ctx.db.query(`INSERT INTO bot_tokens (id, bot_id, secret_hash, name, created_by, purpose) VALUES ($1, $2, $3, $4, $5, $6)`,
        [tokenId, agent.botId, secretHash, purpose, createdBy, purpose]);
    return { id: tokenId, auth: { Authorization: `Bot ${raw}` } };
}

/**
 * No relay through runs others can cause: a model agent answers any member, and an API-key
 * agent's hosted run can be woken by a director, so neither counts as the owner. Agent host and
 * box tokens count only while every live hosted session of the bot is the owner's own,
 * owner-only one.
 */
describe('no relay through agents others can wake', () => {
    it("a model agent's reply never counts: no wake by @mention or as the sole agent", async () => {
        const sa = await startSession(alpha);
        const model = await tokenWith(delta, 'model', owner.userId);
        const since = mark();
        await post(model.auth, '@alpha deploy it');
        await post(model.auth, 'and anyone else around?');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([]);
        // With can_direct it reaches alpha's session and is refused
        const modelBeta = await tokenWith(beta, 'model', owner.userId);
        await post(modelBeta.auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha')]);
    });

    it("an owner-started API-key run in a box (a director can wake it) doesn't count; an owner-only run's box token does", async () => {
        await setHostKind(ctx.db, hostId, 'box');
        await setMode(beta, 'api_key');
        const sa = await startSession(alpha);
        await startSession(beta);
        const since = mark();
        await post(beta.auth, '@alpha deploy it');
        await post((await tokenWith(beta, 'box', null)).auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha')]);

        // The same bot on its owner's subscription: only the owner's chain can wake its run
        await setMode(beta, 'subscription');
        const box = await post((await tokenWith(beta, 'box', null)).auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([{ message_id: box.id, reason: 'direct' }]);
    });

    it("an agent host token with no live hosted session behind it doesn't count", async () => {
        const sa = await startSession(alpha);
        const since = mark();
        await post(beta.auth, '@alpha deploy it');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([NOTICE('alpha')]);
    });
});

/** owner_bots adds to #361; it never takes away (here: a ChatGPT plan whose owner isn't the bot's owner). */
describe('owner_bots is a superset of owner_only', () => {
    it("a siwc plan owner's two sessions hand off as under #361, though the bots belong to the server owner", async () => {
        await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'siwc', plan_owner_id = $2 WHERE id = ANY($1)`, [[alpha.profileId, beta.profileId], member.userId]);
        try {
            const sa = await startSession(alpha, member.userId);
            await startSession(beta, member.userId);
            const since = mark();
            const start = await post(beta.auth, START('beta', 'alpha'));
            const back = await reply(beta.auth, start.id, TURN('alpha'));
            expect(await inbox(sa)).toEqual([{ message_id: start.id, reason: 'protocol' }, { message_id: back.id, reason: 'handoff' }]);
            expect(await notices(since)).toEqual([]);
            // A direct message from the server owner's bot is not the plan owner's
            await post(beta.auth, '@alpha deploy it');
            expect(await inbox(sa)).toHaveLength(2);
        } finally {
            await ctx.db.query(`UPDATE agent_profiles SET plan_owner_id = NULL WHERE id = ANY($1)`, [[alpha.profileId, beta.profileId]]);
        }
    });

    it("another person's bot in a session the owner started hands off as under #361, only with its run's own token", async () => {
        const sa = await startSession(alpha);
        await startSession(gamma);
        const start = await post(gamma.auth, START('gamma', 'alpha'));
        expect(await inbox(sa)).toEqual([{ message_id: start.id, reason: 'protocol' }]);
        // Its owner's personal token, posting as that session: refused
        const theirs = await mint(gamma, director);
        const since = mark();
        await reply(theirs.auth, start.id, TURN('alpha'));
        expect(await inbox(sa)).toEqual([{ message_id: start.id, reason: 'protocol' }]);
        expect(await notices(since)).toEqual([NOTICE('alpha')]);
    });
});

/**
 * #361's hosted branch counts a session the plan owner started only for its own run's posts
 * (its agent host's or box's token) and only on a profile nobody but that plan owner can wake.
 */
describe('#361 hosted authors', () => {
    it('an owner-started API-key agent in a box (a director can wake it): its START and handoff offer are refused, in both settings', async () => {
        await setHostKind(ctx.db, hostId, 'box');
        await setMode(beta, 'api_key');
        const sa = await startSession(alpha);
        await startSession(beta);
        for (const wakes of ['owner_bots', 'owner_only']) {
            await ctx.db.query(`UPDATE servers SET subscription_wakes = $2 WHERE id = $1`, [serverId, wakes]);
            await forgetNotices();
            const since = mark();
            await post(beta.auth, START('beta', 'alpha'));
            expect(await inbox(sa)).toEqual([]);
            expect(await notices(since)).toEqual([NOTICE('alpha')]);
            const parent = await post(owner.auth, `Fix it (${wakes})`);
            const offer = await ctx.request.post(`/channels/${channelId}/handoffs`).set(beta.auth).send({ threadId: parent.id, to: 'alpha', summary: 'x' });
            expect(offer.status, JSON.stringify(offer.body)).toBe(403);
            expect(offer.body.error).toBe('plan_owner_only');
        }
    });

    it("a TURN on an Administrator's token, posted as the owner's owner-started session, is refused in both settings", async () => {
        const sa = await startSession(alpha);
        await startSession(beta);
        const start = await post(beta.auth, START('beta', 'alpha'));
        expect(await inbox(sa)).toEqual([{ message_id: start.id, reason: 'protocol' }]);
        const adminMinted = await mint(beta, admin);
        for (const wakes of ['owner_bots', 'owner_only']) {
            await ctx.db.query(`UPDATE servers SET subscription_wakes = $2 WHERE id = $1`, [serverId, wakes]);
            const since = mark();
            await reply(adminMinted.auth, start.id, TURN('alpha'));
            expect(await inbox(sa)).toEqual([{ message_id: start.id, reason: 'protocol' }]);
            expect(await notices(since)).toEqual([wakes === 'owner_bots' ? "beta is obowner's bot, but its messages don't count as obowner's, so they can't wake alpha: this token was made by obadmin, not obowner; obowner should make a new personal token for the bot (Settings → Agents) and connect with it." : NOTICE('alpha')]);
        }
        // The run's own token still hands off
        const back = await reply(beta.auth, start.id, TURN('alpha'));
        expect((await inbox(sa)).map(r => r.message_id)).toEqual([start.id, back.id]);
    });
});

describe('no fixed loop guard for owner bots', () => {
    it("owner bots wake the owner's agents for as many turns as they like; only the user-set channel and thread guards apply", async () => {
        const sa = await startSession(alpha);
        await startSession(delta);
        const parent = await post(owner.auth, 'Work on the upload test together');
        const wakes: string[] = [];
        const since = mark();
        for (let i = 0; i < 12; i++) wakes.push((await reply(delta.auth, parent.id, `@alpha turn ${i}`)).id);
        expect((await inbox(sa)).map(r => r.message_id)).toEqual(wakes);
        expect(await notices(since)).toEqual([]);
        // The user's own guard (off until set) still stops bot messages: the route refuses the post
        await ctx.db.query('UPDATE channels SET max_thread_bot_hops = 2 WHERE id = $1', [channelId]);
        for (let i = 0; i < 2; i++) await reply(delta.auth, parent.id, '@alpha within the limit');
        const stopped = await ctx.request.post(`/channels/${channelId}/messages/${parent.id}/replies`).set(delta.auth).send({ content: '@alpha one more' });
        expect(stopped.status).toBe(429);
        await ctx.db.query('UPDATE channels SET max_thread_bot_hops = 0 WHERE id = $1', [channelId]);
    });
});

describe('a terminal bot on a fresh personal token (the live report): the chip and the wake agree', () => {
    beforeEach(async () => {
        await ctx.db.query('UPDATE bot_channel_access SET can_direct = false WHERE bot_id = $1 AND channel_id = $2', [delta.botId, channelId]);
    });

    async function boxedAlpha() {
        await setHostKind(ctx.db, hostId, 'box');
        return startSession(alpha);
    }

    it("wakes a boxed subscription agent the owner started, with a new token minted after the terminal opened on an older one", async () => {
        const sa = await boxedAlpha();
        const old = await mint(delta, owner);
        await connectTerminal(delta, old);
        const fresh = await mint(delta, owner);
        const since = mark();
        const m = await post(fresh.auth, '@alpha are you there?');
        expect(await inbox(sa)).toEqual([{ message_id: m.id, reason: 'direct' }]);
        const inThread = await reply(fresh.auth, (await post(owner.auth, 'a thread')).id, '@alpha in a thread');
        expect((await inbox(sa)).map(r => r.message_id)).toContain(inThread.id);
        expect(await notices(since)).toEqual([]);
        const c = await claim();
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        expect(c.body.session.startedByOwner).toBe(true);
        expect(c.body.inbox.every((i: any) => i.ownerBot === true)).toBe(true);
    });

    it("a terminal that reconnected with the new token shares two tokens (mixed): the notice names it and the fix", async () => {
        const sa = await boxedAlpha();
        const old = await mint(delta, owner);
        await connectTerminal(delta, old);
        const fresh = await mint(delta, owner);
        await connectTerminal(delta, fresh);
        const since = mark();
        await post(fresh.auth, '@alpha are you there?');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([
            "delta can't wake alpha: it can't direct agents here, and its messages don't count as obowner's: two different tokens share this bot's terminal session; close the terminal and reconnect with only the new token.",
        ]);
    });

    it("a token someone else made names its maker", async () => {
        const sa = await boxedAlpha();
        const theirs = await mint(delta, admin);
        const since = mark();
        await post(theirs.auth, '@alpha are you there?');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual([
            "delta can't wake alpha: it can't direct agents here, and its messages don't count as obowner's: this token was made by obadmin, not obowner; obowner should make a new personal token for the bot (Settings → Agents) and connect with it.",
        ]);
        // With can_direct of its own the refusal is the plan-owner rule, and names the same cause
        await canDirect(delta);
        const since2 = mark();
        await post(theirs.auth, '@alpha are you there?');
        expect(await notices(since2)).toEqual([
            "delta is obowner's bot, but its messages don't count as obowner's, so they can't wake alpha: this token was made by obadmin, not obowner; obowner should make a new personal token for the bot (Settings → Agents) and connect with it.",
        ]);
    });

    it("a session whose starter is not the owner (lost, or someone else's) names who and the fix", async () => {
        const sa = await startSession(alpha, null);
        const mine = await mint(delta, owner);
        const since = mark();
        await post(mine.auth, '@alpha are you there?');
        await post(mine.auth, '@alpha are you there?');
        expect(await inbox(sa)).toEqual([]);
        // Said once, although the bot mentioned it twice
        expect(await notices(since)).toEqual([startedByNotice('alpha', 'obowner', null)]);
        expect(startedByNotice('alpha', 'obowner', null)).toContain("alpha's session wasn't started by obowner");
    });

    it("with the server set to Only you the chip and the notice both say hand-offs only", async () => {
        const sa = await boxedAlpha();
        await ctx.db.query(`UPDATE servers SET subscription_wakes = 'owner_only' WHERE id = $1`, [serverId]);
        const mine = await mint(delta, owner);
        await connectTerminal(delta, mine);
        const since = mark();
        await post(mine.auth, '@alpha are you there?');
        expect(await inbox(sa)).toEqual([]);
        // delta has no can_direct: the notice is the bot notice
        expect(await notices(since)).toEqual([
            "delta can't wake alpha: Settings → Agents, \"Who can wake subscription agents\", is set to \"Only you\". Set it to \"You and your own agents\" so obowner's bots can, or post the message yourself.",
        ]);
        // with can_direct the refusal is the plan-owner rule, named
        await canDirect(delta);
        const since2 = mark();
        await post(mine.auth, '@alpha are you there?');
        expect(await notices(since2)).toEqual([ownerOnlyNotice('delta', 'alpha', 'obowner')]);
    });
});

describe('a bot that counts as the owner and the owner\'s agents, beyond waking', () => {
    it('a shelved agent says it is shelved and how to resume; the same notice is not repeated within ten minutes', async () => {
        await setMode(alpha, 'api_key');
        const sa = await startSession(alpha);
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved', end_reason = 'budget',
            limit_stop = '{"kind":"wake","used":50,"limit":50,"sessionId":"x"}'::jsonb WHERE id = $1`, [sa]);
        const mine = await mint(delta, owner);
        const since = mark();
        await post(mine.auth, '@alpha are you there?');
        await post(mine.auth, '@alpha are you there?');
        expect(await notices(since)).toEqual([
            `alpha is shelved (its wake limit was reached, 50 of 50; lift the limit in Settings → Agents first), so nothing woke it. Resume it: /resume ${sa}.`,
        ]);
    });

    it("an agent with no session at all gets the start notice", async () => {
        const mine = await mint(delta, owner);
        const since = mark();
        await post(mine.auth, '@alpha are you there?');
        expect(await notices(since)).toEqual(['alpha has no live session here, so nothing woke it. Start one with /start alpha.']);
    });

    it("the bot may start and resume the owner's subscription agent through the commands route: it records the owner as the starter", async () => {
        const mine = await mint(delta, owner);
        const started = await ctx.request.post(`/channels/${channelId}/agent-commands`).set(mine.auth).send({ command: 'start', profile: 'alpha' });
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        const row = await ctx.db.query('SELECT started_by FROM agent_sessions WHERE id = $1', [started.body.session.id]);
        expect(row.rows[0].started_by.trim()).toBe(owner.userId);
        const notice = await ctx.db.query(`SELECT content FROM messages WHERE channel_id = $1 AND system_event = 'agent_session' ORDER BY id DESC LIMIT 1`, [channelId]);
        expect(notice.rows[0].content).toContain("delta (obowner's bot) started a alpha session");
        // Shelved, then resumed by the bot
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved', started_by = $2 WHERE id = $1`, [started.body.session.id, director.userId]);
        const resumed = await ctx.request.post(`/channels/${channelId}/agent-commands`).set(mine.auth).send({ command: 'resume', sessionId: started.body.session.id });
        expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
        expect((await ctx.db.query('SELECT started_by FROM agent_sessions WHERE id = $1', [started.body.session.id])).rows[0].started_by.trim()).toBe(owner.userId);
        // session_wake: the post is accepted with require_direct
        const wake = await ctx.request.post(`/channels/${channelId}/messages`).set(mine.auth).send({ content: '@alpha hi', require_direct: true });
        expect(wake.status, JSON.stringify(wake.body)).toBe(201);
    });

    it("a bot that does not count (another person's, or the owner's on a token an administrator made) may not start anything", async () => {
        const theirs = await mint(delta, admin);
        const a = await ctx.request.post(`/channels/${channelId}/agent-commands`).set(theirs.auth).send({ command: 'start', profile: 'alpha' });
        expect(a.status).toBe(403);
        const b = await ctx.request.post(`/channels/${channelId}/agent-commands`).set(gamma.auth).send({ command: 'start', profile: 'alpha' });
        expect(b.status).toBe(403);
        const none = await ctx.db.query('SELECT 1 FROM agent_sessions WHERE bot_id = $1', [alpha.botId]);
        expect(none.rows.length).toBe(0);
    });
});

describe('the claim reruns the owner-bots check', () => {
    it('a revoked token or a session a director started since drops the pending wake', async () => {
        const sa = await startSession(alpha);
        const mine = await mint(delta, owner);
        await post(mine.auth, '@alpha please review');
        expect(await inbox(sa)).toHaveLength(1);
        const row = (await ctx.db.query('SELECT author_token_id FROM agent_inbox WHERE session_id = $1', [sa])).rows[0];
        expect(row.author_token_id.trim()).toBe(mine.id);
        expect((await ctx.request.delete(`/servers/${serverId}/bots/${delta.botId}/tokens/${mine.id}`).set(owner.auth)).status).toBe(200);
        expect((await claim()).status).toBe(204);
        expect(await inbox(sa)).toEqual([]);

        const again = await mint(delta, owner);
        await post(again.auth, '@alpha please review');
        expect(await inbox(sa)).toHaveLength(1);
        await startSession(delta, director.userId);
        expect((await claim()).status).toBe(204);
        expect(await inbox(sa)).toEqual([]);
    });

    it("switching to owner_only drops an owner bot's pending YIELD that #361 doesn't allow; keeps one it does", async () => {
        const sa = await startSession(alpha);
        await startSession(gamma);
        // A terminal on a token with no recorded maker counts as an owner bot, not under #361
        const legacy = await mint(delta, owner);
        await ctx.db.query(`UPDATE bot_tokens SET created_by = NULL WHERE id = $1`, [legacy.id]);
        await connectTerminal(delta, legacy);
        const opened = await post(gamma.auth, START('gamma', 'alpha', 'delta'));
        const yielded = await reply(legacy.auth, opened.id, TURN('alpha'));
        expect((await inbox(sa)).map(r => r.message_id)).toEqual([opened.id, yielded.id]);
        expect((await setting(owner.auth, { subscriptionWakes: 'owner_only' })).status).toBe(200);
        const c = await claim();
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        // gamma's START (a session the owner started) is kept under #361
        expect(c.body.inbox.map((i: any) => i.messageId)).toEqual([opened.id]);
    });
});

describe('collaboration threads', () => {
    it("an owner bot's plain reply in a bound thread reaches the owner's plan-owned participants without can_direct", async () => {
        const sa = await startSession(alpha);
        await startSession(delta);
        const start = await post(delta.auth, START('delta', 'alpha'));
        const plain = await reply(delta.auth, start.id, 'the stack trace is in the PR');
        expect(await inbox(sa)).toEqual([{ message_id: start.id, reason: 'protocol' }, { message_id: plain.id, reason: 'direct' }]);
    });
});

/**
 * The owner's authority for a bot (src/lib/owner-bot-authority.ts): narrower than "counts as the owner".
 * Only a post on a PERSONAL token the bot's owner made, with the bot's own switch on
 * (users.bot_acts_as_owner), and only where that person can direct agents.
 */
describe('a bot acting with its owner\'s authority', () => {
    const cmd = (auth: object, body: object) => ctx.request.post(`/channels/${channelId}/agent-commands`).set(auth).send(body);
    const revoke = (agent: Agent, t: Token) => ctx.request.delete(`/servers/${serverId}/bots/${agent.botId}/tokens/${t.id}`).set(owner.auth);
    const setActs = (agent: Agent, on: boolean) => ctx.db.query('UPDATE users SET bot_acts_as_owner = $2 WHERE id = $1', [agent.botId, on]);

    beforeEach(async () => {
        await ctx.db.query('UPDATE bot_channel_access SET can_direct = false WHERE bot_id = ANY($1) AND channel_id = $2', [[delta.botId, gamma.botId], channelId]);
        await ctx.db.query('UPDATE users SET bot_acts_as_owner = true WHERE id = ANY($1)', [[alpha.botId, beta.botId, gamma.botId, delta.botId]]);
        await ctx.db.query('UPDATE agent_profiles SET wake_budget = NULL WHERE id = $1', [alpha.profileId]);
        await setHostKind(ctx.db, hostId, 'box'); // an API-key agent in a box (on a machine its profile is owner-only)
    });
    afterAll(async () => { await canDirect(gamma); });

    it("a director's bot, on a personal token the director made, reaches an API-key agent without can_direct", async () => {
        await setMode(alpha, 'api_key');
        const sa = await startSession(alpha);
        const theirs = await mint(gamma, director);
        const m = await post(theirs.auth, '@alpha review this');
        expect(await inbox(sa)).toEqual([{ message_id: m.id, reason: 'direct' }]);
        const c = await claim();
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        expect(c.body.inbox.map((i: any) => [i.authority, i.ownerBot, i.ownerBotDirect])).toEqual([[null, true, true]]);
    });

    it("an owner without DirectAgents in the channel gives the bot nothing, and the notice says so", async () => {
        await setMode(alpha, 'api_key');
        const sa = await startSession(alpha);
        await ctx.db.query('UPDATE users SET bot_owner_id = $2 WHERE id = $1', [delta.botId, member.userId]);
        const theirs = await mint(delta, member);
        const since = mark();
        await post(theirs.auth, '@alpha review this');
        expect(await inbox(sa)).toEqual([]);
        expect(await notices(since)).toEqual(["delta counts as obmember, but obmember can't direct agents in this channel, so delta can't wake alpha. Give obmember the Direct Agents permission here (only the server owner can)."]);
    });

    it('agent host, box and invite tokens do not get the new authority (an invite code can be redeemed by someone else)', async () => {
        await setMode(alpha, 'api_key');
        await setMode(delta, 'subscription');
        const sa = await startSession(alpha);
        await startSession(delta); // an owner-started, owner-only run: its box token still counts for the main rule
        for (const purpose of ['box', 'host', 'invite'] as const) {
            const t = await tokenWith(delta, purpose, null);
            await post(t.auth, '@alpha review this');
            expect(await inbox(sa), purpose).toEqual([]);
            const asked = await cmd(t.auth, { command: 'start', profile: 'alpha' });
            expect(asked.status, purpose).toBe(403);
        }
        // What main already allowed is unchanged: the same invite token wakes the owner's subscription agent
        await setMode(alpha, 'subscription');
        const invite = await tokenWith(delta, 'invite', null);
        const m = await post(invite.auth, '@alpha review this');
        expect((await inbox(sa)).map(r => r.message_id)).toEqual([m.id]);
    });

    it('a counting bot may not start fresh, shelve a live session or start over a limit-stopped one; budgets and CLI commands stay with the person', async () => {
        const mine = await mint(delta, owner);
        const started = await cmd(mine.auth, { command: 'start', profile: 'alpha' });
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        const fresh = await cmd(mine.auth, { command: 'start', profile: 'alpha', fresh: true });
        expect(fresh.status).toBe(403);
        expect(fresh.body.error).toBe('needs_person');
        expect(fresh.body.message).toBe("delta acts as obowner but can't start a fresh session or shelve a live one: that resets its limits and needs obowner in person.");
        const shelve = await cmd(mine.auth, { command: 'start', profile: 'alpha', onLive: 'shelve' });
        expect(shelve.status).toBe(403);
        // Limit-stopped: the start that would pick it up is refused as a resume is
        const id = started.body.session.id;
        await ctx.db.query(`UPDATE agent_profiles SET wake_budget = 1 WHERE id = $1`, [alpha.profileId]);
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved', end_reason = 'budget', wakes_used = 1 WHERE id = $1`, [id]);
        const again = await cmd(mine.auth, { command: 'start', profile: 'alpha' });
        expect(again.status, JSON.stringify(again.body)).toBe(409);
        expect(again.body.error).toBe('budget_exhausted');
        expect((await cmd(mine.auth, { command: 'resume', sessionId: id })).body.error).toBe('budget_exhausted');
        // The person in person is unaffected by fresh
        const person = await cmd(owner.auth, { command: 'start', profile: 'alpha', fresh: true });
        expect(person.status, JSON.stringify(person.body)).toBe(201);
        // Budget changes and CLI commands are refused
        const budget = await cmd(mine.auth, { command: 'budget', sessionId: person.body.session.id, tokenBudget: 5 });
        expect(budget.status).toBe(403);
        const control = await cmd(mine.auth, { command: 'control', profile: 'alpha', control: 'compact' });
        expect(control.status).toBe(403);
        expect(control.body.error).toBe('cannot_direct');
    });

    it('end, lurk and wake by a counting bot act as its owner', async () => {
        const mine = await mint(delta, owner);
        const started = await cmd(mine.auth, { command: 'start', profile: 'alpha' });
        expect(started.status).toBe(201);
        const lurk = await cmd(mine.auth, { command: 'lurk', profile: 'alpha', lurkMode: 'quiet' });
        expect(lurk.status, JSON.stringify(lurk.body)).toBe(200);
        const wake = await ctx.request.post(`/channels/${channelId}/messages`).set(mine.auth).send({ content: '@alpha hi', require_direct: true });
        expect(wake.status, JSON.stringify(wake.body)).toBe(201);
        const ended = await cmd(mine.auth, { command: 'end', profile: 'alpha' });
        expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    });

    it('the per-bot switch: off, the bot keeps only its own can_direct and the main wake rule', async () => {
        await setMode(alpha, 'api_key');
        const sa = await startSession(alpha);
        const mine = await mint(delta, owner);
        // The owner or the bot's owner changes it in the bot's settings; others can't
        expect((await ctx.request.patch(`/servers/${serverId}/bots/${delta.botId}`).set(owner.auth).send({ actsAsOwner: false })).status).toBe(200);
        expect((await ctx.request.get(`/servers/${serverId}/bots/${delta.botId}`).set(owner.auth)).body.actsAsOwner).toBe(false);
        await post(mine.auth, '@alpha review this');
        expect(await inbox(sa)).toEqual([]);
        expect((await cmd(mine.auth, { command: 'start', profile: 'alpha' })).status).toBe(403);
        // The main rule still holds: the owner's subscription agent
        await setMode(alpha, 'subscription');
        const m = await post(mine.auth, '@alpha review this');
        expect((await inbox(sa)).map(r => r.message_id)).toEqual([m.id]);
        expect((await ctx.request.patch(`/servers/${serverId}/bots/${delta.botId}`).set(member.auth).send({ actsAsOwner: true })).status).toBeGreaterThanOrEqual(403);
        expect((await ctx.request.patch(`/servers/${serverId}/bots/${delta.botId}`).set(owner.auth).send({ actsAsOwner: true })).status).toBe(200);
        // Own can_direct still works with the switch off
        await setActs(delta, false);
        await canDirect(delta);
        await setMode(alpha, 'api_key');
        const own = await post(mine.auth, '@alpha again');
        expect((await inbox(sa)).map(r => r.message_id)).toContain(own.id);
    });

    it('the claim rechecks the API-key path: token revoked, person demoted, switch turned off between post and claim', async () => {
        await setMode(alpha, 'api_key');
        const sa = await startSession(alpha);
        const fresh = async (agent: Agent, by: { auth: object }) => {
            const t = await mint(agent, by);
            await post(t.auth, '@alpha review this');
            expect(await inbox(sa)).toHaveLength(1);
            return t;
        };
        const drop = async () => { expect((await claim()).status).toBe(204); expect(await inbox(sa)).toEqual([]); await ctx.db.query('TRUNCATE agent_inbox'); };
        const t1 = await fresh(delta, owner);
        expect((await revoke(delta, t1)).status).toBe(200);
        await drop();
        await fresh(delta, owner);
        await setActs(delta, false);
        await drop();
        await setActs(delta, true);
        // The director is demoted (role removed) after the post
        await fresh(gamma, director);
        const roles = await ctx.db.query(`SELECT server_id, role_id FROM member_roles WHERE user_id = $1 AND server_id = $2`, [director.userId, serverId]);
        await ctx.db.query('DELETE FROM member_roles WHERE user_id = $1 AND server_id = $2', [director.userId, serverId]);
        try { await drop(); } finally {
            for (const r of roles.rows) await ctx.db.query('INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [r.server_id, director.userId, r.role_id]);
        }
    });

    it("the [OWNER'S BOT] mark is on direct rows only: never on lurk or context rows", async () => {
        const sa = await startSession(alpha, owner.userId, { lurk: 'balanced' });
        await startSession(delta);
        const mine = await mint(delta, owner);
        const direct = await post(mine.auth, '@alpha look');
        const lurk = await post(mine.auth, 'just chatting about the build');
        const c = await claim();
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        const byId = new Map(c.body.inbox.map((i: any) => [i.messageId, i]));
        expect(byId.get(direct.id)).toMatchObject({ reason: 'direct', ownerBot: true, ownerBotDirect: true });
        expect(byId.get(lurk.id)).toMatchObject({ reason: 'lurk', ownerBot: true });
        expect((byId.get(lurk.id) as any).ownerBotDirect).toBeUndefined();
        expect(sa).toBeTruthy();
    });

    it('every bot-triggered notice kind is said once per place, not on every message', async () => {
        const twice = async (auth: object, text: string) => {
            await forgetNotices();
            const since = mark();
            await post(auth, text);
            await post(auth, text);
            return notices(since);
        };
        const mine = await mint(delta, owner);
        // plan-owner refusal (another person's bot)
        let sa = await startSession(alpha);
        await startSession(gamma, director.userId);
        await canDirect(gamma);
        expect(await twice(gamma.auth, '@alpha go')).toEqual([NOTICE('alpha')]);
        // whyNotCounting (a token an administrator made), ownerOnly
        expect(await twice((await mint(beta, admin)).auth, '@alpha go')).toHaveLength(1);
        await ctx.db.query(`UPDATE servers SET subscription_wakes = 'owner_only' WHERE id = $1`, [serverId]);
        await canDirect(beta);
        expect(await twice(beta.auth, '@alpha go')).toEqual([ownerOnlyNotice('beta', 'alpha', 'obowner')]);
        await ctx.db.query(`UPDATE servers SET subscription_wakes = 'owner_bots' WHERE id = $1`, [serverId]);
        // started by someone else
        await ctx.db.query('TRUNCATE agent_inbox, agent_sessions CASCADE');
        sa = await startSession(alpha, director.userId);
        expect(await twice(mine.auth, '@alpha go')).toEqual([startedByNotice('alpha', 'obowner', 'obdirector')]);
        // shelved, no session
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved', end_reason = 'user' WHERE id = $1`, [sa]);
        expect(await twice(mine.auth, '@alpha go')).toHaveLength(1);
        await ctx.db.query('TRUNCATE agent_inbox, agent_sessions CASCADE');
        expect(await twice(mine.auth, '@alpha go')).toEqual(['alpha has no live session here, so nothing woke it. Start one with /start alpha.']);
    });

    it('when the owner in person wakes a subscription session with no recorded starter, it becomes theirs; another known person\'s is never adopted', async () => {
        const unknown = await startSession(alpha, null);
        const m = await post(owner.auth, '@alpha are you there?');
        expect(await inbox(unknown)).toEqual([{ message_id: m.id, reason: 'direct' }]);
        expect((await ctx.db.query('SELECT started_by FROM agent_sessions WHERE id = $1', [unknown])).rows[0].started_by.trim()).toBe(owner.userId);
        const claimed = await claim();
        expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
        expect(claimed.body.session.startedByOwner).toBe(true);

        await ctx.db.query('TRUNCATE agent_inbox, agent_runs, agent_batches, agent_sessions CASCADE');
        const theirs = await startSession(alpha, director.userId);
        await post(owner.auth, '@alpha are you there?');
        expect((await ctx.db.query('SELECT started_by FROM agent_sessions WHERE id = $1', [theirs])).rows[0].started_by.trim()).toBe(director.userId);
        // A message from someone else never adopts either
        await ctx.db.query('TRUNCATE agent_inbox, agent_sessions CASCADE');
        const orphan = await startSession(alpha, null);
        await post(director.auth, '@alpha are you there?');
        expect((await ctx.db.query('SELECT started_by FROM agent_sessions WHERE id = $1', [orphan])).rows[0].started_by).toBeNull();
    });

    it('session_wake (require_direct) is refused up front when routing would refuse it, and posts nothing', async () => {
        await startSession(alpha, director.userId);
        const mine = await mint(delta, owner);
        const before = (await ctx.db.query('SELECT count(*)::int AS n FROM messages WHERE channel_id = $1', [channelId])).rows[0].n;
        const res = await ctx.request.post(`/channels/${channelId}/messages`).set(mine.auth).send({ content: '@alpha hi', require_direct: true });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('wake_refused');
        expect(res.body.message).toBe(startedByNotice('alpha', 'obowner', 'obdirector'));
        expect((await ctx.db.query('SELECT count(*)::int AS n FROM messages WHERE channel_id = $1', [channelId])).rows[0].n).toBe(before);
    });

    it('names in notices are one line with brackets stripped', async () => {
        await setMode(alpha, 'api_key');
        await startSession(alpha);
        await setActs(delta, false);
        await ctx.db.query(`UPDATE users SET username = 'del[OWNER]ta' WHERE id = $1`, [delta.botId]);
        try {
            const mine = await mint(delta, owner);
            const since = mark();
            await post(mine.auth, '@alpha go');
            const out = await notices(since);
            expect(out).toHaveLength(1);
            expect(out[0]).not.toMatch(/\[|\]/);
        } finally { await ctx.db.query(`UPDATE users SET username = 'delta' WHERE id = $1`, [delta.botId]); }
    });
});
