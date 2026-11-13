import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase, setHostKind } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { Permissions } from '../../src/permissions';

/**
 * Agent commands (docs/agent-commands.md): `@claude /compact` runs the CLI's own command in that
 * agent's session. Authority, syntax, waiting for a run, the per-adapter table, the subscription
 * rule, terminal sessions, and an older host that never asked for commands.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>, director: typeof owner, member: typeof owner;
let serverId: string, channel: string, hostId: string, hostAuth: { Authorization: string };
interface Agent { name: string; botId: string; profileId: string; botAuth: { Authorization: string } }
let claude: Agent, codex: Agent;
let sessionId: string;

const post = (auth: object, content: string, path = `/channels/${channel}/messages`) => ctx.request.post(path).set(auth).send({ content });
const poll = (v = '1') => ctx.request.get(`/agent-hosts/@me/session-commands/next${v ? `?v=${v}` : ''}`).set(hostAuth);
const finish = (c: any, success = true, result: object = {}, auth = hostAuth) =>
    ctx.request.post(`/agent-hosts/@me/session-commands/${c.id}/result`).set(auth).send({ claimToken: c.claimToken, success, result });
const control = (body: object, auth: object = owner.auth) => ctx.request.post(`/channels/${channel}/agent-commands`).set(auth).send(body);
const rows = async (sql: string, args: unknown[] = []) => (await ctx.db.query(sql, args)).rows;
const notices = async () => (await rows(`SELECT content, thread_id FROM messages WHERE channel_id = $1 AND system_event = 'agent_session' ORDER BY id`, [channel]));
const lastNotice = async () => (await notices()).at(-1)?.content as string;
const commandRows = () => rows(`SELECT btrim(session_id) AS session_id, command, status FROM agent_session_commands ORDER BY id`);
const inboxCount = async () => (await rows(`SELECT count(*)::int AS n FROM agent_inbox WHERE session_id = $1`, [sessionId]))[0].n as number;
async function claimRun() {
    const res = await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
}
async function makeAgent(name: string, adapter: 'claude' | 'codex'): Promise<Agent> {
    const agent = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
        .send({ hostModeAck: true, name, hostId, adapter, workdirAlias: 'agora', channelId: channel });
    expect(agent.status, JSON.stringify(agent.body)).toBe(201);
    return { name, botId: agent.body.bot.id, profileId: agent.body.profile.id, botAuth: { Authorization: `Bot ${agent.body.token}` } };
}
async function startSession(agent: Agent): Promise<string> {
    const start = await control({ command: 'start', profile: agent.name });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    return start.body.session.id;
}
/** Run `fn` with the profile on an API-key box host: directors may then wake it (as in agent-sessions.integration). */
async function apiKey(agent: Agent, fn: () => Promise<void>) {
    await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'api_key', api_key_env = 'ANTHROPIC_API_KEY', host_mode = false WHERE id = $1`, [agent.profileId]);
    await setHostKind(ctx.db, hostId, 'box');
    try { await fn(); } finally {
        await setHostKind(ctx.db, hostId, 'machine');
        await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'subscription', api_key_env = NULL, host_mode = true WHERE id = $1`, [agent.profileId]);
    }
}

beforeAll(async () => {
    ctx = await setupTestApp(); await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'cmdowner'); director = await authedUser(ctx.request, 'cmddirector'); member = await authedUser(ctx.request, 'cmdmember');
    const server = await createServer(ctx.request, owner.auth, 'Commands'); serverId = server.serverId; channel = server.generalChannelId;
    await joinViaInvite(ctx.request, owner.auth, director.auth, serverId);
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    await ctx.db.query(`INSERT INTO channel_member_overrides (channel_id, user_id, allow, deny) VALUES ($1, $2, $3, 0)`, [channel, director.userId, Permissions.DirectAgents.toString()]);
    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'cmd-host' });
    hostId = host.body.host.id; hostAuth = { Authorization: `AgentHost ${host.body.token}` };
    claude = await makeAgent('claudy', 'claude'); codex = await makeAgent('codexy', 'codex');
});
afterAll(async () => { await ctx.close(); });
beforeEach(async () => {
    await ctx.db.query('TRUNCATE agent_sessions CASCADE');
    await ctx.db.query(`DELETE FROM messages WHERE system_event = 'agent_session'`);
    await ctx.db.query(`UPDATE agent_hosts SET revoked_at = NULL, session_commands_seen_at = NOW() WHERE id = $1`, [hostId]);
    sessionId = await startSession(claude);
    await ctx.db.query(`UPDATE agent_sessions SET native_session_id = 'native-1' WHERE id = $1`, [sessionId]);
    await ctx.db.query(`DELETE FROM agent_inbox WHERE session_id = $1`, [sessionId]);
});

