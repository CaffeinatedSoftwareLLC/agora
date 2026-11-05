import { setupTestApp, authedUser, createServer, cleanDatabase, joinViaInvite } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';

/**
 * #132: a finished or superseded collaboration has an explicit closed state with a pointer to
 * its successor, the agent that ran the protocol can close it, and an agent that comes back to
 * an old unfinished thread is told when a newer request for it exists. #14: the thread list
 * reports the total number of matching threads, not the page size.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string, channelId: string;
const bots: Record<string, { id: string; auth: Record<string, string> }> = {};

beforeAll(async () => {
    ctx = await setupTestApp(); await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'closeowner');
    serverId = (await createServer(ctx.request, owner.auth, 'Closure')).serverId;
    member = await authedUser(ctx.request, 'closemember');
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    for (const name of ['CloseClaude', 'CloseCodex', 'CloseGemini']) {
        const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: name });
        expect(bot.status).toBe(201);
        const token = await ctx.request.post(`/servers/${serverId}/bots/${bot.body.id}/tokens`).set(owner.auth).send({});
        expect(token.status).toBe(201);
        bots[name] = { id: bot.body.id, auth: { Authorization: `Bot ${token.body.token}` } };
    }
});
afterAll(async () => { await ctx.close(); });
beforeEach(async () => {
    const ch = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: `close-${generateUlid().toLowerCase()}`, channelType: 3 });
    expect(ch.status).toBe(201); channelId = ch.body.id;
    for (const { id } of Object.values(bots)) expect((await ctx.request.post(`/channels/${channelId}/bots/${id}`).set(owner.auth)).status).toBe(201);
});

const claude = () => bots.CloseClaude.auth;
const codex = () => bots.CloseCodex.auth;
const gemini = () => bots.CloseGemini.auth;
async function post(content: string, auth: Record<string, string>, thread?: string) {
    const res = await ctx.request
        .post(thread ? `/channels/${channelId}/messages/${thread}/replies` : `/channels/${channelId}/messages`).set(auth).send({ content });
    expect(res.status, JSON.stringify(res.body)).toBe(201); return res.body;
}
const close = (thread: string, auth: Record<string, string>, body: Record<string, unknown> = { closed: true }) =>
    ctx.request.patch(`/channels/${channelId}/messages/${thread}/thread`).set(auth).send(body);
const list = (auth: Record<string, string>, query = '') => ctx.request.get(`/channels/${channelId}/threads${query}`).set(auth);
const START = '[AGORA/v1 MODE=review STATE=START]\nReview PR 131\nparticipants: [CloseCodex, CloseClaude]\n[YIELD to=CloseClaude]';
const turn = (to: string) => `[AGORA/v1 MODE=review STATE=TURN]\nMy part.\n[YIELD to=${to}]`;

describe('who can close a thread', () => {
    it('the agent that posted START under someone else\'s message can close it; another agent cannot', async () => {
        // Claude's message; Codex runs the review protocol in a thread under it (the #131 review)
        const parent = await post('PR 131 is ready for review', claude());
        await post(START, codex(), parent.id);
        await post('[AGORA/v1 MODE=review STATE=DONE]\nLooks good.', codex(), parent.id);

        const refused = await close(parent.id, gemini());
        expect(refused.status).toBe(403);
        expect(refused.body.message).toMatch(/posted its START/);

        const listed = (await list(codex())).body.find((t: any) => t.id === parent.id);
        expect(listed.canClose).toBe(true);
        expect((await list(gemini())).body.find((t: any) => t.id === parent.id).canClose).toBe(false);

        const closed = await close(parent.id, codex(), { closed: true, reason: 'done' });
        expect(closed.status).toBe(200);
        expect(closed.body).toMatchObject({ id: parent.id, closeReason: 'done', successorId: null });
        expect(closed.body.threadClosedAt).toBeTruthy();
    });

    it('an ordinary member who did not start it still cannot close it', async () => {
        const parent = await post('Owner topic', owner.auth);
        await post('a reply', member.auth, parent.id);
        expect((await close(parent.id, member.auth)).status).toBe(403);
        // The thread's author always can, and the owner (Manage Messages) can close any
        expect((await close(parent.id, owner.auth)).status).toBe(200);
    });
});

describe('closing with a reason and a successor', () => {
    it('records them, posts a notice in the thread, and points replies, history and discovery at the successor', async () => {
        const old = await post('Beta test plan', claude());
        await post(START, codex(), old.id);
        const next = await post('PR 131 review moves here', claude());

        const res = await close(old.id, codex(), { closed: true, successor: next.id });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toMatchObject({ closeReason: 'superseded', successorId: next.id });

        // History: a notice in the thread, and the reply list's headers
        const history = await ctx.request.get(`/channels/${channelId}/messages/${old.id}/replies`).set(owner.auth);
        expect(history.headers['x-agora-thread-state']).toBe('closed');
        expect(history.headers['x-agora-thread-close-reason']).toBe('superseded');
        expect(history.headers['x-agora-thread-successor']).toBe(next.id);
        const notice = history.body.at(-1);
        expect(notice).toMatchObject({ systemEvent: 'thread_closed', authorId: null,
            systemData: { reason: 'superseded', successorId: next.id, successorChannelId: channelId, closedBy: bots.CloseCodex.id } });
        expect(notice.content).toBe(`Closed by CloseCodex as superseded. The work continues in thread ${next.id}; don't resume it here.`);

        // A reply is refused with the successor
        const blocked = await ctx.request.post(`/channels/${channelId}/messages/${old.id}/replies`).set(claude()).send({ content: 'still here?' });
        expect(blocked.status).toBe(409);
        expect(blocked.body).toMatchObject({ error: 'Thread is closed', successorId: next.id });

        // Discovery: gone from open threads, listed as closed with why and where
        expect((await list(owner.auth)).body.map((t: any) => t.id)).not.toContain(old.id);
        const closedList = await list(owner.auth, '?state=closed');
        expect(closedList.status).toBe(200);
        expect(closedList.body.find((t: any) => t.id === old.id)).toMatchObject({
            closeReason: 'superseded', successorId: next.id, closedByUsername: 'CloseCodex', waiting: null,
        });
        // The channel's message list carries it for agents reading the channel
        const channel = await ctx.request.get(`/channels/${channelId}/messages`).set(owner.auth);
        expect(channel.body.find((m: any) => m.id === old.id)).toMatchObject({ threadCloseReason: 'superseded', threadSuccessorId: next.id });

        // Closing again the same way changes nothing and posts no second notice
        expect((await close(old.id, codex(), { closed: true, successor: next.id })).status).toBe(200);
        const again = await ctx.request.get(`/channels/${channelId}/messages/${old.id}/replies`).set(owner.auth);
        expect(again.body.filter((m: any) => m.systemEvent === 'thread_closed')).toHaveLength(1);

        // Reopening forgets why it closed
        const reopened = await close(old.id, owner.auth, { closed: false });
        expect(reopened.body).toMatchObject({ threadClosedAt: null, closeReason: null, successorId: null });
        const head = await ctx.request.get(`/channels/${channelId}/messages/${old.id}/replies`).set(owner.auth);
        expect(head.headers['x-agora-thread-state']).toBe('open');
        expect(head.headers['x-agora-thread-successor']).toBeUndefined();
    });

    it('adds a reason to a thread that was closed without one', async () => {
        const parent = await post('Quick question', claude());
        await post('answer', codex(), parent.id);
        expect((await close(parent.id, claude())).body.closeReason).toBeNull();
        const later = await close(parent.id, claude(), { closed: true, reason: 'cancelled' });
        expect(later.body.closeReason).toBe('cancelled');
        const replies = (await ctx.request.get(`/channels/${channelId}/messages/${parent.id}/replies`).set(owner.auth)).body;
        expect(replies.at(-1)).toMatchObject({ systemEvent: 'thread_closed', content: 'Closed by CloseClaude as cancelled.' });
    });

    it('validates the reason and the successor', async () => {
        const parent = await post('Topic', claude());
        await post('reply', codex(), parent.id);
        expect((await close(parent.id, claude(), { closed: true, reason: 'finished' })).status).toBe(400);
        expect((await close(parent.id, claude(), { closed: false, reason: 'done' })).status).toBe(400);
        expect((await close(parent.id, claude(), { closed: true, successor: 'not-a-ulid' })).status).toBe(400);
        expect((await close(parent.id, claude(), { closed: true, successor: generateUlid() })).body).toEqual({ error: 'successor_not_found' });
        expect((await close(parent.id, claude(), { closed: true, successor: parent.id })).status).toBe(400);
        expect((await close(parent.id, claude(), { closed: true, successor: (await post('next', claude())).id, reason: 'done' })).status).toBe(400);
        // A reply is not a thread
        const reply = await post('another reply', codex(), parent.id);
        expect((await close(parent.id, claude(), { closed: true, successor: reply.id })).body).toEqual({ error: 'successor_not_found' });
        // A successor in a channel the caller can't see is not found either
        // (a channel the bot was never added to)
        const hidden = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: `hidden-${generateUlid().toLowerCase()}`, channelType: 3 });
        expect(hidden.status).toBe(201);
        const hiddenMsg = await ctx.request.post(`/channels/${hidden.body.id}/messages`).set(owner.auth).send({ content: 'secret' });
        expect(hiddenMsg.status).toBe(201);
        expect((await close(parent.id, claude(), { closed: true, successor: hiddenMsg.body.id })).body).toEqual({ error: 'successor_not_found' });
        // The owner can see it, so for the owner it is a valid successor (checked without closing here)
        expect((await ctx.request.get(`/channels/${hidden.body.id}/messages`).set(claude())).status).toBe(403);
        // Nothing was closed by the refused calls
        expect((await list(owner.auth)).body.map((t: any) => t.id)).toContain(parent.id);
    });
});

describe('thread discovery for an agent that comes back (#132 regression)', () => {
    it('flags an older unfinished collaboration when a newer request for the agent exists', async () => {
        // An unfinished collaboration: Claude's TURN yields to Codex, then everyone moves on
        const old = await post('[AGORA/v1 MODE=plan STATE=START]\nBeta test plan\nparticipants: [CloseClaude, CloseCodex]\n[YIELD to=CloseCodex]', claude());
        await post(turn('CloseCodex'), claude(), old.id);
        await ctx.db.query(`UPDATE messages SET last_reply_at = NOW() - INTERVAL '2 hours' WHERE id = $1`, [old.id]);
        // The coordinator's newer message for Codex at the top of the channel
        const coordinator = await post('@CloseCodex please review PR 131 instead', claude());
        const current = await post('[AGORA/v1 MODE=review STATE=START]\nPR 131\nparticipants: [CloseClaude, CloseCodex]\n[YIELD to=CloseCodex]', claude());
        await post('[AGORA/v1 MODE=review STATE=ACK]\nOn it\n[YIELD to=CloseClaude]', codex(), current.id);

        const forCodex = (await list(codex())).body;
        const oldThread = forCodex.find((t: any) => t.id === old.id);
        expect(oldThread.newerRequestId).toBe(current.id > coordinator.id ? current.id : coordinator.id);
        expect(oldThread.latestProtocol).toMatchObject({ state: 'TURN', yieldTo: 'CloseCodex' });
        // The current collaboration is not flagged: nothing newer is addressed to Codex
        expect(forCodex.find((t: any) => t.id === current.id).newerRequestId).toBeNull();
        // Requests to someone else don't flag it for Gemini, and Claude's own posts don't flag it for Claude
        expect((await list(gemini())).body.find((t: any) => t.id === old.id).newerRequestId).toBeNull();
        expect((await list(claude())).body.find((t: any) => t.id === old.id).newerRequestId).toBeNull();
    });
});

describe('thread totals (#14)', () => {
    it('reports every matching thread in X-Total-Count, whatever the page size', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 7; i++) {
            const parent = await post(`Thread ${i}`, owner.auth);
            await post('reply', owner.auth, parent.id);
            ids.push(parent.id);
        }
        // Without replies a message is not a thread
        await post('No replies', owner.auth);
        const first = await list(owner.auth, '?limit=5');
        expect(first.status).toBe(200);
        expect(first.body).toHaveLength(5);
        expect(first.headers['x-total-count']).toBe('7');
        const page = await list(owner.auth, `?limit=5&before=${encodeURIComponent(first.body[4].lastReplyAt)}`);
        expect(page.body).toHaveLength(2);
        expect(page.headers['x-total-count']).toBe('7');

        await close(ids[0], owner.auth);
        expect((await list(owner.auth, '?limit=5')).headers['x-total-count']).toBe('6');
        expect((await list(owner.auth, '?state=closed')).headers['x-total-count']).toBe('1');
        expect((await list(owner.auth, '?before=yesterday-ish')).status).toBe(400);
        expect((await list(owner.auth, '?state=archived')).status).toBe(400);
    });
});
