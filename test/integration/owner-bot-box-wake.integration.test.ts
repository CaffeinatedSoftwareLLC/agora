import { io, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { signEdge } from '../../src/lib/boxes/contract';
import { rotateBoxTokens } from '../../src/lib/boxes/tokens';
import { checkTerms } from '../../agora-host/src/terms';
import { hostRefusalNotice, subscriptionNotice } from '../../src/lib/provider-terms';

/**
 * Live report (#diakrisis, 2026-11-09): the server owner's bot, connected from a terminal with
 * `agora-mcp --invite` (chip: "counts as you"), @mentioned a boxed Codex on the owner's
 * subscription that the owner had resumed, and got "cci runs on the owner's personal
 * subscription; ask the owner, ..." instead of a wake. Its replies in the owner's task card
 * threads (a host-mode subscription agent) were reported not to wake either.
 *
 * The server wakes all of these (below). The refusal came from cci's box: its container was
 * created before #369 and ran that older agora-host, which refuses any bot's direct wake, and
 * the server posted that refusal in the same words as its own.
 *
 * Everything here goes through the real routes: the box (POST /boxes, boxd's token rotation),
 * the invite (create, redeem), the terminal (agora-mcp's presence socket through the gateway),
 * /start, a budget shelve at claim, /resume, the post, the box host's claim, and the host's own
 * checkTerms on that claim.
 */

const EDGE_SECRET = 'ef'.repeat(32);
process.env.AGORA_EDGE_SECRET = EDGE_SECRET;
process.env.AGORA_TERMINAL_GRACE_MS = '300';
const PORT = 4999;

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let general: string;
let channelId: string;
const sockets: Socket[] = [];

function event(socket: Socket, name: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing ${name}`)), 3000);
        socket.once(name, (v: any) => { clearTimeout(timer); resolve(v); });
    });
}

/** agora-mcp's presence socket (mcp mode): resolves once Agora has attached the terminal sessions. */
async function connectTerminal(token: string): Promise<Array<{ channelId: string; sessionId: string }>> {
    const socket = io(`http://localhost:${PORT}`, {
        transports: ['websocket'], reconnection: false, autoConnect: false, auth: { type: 'bot', token, mode: 'mcp' },
    });
    sockets.push(socket);
    const attached = event(socket, 'TerminalSession');
    socket.connect();
    return (await attached).sessions;
}