describe('syntax', () => {
    it('one mention plus one slash command is a command: recorded, no wake, nothing for the model', async () => {
        const res = await post(owner.auth, '@claudy /compact');
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(await inboxCount()).toBe(0);
        expect(await commandRows()).toEqual([{ session_id: sessionId, command: 'compact', status: 'queued' }]);
        // The mention can come last too
        await ctx.db.query('TRUNCATE agent_session_commands');
        expect((await post(owner.auth, '/context @claudy')).status).toBe(201);
        expect((await commandRows()).map(r => r.command)).toEqual(['context']);
        expect(await inboxCount()).toBe(0);
    });
    it.each([
        ['two mentions', '@claudy @codexy /compact', true],
        ['extra text', '@claudy please /compact', true],
        ['extra text after', '@claudy /compact now and also review the diff', true],
        ['no mention', '/compact', true],
        ['a path', '@claudy /etc/hosts', true],
        ['an unknown command', '@claudy /frobnicate', true],
        ['the command twice', '@claudy /compact /compact', true],
        ['@everyone', '@everyone /compact', true],
    ])('%s is an ordinary message', async (_label, text, wakes) => {
        const res = await post(owner.auth, text);
        expect(res.status).toBe(201);
        expect(await commandRows()).toEqual([]);
        expect((await notices()).some(n => /waiting|takes no arguments|did nothing/.test(n.content))).toBe(false);
        expect(await inboxCount()).toBe(wakes ? 1 : 0);
    });
    it('an ordinary mention still wakes the agent', async () => {
        await post(owner.auth, '@claudy hello');
        expect(await inboxCount()).toBe(1);
    });
    it('a command with an argument it does not take is refused with a notice', async () => {
        await post(owner.auth, '@claudy /compact now');
        expect(await commandRows()).toEqual([]);
        expect(await lastNotice()).toBe('/compact takes no arguments.');
        expect(await inboxCount()).toBe(0);
    });
    it('a command in a thread gets its notice in that thread', async () => {
        const root = await post(owner.auth, 'discussion starts');
        const reply = await post(owner.auth, '@claudy /context', `/channels/${channel}/messages/${root.body.id}/replies`);
        expect(reply.status, JSON.stringify(reply.body)).toBe(201);
        const c = (await poll()).body;
        expect(c.command).toBe('context');
        await finish(c, true, { contextTokens: 61300, contextWindow: 1000000 });
        const last = (await notices()).at(-1)!;
        expect(last.thread_id.trim()).toBe(root.body.id);
        expect(last.content).toBe("claudy's context: 61.3k of 1m tokens (6%).");
    });
});

