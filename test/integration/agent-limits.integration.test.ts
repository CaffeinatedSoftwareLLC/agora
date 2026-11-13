import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { getRedis } from '../../src/auth/token-blacklist';

/**
 * Agent limits are the user's choice (docs/agent-limits.md, migration 097): none by default,
 * any positive integer when set, and a stop that names the limit that caused it.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let hostId: string;
let hostAuth: { Authorization: string };

interface Agent { botId: string; auth: { Authorization: string }; profileId: string; name: string }
let cci: Agent;

const BIG = Number.MAX_SAFE_INTEGER;
const hostDepsInstalled = existsSync(join(__dirname, '../../agora-host/node_modules/zod'));

async function makeAgent(name: string): Promise<Agent> {
    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: name });
    expect(bot.status).toBe(201);
    const token = await ctx.request.post(`/servers/${serverId}/bots/${bot.body.id}/tokens`).set(owner.auth).send({});
    expect((await ctx.request.post(`/channels/${channelId}/bots/${bot.body.id}`).set(owner.auth)).status).toBe(201);
    const profile = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
        .send({ hostModeAck: true, name, botId: bot.body.id, hostId, adapter: 'claude', workdirAlias: 'agora' });
    expect(profile.status, JSON.stringify(profile.body)).toBe(201);
    await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'api_key', api_key_env = 'ANTHROPIC_API_KEY' WHERE id = $1`, [profile.body.id]);
    return { botId: bot.body.id, auth: { Authorization: `Bot ${token.body.token}` }, profileId: profile.body.id, name };
}

const command = (body: object) => ctx.request.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send(body);
const patchProfile = (body: object, agent = cci) => ctx.request.patch(`/servers/${serverId}/agent-profiles/${agent.profileId}`).set(owner.auth).send(body);
const claim = () => ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
const post = (auth: object, content: string) => ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content });
const listed = async (id: string) => (await command({ command: 'sessions' })).body.sessions.find((s: any) => s.id === id);
const lastNotice = async (like: string) => (await ctx.db.query(
    `SELECT content FROM messages WHERE channel_id = $1 AND author_id IS NULL AND content LIKE $2 ORDER BY id DESC LIMIT 1`, [channelId, like])).rows[0]?.content as string | undefined;

/** A fresh live session for the agent, started by the owner; earlier ones are ended. */
async function startSession(agent = cci): Promise<string> {
    await ctx.db.query(`UPDATE agent_runs SET status = 'succeeded', finished_at = NOW() WHERE status = 'claimed'`);
    await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE state <> 'ended'`);
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, serverId, channelId, agent.botId, agent.profileId, owner.userId]);
    return id;
}

async function finish(c: any, body: object = {}) {
    const done = await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/complete`).set(hostAuth).send({ claimToken: c.run.claimToken, ...body });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'limitsowner');
    const server = await createServer(ctx.request, owner.auth, 'Limits Server');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 100000 WHERE id = $1', [channelId]);
    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
    hostId = host.body.host.id;
    hostAuth = { Authorization: `AgentHost ${host.body.token}` };
    cci = await makeAgent('cci');
});
afterAll(async () => { await ctx.close(); });
beforeEach(async () => {
    await ctx.db.query(`UPDATE agent_profiles SET wake_budget = NULL, token_budget = NULL, run_timeout_sec = NULL`);
    await ctx.db.query(`UPDATE channels SET max_bot_hops = NULL, max_thread_bot_hops = NULL WHERE id = $1`, [channelId]);
    try { await getRedis().del(`loopguard:${channelId}`); } catch { /* no Redis: the guard is off anyway */ }
});

