import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { claimNext, complete, fail, sweepExpiredRuns, type Notice } from '../../src/lib/agent-runs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Agent sessions, server side (docs/planning/agent-sessions-wbs.md): client_key (S0),
 * wake routing into session inboxes (S1), and the host API (S2).
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let hostId: string;
let hostAuth: { Authorization: string };

interface Agent { botId: string; auth: { Authorization: string }; profileId: string; name: string }
let codex: Agent;
let claude: Agent;
let outsider: Agent; // a bot with channel access but no session

async function makeBot(name: string): Promise<{ botId: string; auth: { Authorization: string } }> {
    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: name });
    expect(bot.status).toBe(201);
    const token = await ctx.request.post(`/servers/${serverId}/bots/${bot.body.id}/tokens`).set(owner.auth).send({});
    expect((await ctx.request.post(`/channels/${channelId}/bots/${bot.body.id}`).set(owner.auth)).status).toBe(201);
    return { botId: bot.body.id, auth: { Authorization: `Bot ${token.body.token}` } };
}

async function makeAgent(name: string, adapter: 'codex' | 'claude'): Promise<Agent> {
    const bot = await makeBot(name);
    const profile = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
        .send({ name, botId: bot.botId, hostId, adapter, workdirAlias: 'agora', model: 'm', effort: 'high' });
    expect(profile.status, JSON.stringify(profile.body)).toBe(201);
    // These tests cover the ordinary authority rules, which apply to API-key profiles;
    // subscription profiles (owner only) are in provider-terms.integration.test.ts
    await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'api_key', api_key_env = 'ANTHROPIC_API_KEY' WHERE id = $1`, [profile.body.id]);
    return { ...bot, profileId: profile.body.id, name };
}

/** Sessions are started by /start in S4; here they are inserted directly. */
async function startSession(agent: Agent, overrides: Record<string, unknown> = {}): Promise<string> {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by, native_session_id, summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, serverId, channelId, agent.botId, agent.profileId, owner.userId,
         overrides.native ?? null, overrides.summary ?? null]
    );
    return id;
}

async function post(auth: object, content: string, extra: object = {}): Promise<any> {
    const res = await ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content, ...extra });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    return res.body;
}

async function reply(auth: object, threadId: string, content: string, extra: object = {}): Promise<any> {
    const res = await ctx.request.post(`/channels/${channelId}/messages/${threadId}/replies`).set(auth).send({ content, ...extra });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    return res.body;
}

async function inbox(sessionId: string): Promise<Array<{ message_id: string; reason: string; acked: boolean }>> {
    const rows = await ctx.db.query(
        `SELECT message_id, reason, acked_at IS NOT NULL AS acked FROM agent_inbox WHERE session_id = $1 ORDER BY id`,
        [sessionId]
    );
    return rows.rows.map((r: any) => ({ message_id: r.message_id.trim(), reason: r.reason, acked: r.acked }));
}

async function claim(wait = 0) {
    return ctx.request.get(`/agent-hosts/@me/runs/next?wait=${wait}`).set(hostAuth);
}

/** Wait until some backend is blocked on a lock: the competing operation has really started. */
async function waitForLockWait(timeoutMs = 5000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        const r = await ctx.db.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
        );
        if (r.rows[0].n > 0) return;
        await new Promise(res => setTimeout(res, 25));
    }
    throw new Error('no backend ever waited on a lock');
}

/** agora-host's dependencies are needed for the cross-package contract test. */
const hostDepsInstalled = existsSync(join(__dirname, '../../agora-host/node_modules/zod'));

async function resetSessions() {
    await ctx.db.query('TRUNCATE agent_runs, agent_inbox, agent_batches, agent_session_threads, agent_sessions CASCADE');
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'asowner');
    const server = await createServer(ctx.request, owner.auth, 'Sessions Server');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    member = await authedUser(ctx.request, 'asmember');
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 1000, max_bot_hops = 1000, max_thread_bot_hops = 0 WHERE id = $1', [channelId]);

    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
    expect(host.status).toBe(201);
    hostId = host.body.host.id;
    hostAuth = { Authorization: `AgentHost ${host.body.token}` };

    codex = await makeAgent('codex', 'codex');
    claude = await makeAgent('claude', 'claude');
    outsider = { ...(await makeBot('outsider')), profileId: '', name: 'outsider' };
});

afterAll(async () => {
    await ctx.close();
});

beforeEach(resetSessions);

describe('workspace lifecycle and branch reports', () => {
    it('defers cleanup until the ended session’s claim settles and lets its historical host reconcile after a profile move', async () => {
        const id = await startSession(codex);
        await post(owner.auth, '@codex work');
        const c = (await claim()).body;
        const url = '/agent-hosts/@me/workspaces/reconcile';
        await ctx.request.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'end', profile: 'codex' });
        expect((await ctx.request.post(url).set(hostAuth).send({ sessionIds: [id] })).body).toEqual([]);
        const other = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'moved-wsi-host' });
        try {
            expect((await ctx.request.patch(`/servers/${serverId}/agent-profiles/${codex.profileId}`).set(owner.auth).send({ hostId: other.body.host.id })).status).toBe(200);
            expect((await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/fail`).set(hostAuth).send({ claimToken: c.run.claimToken, error: 'cancelled' })).status).toBe(200);
            expect((await ctx.request.post(url).set(hostAuth).send({ sessionIds: [id] })).body).toEqual([id]);
        } finally {
            await ctx.request.patch(`/servers/${serverId}/agent-profiles/${codex.profileId}`).set(owner.auth).send({ hostId });
        }
    });
    it('stores branch/base/head through completion and session listing; rejects partial or foreign reports', async () => {
        const id = await startSession(codex);
        await post(owner.auth, '@codex work');
        const c = (await claim()).body;
        const url = `/agent-hosts/@me/runs/${c.run.id}/complete`;
        expect((await ctx.request.post(url).set(hostAuth).send({ claimToken: c.run.claimToken, branch: `agora/codex/${id}` })).status).toBe(400);
        expect((await ctx.request.post(url).set(hostAuth).send({ claimToken: c.run.claimToken, branch: `agora/codex/${generateUlid()}`, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) })).status).toBe(400);
        const fields = { branch: `agora/codex/${id}`, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
        expect((await ctx.request.post(url).set(hostAuth).send({ claimToken: c.run.claimToken, ...fields })).status).toBe(200);
        const list = await ctx.request.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'sessions' });
        expect(list.body.sessions[0]).toMatchObject(fields);
        const run = await ctx.db.query('SELECT branch, base_sha, head_sha FROM agent_runs WHERE id = $1', [c.run.id]);
        expect(run.rows[0]).toMatchObject({ branch: fields.branch, base_sha: fields.baseSha, head_sha: fields.headSha });
    });
    it('reconciles idle ended sessions only for their host, and posts dirty-file warnings', async () => {
        const id = await startSession(codex);
        const url = '/agent-hosts/@me/workspaces/reconcile';
        expect((await ctx.request.post(url).set(hostAuth).send({ sessionIds: [id] })).body).toEqual([]);
        await ctx.request.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'end', profile: 'codex' });
        expect((await ctx.request.post(url).set(hostAuth).send({ sessionIds: [id] })).body).toEqual([id]);
        const other = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'other-wsi' });
        const otherAuth = { Authorization: `AgentHost ${other.body.token}` };
        expect((await ctx.request.post(url).set(otherAuth).send({ sessionIds: [id] })).body).toEqual([]);
        const warning = '/agent-hosts/@me/workspaces/warning';
        expect((await ctx.request.post(warning).set(otherAuth).send({ sessionId: id, paths: ['dirty.txt'] })).status).toBe(404);
        expect((await ctx.request.post(warning).set(hostAuth).send({ sessionId: id, paths: ['dirty.txt'] })).status).toBe(200);
        expect((await ctx.db.query(`SELECT content FROM messages WHERE channel_id = $1 ORDER BY id DESC LIMIT 1`, [channelId])).rows[0].content).toContain('dirty.txt');
    });
});