describe('authority', () => {
    it('a member without DirectAgents is refused with the same message as /start; nothing is queued', async () => {
        await post(member.auth, '@claudy /compact');
        expect(await commandRows()).toEqual([]);
        expect(await lastNotice()).toContain("can't direct agents");
        expect(await inboxCount()).toBe(0);
        // and the control route says 403 cannot_direct
        const res = await control({ command: 'control', profile: 'claudy', control: 'compact' }, member.auth);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('cannot_direct');
    });
    it('a bot that may not direct is refused; one that may still cannot use a subscription agent', async () => {
        const other = await makeAgent('botty', 'claude');
        await post(other.botAuth, '@claudy /compact');
        expect(await commandRows()).toEqual([]);
        expect(await lastNotice()).toContain("can't direct agents");
        await ctx.db.query(`UPDATE bot_channel_access SET can_direct = true WHERE bot_id = $1 AND channel_id = $2`, [other.botId, channel]);
        await post(other.botAuth, '@claudy /compact');
        expect(await commandRows()).toEqual([]);
        expect(await lastNotice()).toMatch(/subscription|plan|owner/i);
    });
    it('the owner is allowed; a subscription agent answers a director only through the plan rule', async () => {
        await post(director.auth, '@claudy /compact');
        expect(await commandRows()).toEqual([]);
        expect(await lastNotice()).toMatch(/subscription|plan|owner/i);
        await post(owner.auth, '@claudy /compact');
        expect((await commandRows()).length).toBe(1);
    });
    it('a director may compact an API-key agent, but /clear stays the owner\'s', async () => {
        await apiKey(claude, async () => {
            await post(director.auth, '@claudy /compact');
            expect((await commandRows()).map(r => r.command)).toEqual(['compact']);
            await ctx.db.query('TRUNCATE agent_session_commands');
            await post(director.auth, '@claudy /clear');
            expect(await commandRows()).toEqual([]);
            expect(await lastNotice()).toBe('Only the server owner can send /clear to claudy.');
            await post(owner.auth, '@claudy /clear');
            expect((await commandRows()).map(r => r.command)).toEqual(['clear']);
        });
    });
});

describe('the per-adapter table', () => {
    it('a command the CLI has no way to run gets a notice and queues nothing', async () => {
        const codexSession = await startSession(codex);
        await post(owner.auth, '@codexy /context');
        expect(await commandRows()).toEqual([]);
        expect(await lastNotice()).toBe('codexy has no context command Agora can run.');
        await ctx.db.query(`DELETE FROM agent_inbox WHERE session_id = $1`, [codexSession]);
        await post(owner.auth, '@codexy /context');
        expect(await rows(`SELECT 1 FROM agent_inbox WHERE session_id = $1`, [codexSession])).toEqual([]);
        await post(owner.auth, '@codexy /model gpt-5');
        expect(await lastNotice()).toMatch(/Settings → Agents/);
        // Codex can compact (through its app server)
        await post(owner.auth, '@codexy /compact');
        expect((await commandRows()).map(r => r.command)).toEqual(['compact']);
    });
    it('lists what each session supports, for the session sheet', async () => {
        const sessions = await control({ command: 'sessions' });
        const row = sessions.body.sessions.find((s: any) => s.id === sessionId);
        expect(row.adapter).toBe('claude');
        expect(row.commands.map((c: any) => c.name)).toEqual(['compact', 'context', 'clear', 'stop']);
        expect(row.commands.find((c: any) => c.name === 'clear').ownerOnly).toBe(true);
        expect(row.pendingCommand).toBeNull();
        await post(owner.auth, '@claudy /compact');
        const again = (await control({ command: 'sessions' })).body.sessions.find((s: any) => s.id === sessionId);
        expect(again.pendingCommand).toEqual({ command: 'compact', status: 'queued' });
    });
});