async function until<T>(check: () => Promise<T | undefined | null | false>, what: string, ms = 4000): Promise<T> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const v = await check();
        if (v) return v;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for ${what}`);
}

const command = (body: object) => ctx.request.post(`/channels/${channelId}/agent-commands`).set(owner.auth).send(body);
async function post(auth: object, content: string, threadId?: string): Promise<any> {
    const url = threadId ? `/channels/${channelId}/messages/${threadId}/replies` : `/channels/${channelId}/messages`;
    const res = await ctx.request.post(url).set(auth).send({ content });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    return res.body;
}
async function inbox(sessionId: string): Promise<Array<{ message_id: string; reason: string }>> {
    const rows = await ctx.db.query(`SELECT message_id, reason FROM agent_inbox WHERE session_id = $1 AND reason <> 'command' AND acked_at IS NULL ORDER BY id`, [sessionId]);
    return rows.rows.map((r: any) => ({ message_id: r.message_id.trim(), reason: r.reason }));
}
async function notices(since: string): Promise<string[]> {
    const rows = await ctx.db.query(
        `SELECT content FROM messages WHERE channel_id = $1 AND author_id IS NULL AND system_event = 'agent_session' AND id > $2 ORDER BY id`,
        [channelId, since]);
    return rows.rows.map((r: any) => r.content);
}
const lastId = async () => (await ctx.db.query(`SELECT max(id) AS id FROM messages`)).rows[0].id.trim();

/** The box, as Settings creates it and boxd starts it. */
let box: { id: string; botId: string; profileId: string; hostAuth: Record<string, string> };
/** diakrisis: a host-mode agent on the owner's machine (subscription), worker on task cards. */
let worker: { botId: string; profileId: string; hostAuth: Record<string, string> };
/** LM_DIR_Claude: the owner's bot on the redeemed invite token. */
let lead: { botId: string; token: string; tokenId: string; auth: { Authorization: string } };

const START = (...names: string[]) => `[AGORA/v1 MODE=review STATE=START]\nparticipants: [${names.join(', ')}]\ntask: review`;
const TURN = (to: string) => `[AGORA/v1 MODE=review STATE=TURN]\nyour turn\n[YIELD to=${to}]`;

beforeAll(async () => {
    ctx = await setupTestApp();
    await ctx.app.listen({ port: PORT, host: '127.0.0.1' });
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'espresso');
    const server = await createServer(ctx.request, owner.auth, 'Diakrisis');
    serverId = server.serverId;
    general = server.generalChannelId;
    const ch = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: 'diakrisis', channelType: 3 });
    expect(ch.status, JSON.stringify(ch.body)).toBe(201);
    channelId = ch.body.id;

    // cci: a boxed Codex on the owner's own login
    const created = await ctx.request.post(`/servers/${serverId}/boxes`).set(owner.auth).send({ name: 'cci', adapter: 'codex', homeChannelId: channelId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.box.auth).toBe('subscription');
    const row = (await ctx.db.query(`SELECT b.profile_id, p.bot_id FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id WHERE b.id = $1`,
        [created.body.box.id])).rows[0];
    const tokens = await rotateBoxTokens(ctx.db, created.body.box.id);
    box = { id: created.body.box.id, botId: row.bot_id.trim(), profileId: row.profile_id.trim(),
        hostAuth: { Authorization: `AgentHost ${tokens.hostToken}`, ...signEdge(EDGE_SECRET, created.body.box.id, tokens.generation) } };

    // LM_DIR_Claude: an agent invite for a new bot (the owner's), redeemed by agora-mcp --invite
    const invite = await ctx.request.post(`/servers/${serverId}/agent-invites`).set(owner.auth).send({ username: 'LM_DIR_Claude' });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);
    const redeemed = await ctx.request.post('/agent-invites/redeem').send({ code: invite.body.code });
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(200);
    const token = redeemed.body.token as string;
    lead = { botId: redeemed.body.botId, token, tokenId: token.slice('bot_'.length).split('.')[0], auth: { Authorization: `Bot ${token}` } };
    // It joins #diakrisis (an invite's bot starts in #general only)
    expect((await ctx.request.post(`/channels/${channelId}/bots/${lead.botId}`).set(owner.auth)).status).toBe(201);

    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
    const agent = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
        .send({ hostModeAck: true, name: 'diakrisis', adapter: 'claude', hostId: host.body.host.id, workdirAlias: 'agora', channelId });
    expect(agent.status, JSON.stringify(agent.body)).toBe(201);
    worker = { botId: agent.body.bot.id, profileId: agent.body.profile.id, hostAuth: { Authorization: `AgentHost ${host.body.token}` } };
    expect((await ctx.db.query(`SELECT auth_mode, host_mode FROM agent_profiles WHERE id = $1`, [worker.profileId])).rows[0])
        .toMatchObject({ auth_mode: 'subscription', host_mode: true });
});

afterEach(async () => {
    for (const s of sockets.splice(0)) s.disconnect();
    await until(async () => (await ctx.db.query(`SELECT 1 FROM agent_sessions WHERE kind = 'terminal' AND state = 'live'`)).rows.length === 0,
        'terminal sessions to end');
});
afterAll(async () => {
    await ctx.close();
    delete process.env.AGORA_EDGE_SECRET;
});

/** cci's channel session: started by the owner, shelved over its token budget at a claim, resumed by the owner with more. */
async function startedShelvedResumed(): Promise<string> {
    await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE kind = 'hosted' AND state <> 'ended'`);
    const started = await command({ command: 'start', profile: 'cci', fresh: true });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const id = started.body.session.id;
    await ctx.db.query('UPDATE agent_sessions SET tokens_used = 60000000 WHERE id = $1', [id]);
    expect((await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(box.hostAuth)).status).toBe(204);
    expect((await ctx.db.query('SELECT state FROM agent_sessions WHERE id = $1', [id])).rows[0].state).toBe('shelved');
    const resumed = await command({ command: 'resume', sessionId: id, tokenBudget: 200_000_000 });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body.session.state).toBe('live');
    // The /resume notice is the session's first wake; take it, as the box would, and finish the run
    const first = await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(box.hostAuth);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await ctx.db.query(`UPDATE agent_runs SET status = 'succeeded', finished_at = NOW() WHERE id = $1`, [first.body.run.id]);
    await ctx.db.query(`UPDATE agent_batches SET status = 'done', finished_at = NOW() WHERE session_id = $1`, [id]);
    await ctx.db.query(`UPDATE agent_inbox SET acked_at = NOW() WHERE session_id = $1`, [id]);
    return id;
}

