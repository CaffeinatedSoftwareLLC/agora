import { setupTestApp, authedUser, createServer, cleanDatabase, joinViaInvite } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { runHandoffNudges, type NudgeEvent } from '../../src/workers/handoff-nudge';

/**
 * #327: a promised handoff can silently never happen. Threads show who they wait on, a YIELD to
 * oneself is refused, and an agent that has kept a thread waiting gets one reminder (its owner
 * is told when it is offline).
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string, channelId: string;
const bots: Record<string, { id: string; auth: Record<string, string> }> = {};

beforeAll(async () => {
    ctx = await setupTestApp(); await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'waitowner');
    serverId = (await createServer(ctx.request, owner.auth, 'Waiting')).serverId;
    // An ordinary member: may post, may not direct agents
    member = await authedUser(ctx.request, 'waitmember');
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    for (const name of ['WaitClaude', 'WaitCodex']) {
        const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: name });
        expect(bot.status).toBe(201);
        const token = await ctx.request.post(`/servers/${serverId}/bots/${bot.body.id}/tokens`).set(owner.auth).send({});
        expect(token.status).toBe(201);
        bots[name] = { id: bot.body.id, auth: { Authorization: `Bot ${token.body.token}` } };
    }
});
afterAll(async () => { await ctx.close(); });
beforeEach(async () => {
    const ch = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: `wait-${generateUlid().toLowerCase()}`, channelType: 3 });
    expect(ch.status).toBe(201); channelId = ch.body.id;
    for (const { id } of Object.values(bots)) expect((await ctx.request.post(`/channels/${channelId}/bots/${id}`).set(owner.auth)).status).toBe(201);
    // Each test starts with no recent reminders for the per-bot limits
    await ctx.db.query(`UPDATE messages SET system_data = system_data || '{"at": 0}' WHERE system_event = 'handoff_nudge'`);
});

const claude = () => bots.WaitClaude.auth;
const codex = () => bots.WaitCodex.auth;
const send = (content: string, auth: Record<string, string>, thread?: string) => ctx.request
    .post(thread ? `/channels/${channelId}/messages/${thread}/replies` : `/channels/${channelId}/messages`).set(auth).send({ content });
async function post(content: string, auth: Record<string, string>, thread?: string) {
    const res = await send(content, auth, thread);
    expect(res.status, JSON.stringify(res.body)).toBe(201); return res.body;
}
const turn = (to: string, text = 'Here is my part.') => `[AGORA/v1 MODE=fix STATE=TURN]\n${text}\n[YIELD to=${to}]`;
const wait = (on: string, what: string) => `[AGORA/v1 MODE=fix STATE=WAIT]\nThe builder is still running.\n[WAIT on=${on} for=${what}]`;
const threads = async () => (await ctx.request.get(`/channels/${channelId}/threads`).set(owner.auth)).body as any[];
const replies = async (thread: string) => (await ctx.request.get(`/channels/${channelId}/messages/${thread}/replies`).set(owner.auth)).body as any[];
const MIN = 60_000;
const later = (minutes: number) => Date.now() + minutes * MIN;
const run = (now: number, connected: string[] = [], beforeWrite?: () => Promise<void>) => {
    const events: NudgeEvent[] = [];
    // beforeWrite runs once, after the pass picked its waits and before it locks the first one
    const db = !beforeWrite ? ctx.db : { connect: async () => {
        const client = await ctx.db.connect();
        const query = client.query.bind(client) as (...a: any[]) => any;
        let fired = false;
        (client as any).query = async (...a: any[]) => {
            if (!fired && a[0] === 'BEGIN') { fired = true; await beforeWrite(); }
            return query(...a);
        };
        return client;
    } } as any;
    return runHandoffNudges({ db, emit: e => events.push(e), isConnected: id => connected.includes(id) }, now)
        .then(result => ({ ...result, events }));
};
const nudgesIn = async (thread: string) => (await replies(thread)).filter(m => m.systemEvent === 'handoff_nudge');

describe('a YIELD to oneself', () => {
    it('is refused on a top-level post, a reply and an edit, with what to post instead', async () => {
        const top = await send(turn('waitclaude'), claude());
        expect(top.status).toBe(400);
        expect(top.body.error).toBe('yield_to_self');
        expect(top.body.message).toMatch(/\[WAIT on=WaitClaude for=/);

        const parent = await post('[AGORA/v1 MODE=fix STATE=START]\nparticipants: [WaitClaude, WaitCodex]\n[YIELD to=WaitCodex]', claude());
        expect((await send(turn('WaitClaude'), claude(), parent.id)).status).toBe(400);
        expect((await replies(parent.id))).toHaveLength(0);

        const ok = await post(turn('WaitCodex'), claude(), parent.id);
        const edit = await ctx.request.patch(`/channels/${channelId}/messages/${ok.id}`).set(claude()).send({ content: turn('WaitClaude') });
        expect(edit.status).toBe(400);
        expect(edit.body.error).toBe('yield_to_self');
    });

    it('is refused for people too, and a YIELD to someone else still posts', async () => {
        expect((await send(turn('waitowner'), owner.auth)).status).toBe(400);
        expect((await send(turn('WaitCodex'), owner.auth)).status).toBe(201);
    });
});

describe('who a thread waits on', () => {
    it('is in the thread list: the YIELD target, then a WAIT, then nobody after DONE', async () => {
        const parent = await post('Fix the relay', owner.auth);
        await post(turn('WaitCodex'), claude(), parent.id);
        const first = (await threads()).find(t => t.id === parent.id);
        expect(first.waiting).toEqual(expect.objectContaining({ on: 'WaitCodex', for: null }));
        expect(Date.parse(first.waiting.since)).toBeGreaterThan(Date.now() - MIN);

        const waiting = await post(wait('WaitClaude', 'builder commit'), claude(), parent.id);
        expect((await threads()).find(t => t.id === parent.id).waiting)
            .toEqual(expect.objectContaining({ on: 'WaitClaude', for: 'builder commit', messageId: waiting.id }));

        await post('[AGORA/v1 MODE=fix STATE=DONE]\nshipped', claude(), parent.id);
        expect((await threads()).find(t => t.id === parent.id).waiting).toBeNull();
    });

    it('a WAIT naming an agent reaches its chat_wait as direct attention', async () => {
        expect((await ctx.request.get(`/channels/${channelId}/attention`).set(claude())).status).toBe(200);
        const parent = await post('Fix the relay', owner.auth);
        const w = await post(wait('WaitClaude', 'builder commit'), codex(), parent.id);
        const feed = await ctx.request.get(`/channels/${channelId}/attention`).set(claude());
        expect(feed.body.map((m: any) => [m.id, m.attention])).toEqual([[w.id, 'direct']]);
    });
});

describe('handoff nudges', () => {
    /** 2026-11-03: Claude promised Codex the builder's commit and never posted it. */
    async function deferredHandoff() {
        const parent = await post('[AGORA/v1 MODE=fix STATE=START]\nRelay on Heroku\nparticipants: [WaitClaude, WaitCodex]\n[YIELD to=WaitCodex]', claude());
        await post('[AGORA/v1 MODE=fix STATE=ACK]\nReady\n[YIELD to=WaitClaude]', codex(), parent.id);
        const promise = await post(wait('WaitClaude', 'builder commit'), claude(), parent.id);
        return { thread: parent.id as string, promise: promise.id as string };
    }

    it('reminds the agent once after 15 quiet minutes, and tells its owner when it is offline', async () => {
        const { thread, promise } = await deferredHandoff();

        expect((await run(later(14))).nudged).toBe(0);
        expect(await nudgesIn(thread)).toHaveLength(0);

        const pass = await run(later(16));
        expect(pass.nudged).toBeGreaterThanOrEqual(1);
        const [nudge] = await nudgesIn(thread);
        expect(nudge.content).toMatch(/^@WaitClaude this thread has waited on you for 1[56] min \(for: builder commit\)\./);
        expect(nudge.content).toMatch(/Agora can't reach WaitClaude here, so its owner was told\.$/);
        expect(nudge.systemData).toEqual(expect.objectContaining({ waitingOn: 'WaitClaude', protocolMessageId: promise, for: 'builder commit' }));
        expect(pass.events.map(e => e.event)).toEqual(expect.arrayContaining(['Message', 'ThreadMetadataUpdate']));

        // The mention wakes Claude's chat_wait; Codex sees it as a reply in its thread, which its until=turn wait skips
        const mention = await ctx.db.query('SELECT user_id FROM message_mentions WHERE message_id = $1', [nudge.id]);
        expect(mention.rows.map(r => r.user_id.trim())).toEqual([bots.WaitClaude.id]);
        const told = await ctx.db.query(`SELECT label, type FROM notifications WHERE user_id = $1 AND thread_id = $2`, [owner.userId, thread]);
        expect(told.rows).toEqual([expect.objectContaining({ type: 'collab', label: expect.stringMatching(/^WaitClaude has kept a thread waiting in #wait-/) })]);

        // Once per waiting message
        await run(later(40));
        expect(await nudgesIn(thread)).toHaveLength(1);
    });

    it('does not tell the owner while the agent is connected', async () => {
        const { thread } = await deferredHandoff();
        await run(later(16), [bots.WaitClaude.id]);
        const [nudge] = await nudgesIn(thread);
        expect(nudge.content).not.toMatch(/owner/);
        const told = await ctx.db.query('SELECT 1 FROM notifications WHERE thread_id = $1', [thread]);
        expect(told.rows).toHaveLength(0);
    });

    it('leaves the thread alone once the agent posts, and a fresh WAIT starts a new wait', async () => {
        const { thread } = await deferredHandoff();
        await post('Builder is at step 3 of 5.', claude(), thread);
        await run(later(16));
        expect(await nudgesIn(thread)).toHaveLength(0);

        const again = await post(wait('WaitClaude', 'builder step 5'), claude(), thread);
        await run(later(32));
        const nudges = await nudgesIn(thread);
        expect(nudges.map(n => n.systemData.protocolMessageId)).toEqual([again.id]);
    });

    it('nudges the agent a TURN yields to, and never a person or a finished or closed thread', async () => {
        const toCodex = await post('Review this', claude());
        await post('[AGORA/v1 MODE=fix STATE=ACK]\nready\n[YIELD to=WaitClaude]', codex(), toCodex.id);
        await post(turn('WaitCodex'), claude(), toCodex.id);
        const toPerson = await post('Ask the owner', owner.auth);
        await post(turn('waitowner'), claude(), toPerson.id);
        const done = await post('Finished work', owner.auth);
        await post(turn('WaitCodex'), claude(), done.id);
        await post('[AGORA/v1 MODE=fix STATE=DONE]\nall good', claude(), done.id);
        const closed = await post('Closed work', owner.auth);
        await post(turn('WaitCodex'), claude(), closed.id);
        expect((await ctx.request.patch(`/channels/${channelId}/messages/${closed.id}/thread`).set(owner.auth).send({ closed: true })).status).toBe(200);

        await run(later(16));
        expect((await nudgesIn(toCodex.id)).map(n => n.systemData.waitingOn)).toEqual(['WaitCodex']);
        expect(await nudgesIn(toPerson.id)).toHaveLength(0);
        expect(await nudgesIn(done.id)).toHaveLength(0);
        expect(await nudgesIn(closed.id)).toHaveLength(0);
    });

    it('never nudges an agent that has not posted in the thread, so a post cannot page any bot owner', async () => {
        const top = await post(wait('WaitCodex', 'nothing'), owner.auth);
        const thread = await post('Unrelated', owner.auth);
        await post(turn('WaitCodex'), claude(), thread.id);
        await run(later(16));
        expect(await nudgesIn(top.id)).toHaveLength(0);
        expect(await nudgesIn(thread.id)).toHaveLength(0);
    });

    it('leaves waits older than 4x the nudge time alone, so a deploy does not wake every old thread', async () => {
        const { thread } = await deferredHandoff();
        await run(later(61));
        expect(await nudgesIn(thread)).toHaveLength(0);
        // Closed, so later tests' passes don't pick this wait up
        expect((await ctx.request.patch(`/channels/${channelId}/messages/${thread}/thread`).set(owner.auth).send({ closed: true })).status).toBe(200);
    });

    it('reminds a bot at most once per nudge time, and tells its owner at most once an hour', async () => {
        const a = await deferredHandoff();
        const b = await deferredHandoff();
        const first = await run(later(16));
        expect(await nudgesIn(a.thread)).toHaveLength(1);
        expect(await nudgesIn(b.thread)).toHaveLength(0);
        expect(first.ownersNotified).toBe(1);

        const second = await run(later(32));
        const [late] = await nudgesIn(b.thread);
        expect(late.content).toMatch(/Agora can't reach WaitClaude here\.$/);
        expect(second.ownersNotified).toBe(0);
        const told = await ctx.db.query('SELECT 1 FROM notifications WHERE user_id = $1 AND thread_id IN ($2, $3)', [owner.userId, a.thread, b.thread]);
        expect(told.rows).toHaveLength(1);
    });

    it('never turns an ordinary member\'s WAIT or YIELD into a reminder, and a member cannot cancel one', async () => {
        // Both agents took part, then the work paused without a wait
        const thread = await post('Relay on Heroku', claude());
        await post('Looking.', codex(), thread.id);
        await post(wait('WaitCodex', 'forged'), member.auth, thread.id);
        await post(turn('WaitClaude'), member.auth, thread.id);
        // A real wait, which a member's DONE does not end
        const real = await deferredHandoff();
        await post('[AGORA/v1 MODE=fix STATE=DONE]\nnothing to do', member.auth, real.thread);
        await run(later(16));
        expect(await nudgesIn(thread.id)).toHaveLength(0);
        expect((await nudgesIn(real.thread)).map(n => n.systemData.protocolMessageId)).toEqual([real.promise]);
    });

    it('counts another bot\'s handoff only once that bot has taken part in the thread', async () => {
        const thread = await post('Relay on Heroku', owner.auth);
        await post('Looking.', codex(), thread.id);
        // WaitClaude's first post in the thread hands off to Codex: not a participant's handoff
        await post(turn('WaitCodex'), claude(), thread.id);
        await run(later(16));
        expect(await nudgesIn(thread.id)).toHaveLength(0);
    });

    it('drops a wait whose author could direct agents but no longer can, without starving the rest', async () => {
        // 55 threads where Claude took part and a former director YIELDed to it, as stored rows: the
        // stamp says they could direct when they posted; the member has no DirectAgents now
        for (let i = 0; i < 55; i++) {
            const parent = generateUlid();
            await ctx.db.query(`INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1, $2, $3, 'job')`,
                [parent, channelId, bots.WaitClaude.id]);
            await ctx.db.query(`INSERT INTO messages (id, channel_id, author_id, content, thread_id, protocol, author_could_direct)
                VALUES ($1, $2, $3, 'over to you', $4, $5, true)`,
            [generateUlid(), channelId, member.userId, parent, JSON.stringify({ version: 1, mode: 'fix', state: 'TURN', yieldTo: 'WaitClaude' })]);
            await ctx.db.query('UPDATE messages SET reply_count = 1, last_reply_at = NOW() WHERE id = $1', [parent]);
        }
        const { thread } = await deferredHandoff();
        const pass = await run(later(16));
        expect(pass.nudged).toBe(1);
        expect(await nudgesIn(thread)).toHaveLength(1);
    });

    it('is not starved by a batch of waits it may not nudge', async () => {
        // More top-level YIELDs to a bot that never posted than one pass takes
        for (let i = 0; i < 55; i++) await post(turn('WaitCodex', `job ${i}`), owner.auth);
        const { thread } = await deferredHandoff();
        await run(later(16));
        expect(await nudgesIn(thread)).toHaveLength(1);
    });

    for (const [what, act] of [
        ['a DONE', (t: string) => post('[AGORA/v1 MODE=fix STATE=DONE]\nshipped', codex(), t)],
        ['a reply from the agent', (t: string) => post('Here is the commit.', claude(), t)],
        ['closing the thread', (t: string) => ctx.request.patch(`/channels/${channelId}/messages/${t}/thread`).set(owner.auth).send({ closed: true })],
    ] as const) {
        it(`posts nothing when ${what} lands while the pass runs`, async () => {
            const { thread } = await deferredHandoff();
            const pass = await run(later(16), [], async () => { await act(thread); });
            expect(await nudgesIn(thread)).toHaveLength(0);
            expect(pass.events.filter(e => (e.data as any).threadId === thread || (e.data as any).messageId === thread)).toEqual([]);
        });
    }

    it('sends the reminder live with what agora-mcp needs to filter it', async () => {
        const { thread } = await deferredHandoff();
        const pass = await run(later(16));
        const live = pass.events.find(e => e.event === 'Message' && (e.data as any).threadId === thread)!.data as any;
        expect(live).toEqual(expect.objectContaining({ systemEvent: 'handoff_nudge', authorBot: false, mentionsEveryone: false,
            systemData: expect.objectContaining({ waitingOn: 'WaitClaude' }) }));
    });

    it('follows threads.nudge_minutes, and 0 turns nudges off', async () => {
        await ctx.db.query('UPDATE users SET is_instance_admin = true WHERE id = $1', [owner.userId]);
        const admin = owner;
        const set = (body: unknown) => ctx.request.patch('/admin/settings/threads').set(admin.auth).send(body);
        expect((await set({ nudgeMinutes: -1 })).status).toBe(400);
        expect((await set({ nudgeMinutes: 5 })).body).toEqual({ nudgeMinutes: 5 });
        expect((await ctx.request.get('/admin/settings/threads').set(admin.auth)).body).toEqual({ nudgeMinutes: 5 });

        const { thread } = await deferredHandoff();
        await run(later(6));
        expect(await nudgesIn(thread)).toHaveLength(1);

        expect((await set({ nudgeMinutes: 0 })).status).toBe(200);
        const quiet = await deferredHandoff();
        await run(later(600));
        expect(await nudgesIn(quiet.thread)).toHaveLength(0);
        expect((await set({ nudgeMinutes: 15 })).status).toBe(200);
    });
});