describe('delivery to the host', () => {
    it('hands the command to the host with the conversation id, then posts one notice with the numbers', async () => {
        await post(owner.auth, '@claudy /compact');
        const c = (await poll()).body;
        expect(c).toMatchObject({ sessionId, profile: 'claudy', adapter: 'claude', command: 'compact', arg: null, nativeSessionId: 'native-1', workdirAlias: 'agora' });
        expect((await poll()).status).toBe(204);
        const before = (await notices()).length;
        expect((await finish(c, true, { tokensBefore: 182000, tokensAfter: 41000 })).status).toBe(200);
        expect(await lastNotice()).toBe('claudy compacted its conversation: 182k to 41k tokens.');
        expect((await notices()).length).toBe(before + 1);
        // repeating the report changes nothing
        expect((await finish(c, true, { tokensBefore: 1, tokensAfter: 1 })).body.repeated).toBe(true);
        expect((await notices()).length).toBe(before + 1);
        expect((await commandRows())[0].status).toBe('succeeded');
    });
    it('says "done" when the CLI reports no numbers, and the failure when it fails', async () => {
        await post(owner.auth, '@claudy /compact');
        await finish((await poll()).body, true, {});
        expect(await lastNotice()).toBe('claudy compacted its conversation: done.');
        await post(owner.auth, '@claudy /compact');
        await finish((await poll()).body, false, { error: 'compact_failed', message: 'Not enough messages to compact.' });
        expect(await lastNotice()).toBe('claudy: /compact failed: the CLI could not compact it (Not enough messages to compact.).');
    });
    it('clear resets the stored conversation when the host confirms', async () => {
        await post(owner.auth, '@claudy /clear');
        const c = (await poll()).body;
        expect(c.command).toBe('clear');
        await finish(c, true, {});
        expect((await rows('SELECT native_session_id FROM agent_sessions WHERE id = $1', [sessionId]))[0].native_session_id).toBeNull();
        expect(await lastNotice()).toBe("claudy started a fresh conversation (cmdowner's /clear). Earlier messages stay in the channel history.");
    });
    it('waits for a run in progress, goes before the next run, and holds that run back', async () => {
        await post(owner.auth, '@claudy do the thing');
        const run = await claimRun();
        await post(owner.auth, '@claudy /compact');
        expect((await poll()).status).toBe(204);
        // finish the run; the command is next, and a wake that arrives meanwhile waits for it
        await post(owner.auth, '@claudy and one more thing');
        expect((await ctx.request.post(`/agent-hosts/@me/runs/${run.run.id}/complete`).set(hostAuth).send({ claimToken: run.run.claimToken, nativeSessionId: 'native-1' })).status).toBe(200);
        expect((await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth)).status).toBe(204);
        const c = (await poll()).body;
        expect(c.command).toBe('compact');
        await finish(c, true, {});
        expect((await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth)).status).toBe(200);
    });
    it('only one command waits at a time', async () => {
        await post(owner.auth, '@claudy /compact');
        await post(owner.auth, '@claudy /context');
        expect(await lastNotice()).toBe('claudy already has /compact waiting; send /context after it finishes.');
        expect((await commandRows()).length).toBe(1);
    });
    it('/stop cancels the run now and says so when nothing runs', async () => {
        await post(owner.auth, '@claudy /stop');
        expect(await lastNotice()).toBe("claudy isn't running anything.");
        await post(owner.auth, '@claudy long task');
        const run = await claimRun();
        await post(owner.auth, '@claudy /stop');
        expect(await lastNotice()).toBe('cmdowner asked claudy to stop its current run.');
        const beat = await ctx.request.post(`/agent-hosts/@me/runs/${run.run.id}/heartbeat`).set(hostAuth).send({ claimToken: run.run.claimToken });
        expect(beat.body).toMatchObject({ cancel: true });
        expect(await commandRows()).toEqual([]);
    });
    it('the control route queues the same command', async () => {
        const res = await control({ command: 'control', profile: 'claudy', control: 'compact' });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toMatchObject({ action: 'control', outcome: 'queued' });
        expect((await commandRows()).map(r => r.command)).toEqual(['compact']);
        const refused = await control({ command: 'control', profile: 'claudy', control: 'clear' });
        expect(refused.body.outcome).toBe('refused');
        expect((await commandRows()).length).toBe(1);
        expect((await control({ command: 'control', profile: 'nobody', control: 'compact' })).status).toBe(404);
    });
    it('lists the latest commands of a session for those who can see the channel', async () => {
        await post(owner.auth, '@claudy /compact');
        const list = await ctx.request.get(`/channels/${channel}/sessions/${sessionId}/commands`).set(member.auth);
        expect(list.body.commands).toEqual([expect.objectContaining({ command: 'compact', status: 'queued', requestedBy: 'cmdowner' })]);
    });
});