describe('client_key (S0)', () => {
    it('returns the first post on a repeat to the same place with the same content', async () => {
        const first = await post(codex.auth, 'hello once', { client_key: 'k-1' });
        const again = await ctx.request.post(`/channels/${channelId}/messages`).set(codex.auth).send({ content: 'hello once', client_key: 'k-1' });
        expect(again.status).toBe(200);
        expect(again.body.id).toBe(first.id);
        expect(again.body.replayed).toBe(true);
        const count = await ctx.db.query(`SELECT count(*)::int AS n FROM messages WHERE client_key = 'k-1'`);
        expect(count.rows[0].n).toBe(1);
    });

    it('refuses the same key with other content or in a thread', async () => {
        const first = await post(codex.auth, 'original', { client_key: 'k-2' });
        const other = await ctx.request.post(`/channels/${channelId}/messages`).set(codex.auth).send({ content: 'changed', client_key: 'k-2' });
        expect(other.status).toBe(409);
        expect(other.body.error).toBe('client_key_conflict');
        const inThread = await ctx.request.post(`/channels/${channelId}/messages/${first.id}/replies`).set(codex.auth).send({ content: 'original', client_key: 'k-2' });
        expect(inThread.status).toBe(409);
    });

    it('lets two authors use the same key', async () => {
        const a = await post(codex.auth, 'same text', { client_key: 'shared' });
        const b = await post(claude.auth, 'same text', { client_key: 'shared' });
        expect(a.id).not.toBe(b.id);
    });

    it('inserts one row when two posts with one key race', async () => {
        const send = () => ctx.request.post(`/channels/${channelId}/messages`).set(codex.auth).send({ content: 'race', client_key: 'k-race' });
        const [x, y] = await Promise.all([send(), send()]);
        expect([x.status, y.status].sort()).toEqual([200, 201]);
        expect(x.body.id).toBe(y.body.id);
    });

    it('does not replay into a channel the bot lost access to', async () => {
        const bot = await makeBot('keyloser');
        await post(bot.auth, 'before', { client_key: 'k-lost' });
        await ctx.request.delete(`/channels/${channelId}/bots/${bot.botId}`).set(owner.auth);
        const res = await ctx.request.post(`/channels/${channelId}/messages`).set(bot.auth).send({ content: 'before', client_key: 'k-lost' });
        expect(res.status).toBe(403);
    });
});