describe('defaults: no limit', () => {
    it('a new profile and a new channel have no limits, in the API and in the database', async () => {
        const profiles = await ctx.request.get(`/servers/${serverId}/agent-profiles`).set(owner.auth);
        expect(profiles.body.find((p: any) => p.id === cci.profileId)).toMatchObject({ wakeBudget: null, tokenBudget: null, runTimeoutSec: null });
        const created = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: 'fresh', channelType: 3 });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const row = (await ctx.db.query('SELECT max_bot_hops, max_thread_bot_hops FROM channels WHERE id = $1', [created.body.id])).rows[0];
        expect(row).toEqual({ max_bot_hops: null, max_thread_bot_hops: null });
        const channels = await ctx.request.get(`/servers/${serverId}/channels`).set(owner.auth);
        expect(channels.body.find((c: any) => c.id === created.body.id)).toMatchObject({ maxBotHops: null, maxThreadBotHops: null });
    });

    it('a session far past the old defaults (50 wakes, 50M tokens) is still woken, with no limits in its claim', async () => {
        const id = await startSession();
        await ctx.db.query('UPDATE agent_sessions SET wakes_used = 5000, tokens_used = 900000000000 WHERE id = $1', [id]);
        expect((await post(owner.auth, '@cci carry on')).status).toBe(201);
        const c = await claim();
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        expect(c.body.session).toMatchObject({ id, wakesUsed: 5001, wakeLimit: null, tokenLimit: null });
        expect(c.body.run.timeLimitSeconds).toBeNull();
        // An agora-host from Agora 0.4.0 or earlier needs numbers in these fields, and a run time of at most a day
        expect(c.body.run.timeoutSeconds).toBe(86400);
        expect(c.body.session).toMatchObject({ wakeBudget: 0, tokenBudget: 0 });
        expect(await listed(id)).toMatchObject({ state: 'live', wakeBudget: null, tokenBudget: null, limitStop: null });
        // Usage beyond any old limit never stops it
        const beat = await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/heartbeat`).set(hostAuth).send({ claimToken: c.body.run.claimToken, tokensUsed: 80000000 });
        expect(beat.body.cancel).toBe(false);
        await finish(c.body, { tokensUsed: 90000000 });
        expect((await listed(id)).state).toBe('live');
    });

    it.skipIf(!hostDepsInstalled)("agora-host's claim parser takes a claim without limits and one with a limit over a day", async () => {
        const { claimSchema, runTimeLimit } = await import('../../agora-host/src/types');
        await startSession();
        await post(owner.auth, '@cci one');
        const none = await claim();
        const parsedNone = claimSchema.safeParse(none.body);
        expect(parsedNone.success, JSON.stringify(parsedNone.success ? '' : parsedNone.error.issues)).toBe(true);
        expect(runTimeLimit(parsedNone.data!.run)).toBeNull();
        await finish(none.body);
        expect((await patchProfile({ runTimeoutSec: 30 * 86400 })).status).toBe(200);
        await post(owner.auth, '@cci two');
        const long = await claim();
        const parsedLong = claimSchema.safeParse(long.body);
        expect(parsedLong.success, JSON.stringify(parsedLong.success ? '' : parsedLong.error.issues)).toBe(true);
        expect(runTimeLimit(parsedLong.data!.run)).toBe(30 * 86400);
        expect(long.body.run.timeoutSeconds).toBe(86400);
        await finish(long.body);
    });

    it('bots talk past the old 4-message guard when the channel has none', async () => {
        for (let i = 0; i < 8; i++) expect((await post(cci.auth, `bot message ${i}`)).status).toBe(201);
    });
});

describe('a limit the owner sets', () => {
    it('takes any positive integer, however large, and null removes it', async () => {
        const set = await patchProfile({ wakeBudget: BIG, tokenBudget: BIG, runTimeoutSec: BIG });
        expect(set.status, JSON.stringify(set.body)).toBe(200);
        expect(set.body).toMatchObject({ wakeBudget: BIG, tokenBudget: BIG, runTimeoutSec: BIG });
        const read = await ctx.request.get(`/servers/${serverId}/agent-profiles`).set(owner.auth);
        expect(read.body.find((p: any) => p.id === cci.profileId)).toMatchObject({ wakeBudget: BIG, tokenBudget: BIG, runTimeoutSec: BIG });
        // The old caps: 100000 wakes, 7200 s
        expect((await patchProfile({ wakeBudget: 100001, runTimeoutSec: 7201 })).body).toMatchObject({ wakeBudget: 100001, runTimeoutSec: 7201, tokenBudget: BIG });
        for (const bad of [0, -1, 1.5, 'many']) expect((await patchProfile({ wakeBudget: bad })).status, String(bad)).toBe(400);
        expect((await patchProfile({ wakeBudget: null, tokenBudget: null, runTimeoutSec: null })).body)
            .toMatchObject({ wakeBudget: null, tokenBudget: null, runTimeoutSec: null });

        const config = (body: object) => ctx.request.patch(`/channels/${channelId}/bot-config`).set(owner.auth).send(body);
        expect((await config({ maxBotHops: BIG, maxThreadBotHops: 1001 })).body).toEqual({ channelId, maxBotHops: BIG, maxThreadBotHops: 1001 });
        expect((await config({ maxBotHops: null })).body).toEqual({ channelId, maxBotHops: null, maxThreadBotHops: 1001 });
        expect((await config({ maxThreadBotHops: -1 })).status).toBe(400);
    });

    it('the loop guard stops bots at the number set, and its notice says the limit and how to lift it', async () => {
        expect((await ctx.request.patch(`/channels/${channelId}/bot-config`).set(owner.auth).send({ maxBotHops: 2 })).status).toBe(200);
        expect((await post(cci.auth, 'one')).status).toBe(201);
        expect((await post(cci.auth, 'two')).status).toBe(201);
        const third = await post(cci.auth, 'three');
        expect(third.status).toBe(429);
        const notice = (await ctx.db.query(`SELECT content FROM messages WHERE channel_id = $1 AND system_event = 'loop_guard' ORDER BY id DESC LIMIT 1`, [channelId])).rows[0].content;
        expect(notice).toBe("Loop guard: 2 consecutive bot messages. Human input required to continue. This channel's limit is 2 in a row: "
            + "a person's message or Continue resets the count, and Server settings → Bots raises it or turns it off.");
        // Turning it off lets them go on
        expect((await ctx.request.patch(`/channels/${channelId}/bot-config`).set(owner.auth).send({ maxBotHops: null })).status).toBe(200);
        for (let i = 0; i < 4; i++) expect((await post(cci.auth, `again ${i}`)).status).toBe(201);
    });

    it('a run claimed under a time limit carries it; the stop names it', async () => {
        expect((await patchProfile({ runTimeoutSec: 120 })).status).toBe(200);
        await startSession();
        await post(owner.auth, '@cci long job');
        const c = (await claim()).body;
        expect(c.run).toMatchObject({ timeLimitSeconds: 120, timeoutSeconds: 120 });
        const failed = await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/fail`).set(hostAuth).send({ claimToken: c.run.claimToken, error: 'run_timeout', retryable: true });
        expect(failed.status).toBe(200);
        expect(await lastNotice("cci's run%")).toBe(`cci's run was stopped by its run time limit (2-minute), and its last wake was dropped. `
            + 'Raise or remove "Time per run" for cci in [Agent settings](/settings/agents), then send it again.');
    });
});

