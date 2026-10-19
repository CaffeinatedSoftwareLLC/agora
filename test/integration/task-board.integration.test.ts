import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { Permissions } from '../../src/permissions';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Task board and subtask delegation (docs/task-board.md): cards that start worktree
 * sessions scoped to their own thread and follow their branch and pull request, and agents
 * that delegate a brief to a child session whose summary alone comes back.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>, director: typeof owner, member: typeof owner;
let serverId: string, channelId: string, hostId: string, hostAuth: object;
interface Agent { botId: string; auth: object; profileId: string; name: string }
let builder: Agent, helper: Agent;
const sha = 'c'.repeat(40);

/** agora-host's dependencies are needed for the cross-package contract test. */
const hostDepsInstalled = existsSync(join(__dirname, '../../agora-host/node_modules/zod'));

async function makeAgent(name: string): Promise<Agent> {
    const agent = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
        .send({ name, hostId, adapter: 'codex', workdirAlias: 'agora', channelId });
    expect(agent.status, JSON.stringify(agent.body)).toBe(201);
    return { botId: agent.body.bot.id, auth: { Authorization: `Bot ${agent.body.token}` }, profileId: agent.body.profile.id, name };
}
const tasks = (auth: object = owner.auth) => ctx.request.get(`/channels/${channelId}/tasks`).set(auth);
const create = (body: object, auth: object = owner.auth) => ctx.request.post(`/channels/${channelId}/tasks`).set(auth).send(body);
const patch = (id: string, body: object, auth: object = owner.auth) => ctx.request.patch(`/channels/${channelId}/tasks/${id}`).set(auth).send(body);
const start = (id: string, auth: object = owner.auth) => ctx.request.post(`/channels/${channelId}/tasks/${id}/start`).set(auth);
const command = (body: object, auth: object = owner.auth) => ctx.request.post(`/channels/${channelId}/agent-commands`).set(auth).send(body);
const subtask = (body: object, auth: object = builder.auth) => ctx.request.post(`/channels/${channelId}/subtasks`).set(auth).send(body);
async function claim(): Promise<any> {
    const res = await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
}
async function noClaim() {
    expect((await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth)).status).toBe(204);
}
const completeRun = (c: any, body: object = {}) => ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/complete`).set(hostAuth)
    .send({ claimToken: c.run.claimToken, ...body });
async function session(id: string) {
    return (await ctx.db.query('SELECT * FROM agent_sessions WHERE id = $1', [id])).rows[0];
}
async function inbox(sessionId: string) {
    return (await ctx.db.query(`SELECT btrim(message_id) AS message_id, btrim(thread_id) AS thread_id, reason, acked_at IS NOT NULL AS acked
        FROM agent_inbox WHERE session_id = $1 ORDER BY id`, [sessionId])).rows;
}
async function reply(threadId: string, content: string, auth: object = owner.auth) {
    const res = await ctx.request.post(`/channels/${channelId}/messages/${threadId}/replies`).set(auth).send({ content });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'tbowner');
    director = await authedUser(ctx.request, 'tbdirector');
    member = await authedUser(ctx.request, 'tbmember');
    const server = await createServer(ctx.request, owner.auth, 'Board');
    serverId = server.serverId; channelId = server.generalChannelId;
    await joinViaInvite(ctx.request, owner.auth, director.auth, serverId);
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    await ctx.db.query(`INSERT INTO channel_member_overrides (channel_id, user_id, allow, deny) VALUES ($1, $2, $3, 0)`,
        [channelId, director.userId, Permissions.DirectAgents.toString()]);
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 1000, max_bot_hops = 1000, max_thread_bot_hops = 0 WHERE id = $1', [channelId]);
    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'board-host' });
    hostId = host.body.host.id; hostAuth = { Authorization: `AgentHost ${host.body.token}` };
    builder = await makeAgent('builder');
    helper = await makeAgent('helper');
});
afterAll(async () => { await ctx.close(); });
beforeEach(async () => {
    await ctx.db.query('TRUNCATE task_cards, agent_runs, agent_inbox, agent_batches, agent_workspace_commands, agent_sessions CASCADE');
    // Most tests use the ordinary authority rules (API-key profiles); subscription has its own test
    await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'api_key', api_key_env = 'OPENAI_API_KEY', token_budget = 2000000 WHERE server_id = $1`, [serverId]);
    await ctx.db.query('UPDATE bot_channel_access SET can_direct = false WHERE channel_id = $1', [channelId]);
});