describe('wake routing (S1)', () => {
    it('wakes a mentioned agent on the owner\'s post, and not on a member\'s', async () => {
        const s1 = await startSession(codex);
        await startSession(claude);
        const m = await post(owner.auth, '@codex please look at this');
        await post(member.auth, '@codex do something else');
        expect(await inbox(s1)).toEqual([{ message_id: m.id, reason: 'direct', acked: false }]);
    });

    it('wakes the only live agent without a mention', async () => {
        const s1 = await startSession(codex);
        const m = await post(owner.auth, 'anyone around?');
        expect((await inbox(s1)).map(r => r.message_id)).toEqual([m.id]);
    });

    it('does not wake on other bots\' chatter or in unbound threads', async () => {
        const s1 = await startSession(codex);
        const p = await post(outsider.auth, '@codex do my bidding');
        await reply(outsider.auth, p.id, '[AGORA/v1 MODE=plan STATE=TURN]\nhi\n[YIELD to=codex]');
        expect(await inbox(s1)).toEqual([]);
    });

    it('binds a thread on a top-level START and routes the protocol inside it', async () => {
        const sx = await startSession(codex);
        const sc = await startSession(claude);
        const start = await post(claude.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [claude, codex]\ntask: x');
        expect(await inbox(sx)).toEqual([{ message_id: start.id, reason: 'protocol', acked: false }]);
        const binding = await ctx.db.query('SELECT state FROM agent_session_threads WHERE thread_id = $1', [start.id]);
        expect(binding.rows[0].state).toBe('open');

        const ack = await reply(codex.auth, start.id, '[AGORA/v1 MODE=plan STATE=ACK]\nok');
        expect((await inbox(sc)).map(r => [r.message_id, r.reason])).toEqual([[ack.id, 'protocol']]);

        const turn = await reply(claude.auth, start.id, '[AGORA/v1 MODE=plan STATE=TURN]\nidea\n[YIELD to=codex]');
        expect((await inbox(sx)).map(r => r.message_id)).toContain(turn.id);

        const decide = await reply(codex.auth, start.id, '[AGORA/v1 MODE=plan STATE=DECIDE]\nAGREE');
        expect((await inbox(sc)).map(r => r.message_id)).toContain(decide.id);
    });

    it('binds nothing for a START from a bot without a session or naming no live agent', async () => {
        await startSession(codex);
        const a = await post(outsider.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [outsider, codex]');
        const b = await post(codex.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [codex, nobody]');
        const rows = await ctx.db.query('SELECT thread_id FROM agent_session_threads WHERE thread_id = ANY($1)', [[a.id, b.id]]);
        expect(rows.rows).toEqual([]);
    });

    it('ignores a YIELD to a non-participant and protocol from non-participants', async () => {
        const sx = await startSession(codex);
        await startSession(claude);
        const start = await post(claude.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [claude, codex]');
        await reply(claude.auth, start.id, '[AGORA/v1 MODE=plan STATE=TURN]\nx\n[YIELD to=outsider]');
        await reply(outsider.auth, start.id, '[AGORA/v1 MODE=plan STATE=TURN]\ny\n[YIELD to=codex]');
        expect((await inbox(sx)).map(r => r.reason)).toEqual(['protocol']); // only the START
    });

    it('a non-participant\'s DONE or CANCEL does not close the thread; a director\'s CANCEL does', async () => {
        await startSession(codex);
        await startSession(claude);
        const start = await post(claude.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [claude, codex]');
        await reply(outsider.auth, start.id, '[AGORA/v1 MODE=plan STATE=DONE]\nfake');
        await reply(member.auth, start.id, '[AGORA/v1 MODE=plan STATE=CANCEL]');
        let binding = await ctx.db.query('SELECT state FROM agent_session_threads WHERE thread_id = $1', [start.id]);
        expect(binding.rows[0].state).toBe('open');
        await reply(owner.auth, start.id, '[AGORA/v1 MODE=plan STATE=CANCEL]');
        binding = await ctx.db.query('SELECT state FROM agent_session_threads WHERE thread_id = $1', [start.id]);
        expect(binding.rows[0].state).toBe('closed');
    });

    it('DONE from a participant closes the thread and drops its queued handoffs', async () => {
        const sx = await startSession(codex);
        await startSession(claude);
        const start = await post(claude.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [claude, codex]');
        await reply(claude.auth, start.id, '[AGORA/v1 MODE=plan STATE=DONE]\nfinished');
        expect((await inbox(sx)).every(r => r.acked)).toBe(true);
    });

    it('a director\'s message in a bound thread reaches every participant', async () => {
        const sx = await startSession(codex);
        const sc = await startSession(claude);
        const start = await post(claude.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [claude, codex]');
        const d = await reply(owner.auth, start.id, 'both of you: focus on tests');
        expect((await inbox(sx)).map(r => r.message_id)).toContain(d.id);
        expect((await inbox(sc)).map(r => r.message_id)).toContain(d.id);
    });
});

describe('thread and case-insensitive mentions (#120)', () => {
    async function noticesSince(since: string): Promise<Array<{ content: string; thread: string | null }>> {
        const rows = await ctx.db.query(
            `SELECT content, thread_id FROM messages WHERE channel_id = $1 AND author_id IS NULL AND system_event = 'agent_session' AND id > $2 ORDER BY id`,
            [channelId, since]);
        return rows.rows.map((r: any) => ({ content: r.content, thread: r.thread_id?.trim() ?? null }));
    }
    async function threadRows(sessionId: string) {
        const rows = await ctx.db.query(`SELECT message_id, thread_id, reason FROM agent_inbox WHERE session_id = $1 ORDER BY id`, [sessionId]);
        return rows.rows.map((r: any) => ({ message_id: r.message_id.trim(), thread_id: r.thread_id?.trim() ?? null, reason: r.reason }));
    }

    it('the original repro: the owner\'s @codex reply in a thread another bot\'s session started wakes codex there', async () => {
        const sx = await startSession(codex);
        await startSession(claude);
        const parent = await post(claude.auth, 'Opened the PR, details in this thread');
        const r = await reply(owner.auth, parent.id, '@codex check the PR');
        expect(await threadRows(sx)).toEqual([{ message_id: r.id, thread_id: parent.id, reason: 'direct' }]);

        // The host gets the thread as the destination for the reply
        const c = await claim();
        expect(c.status).toBe(200);
        expect(c.body.session.id).toBe(sx);
        expect(c.body.inbox).toEqual([expect.objectContaining({ messageId: r.id, threadId: parent.id, reason: 'direct', authority: 'owner' })]);
    });

    it('wakes only the mentioned agent, and nobody on a member\'s mention', async () => {
        const sx = await startSession(codex);
        const sc = await startSession(claude);
        const parent = await post(member.auth, 'a question');
        await reply(member.auth, parent.id, '@codex can you look?');
        expect(await inbox(sx)).toEqual([]);
        const r = await reply(owner.auth, parent.id, '@claude can you look?');
        expect(await inbox(sx)).toEqual([]);
        expect((await inbox(sc)).map(x => x.message_id)).toEqual([r.id]);
    });

    it('a thread reply without a mention still wakes nobody outside a bound thread', async () => {
        const sx = await startSession(codex);
        const parent = await post(owner.auth, 'top');
        await ctx.db.query('TRUNCATE agent_inbox CASCADE');
        await reply(owner.auth, parent.id, 'no mention here');
        expect(await inbox(sx)).toEqual([]);
    });

    it('resolves mentions case-insensitively, top level and in threads', async () => {
        const mixed = await makeBot('MixCase');
        const profile = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
            .send({ name: 'mixcase', botId: mixed.botId, hostId, adapter: 'codex', workdirAlias: 'agora' });
        expect(profile.status, JSON.stringify(profile.body)).toBe(201);
        await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'api_key', api_key_env = 'CODEX_API_KEY' WHERE id = $1`, [profile.body.id]);
        const sm = await startSession({ ...mixed, profileId: profile.body.id, name: 'mixcase' });
        const sx = await startSession(codex);

        const top = await post(owner.auth, '@mixcase describe this image');
        expect(top.mentions).toEqual([mixed.botId]);
        const loud = await reply(owner.auth, top.id, '@CODEX and you too');
        expect(loud.mentions).toEqual([codex.botId]);
        expect((await inbox(sm)).map(x => x.message_id)).toEqual([top.id]);
        expect((await inbox(sx)).map(x => x.message_id)).toEqual([loud.id]);

        const everyone = await post(member.auth, 'hello @Everyone');
        expect(everyone.mentionsEveryone).toBe(true);
    });

    it('a mention of a non-participant in a bound thread wakes it; participants keep the bound rules', async () => {
        const sx = await startSession(codex);
        const sc = await startSession(claude);
        const third = await makeAgent('third', 'claude');
        const st = await startSession(third);
        const start = await post(claude.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [claude, codex]\ntask: x');
        const r = await reply(owner.auth, start.id, '@third please review this plan');
        expect((await threadRows(st))).toEqual([{ message_id: r.id, thread_id: start.id, reason: 'direct' }]);
        // Participants hear a director in the thread, mentioned or not (unchanged)
        expect((await inbox(sx)).map(x => x.message_id)).toContain(r.id);
        expect((await inbox(sc)).map(x => x.message_id)).toContain(r.id);
    });

    it('a task card session in its thread takes the mention, not the agent\'s channel session too', async () => {
        const channelSession = await startSession(codex);
        const parent = await post(owner.auth, 'card thread');
        const scopedId = generateUlid();
        await ctx.db.query(
            `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by, thread_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [scopedId, serverId, channelId, codex.botId, codex.profileId, owner.userId, parent.id]);
        await ctx.db.query('TRUNCATE agent_inbox CASCADE');
        const r = await reply(owner.auth, parent.id, '@codex go');
        expect((await inbox(scopedId)).map(x => x.message_id)).toEqual([r.id]);
        expect(await inbox(channelSession)).toEqual([]);
    });

    it('says why when an authorised mention of a known agent wakes nothing: no live session', async () => {
        await startSession(claude);
        const parent = await post(claude.auth, 'thread by another agent');
        const since = generateUlid();
        const r = await reply(owner.auth, parent.id, '@codex check the PR');
        expect(r.id).toBeTruthy();
        expect(await noticesSince(since)).toEqual([
            { content: 'codex has no live session here, so nothing woke it. Start one with /start codex.', thread: parent.id },
        ]);
        // Top level too, and the parent's reply count includes the notice
        const since2 = generateUlid();
        await post(owner.auth, '@Codex are you there?');
        expect(await noticesSince(since2)).toEqual([
            { content: 'codex has no live session here, so nothing woke it. Start one with /start codex.', thread: null },
        ]);
        const count = await ctx.db.query('SELECT reply_count FROM messages WHERE id = $1', [parent.id]);
        expect(count.rows[0].reply_count).toBe(2);
    });

    it('no notice for a member\'s mention, a plain bot mention, or a woken agent', async () => {
        await startSession(codex);
        const since = generateUlid();
        await post(member.auth, '@claude hello?');
        await post(owner.auth, '@outsider hello?');
        await post(owner.auth, '@codex hello?');
        expect(await noticesSince(since)).toEqual([]);
    });
});

describe('commands (S4)', () => {
    const cmd = (auth: object, body: object) => ctx.request.post(`/channels/${channelId}/agent-commands`).set(auth).send(body);

    it('/start creates a session, posts a notice and wakes the agent with it', async () => {
        const res = await cmd(owner.auth, { command: 'start', profile: 'codex' });
        expect(res.status).toBe(201);
        expect(res.body.action).toBe('started');
        const c = await claim();
        expect(c.status).toBe(200);
        expect(c.body.session.id).toBe(res.body.session.id);
        expect(c.body.inbox).toEqual([expect.objectContaining({ reason: 'command', authorId: null })]);
        expect(c.body.inbox[0].content).toMatch(/started a codex session/);
    });

    it('only the owner and directors can start; anyone with access can list', async () => {
        expect((await cmd(member.auth, { command: 'start', profile: 'codex' })).status).toBe(403);
        expect((await cmd(outsider.auth, { command: 'start', profile: 'codex' })).status).toBe(403);
        await cmd(owner.auth, { command: 'start', profile: 'codex' });
        const list = await cmd(member.auth, { command: 'sessions' });
        expect(list.status).toBe(200);
        expect(list.body.sessions).toEqual([expect.objectContaining({ profile: 'codex', state: 'live', running: false })]);
    });

    it('/start with a live session asks, then keeps or shelves and starts fresh', async () => {
        const first = await cmd(owner.auth, { command: 'start', profile: 'codex' });
        const ask = await cmd(owner.auth, { command: 'start', profile: 'codex' });
        expect(ask.status).toBe(409);
        expect(ask.body).toMatchObject({ error: 'session_live', session: { id: first.body.session.id } });
        const keep = await cmd(owner.auth, { command: 'start', profile: 'codex', onLive: 'keep' });
        expect(keep.body).toMatchObject({ action: 'kept', session: { id: first.body.session.id } });
        const shelve = await cmd(owner.auth, { command: 'start', profile: 'codex', onLive: 'shelve' });
        expect(shelve.status).toBe(201);
        expect(shelve.body.session.id).not.toBe(first.body.session.id);
        const old = await ctx.db.query('SELECT state, end_reason FROM agent_sessions WHERE id = $1', [first.body.session.id]);
        expect(old.rows[0]).toMatchObject({ state: 'shelved', end_reason: 'replaced' });
    });

    it('/start resumes this profile\'s latest shelved session, never another profile\'s', async () => {
        const a = await cmd(owner.auth, { command: 'start', profile: 'codex' });
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved', shelved_at = NOW() WHERE id = $1`, [a.body.session.id]);
        // A second profile for the same bot
        const p2 = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
            .send({ name: 'codex-review', botId: codex.botId, hostId, adapter: 'codex', workdirAlias: 'agora', effort: 'high' });
        expect(p2.status).toBe(201);
        try {
            const b = await cmd(owner.auth, { command: 'start', profile: 'codex-review' });
            expect(b.body.action).toBe('started'); // not codex's shelved session
            const conflict = await cmd(owner.auth, { command: 'start', profile: 'codex' });
            expect(conflict.status).toBe(409); // the bot is live here under codex-review
            await cmd(owner.auth, { command: 'end', profile: 'codex-review' });
            const r = await cmd(owner.auth, { command: 'start', profile: 'codex' });
            expect(r.body).toMatchObject({ action: 'resumed', session: { id: a.body.session.id } });
        } finally {
            await ctx.db.query(`UPDATE agent_sessions SET state = 'ended' WHERE profile_id = $1`, [p2.body.id]);
            await resetSessions();
            await ctx.request.delete(`/servers/${serverId}/agent-profiles/${p2.body.id}`).set(owner.auth);
        }
    });

    it('/end during a run cancels it and drops queued work', async () => {
        const s = await cmd(owner.auth, { command: 'start', profile: 'codex' });
        const c = await claim();
        const listed = await cmd(owner.auth, { command: 'sessions' });
        expect(listed.body.sessions).toEqual([expect.objectContaining({ id: s.body.session.id, running: true })]);
        await post(owner.auth, '@codex queued while running');
        const end = await cmd(owner.auth, { command: 'end', profile: 'codex' });
        expect(end.body.action).toBe('ended');
        const hb = await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/heartbeat`).set(hostAuth).send({ claimToken: c.body.run.claimToken });
        expect(hb.body).toEqual({ cancel: true, reason: 'ended' });
        expect((await inbox(s.body.session.id)).every(r => r.acked || r.reason === 'command')).toBe(true);
        expect((await cmd(owner.auth, { command: 'end', profile: 'codex' })).status).toBe(404);
    });

    it('/resume takes only shelved sessions of this channel', async () => {
        const a = await cmd(owner.auth, { command: 'start', profile: 'codex' });
        const id = a.body.session.id;
        expect((await cmd(owner.auth, { command: 'resume', sessionId: id })).status).toBe(400); // live, not shelved
        await cmd(owner.auth, { command: 'end', profile: 'codex' });
        expect((await cmd(owner.auth, { command: 'resume', sessionId: id })).status).toBe(400); // ended
        const b = await cmd(owner.auth, { command: 'start', profile: 'codex' });
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved', shelved_at = NOW() WHERE id = $1`, [b.body.session.id]);
        const r = await cmd(owner.auth, { command: 'resume', sessionId: b.body.session.id });
        expect(r.body).toMatchObject({ action: 'resumed', session: { state: 'live' } });
    });

    it('refuses an unknown profile and a bot without access to the channel', async () => {
        expect((await cmd(owner.auth, { command: 'start', profile: 'nope' })).status).toBe(404);
        const lone = await makeBot('lonebot');
        await ctx.request.delete(`/channels/${channelId}/bots/${lone.botId}`).set(owner.auth);
        const p = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
            .send({ name: 'lone', botId: lone.botId, hostId, adapter: 'claude', workdirAlias: 'x' });
        const res = await cmd(owner.auth, { command: 'start', profile: 'lone' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('bot_not_in_channel');
        await ctx.request.delete(`/servers/${serverId}/agent-profiles/${p.body.id}`).set(owner.auth);
    });

    it('a bot with can_direct can start sessions (orchestrator)', async () => {
        await ctx.request.put(`/channels/${channelId}/bots/${claude.botId}/direct`).set(owner.auth).send({ canDirect: true });
        try {
            const res = await cmd(claude.auth, { command: 'start', profile: 'codex' });
            expect(res.status).toBe(201);
        } finally {
            await ctx.request.put(`/channels/${channelId}/bots/${claude.botId}/direct`).set(owner.auth).send({ canDirect: false });
        }
    });
    it('/start from a bot without can_direct says cannot_direct, with its name and the channel (#75)', async () => {
        const res = await cmd(claude.auth, { command: 'start', profile: 'codex' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('cannot_direct');
        expect(res.body.message).toMatch(/^claude can't direct agents in #general; ask the server owner to grant DirectAgents/);
    });
});

describe('session_wake: require_direct (#75)', () => {
    const wake = (auth: object, content: string) =>
        ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content, require_direct: true });

    it('refuses a wake from a bot that cannot direct: nothing is posted, nothing is queued', async () => {
        const session = await startSession(codex);
        const before = await ctx.db.query('SELECT count(*)::int AS n FROM messages WHERE channel_id = $1', [channelId]);
        const res = await wake(claude.auth, '@codex review PR 62');
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: 'cannot_direct', username: 'claude', channel: 'general' });
        expect(res.body.message).toMatch(/or @ the agent yourself/);
        const after = await ctx.db.query('SELECT count(*)::int AS n FROM messages WHERE channel_id = $1', [channelId]);
        expect(after.rows[0].n).toBe(before.rows[0].n);
        expect(await inbox(session)).toEqual([]);
    });

    it('refuses a member without DirectAgents too', async () => {
        await startSession(codex);
        expect((await wake(member.auth, '@codex hi')).body.error).toBe('cannot_direct');
    });

    it('posts and wakes when the caller can direct', async () => {
        const session = await startSession(codex);
        await ctx.request.put(`/channels/${channelId}/bots/${claude.botId}/direct`).set(owner.auth).send({ canDirect: true });
        try {
            const res = await wake(claude.auth, '@codex review PR 62');
            expect(res.status).toBe(201);
            expect(await inbox(session)).toEqual([{ message_id: res.body.id, reason: 'direct', acked: false }]);
        } finally {
            await ctx.request.put(`/channels/${channelId}/bots/${claude.botId}/direct`).set(owner.auth).send({ canDirect: false });
        }
    });

    it('a post without require_direct still goes through, as before', async () => {
        await startSession(codex);
        await post(claude.auth, '@codex just chatting');
    });
});

describe('host API (S2)', () => {
    it('refuses host tokens elsewhere and other tokens on host routes', async () => {
        expect((await ctx.request.get(`/servers/${serverId}/agent-profiles`).set(hostAuth)).status).toBe(403);
        expect((await ctx.request.get('/agent-hosts/@me/runs/next').set(owner.auth)).status).toBe(403);
        expect((await ctx.request.get('/agent-hosts/@me/runs/next').set(codex.auth)).status).toBe(403);
        expect((await ctx.request.get('/agent-hosts/@me/runs/next').set({ Authorization: 'AgentHost ah_bad' })).status).toBe(401);
    });

    it('returns 204 when there is nothing to do', async () => {
        expect((await claim()).status).toBe(204);
    });

    it('broadcasts host run transitions to the channel room', async () => {
        const sessionId = await startSession(codex);
        await post(owner.auth, '@codex run');
        const emit = vi.fn();
        const room = vi.spyOn(ctx.app.io, 'to').mockReturnValue({ emit } as any);
        try {
            const c = await claim();
            expect(c.status).toBe(200);
            await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('AgentSessionUpdate', expect.objectContaining({ channelId, sessionId, running: true })));
            expect(room).toHaveBeenCalledWith(`channel:${channelId}`);
            await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/complete`).set(hostAuth)
                .send({ claimToken: c.body.run.claimToken });
            await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('AgentSessionUpdate', expect.objectContaining({ channelId, sessionId, running: false })));
        } finally { room.mockRestore(); }
    });

    it('returns running events on claim, success, failure, and expiry', async () => {
        const sessionId = await startSession(codex);
        const host = { id: hostId, serverId };
        const notices: Notice[] = [];
        const expectUpdate = (running: boolean) => {
            expect(notices.filter(n => n.eventName === 'AgentSessionUpdate').at(-1)).toEqual({
                channelId, eventName: 'AgentSessionUpdate', event: expect.objectContaining({ channelId, sessionId, running }),
            });
            notices.length = 0;
        };
        for (const finish of ['success', 'failure', 'expiry']) {
            await post(owner.auth, '@codex work');
            const run = (await claimNext(ctx.db, host, notices))!.run;
            expectUpdate(true);
            if (finish === 'success') await complete(ctx.db, host, run.id, { claimToken: run.claimToken }, notices);
            if (finish === 'failure') await fail(ctx.db, host, run.id, { claimToken: run.claimToken, error: 'test' }, notices);
            if (finish === 'expiry') {
                await ctx.db.query("UPDATE agent_runs SET lease_until = NOW() - interval '1 second' WHERE id = $1", [run.id]);
                await sweepExpiredRuns(ctx.db, notices);
            }
            expectUpdate(false);
        }
    });

    it('claims a batch with content, then completes it', async () => {
        const s = await startSession(codex, { summary: 'earlier work' });
        const m = await post(owner.auth, '@codex weather please');
        const c = await claim();
        expect(c.status).toBe(200);
        expect(c.body.session).toMatchObject({ id: s, summary: 'earlier work', wakesUsed: 1, lurkMode: null });
        expect(c.body.profile).toMatchObject({ name: 'codex', adapter: 'codex', workdirAlias: 'agora' });
        expect(c.body.inbox).toEqual([expect.objectContaining({
            messageId: m.id, reason: 'direct', authority: 'owner', content: '@codex weather please',
        })]);
        expect(c.body.run.deliveryKey).toMatch(/^dk_/);
        expect(c.body.run.leaseUntil).toBeTruthy();

        // One run per session at a time
        await post(owner.auth, '@codex and another thing');
        expect((await claim()).status).toBe(204);

        const done = await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/complete`).set(hostAuth)
            .send({ claimToken: c.body.run.claimToken, nativeSessionId: 'native-1', tokensUsed: 1000, summary: 'answered' });
        expect(done.body).toEqual({ ok: true });
        const session = await ctx.db.query('SELECT native_session_id, tokens_used, summary FROM agent_sessions WHERE id = $1', [s]);
        expect(session.rows[0]).toMatchObject({ native_session_id: 'native-1', summary: 'answered' });
        expect(Number(session.rows[0].tokens_used)).toBe(1000);

        // The message that arrived during the run is the next batch
        const next = await claim();
        expect(next.status).toBe(200);
        expect(next.body.inbox.map((i: any) => i.content)).toEqual(['@codex and another thing']);
    });

    it('two concurrent claims take a session once', async () => {
        await startSession(codex);
        await post(owner.auth, 'only you');
        const [a, b] = await Promise.all([claim(), claim()]);
        expect([a.status, b.status].sort()).toEqual([200, 204]);
    });

    it('takes at most 20 rows per batch, oldest first', async () => {
        const s = await startSession(codex);
        for (let i = 0; i < 22; i++) await post(owner.auth, `msg ${i}`);
        const c = await claim();
        expect(c.body.inbox).toHaveLength(20);
        expect(c.body.inbox[0].content).toBe('msg 0');
        await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/complete`).set(hostAuth).send({ claimToken: c.body.run.claimToken });
        const c2 = await claim();
        expect(c2.body.inbox.map((i: any) => i.content)).toEqual(['msg 20', 'msg 21']);
        expect((await inbox(s)).every(r => r.acked) === false).toBe(true);
    });

    it('acknowledges rows whose author lost authority before the claim', async () => {
        const s = await startSession(codex);
        const role = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth)
            .send({ name: 'Dir', permissions: (1n << 29n).toString() });
        await ctx.request.put(`/servers/${serverId}/members/${member.userId}/roles/${role.body.id}`).set(owner.auth);
        await post(member.auth, '@codex do it');
        expect(await inbox(s)).toHaveLength(1);
        await ctx.request.delete(`/servers/${serverId}/members/${member.userId}/roles/${role.body.id}`).set(owner.auth);
        expect((await claim()).status).toBe(204);
        expect((await inbox(s))[0].acked).toBe(true);
    });

    it('acknowledges work for a paused bot', async () => {
        const s = await startSession(codex);
        await post(owner.auth, '@codex hi');
        await ctx.db.query('UPDATE users SET bot_paused_at = NOW() WHERE id = $1', [codex.botId]);
        try {
            expect((await claim()).status).toBe(204);
            expect((await inbox(s))[0].acked).toBe(true);
        } finally {
            await ctx.db.query('UPDATE users SET bot_paused_at = NULL WHERE id = $1', [codex.botId]);
        }
    });

    it('fences stale claims and treats repeats safely', async () => {
        await startSession(codex);
        await post(owner.auth, '@codex go');
        const c = await claim();
        const url = `/agent-hosts/@me/runs/${c.body.run.id}`;
        expect((await ctx.request.post(`${url}/heartbeat`).set(hostAuth).send({ claimToken: 'rt_wrong_token' })).status).toBe(409);
        const hb = await ctx.request.post(`${url}/heartbeat`).set(hostAuth).send({ claimToken: c.body.run.claimToken });
        expect(hb.body.cancel).toBe(false);

        const body = { claimToken: c.body.run.claimToken, tokensUsed: 10 };
        expect((await ctx.request.post(`${url}/complete`).set(hostAuth).send(body)).body).toEqual({ ok: true });
        const again = await ctx.request.post(`${url}/complete`).set(hostAuth).send(body);
        expect(again.status).toBe(200);
        expect(again.body.repeated).toBe(true);
        const f = await ctx.request.post(`${url}/fail`).set(hostAuth).send({ claimToken: c.body.run.claimToken, error: 'x' });
        expect(f.status).toBe(409);
        expect(f.body.error).toBe('already_finished');
        // Usage was charged once
        const s = await ctx.db.query('SELECT tokens_used FROM agent_sessions WHERE bot_id = $1 AND state = $2', [codex.botId, 'live']);
        expect(Number(s.rows[0].tokens_used)).toBe(10);
    });

    it('checks the lease at request time, before the sweeper', async () => {
        await startSession(codex);
        await post(owner.auth, '@codex go');
        const c = await claim();
        await ctx.db.query(`UPDATE agent_runs SET lease_until = NOW() - interval '1 second' WHERE id = $1`, [c.body.run.id]);
        const res = await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/complete`).set(hostAuth).send({ claimToken: c.body.run.claimToken });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('lease_expired');
        const run = await ctx.db.query('SELECT status FROM agent_runs WHERE id = $1', [c.body.run.id]);
        expect(run.rows[0].status).toBe('expired');
    });

    it('retries a crashed batch unchanged, keeps new arrivals for later, and gives up after 3 attempts', async () => {
        await startSession(codex);
        await post(owner.auth, '@codex A');
        const first = await claim();
        await post(owner.auth, '@codex B'); // arrives during attempt 1

        for (let attempt = 1; attempt <= 3; attempt++) {
            const c = attempt === 1 ? first : await claim();
            expect(c.status).toBe(200);
            expect(c.body.run.attempt).toBe(attempt);
            expect(c.body.run.deliveryKey).toBe(first.body.run.deliveryKey);
            expect(c.body.inbox.map((i: any) => i.content)).toEqual(['@codex A']);
            await ctx.db.query(`UPDATE agent_runs SET lease_until = NOW() - interval '1 second' WHERE id = $1`, [c.body.run.id]);
            const notices: Notice[] = [];
            expect(await sweepExpiredRuns(ctx.db, notices)).toBe(1);
            expect(notices.filter(n => n.eventName === 'AgentSessionUpdate')).toHaveLength(1);
            if (attempt === 3) expect(notices.filter(n => !n.eventName || n.eventName === 'Message')).toHaveLength(1);
        }
        const next = await claim();
        expect(next.body.inbox.map((i: any) => i.content)).toEqual(['@codex B']);
        expect(next.body.run.deliveryKey).not.toBe(first.body.run.deliveryKey);
    });

    it('drops cancelled work on expiry instead of retrying it', async () => {
        await startSession(codex);
        await startSession(claude);
        const start = await post(claude.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [claude, codex]');
        const c = await claim();
        expect(c.body.profile.name).toBe('codex');
        await reply(owner.auth, start.id, '[AGORA/v1 MODE=plan STATE=CANCEL]');
        const hb = await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/heartbeat`).set(hostAuth).send({ claimToken: c.body.run.claimToken });
        expect(hb.body).toEqual({ cancel: true, reason: 'thread_cancelled' });
        await ctx.db.query(`UPDATE agent_runs SET lease_until = NOW() - interval '1 second' WHERE id = $1`, [c.body.run.id]);
        await sweepExpiredRuns(ctx.db, []);
        const batch = await ctx.db.query('SELECT status FROM agent_batches WHERE id = (SELECT batch_id FROM agent_runs WHERE id = $1)', [c.body.run.id]);
        expect(batch.rows[0].status).toBe('dropped');
        // Nothing left for codex (claude's ACK-free START produced nothing for claude either)
        expect((await claim()).status).toBe(204);
    });

    it('complete after a cancel records the work and is not retried', async () => {
        const s = await startSession(codex);
        await post(owner.auth, '@codex go');
        const c = await claim();
        await ctx.db.query(`UPDATE agent_runs SET cancel_requested = true, cancel_reason = 'ended' WHERE id = $1`, [c.body.run.id]);
        await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE id = $1`, [s]);
        const res = await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/complete`).set(hostAuth)
            .send({ claimToken: c.body.run.claimToken, tokensUsed: 50 });
        expect(res.body).toEqual({ ok: true, cancelled: true });
        const session = await ctx.db.query('SELECT tokens_used FROM agent_sessions WHERE id = $1', [s]);
        expect(Number(session.rows[0].tokens_used)).toBe(50);
    });

    it('charges failed usage and shelves the session at its token budget', async () => {
        const s = await startSession(codex);
        await ctx.db.query('UPDATE agent_profiles SET token_budget = 100 WHERE id = $1', [codex.profileId]);
        try {
            await post(owner.auth, '@codex go');
            const c = await claim();
            await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/fail`).set(hostAuth)
                .send({ claimToken: c.body.run.claimToken, error: 'cli_error', tokensUsed: 150, retryable: true });
            expect((await claim()).status).toBe(204); // budget reached: no claim
            const session = await ctx.db.query('SELECT state, end_reason, tokens_used FROM agent_sessions WHERE id = $1', [s]);
            expect(session.rows[0]).toMatchObject({ state: 'shelved', end_reason: 'budget' });
            expect(Number(session.rows[0].tokens_used)).toBe(150);
        } finally {
            await ctx.db.query('UPDATE agent_profiles SET token_budget = 2000000 WHERE id = $1', [codex.profileId]);
        }
    });

    it('shelves the session when its wake budget is used up', async () => {
        const s = await startSession(codex);
        await ctx.db.query('UPDATE agent_sessions SET wakes_used = 50 WHERE id = $1', [s]);
        await post(owner.auth, '@codex go');
        expect((await claim()).status).toBe(204);
        const session = await ctx.db.query('SELECT state, end_reason FROM agent_sessions WHERE id = $1', [s]);
        expect(session.rows[0]).toMatchObject({ state: 'shelved', end_reason: 'budget' });
    });

    it('a retry batch whose thread closed is dropped', async () => {
        await startSession(codex);
        await startSession(claude);
        const start = await post(claude.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [claude, codex]');
        const c = await claim();
        await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/fail`).set(hostAuth)
            .send({ claimToken: c.body.run.claimToken, error: 'crash', retryable: true });
        await reply(claude.auth, start.id, '[AGORA/v1 MODE=plan STATE=DONE]\nok');
        expect((await claim()).status).toBe(204);
        const batch = await ctx.db.query('SELECT status FROM agent_batches WHERE id = (SELECT batch_id FROM agent_runs WHERE id = $1)', [c.body.run.id]);
        expect(batch.rows[0].status).toBe('dropped');
    });

    it('a profile edit during a run keeps the old native ID from coming back', async () => {
        const s = await startSession(codex, { native: 'old-native' });
        await post(owner.auth, '@codex go');
        const c = await claim();
        expect(c.body.session.nativeSessionId).toBe('old-native');
        const patch = await ctx.request.patch(`/servers/${serverId}/agent-profiles/${codex.profileId}`).set(owner.auth).send({ workdirAlias: 'other' });
        expect(patch.status).toBe(200);
        await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/complete`).set(hostAuth)
            .send({ claimToken: c.body.run.claimToken, nativeSessionId: 'from-stale-run' });
        const session = await ctx.db.query('SELECT native_session_id FROM agent_sessions WHERE id = $1', [s]);
        expect(session.rows[0].native_session_id).toBeNull();
        await ctx.request.patch(`/servers/${serverId}/agent-profiles/${codex.profileId}`).set(owner.auth).send({ workdirAlias: 'agora' });
    });

    it('a revoked host is refused', async () => {
        const h = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'temp' });
        const auth = { Authorization: `AgentHost ${h.body.token}` };
        expect((await ctx.request.get('/agent-hosts/@me/runs/next').set(auth)).status).toBe(204);
        await ctx.request.delete(`/servers/${serverId}/agent-hosts/${h.body.host.id}`).set(owner.auth);
        expect((await ctx.request.get('/agent-hosts/@me/runs/next').set(auth)).status).toBe(401);
    });

    it('creates an agent in one step: bot, token, channel access and profile', async () => {
        const res = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
            .send({ name: 'gemma', adapter: 'claude', hostId, workdirAlias: 'agora', effort: 'medium', channelId });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.token).toMatch(/^bot_/);
        expect(res.body.profile).toMatchObject({ name: 'gemma', adapter: 'claude', effort: 'medium' });
        // The token works and the bot can read the channel
        const read = await ctx.request.get(`/channels/${channelId}/messages`).set({ Authorization: `Bot ${res.body.token}` });
        expect(read.status).toBe(200);
        // /start works right away
        const start = await ctx.request.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'start', profile: 'gemma' });
        expect(start.status).toBe(201);
        // Names are unique
        const dup = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
            .send({ name: 'gemma', adapter: 'claude', hostId, workdirAlias: 'agora' });
        expect(dup.status).toBe(409);
        expect((await ctx.request.post(`/servers/${serverId}/agents`).set(member.auth)
            .send({ name: 'x1', adapter: 'claude', hostId, workdirAlias: 'a' })).status).toBe(403);
    });

    it('a CANCEL that closes the thread while a claim waits leaves nothing to claim', async () => {
        await startSession(codex);
        await startSession(claude);
        const start = await post(claude.auth, '[AGORA/v1 MODE=plan STATE=START]\nparticipants: [claude, codex]');
        // Hold the binding the way a CANCEL in progress does, then let the claim start
        const cancel = await ctx.db.connect();
        try {
            await cancel.query('BEGIN');
            await cancel.query(`SELECT 1 FROM agent_session_threads WHERE thread_id = $1 FOR UPDATE`, [start.id]);
            const pending = claim();
            await waitForLockWait();
            await cancel.query(`UPDATE agent_session_threads SET state = 'closed', closed_at = NOW() WHERE thread_id = $1`, [start.id]);
            await cancel.query(`UPDATE agent_inbox SET acked_at = NOW() WHERE thread_id = $1 AND batch_id IS NULL AND acked_at IS NULL`, [start.id]);
            await cancel.query('COMMIT');
            expect((await pending).status).toBe(204);
        } finally {
            cancel.release();
        }
        const runs = await ctx.db.query('SELECT count(*)::int AS n FROM agent_runs');
        expect(runs.rows[0].n).toBe(0);
    });

    it('/end and a completion overlapping do not deadlock; the completion reports the cancel', async () => {
        const s = await startSession(codex);
        await post(owner.auth, '@codex go');
        const c = await claim();
        // Hold the session the way /end does, flag the run, and let complete wait behind it
        const end = await ctx.db.connect();
        try {
            await end.query('BEGIN');
            await end.query(`SELECT 1 FROM agent_sessions WHERE id = $1 FOR UPDATE`, [s]);
            // .then() starts the request now; a bare supertest request only starts when awaited
            const pending = ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/complete`).set(hostAuth)
                .send({ claimToken: c.body.run.claimToken, tokensUsed: 5 }).then(r => r);
            await waitForLockWait();
            await end.query(`UPDATE agent_runs SET cancel_requested = true, cancel_reason = 'ended' WHERE session_id = $1 AND status = 'claimed'`, [s]);
            await end.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE id = $1`, [s]);
            await end.query('COMMIT');
            const res = await pending;
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ ok: true, cancelled: true });
        } finally {
            end.release();
        }
    });

    it('a profile edit committing while a completion waits keeps the old native ID out', async () => {
        const s = await startSession(codex, { native: 'old-native' });
        await post(owner.auth, '@codex go');
        const c = await claim();
        const edit = await ctx.db.connect();
        try {
            await edit.query('BEGIN');
            await edit.query(`SELECT 1 FROM agent_profiles WHERE id = $1 FOR UPDATE`, [codex.profileId]);
            const pending = ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/complete`).set(hostAuth)
                .send({ claimToken: c.body.run.claimToken, nativeSessionId: 'from-stale-run' }).then(r => r);
            await waitForLockWait();
            await edit.query(`UPDATE agent_profiles SET generation = generation + 1 WHERE id = $1`, [codex.profileId]);
            await edit.query(`UPDATE agent_sessions SET native_session_id = NULL WHERE profile_id = $1`, [codex.profileId]);
            await edit.query('COMMIT');
            expect((await pending).status).toBe(200);
        } finally {
            edit.release();
        }
        const session = await ctx.db.query('SELECT native_session_id FROM agent_sessions WHERE id = $1', [s]);
        expect(session.rows[0].native_session_id).toBeNull();
    });

    it('a host revoked during its long poll gets 401, not work', async () => {
        const h = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'polling' });
        const auth = { Authorization: `AgentHost ${h.body.token}` };
        await ctx.db.query('UPDATE agent_profiles SET host_id = $1 WHERE id = $2', [h.body.host.id, codex.profileId]);
        try {
            await startSession(codex);
            const pending = ctx.request.get('/agent-hosts/@me/runs/next?wait=5').set(auth).then(r => r);
            // Wait until the poll has authenticated (it stamps last_seen_at) and is waiting
            const until = Date.now() + 5000;
            let authenticated = false;
            while (!authenticated && Date.now() < until) {
                const seen = await ctx.db.query('SELECT last_seen_at FROM agent_hosts WHERE id = $1', [h.body.host.id]);
                authenticated = !!seen.rows[0].last_seen_at;
                if (!authenticated) await new Promise(r => setTimeout(r, 25));
            }
            expect(authenticated, 'the poll authenticated before the revoke').toBe(true);
            await new Promise(r => setTimeout(r, 100));
            await ctx.request.delete(`/servers/${serverId}/agent-hosts/${h.body.host.id}`).set(owner.auth);
            await post(owner.auth, '@codex work for a revoked host');
            expect((await pending).status).toBe(401);
        } finally {
            await ctx.db.query('UPDATE agent_profiles SET host_id = $1 WHERE id = $2', [hostId, codex.profileId]);
        }
    });

    it('a post rejected for its attachments wakes nobody', async () => {
        const s = await startSession(codex);
        const res = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth)
            .send({ content: '@codex with a bad file', attachments: ['01J00000000000000000000000'] });
        expect(res.status).toBe(400);
        expect(await inbox(s)).toEqual([]);
    });

    // Cross-package contract check; run `npm ci` in agora-host/ to enable it
    it.skipIf(!hostDepsInstalled)('a real claim passes agora-host\'s claim parser (needs agora-host deps)', async () => {
        const { claimSchema } = await import('../../agora-host/src/types');
        // A profile with no model or effort, woken by a /start notice
        await ctx.db.query('UPDATE agent_profiles SET model = NULL, effort = NULL WHERE id = $1', [codex.profileId]);
        try {
            const started = await ctx.request.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send({ command: 'start', profile: 'codex' });
            expect(started.status).toBe(201);
            await post(owner.auth, '@codex and a direct message');
            const c = await claim();
            expect(c.status).toBe(200);
            const parsed = claimSchema.safeParse(c.body);
            expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues)).toBe(true);
            expect(c.body.inbox.map((i: any) => i.reason)).toEqual(['command', 'direct']);
        } finally {
            await ctx.db.query(`UPDATE agent_profiles SET model = 'm', effort = 'high' WHERE id = $1`, [codex.profileId]);
        }
    });

    it('/start replacing a session and a profile edit overlapping do not deadlock', async () => {
        const live = await startSession(codex, { native: 'n1' });
        const edit = await ctx.db.connect();
        try {
            // Hold the profile the way an incompatible PATCH does, then start the replacement
            await edit.query('BEGIN');
            await edit.query(`SELECT 1 FROM agent_profiles WHERE id = $1 FOR UPDATE`, [codex.profileId]);
            const pending = ctx.request.post(`/channels/${channelId}/agent-commands`).set(owner.auth)
                .send({ command: 'start', profile: 'codex', onLive: 'shelve' }).then(r => r);
            await waitForLockWait();
            // The PATCH goes on to touch the profile's sessions, including the live one
            await edit.query(`UPDATE agent_profiles SET generation = generation + 1 WHERE id = $1`, [codex.profileId]);
            await edit.query(`UPDATE agent_sessions SET native_session_id = NULL WHERE profile_id = $1`, [codex.profileId]);
            await edit.query('COMMIT');
            const res = await pending;
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            const old = await ctx.db.query('SELECT state FROM agent_sessions WHERE id = $1', [live]);
            expect(old.rows[0].state).toBe('shelved');
        } finally {
            edit.release();
        }
    });

    it('only the owner manages hosts and profiles', async () => {
        expect((await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(member.auth).send({ name: 'x' })).status).toBe(403);
        expect((await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(member.auth)
            .send({ name: 'x', botId: codex.botId, hostId, adapter: 'codex', workdirAlias: 'a' })).status).toBe(403);
        // Members can list profiles
        expect((await ctx.request.get(`/servers/${serverId}/agent-profiles`).set(member.auth)).status).toBe(200);
    });
});


describe('run visibility and session token budgets', () => {
    it('publishes durable run details and stores unique changed paths on completion', async () => {
        const id = await startSession(codex);
        await post(owner.auth, '@codex work');
        const notices: Notice[] = [];
        const c = (await claimNext(ctx.db, { id: hostId, serverId }, notices))!;
        expect(notices.find(n => n.eventName === 'AgentSessionUpdate')?.event.run).toMatchObject({ id: c.run.id, status: 'claimed', changedPaths: [] });
        const done = await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/complete`).set(hostAuth)
            .send({ claimToken: c.run.claimToken, tokensUsed: 12, changedPaths: ['src/a.ts', 'src/a.ts', 'file name.txt'] });
        expect(done.status, JSON.stringify(done.body)).toBe(200);
        const list = await ctx.request.post(`/channels/${channelId}/agent-commands`).set(member.auth).send({ command: 'sessions' });
        expect(list.body.sessions.find((s: any) => s.id === id).recentRuns[0].changedPaths).toEqual(['src/a.ts', 'file name.txt']);
        expect(list.body.sessions.find((s: any) => s.id === id)).toMatchObject({ running: false, run: { id: c.run.id, status: 'succeeded', error: 'nothing_posted', changedPaths: ['src/a.ts', 'file name.txt'] } });
        const repeat = await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/complete`).set(hostAuth).send({ claimToken: c.run.claimToken, tokensUsed: 12 });
        expect(repeat.body.repeated).toBe(true);
        expect(Number((await ctx.db.query('SELECT tokens_used FROM agent_sessions WHERE id = $1', [id])).rows[0].tokens_used)).toBe(12);
    });

    it('charges heartbeats once, pauses at the session limit, and lets only the owner raise and resume', async () => {
        const id = await startSession(codex);
        const command = (auth: Record<string, string>, body: object) => ctx.request.post(`/channels/${channelId}/agent-commands`).set(auth).send(body);
        expect((await command(owner.auth, { command: 'budget', sessionId: id, tokenBudget: 20 })).status).toBe(200);
        expect((await command(member.auth, { command: 'budget', sessionId: id, tokenBudget: 100 })).status).toBe(403);
        expect((await command(owner.auth, { command: 'budget', sessionId: id, tokenBudget: -1 })).status).toBe(400);
        await post(owner.auth, '@codex work');
        const c = (await claim()).body;
        const beat = (tokensUsed: number) => ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/heartbeat`).set(hostAuth).send({ claimToken: c.run.claimToken, tokensUsed });
        expect((await beat(10)).body.cancel).toBe(false);
        expect((await beat(10)).body.cancel).toBe(false);
        expect((await beat(5)).body.cancel).toBe(false);
        expect((await beat(20)).body).toMatchObject({ cancel: true, reason: 'shelved' });
        const paused = (await ctx.db.query('SELECT * FROM agent_sessions WHERE id = $1', [id])).rows[0];
        expect(paused.state).toBe('shelved'); expect(Number(paused.tokens_used)).toBe(20);
        expect((await command(owner.auth, { command: 'resume', sessionId: id })).body.error).toBe('budget_exhausted');
        const failed = await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/fail`).set(hostAuth).send({ claimToken: c.run.claimToken, error: 'cancelled', tokensUsed: 23 });
        expect(failed.status).toBe(200);
        expect(Number((await ctx.db.query('SELECT tokens_used FROM agent_sessions WHERE id = $1', [id])).rows[0].tokens_used)).toBe(23);
        const resumed = await command(owner.auth, { command: 'resume', sessionId: id, tokenBudget: 100 });
        expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
        expect(resumed.body.session).toMatchObject({ state: 'live', tokenBudget: 100, tokensUsed: 23 });
    });

    it('shelves completions that exhaust a budget and suppresses the no-reply marker when the bot posted', async () => {
        const id = await startSession(codex);
        await ctx.db.query('UPDATE agent_sessions SET token_budget = 5 WHERE id = $1', [id]);
        await post(owner.auth, '@codex work');
        const c = (await claim()).body;
        await post(codex.auth, 'Here is my reply');
        const done = await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/complete`).set(hostAuth).send({ claimToken: c.run.claimToken, tokensUsed: 5 });
        expect(done.status).toBe(200);
        const row = (await ctx.db.query('SELECT error FROM agent_runs WHERE id = $1', [c.run.id])).rows[0];
        expect(row.error).toBeNull();
        expect((await ctx.db.query('SELECT state FROM agent_sessions WHERE id = $1', [id])).rows[0].state).toBe('shelved');
    });
});