describe('a stop says which limit', () => {
    /**
     * The report this change answers: cci "keeps getting blocked, it hasn't hit its token budget but
     * the UI claims it did". A session stopped by the wake limit was shelved as "budget" with nothing
     * that told it apart from a token stop; the only control offered raised tokens, and that changed nothing.
     */
    it('stopped by the wake limit: the session, the notice and the refused resume all say wakes, and raising tokens is not the fix', async () => {
        expect((await patchProfile({ wakeBudget: 50, tokenBudget: 50_000_000 })).status).toBe(200);
        const id = await startSession();
        await ctx.db.query('UPDATE agent_sessions SET wakes_used = 50, tokens_used = 1200000 WHERE id = $1', [id]);
        await post(owner.auth, '@cci go');
        expect((await claim()).status).toBe(204);

        const stop = { kind: 'wake', used: 50, limit: 50, sessionId: id };
        const shelved = await listed(id);
        expect(shelved).toMatchObject({ state: 'shelved', endReason: 'budget', limitStop: stop, wakesUsed: 50, wakeBudget: 50, tokensUsed: 1200000, tokenBudget: 50_000_000 });
        expect(await lastNotice('Session for cci shelved:%')).toBe('Session for cci shelved: its wake limit is used up (50 of 50 wakes). '
            + `Raise or remove "Wakes per session" for cci in [Agent settings](/settings/agents), then /resume ${id}.`);

        // What the UI offered before: more tokens. It is refused again, and now says why
        const moreTokens = await command({ command: 'resume', sessionId: id, tokenBudget: 900_000_000 });
        expect(moreTokens.status).toBe(409);
        expect(moreTokens.body).toEqual({ error: 'budget_exhausted', limit: stop, message: 'Wake limit reached: 50 of 50 wakes.' });

        // The action the notice names, on the profile, reaches the shelved session: no new session needed
        expect((await patchProfile({ wakeBudget: null })).status).toBe(200);
        const resumed = await command({ command: 'resume', sessionId: id });
        expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
        expect(resumed.body.session).toMatchObject({ id, state: 'live', endReason: null, limitStop: null, wakeBudget: null, wakesUsed: 50 });
        expect((await claim()).status).toBe(200);
    });

    it('stopped by the token limit: says tokens, with the numbers', async () => {
        expect((await patchProfile({ tokenBudget: 100 })).status).toBe(200);
        const id = await startSession();
        await post(owner.auth, '@cci go');
        const c = (await claim()).body;
        expect(c.session).toMatchObject({ tokenLimit: 100, tokenBudget: 100, wakeLimit: null });
        await finish(c, { tokensUsed: 150 });
        const stop = { kind: 'token', used: 150, limit: 100, sessionId: id, source: 'agent' };
        expect(await listed(id)).toMatchObject({ state: 'shelved', endReason: 'budget', limitStop: stop });
        expect(await lastNotice('Session for cci shelved:%')).toBe('Session for cci shelved: its token limit is used up (150 of 100 tokens). '
            + `Raise or remove "Tokens per session" for cci in [Agent settings](/settings/agents), then /resume ${id}.`);
        expect((await command({ command: 'resume', sessionId: id })).body).toEqual({ error: 'budget_exhausted', limit: stop, message: 'Token limit reached: 150 of 100 tokens.' });
        // A live session takes the raised profile limit too: resume, then spend past the old one
        expect((await patchProfile({ tokenBudget: 1000 })).status).toBe(200);
        expect((await command({ command: 'resume', sessionId: id })).status).toBe(200);
        const again = (await claim()).body;
        await finish(again, { tokensUsed: 200 });
        expect(await listed(id)).toMatchObject({ state: 'live', tokensUsed: 350, tokenBudget: 1000 });
    });

    it("stopped by a token limit set on the session itself: the notice points at the session's controls, and clearing it there lifts it", async () => {
        const id = await startSession();
        expect((await command({ command: 'budget', sessionId: id, tokenBudget: 5 })).status).toBe(200);
        await post(owner.auth, '@cci go');
        await finish((await claim()).body, { tokensUsed: 6 });
        const stop = { kind: 'token', used: 6, limit: 5, sessionId: id, source: 'session' };
        expect(await listed(id)).toMatchObject({ state: 'shelved', limitStop: stop, tokenBudget: 5 });
        expect(await lastNotice('Session for cci shelved:%')).toBe("Session for cci shelved: its token limit is used up (6 of 5 tokens). That is this session's own token limit: "
            + `raise or clear it in its session controls (the agent's chip, or its task card), then /resume ${id}.`);
        expect((await command({ command: 'resume', sessionId: id })).body.message).toBe("Token limit (that session's own) reached: 6 of 5 tokens.");
        // Cleared and resumed in one step: the session follows its agent's setting again (no limit)
        const resumed = await command({ command: 'resume', sessionId: id, tokenBudget: null });
        expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
        expect(resumed.body.session).toMatchObject({ state: 'live', tokenBudget: null, limitStop: null });
    });

    it("stopped because the API key is out of credit: not described as one of Agora's limits", async () => {
        const id = await startSession();
        await post(owner.auth, '@cci go');
        const c = (await claim()).body;
        const failed = await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/fail`).set(hostAuth)
            .send({ claimToken: c.run.claimToken, error: 'credit_exhausted', retryable: false });
        expect(failed.status).toBe(200);
        expect(await listed(id)).toMatchObject({ state: 'shelved', endReason: 'budget', limitStop: { kind: 'credit' } });
        // Nothing of Agora's is in the way of a resume
        expect((await command({ command: 'resume', sessionId: id })).status).toBe(200);
    });
});

describe('a profile change reaches its sessions', () => {
    it("removing or raising the profile's token limit lifts a session's own lower one; a higher one set on the session stays", async () => {
        expect((await patchProfile({ tokenBudget: 1000 })).status).toBe(200);
        const id = await startSession();
        // The owner gave this session its own limits on its card, first below and later above the profile's
        expect((await command({ command: 'budget', sessionId: id, tokenBudget: 500 })).body.session.tokenBudget).toBe(500);
        expect((await patchProfile({ tokenBudget: 2000 })).status).toBe(200);
        expect((await listed(id)).tokenBudget).toBe(2000);

        expect((await command({ command: 'budget', sessionId: id, tokenBudget: 9000 })).body.session.tokenBudget).toBe(9000);
        expect((await patchProfile({ tokenBudget: 3000 })).status).toBe(200);
        expect((await listed(id)).tokenBudget).toBe(9000);
        // A change to another field leaves it alone
        expect((await patchProfile({ wakeBudget: 10 })).status).toBe(200);
        expect((await listed(id)).tokenBudget).toBe(9000);

        expect((await patchProfile({ tokenBudget: null })).status).toBe(200);
        expect(await listed(id)).toMatchObject({ tokenBudget: null, wakeBudget: 10 });
        expect((await ctx.db.query('SELECT token_budget FROM agent_sessions WHERE id = $1', [id])).rows[0].token_budget).toBeNull();
    });

    it("a session's own limit can be set to any size and cleared back to the profile's", async () => {
        const id = await startSession();
        expect((await command({ command: 'budget', sessionId: id, tokenBudget: BIG })).body.session.tokenBudget).toBe(BIG);
        expect((await command({ command: 'budget', sessionId: id, tokenBudget: null })).body.session.tokenBudget).toBeNull();
        expect((await command({ command: 'budget', sessionId: id })).status).toBe(400);
        expect((await command({ command: 'budget', sessionId: id, tokenBudget: 0 })).status).toBe(400);
    });
});

describe('migration 097 on existing rows', () => {
    it('values the program chose become "no limit"; values a person set stay; shelved sessions stay shelved and resume', async () => {
        const other = await makeAgent('custom');
        const old = await makeAgent('older');
        // cci: every old default. custom: the owner's own numbers. older: the pre-093 token default
        await ctx.db.query('UPDATE agent_profiles SET wake_budget = 50, token_budget = 50000000, run_timeout_sec = 900 WHERE id = $1', [cci.profileId]);
        await ctx.db.query('UPDATE agent_profiles SET wake_budget = 51, token_budget = 60000000, run_timeout_sec = 3600 WHERE id = $1', [other.profileId]);
        await ctx.db.query('UPDATE agent_profiles SET wake_budget = 100000, token_budget = 2000000, run_timeout_sec = 7200 WHERE id = $1', [old.profileId]);
        const channel = async (name: string, top: number, thread: number) => {
            const c = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name, channelType: 3 });
            await ctx.db.query('UPDATE channels SET max_bot_hops = $2, max_thread_bot_hops = $3 WHERE id = $1', [c.body.id, top, thread]);
            return c.body.id as string;
        };
        const byDefault = await channel('by-default', 4, 0), custom = await channel('custom-guard', 9, 4), off = await channel('guard-off', 0, 0);
        // cci's session, shelved by the old 50-wake default, with a per-session token limit the owner set
        const id = await startSession();
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved', end_reason = 'budget', shelved_at = NOW(), wakes_used = 50, token_budget = 70000000 WHERE id = $1`, [id]);

        await ctx.db.query(readFileSync(join(__dirname, '../../src/db/migrations/097_limits_opt_in.sql'), 'utf-8'));

        const profile = async (a: Agent) => (await ctx.db.query('SELECT wake_budget, token_budget, run_timeout_sec FROM agent_profiles WHERE id = $1', [a.profileId])).rows[0];
        expect(await profile(cci)).toEqual({ wake_budget: null, token_budget: null, run_timeout_sec: null });
        expect(await profile(other)).toEqual({ wake_budget: '51', token_budget: '60000000', run_timeout_sec: '3600' });
        expect(await profile(old)).toEqual({ wake_budget: '100000', token_budget: null, run_timeout_sec: '7200' });
        const guard = async (c: string) => (await ctx.db.query('SELECT max_bot_hops, max_thread_bot_hops FROM channels WHERE id = $1', [c])).rows[0];
        expect(await guard(byDefault)).toEqual({ max_bot_hops: null, max_thread_bot_hops: null });
        expect(await guard(custom)).toEqual({ max_bot_hops: '9', max_thread_bot_hops: '4' });
        expect(await guard(off)).toEqual({ max_bot_hops: null, max_thread_bot_hops: null });

        // Not un-shelved by the migration; the owner's Resume now succeeds, on the same session
        const session = (await ctx.db.query('SELECT state, end_reason, token_budget, wakes_used FROM agent_sessions WHERE id = $1', [id])).rows[0];
        expect(session).toEqual({ state: 'shelved', end_reason: 'budget', token_budget: '70000000', wakes_used: 50 });
        const resumed = await command({ command: 'resume', sessionId: id });
        expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
        expect(resumed.body.session).toMatchObject({ id, state: 'live', wakeBudget: null, tokenBudget: 70000000 });
    });
});