describe('hosts and sessions that cannot take commands', () => {
    it('an older agora-host never finds a command, and the sender is told it was not sent', async () => {
        await ctx.db.query(`UPDATE agent_hosts SET session_commands_seen_at = NULL WHERE id = $1`, [hostId]);
        await post(owner.auth, '@claudy /compact');
        expect(await commandRows()).toEqual([]);
        expect(await lastNotice()).toMatch(/isn't answering commands/);
        // a host that polls without ?v=1 neither marks itself ready nor receives anything
        expect((await poll('')).status).toBe(204);
        expect((await rows('SELECT session_commands_seen_at FROM agent_hosts WHERE id = $1', [hostId]))[0].session_commands_seen_at).toBeNull();
        await poll('1');
        await post(owner.auth, '@claudy /compact');
        expect((await poll('')).status).toBe(204);
        expect((await commandRows())[0].status).toBe('queued');
    });
    it('a command nobody claims is given up on and does not hold the session', async () => {
        await post(owner.auth, '@claudy /compact');
        await ctx.db.query(`UPDATE agent_session_commands SET created_at = NOW() - INTERVAL '1 hour'`);
        await post(owner.auth, '@claudy /context');
        expect((await commandRows()).map(r => `${r.command}:${r.status}`)).toEqual(['compact:failed', 'context:queued']);
    });
    it('a stale queued or claimed command is never claimed, never holds a run, shows no waiting state, and says it expired', async () => {
        await post(owner.auth, '@claudy /compact');
        await ctx.db.query(`UPDATE agent_session_commands SET created_at = NOW() - INTERVAL '1 hour'`);
        const before = (await notices()).length;
        expect((await poll()).status).toBe(204);
        expect((await commandRows())[0].status).toBe('failed');
        expect(await lastNotice()).toBe('claudy: /compact failed: no host picked it up.');
        expect((await notices()).length).toBe(before + 1);
        // a claimed one whose host died
        await post(owner.auth, '@claudy /context');
        await poll();
        await ctx.db.query(`UPDATE agent_session_commands SET lease_until = NOW() - INTERVAL '1 second' WHERE status = 'claimed'`);
        const row = (await control({ command: 'sessions' })).body.sessions.find((x: any) => x.id === sessionId);
        expect(row.pendingCommand).toBeNull();
        await post(owner.auth, '@claudy wake please');
        expect((await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth)).status).toBe(200);
    });
    it('the control route only answers in a real top-level message of this channel', async () => {
        const bad = await control({ command: 'control', profile: 'claudy', control: 'context', threadId: generateUlid() });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toBe('invalid_thread');
        const root = await post(owner.auth, 'a thread');
        expect((await control({ command: 'control', profile: 'claudy', control: 'context', threadId: root.body.id })).status).toBe(200);
    });
    it('an agent with no live session, or connected from a terminal, gets a notice and nothing is sent', async () => {
        await ctx.db.query(`UPDATE agent_sessions SET state = 'ended' WHERE id = $1`, [sessionId]);
        await post(owner.auth, '@claudy /compact');
        expect(await lastNotice()).toBe('claudy has no live session here, so /compact did nothing. Start one with /start claudy.');
        await ctx.db.query(`INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, kind, state, terminal_mode) VALUES ($1, $2, $3, $4, 'terminal', 'live', 'mcp')`,
            [generateUlid(), serverId, channel, claude.botId]);
        await post(owner.auth, '@claudy /compact');
        expect(await lastNotice()).toBe("claudy is connected from a terminal; type /compact there. Agora can't type into your terminal.");
        await post(owner.auth, '@claudy /stop');
        expect(await lastNotice()).toBe("claudy is connected from a terminal; press Esc there. Agora can't type into your terminal.");
        expect(await commandRows()).toEqual([]);
    });
    it('a result needs the claim token, the right host and a live lease', async () => {
        await post(owner.auth, '@claudy /compact');
        const c = (await poll()).body;
        expect((await finish({ ...c, claimToken: 'wrong-claim-token' })).status).toBe(409);
        const host2 = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'other-host' });
        expect((await finish(c, true, {}, { Authorization: `AgentHost ${host2.body.token}` })).status).toBe(404);
        await ctx.db.query(`UPDATE agent_session_commands SET lease_until = NOW() - INTERVAL '1 second'`);
        expect((await finish(c, true, {})).status).toBe(409);
        expect((await ctx.request.post(`/agent-hosts/@me/session-commands/${c.id}/result`).set(hostAuth).send({ claimToken: c.claimToken, success: true, result: { tokensBefore: 'a lot' } })).status).toBe(400);
    });
});