/** The box host's claim, and the box's own agora-host rule on it (agora-host/src/terms.ts). */
async function claimAndCheck(): Promise<any> {
    const c = await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(box.hostAuth);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(() => checkTerms({ auth: 'subscription', adapter: 'codex', requireRunApproval: false } as any, c.body)).not.toThrow();
    return c.body;
}

/** What the channel's session list says about the terminal (the chip). */
async function chip(): Promise<any> {
    const res = await command({ command: 'sessions' });
    expect(res.status).toBe(200);
    return res.body.sessions.find((s: any) => s.kind === 'terminal' && s.state === 'live' && s.botId === lead.botId);
}

describe('the owner\'s terminal bot wakes the owner\'s resumed boxed agent', () => {
    it('connected after it joined the channel: a top-level @mention wakes cci, with no notice', async () => {
        const sessions = await connectTerminal(lead.token);
        expect(sessions.map(s => s.channelId).sort()).toEqual([general, channelId].sort());
        expect(await chip()).toMatchObject({ ownerToken: true, ownerTokenReason: null });
        const cci = await startedShelvedResumed();
        const since = await lastId();
        const m = await post(lead.auth, '@cci Welcome back. Please review my request just above');
        expect(await notices(since)).toEqual([]);
        expect(await inbox(cci)).toEqual([{ message_id: m.id, reason: 'direct' }]);
        const claim = await claimAndCheck();
        expect(claim.inbox.map((i: any) => [i.reason, i.ownerBot])).toEqual([['direct', true]]);
    });

    it('a thread reply @mention and a START/YIELD from the terminal wake it too', async () => {
        await connectTerminal(lead.token);
        const cci = await startedShelvedResumed();
        const since = await lastId();
        const parent = await post(lead.auth, 'my request: review the parser');
        const inThread = await post(lead.auth, '@cci please look at this one', parent.id);
        const start = await post(lead.auth, START('LM_DIR_Claude', 'cci'));
        const back = await post(lead.auth, TURN('cci'), start.id);
        expect(await notices(since)).toEqual([]);
        expect(await inbox(cci)).toEqual([
            { message_id: inThread.id, reason: 'direct' }, { message_id: start.id, reason: 'protocol' }, { message_id: back.id, reason: 'handoff' },
        ]);
        await claimAndCheck();
    });

    it("a box on an older agora-host that refuses the run gets the host's own notice, not the server's refusal text", async () => {
        // The live cause: cci's container was created before #369, so its agora-host refused
        // every bot-authored direct item (subscription_owner_only); the notice read exactly
        // like the server's own refusal. boxd now rebuilds such boxes (boxd-reconcile.unit.test.ts).
        await connectTerminal(lead.token);
        const cci = await startedShelvedResumed();
        await post(lead.auth, '@cci Welcome back. Please review my request just above');
        const c = await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(box.hostAuth);
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        const since = await lastId();
        const failed = await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/fail`).set(box.hostAuth)
            .send({ claimToken: c.body.run.claimToken, error: 'subscription_owner_only', retryable: false });
        expect(failed.status, JSON.stringify(failed.body)).toBe(200);
        const said = await notices(since);
        expect(said).toContain(hostRefusalNotice('cci'));
        expect(said).not.toContain(subscriptionNotice('cci'));
        expect(await inbox(cci)).toEqual([]);
    });
});

/** A task card for diakrisis, started by the owner: its session and thread. */
async function startedCard(title: string): Promise<{ sessionId: string; threadId: string }> {
    const res = await ctx.request.post(`/channels/${channelId}/tasks`).set(owner.auth).send({ title, profile: 'diakrisis', start: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = (await ctx.db.query(`SELECT session_id, thread_id FROM task_cards WHERE id = $1`, [res.body.card.id])).rows[0];
    const sessionId = row.session_id.trim();
    // The kickoff is the card's first wake: take it, as the host would, and finish it
    const first = await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(worker.hostAuth);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await ctx.db.query(`UPDATE agent_runs SET status = 'succeeded', finished_at = NOW() WHERE id = $1`, [first.body.run.id]);
    await ctx.db.query(`UPDATE agent_batches SET status = 'done', finished_at = NOW() WHERE session_id = $1`, [sessionId]);
    await ctx.db.query(`UPDATE agent_inbox SET acked_at = NOW() WHERE session_id = $1`, [sessionId]);
    return { sessionId, threadId: row.thread_id.trim() };
}

describe("the owner's terminal bot wakes the owner's task card sessions", () => {
    for (const canDirect of [false, true]) {
        it(`a reply in the card's thread, @mention and plain, wakes the card's session (can_direct ${canDirect})`, async () => {
            await ctx.db.query('UPDATE bot_channel_access SET can_direct = $3 WHERE bot_id = $1 AND channel_id = $2', [lead.botId, channelId, canDirect]);
            await connectTerminal(lead.token);
            expect(await chip()).toMatchObject({ ownerToken: true });
            const card = await startedCard(`review ${canDirect}`);
            const since = await lastId();
            const mention = await post(lead.auth, '@diakrisis please pick up the parser review', card.threadId);
            const plain = await post(lead.auth, 'and the tokenizer after that', card.threadId);
            expect(await notices(since)).toEqual([]);
            expect(await inbox(card.sessionId)).toEqual([{ message_id: mention.id, reason: 'direct' }, { message_id: plain.id, reason: 'direct' }]);
            const c = await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(worker.hostAuth);
            expect(c.status, JSON.stringify(c.body)).toBe(200);
            expect(c.body.inbox.map((i: any) => [i.messageId, i.ownerBot])).toEqual([[mention.id, true], [plain.id, true]]);
            expect(() => checkTerms({ auth: 'subscription', adapter: 'claude', requireRunApproval: false } as any, c.body)).not.toThrow();
            await ctx.db.query(`UPDATE agent_runs SET status = 'succeeded', finished_at = NOW() WHERE id = $1`, [c.body.run.id]);
            await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE id = $1`, [card.sessionId]);
        });
    }
});

/**
 * The second live report's actual cause: the diakrisis card runs hit the profile's default 900 s
 * run time limit (`run_timeout`); each was retried, with a generic notice at the end.
 */
describe('a run stopped at its time limit', () => {
    it('is not retried, and the notice says which limit it hit and where to raise it', async () => {
        const card = await startedCard('long job');
        await post(owner.auth, 'run the full evaluation', card.threadId);
        const c = await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(worker.hostAuth);
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        expect(c.body.run.timeoutSeconds).toBe(900);
        const since = await lastId();
        const failed = await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/fail`).set(worker.hostAuth)
            .send({ claimToken: c.body.run.claimToken, error: 'run_timeout', retryable: true });
        expect(failed.status, JSON.stringify(failed.body)).toBe(200);
        expect(await notices(since)).toEqual(["diakrisis's run hit its 15-minute limit; raise it in Settings → Agents."]);
        const batch = await ctx.db.query(`SELECT status FROM agent_batches WHERE id = (SELECT batch_id FROM agent_runs WHERE id = $1)`, [c.body.run.id]);
        expect(batch.rows[0].status).toBe('failed');
        expect((await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(worker.hostAuth)).status).toBe(204);
        await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE id = $1`, [card.sessionId]);
    });
});