describe('task board', () => {
    it('anyone in the channel reads the board; only the owner and directors change it', async () => {
        expect((await create({ title: 'Nope' }, member.auth)).status).toBe(403);
        expect((await create({ title: 'Nope' }, builder.auth)).status).toBe(403);
        const made = await create({ title: '  Fix the login  ', description: 'Steps\nhere', profile: 'builder' }, director.auth);
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        expect(made.body.card).toMatchObject({ title: 'Fix the login', description: 'Steps\nhere', status: 'todo', profile: { name: 'builder' }, session: null, threadId: null });

        const board = await tasks(member.auth);
        expect(board.status).toBe(200);
        expect(board.body).toMatchObject({ canManage: false, isOwner: false });
        expect(board.body.cards.map((c: any) => c.title)).toEqual(['Fix the login']);
        expect((await tasks(director.auth)).body).toMatchObject({ canManage: true, isOwner: false });

        const id = made.body.card.id;
        expect((await patch(id, { status: 'review' }, member.auth)).status).toBe(403);
        const moved = await patch(id, { status: 'review', title: 'Fix login', profile: null }, director.auth);
        expect(moved.status, JSON.stringify(moved.body)).toBe(200);
        expect(moved.body.card).toMatchObject({ status: 'review', title: 'Fix login', profile: null });
        expect((await patch(id, { status: 'bogus' })).status).toBe(400);
        expect((await patch(id, { profile: 'nobody' })).body.error).toBe('unknown_profile');
        expect((await ctx.request.delete(`/channels/${channelId}/tasks/${id}`).set(member.auth)).status).toBe(403);
        expect((await ctx.request.delete(`/channels/${channelId}/tasks/${id}`).set(owner.auth)).status).toBe(204);
        expect((await tasks()).body.cards).toEqual([]);
    });

    it('starting a card opens its thread and a worktree session scoped to it, next to the channel session', async () => {
        const channelSession = await command({ command: 'start', profile: 'builder' });
        expect(channelSession.status, JSON.stringify(channelSession.body)).toBe(201);

        const made = await create({ title: 'Add tests', description: 'Cover the parser', profile: 'builder', start: true }, director.auth);
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        expect(made.body.action).toBe('started');
        const card = made.body.card;
        expect(card).toMatchObject({ status: 'in_progress', session: { state: 'live', profile: 'builder' } });
        expect(card.threadId).toBeTruthy();

        // The card's thread is a task_card notice; the kickoff is a reply in it and the agent's first wake
        const parent = (await ctx.db.query('SELECT system_event, system_data, reply_count FROM messages WHERE id = $1', [card.threadId])).rows[0];
        expect(parent).toMatchObject({ system_event: 'task_card', system_data: { kind: 'task_card', taskId: card.id }, reply_count: 1 });
        const s = await session(card.session.id);
        expect(s.thread_id.trim()).toBe(card.threadId);
        expect(s.started_by.trim()).toBe(director.userId);
        const rows = await inbox(card.session.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ reason: 'command', thread_id: card.threadId });
        const kickoff = (await ctx.db.query('SELECT content, thread_id FROM messages WHERE id = $1', [rows[0].message_id])).rows[0];
        expect(kickoff.thread_id.trim()).toBe(card.threadId);
        expect(kickoff.content).toContain('Cover the parser');

        // Starting again keeps it; the agent's channel session is untouched
        expect((await start(card.id)).body.action).toBe('kept');
        expect((await session(channelSession.body.session.id)).state).toBe('live');

        // /sessions lists both, the channel session first
        const listed = (await command({ command: 'sessions' }, member.auth)).body.sessions;
        expect(listed.map((x: any) => x.threadId)).toEqual([null, card.threadId]);
    });

    it('routes a director in the card thread to the card session only, and top-level mentions to the channel session', async () => {
        const channelSession = (await command({ command: 'start', profile: 'builder' })).body.session.id;
        const card = (await create({ title: 'Scoped', profile: 'builder', start: true })).body.card;
        await ctx.db.query('UPDATE agent_inbox SET acked_at = NOW()');

        const inThread = await reply(card.threadId, 'please also update the docs', director.auth);
        expect((await inbox(card.session.id)).filter(r => !r.acked)).toEqual([{ message_id: inThread.id, thread_id: card.threadId, reason: 'direct', acked: false }]);
        expect((await inbox(channelSession)).filter(r => !r.acked)).toEqual([]);

        // Someone without authority in the thread wakes nobody
        await reply(card.threadId, 'drive-by comment', member.auth);
        expect((await inbox(card.session.id)).filter(r => !r.acked)).toHaveLength(1);

        const top = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: '@builder status?' });
        expect(top.status).toBe(201);
        expect((await inbox(channelSession)).filter(r => !r.acked).map(r => r.message_id)).toEqual([top.body.id]);
        expect((await inbox(card.session.id)).filter(r => !r.acked)).toHaveLength(1);
    });

    it('claims carry the card scope; ending and starting again resumes the same worktree session', async () => {
        const card = (await create({ title: 'Claimed', profile: 'builder', start: true })).body.card;
        const c = await claim();
        expect(c.session).toMatchObject({ id: card.session.id, threadId: card.threadId, parentSessionId: null, scope: { kind: 'task', title: 'Claimed' } });
        expect(c.inbox[0]).toMatchObject({ reason: 'command', threadId: card.threadId });
        if (hostDepsInstalled) {
            const { claimSchema } = await import('../../agora-host/src/types');
            const { wakePrompt } = await import('../../agora-host/src/prompt');
            const parsed = claimSchema.parse(c);
            expect(parsed.session.scope).toEqual({ kind: 'task', title: 'Claimed' });
            expect(wakePrompt(parsed)).toContain(`Post every reply in thread ${card.threadId}`);
        }
        expect((await completeRun(c, { summary: 'did it', branch: `agora/builder/${card.session.id}`, baseSha: 'b'.repeat(40), headSha: sha })).status).toBe(200);
        expect((await tasks()).body.cards[0].session).toMatchObject({ branch: `agora/builder/${card.session.id}`, headSha: sha });

        // A card's session is ended by ID; /end by profile only touches the channel session
        expect((await command({ command: 'end', profile: 'builder' })).body.error).toBe('no_live_session');
        const ended = await command({ command: 'end', sessionId: card.session.id }, director.auth);
        expect(ended.status, JSON.stringify(ended.body)).toBe(200);
        expect((await session(card.session.id)).state).toBe('ended');

        // Ended: starting again is a new session in the same thread
        const again = await start(card.id, director.auth);
        expect(again.status, JSON.stringify(again.body)).toBe(201);
        expect(again.body.card.session.id).not.toBe(card.session.id);
        expect(again.body.card.threadId).toBe(card.threadId);

        // Shelved: starting again resumes it
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved', end_reason = 'budget' WHERE id = $1`, [again.body.card.session.id]);
        const resumed = await start(card.id);
        expect(resumed.status).toBe(200);
        expect(resumed.body).toMatchObject({ action: 'resumed', card: { session: { id: again.body.card.session.id, state: 'live' } } });
    });

    it('refuses to reassign a working card, and a director cannot start a subscription agent', async () => {
        const card = (await create({ title: 'Busy', profile: 'builder', start: true })).body.card;
        expect((await patch(card.id, { profile: 'helper' })).body.error).toBe('card_session_live');
        expect((await patch(card.id, { status: 'review' })).status).toBe(200);

        await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'subscription', api_key_env = NULL WHERE id = $1`, [helper.profileId]);
        const other = (await create({ title: 'Owner only', profile: 'helper' }, director.auth)).body.card;
        const refused = await start(other.id, director.auth);
        expect(refused.status).toBe(403);
        expect(refused.body.error).toBe('subscription_owner_only');
        expect((await start(other.id, owner.auth)).status).toBe(201);
        expect((await start(other.id, member.auth)).status).toBe(403);
        const unassigned = (await create({ title: 'Nobody' })).body.card;
        expect((await start(unassigned.id)).body.error).toBe('no_assignee');
    });

    it('follows the pull request: opened → review, merged → done', async () => {
        const card = (await create({ title: 'Ship it', profile: 'builder', start: true })).body.card;
        const root = `/channels/${channelId}/sessions/${card.session.id}/workspace-commands`;
        const next = async () => (await ctx.request.get('/agent-hosts/@me/workspace-commands/next').set(hostAuth)).body;
        const result = (c: any, data: object) => ctx.request.post(`/agent-hosts/@me/workspace-commands/${c.id}/result`).set(hostAuth)
            .send({ claimToken: c.claimToken, success: true, result: data });

        expect((await ctx.request.post(root).set(owner.auth).send({ action: 'pr', message: 'Ship it' })).status).toBe(202);
        expect((await result(await next(), { message: 'Opened GitHub pull request', url: 'https://github.com/o/r/pull/7' })).status).toBe(200);
        expect((await tasks()).body.cards[0]).toMatchObject({ status: 'review', prUrl: 'https://github.com/o/r/pull/7', prState: 'open' });

        // Directors may check the PR's state; it only reads
        expect((await ctx.request.post(root).set(member.auth).send({ action: 'pr_status' })).status).toBe(403);
        const queued = await ctx.request.post(root).set(director.auth).send({ action: 'pr_status' });
        expect(queued.status, JSON.stringify(queued.body)).toBe(202);
        const c = await next();
        expect(c.action).toBe('pr_status');
        expect((await result(c, { prState: 'bogus' })).status).toBe(400);
        expect((await result(c, { prState: 'merged', url: 'https://github.com/o/r/pull/7', message: 'Pull request is merged' })).status).toBe(200);
        expect((await tasks()).body.cards[0]).toMatchObject({ status: 'done', prState: 'merged' });
    });
});

describe('subtasks', () => {
    /** Start builder's channel session and claim its run, so it is mid-run like a real agent. */
    async function runningParent(): Promise<{ sessionId: string; run: any }> {
        const started = await command({ command: 'start', profile: 'builder' });
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        return { sessionId: started.body.session.id, run: await claim() };
    }

    it('only an agent, mid-run in its own session, can delegate', async () => {
        const started = (await command({ command: 'start', profile: 'builder' })).body.session.id;
        const body = { parentSessionId: started, title: 'Look', brief: 'Find the bug' };
        expect((await subtask(body, owner.auth)).body.error).toBe('agents_only');
        expect((await subtask(body)).body.error).toBe('parent_not_running');
        expect((await subtask(body, helper.auth)).body.error).toBe('parent_not_found');
        await claim();
        expect((await subtask(body)).status).toBe(201);
    });

    it('starts the child in a new thread with only the brief, on the budget the parent has left', async () => {
        const { sessionId: parentId, run } = await runningParent();
        await ctx.db.query('UPDATE agent_sessions SET tokens_used = 500000 WHERE id = $1', [parentId]);
        const res = await subtask({ parentSessionId: parentId, title: 'Write the parser tests', brief: 'Add tests for parse() in src/parse.ts. Report coverage.', client_key: 'dk_1:1' });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        const child = res.body.session;
        expect(child).toMatchObject({ profile: 'builder', parentSessionId: parentId, title: 'Write the parser tests', tokenBudget: 1500000, state: 'live' });

        // A repeat with the same key returns the same subtask
        const repeat = await subtask({ parentSessionId: parentId, title: 'Write the parser tests', brief: 'Add tests for parse() in src/parse.ts. Report coverage.', client_key: 'dk_1:1' });
        expect(repeat.status).toBe(200);
        expect(repeat.body).toMatchObject({ action: 'repeated', session: { id: child.id } });

        const thread = (await ctx.db.query('SELECT system_event, system_data, reply_count, thread_id FROM messages WHERE id = $1', [child.threadId])).rows[0];
        expect(thread).toMatchObject({ system_event: 'subtask', reply_count: 1, thread_id: null });
        expect(thread.system_data).toMatchObject({ sessionId: child.id, parentSessionId: parentId });
        const rows = await inbox(child.id);
        expect(rows).toEqual([expect.objectContaining({ reason: 'delegate', thread_id: child.threadId })]);
        const brief = (await ctx.db.query('SELECT author_id, content FROM messages WHERE id = $1', [rows[0].message_id])).rows[0];
        expect(brief.author_id.trim()).toBe(builder.botId);

        // The parent finishes its run; the child's clean-context claim holds only the brief
        expect((await completeRun(run, { summary: 'delegated' })).status).toBe(200);
        const c = await claim();
        expect(c.session).toMatchObject({ id: child.id, nativeSessionId: null, summary: null, threadId: child.threadId, parentSessionId: parentId,
            scope: { kind: 'subtask', title: 'Write the parser tests' } });
        expect(c.inbox).toEqual([expect.objectContaining({ reason: 'delegate', authorBot: true, content: brief.content, threadId: child.threadId })]);
        if (hostDepsInstalled) {
            const { claimSchema } = await import('../../agora-host/src/types');
            const { wakePrompt } = await import('../../agora-host/src/prompt');
            const prompt = wakePrompt(claimSchema.parse(c));
            expect(prompt).toContain(`delegated by session ${parentId}`);
            expect(prompt).toContain('clean context');
        }
    });

    it('posts only the summary back to the parent thread, wakes the parent and shelves the child', async () => {
        const { sessionId: parentId, run } = await runningParent();
        // The parent works in a collab thread and wants the summary there
        const top = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'Plan thread' });
        const res = await subtask({ parentSessionId: parentId, title: 'Investigate', brief: 'Why is CI red?', reportThreadId: top.body.id });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        const childId = res.body.session.id;
        expect((await completeRun(run)).status).toBe(200);

        const c = await claim();
        expect(c.session.id).toBe(childId);
        // The child posts progress in its own thread; the run reports a summary and its tokens
        await reply(res.body.session.threadId, 'looking at the logs', builder.auth);
        const done = await completeRun(c, { summary: 'CI is red because of a flaky timeout in auth tests.', tokensUsed: 1234,
            branch: `agora/builder/${childId}`, baseSha: 'b'.repeat(40), headSha: sha });
        expect(done.status, JSON.stringify(done.body)).toBe(200);

        const summary = (await ctx.db.query(`SELECT id, author_id, content, thread_id FROM messages WHERE thread_id = $1 AND author_id = $2`, [top.body.id, builder.botId])).rows;
        expect(summary).toHaveLength(1);
        expect(summary[0].content).toContain('Subtask "Investigate" finished');
        expect(summary[0].content).toContain(`agora/builder/${childId} @ ${sha.slice(0, 12)}`);
        expect(summary[0].content).toContain('flaky timeout');
        expect(summary[0].content).not.toContain('looking at the logs');
        expect((await ctx.db.query('SELECT reply_count FROM messages WHERE id = $1', [top.body.id])).rows[0].reply_count).toBe(1);

        expect(await session(childId)).toMatchObject({ state: 'shelved', end_reason: 'done' });
        expect((await inbox(parentId)).filter(r => r.reason === 'delegate')).toEqual([{ message_id: summary[0].id.trim(), thread_id: top.body.id, reason: 'delegate', acked: false }]);

        // The parent wakes with the summary (and the owner's top-level post, which was addressed to it too)
        const p = await claim();
        expect(p.session.id).toBe(parentId);
        expect(p.inbox).toContainEqual(expect.objectContaining({ messageId: summary[0].id.trim(), reason: 'delegate', authorBot: true, threadId: top.body.id }));
    });

    it('spends the parent budget: a child that uses it up stops both', async () => {
        const { sessionId: parentId, run } = await runningParent();
        await ctx.db.query('UPDATE agent_sessions SET token_budget = 10000 WHERE id = $1', [parentId]);
        const res = await subtask({ parentSessionId: parentId, title: 'Big', brief: 'Spend', tokenBudget: 999999 });
        expect(res.body.session.tokenBudget).toBe(10000);
        const childId = res.body.session.id;
        expect((await completeRun(run, { tokensUsed: 4000 })).status).toBe(200);
        const c = await claim();
        expect(c.session.id).toBe(childId);
        // Heartbeat with usage beyond what the parent has left: the child is told to stop
        const beat = await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/heartbeat`).set(hostAuth).send({ claimToken: c.run.claimToken, tokensUsed: 7000 });
        expect(beat.body).toMatchObject({ cancel: true });
        expect(await session(childId)).toMatchObject({ state: 'shelved', end_reason: 'budget' });
        const notice = (await ctx.db.query(`SELECT content FROM messages WHERE content LIKE 'Subtask session for builder%' ORDER BY id DESC LIMIT 1`)).rows[0];
        expect(notice.content).toContain(`the budget of its parent session ${parentId} is used up`);

        // The parent's own next wake finds its family budget gone
        await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: '@builder next' });
        await noClaim();
        expect(await session(parentId)).toMatchObject({ state: 'shelved', end_reason: 'budget' });
        // And there is nothing left to delegate
        expect((await command({ command: 'resume', sessionId: parentId })).body.error).toBe('budget_exhausted');
    });

    it('needs authority to delegate to another agent, the owner for a subscription agent, and stops at two levels', async () => {
        const { sessionId: parentId } = await runningParent();
        const other = await subtask({ parentSessionId: parentId, title: 'Other', brief: 'Help', profile: 'helper' });
        expect(other.status).toBe(403);
        expect(other.body.error).toBe('cannot_direct');
        await ctx.db.query('UPDATE bot_channel_access SET can_direct = true WHERE bot_id = $1 AND channel_id = $2', [builder.botId, channelId]);
        expect((await subtask({ parentSessionId: parentId, title: 'Other', brief: 'Help', profile: 'helper' })).status).toBe(201);

        // A director-started parent cannot hand work to an agent on the owner's subscription
        await ctx.db.query(`UPDATE agent_sessions SET started_by = $2 WHERE id = $1`, [parentId, director.userId]);
        await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'subscription', api_key_env = NULL WHERE id = $1`, [helper.profileId]);
        const terms = await subtask({ parentSessionId: parentId, title: 'Sub', brief: 'Help', profile: 'helper' });
        expect(terms.status).toBe(403);
        expect(terms.body.error).toBe('subscription_owner_only');
        await ctx.db.query(`UPDATE agent_sessions SET started_by = $2 WHERE id = $1`, [parentId, owner.userId]);

        // Depth: parent → child → grandchild, and no further
        const child = (await subtask({ parentSessionId: parentId, title: 'Child', brief: 'Go' })).body.session.id;
        await ctx.db.query(`UPDATE agent_runs SET status = 'succeeded', finished_at = NOW() WHERE session_id = $1`, [parentId]);
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved' WHERE id <> $1`, [child]);
        const childRun = await claim();
        expect(childRun.session.id).toBe(child);
        const grandchild = await subtask({ parentSessionId: child, title: 'Grandchild', brief: 'Deeper' });
        expect(grandchild.status, JSON.stringify(grandchild.body)).toBe(201);
        await ctx.db.query(`UPDATE agent_runs SET status = 'succeeded', finished_at = NOW() WHERE session_id = $1`, [child]);
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved' WHERE id <> $1`, [grandchild.body.session.id]);
        const gRun = await claim();
        expect(gRun.session.id).toBe(grandchild.body.session.id);
        expect((await subtask({ parentSessionId: grandchild.body.session.id, title: 'Too deep', brief: 'No' })).body.error).toBe('subtask_depth');
    });
});
