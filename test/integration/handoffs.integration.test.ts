import { setupTestApp, authedUser, createServer, cleanDatabase, joinViaInvite } from '../helpers';

/** Ownership handoffs between agents (#84, src/lib/handoffs.ts). */
let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>, member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string, channel: string, privateChannel: string, hostId: string, hostAuth: { Authorization: string };
interface Agent { id: string; profileId: string; name: string; auth: { Authorization: string } }
let a: Agent, b: Agent, c: Agent;
const SHA = 'a'.repeat(40), SHA2 = 'b'.repeat(40);

async function makeAgent(name: string): Promise<Agent> {
    const res = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
        .send({ name, hostId, adapter: 'codex', workdirAlias: 'repo', channelId: channel });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.bot.id, profileId: res.body.profile.id, name, auth: { Authorization: `Bot ${res.body.token}` } };
}
async function start(agent: Agent) {
    const res = await ctx.request.post(`/channels/${channel}/agent-commands`).set(owner.auth).send({ command: 'start', profile: agent.name });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.session.id as string;
}
async function end(agent: Agent) {
    expect((await ctx.request.post(`/channels/${channel}/agent-commands`).set(owner.auth).send({ command: 'end', profile: agent.name })).status).toBe(200);
}
const claim = () => ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
/** Run every queued wake to completion; each run reports `head` as its committed head. */
async function drain(head = SHA) {
    const claims: any[] = [];
    for (let i = 0; i < 10; i++) {
        const res = await claim();
        if (res.status === 204) return claims;
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        claims.push(res.body);
        const done = await ctx.request.post(`/agent-hosts/@me/runs/${res.body.run.id}/complete`).set(hostAuth).send({
            claimToken: res.body.run.claimToken, nativeSessionId: null, tokensUsed: 1, summary: 'ok',
            branch: `agora/${res.body.profile.name}/${res.body.session.id}`, baseSha: SHA2, headSha: head,
        });
        expect(done.status, JSON.stringify(done.body)).toBe(200);
    }
    throw new Error('runs did not drain');
}
async function thread() {
    const res = await ctx.request.post(`/channels/${channel}/messages`).set(member.auth).send({ content: 'Fix the flaky upload test' });
    expect(res.status).toBe(201);
    return res.body.id as string;
}
const offer = (agent: Agent, body: object) => ctx.request.post(`/channels/${channel}/handoffs`).set(agent.auth).send(body);
const answer = (auth: object, id: string, action: string, extra: object = {}) =>
    ctx.request.post(`/channels/${channel}/handoffs/${id}`).set(auth).send({ action, ...extra });
const state = (threadId: string, auth: object = owner.auth) => ctx.request.get(`/channels/${channel}/threads/${threadId}/handoffs`).set(auth);
async function reserve(agent: Agent, paths: string[]) {
    const res = await ctx.request.post(`/channels/${channel}/file-reservations`).set(agent.auth).send({ action: 'reserve', paths });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.reservation;
}
async function inbox(sessionId: string) {
    return (await ctx.db.query(`SELECT i.reason, i.acked_at IS NOT NULL AS acked, m.system_event, m.content FROM agent_inbox i
        JOIN messages m ON m.id = i.message_id WHERE i.session_id = $1 ORDER BY i.id`, [sessionId])).rows;
}
async function notices(threadId: string) {
    return (await ctx.db.query(`SELECT content FROM messages WHERE thread_id = $1 AND system_event = 'agent_session' ORDER BY id`, [threadId])).rows.map(r => r.content as string);
}
async function offerOk(agent: Agent, body: object) {
    const res = await offer(agent, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.offer;
}

beforeAll(async () => {
    ctx = await setupTestApp(); await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'hoowner'); member = await authedUser(ctx.request, 'homember');
    const server = await createServer(ctx.request, owner.auth, 'Handoffs'); serverId = server.serverId; channel = server.generalChannelId;
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 1000, max_bot_hops = 1000 WHERE id = $1', [channel]);
    const ch = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: 'private', channelType: 3 }); privateChannel = ch.body.id;
    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'handoff-host' });
    hostId = host.body.host.id; hostAuth = { Authorization: `AgentHost ${host.body.token}` };
    a = await makeAgent('hoa'); b = await makeAgent('hob'); c = await makeAgent('hoc');
});
afterAll(async () => { await ctx.close(); });
beforeEach(async () => {
    await ctx.db.query('TRUNCATE agent_runs, agent_inbox, agent_batches, agent_session_threads, agent_sessions CASCADE');
    await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'subscription', plan_owner_id = NULL WHERE server_id = $1`, [serverId]);
});

describe('offer', () => {
    it('pins the last committed branch@sha and reservations, posts the card as the sender and wakes the recipient', async () => {
        const sa = await start(a), sb = await start(b);
        await drain();
        const t = await thread();
        const r = await reserve(a, ['src/upload/']);
        const o = await offerOk(a, { threadId: t, to: 'HOB', summary: 'Upload fix is half done; tests left.' });
        expect(o).toMatchObject({ status: 'pending', from: 'hoa', to: 'hob', fromSessionId: sa, toSessionId: sb,
            branch: `agora/hoa/${sa}`, headSha: SHA, senderRunning: false, reservationIds: [r.id], paths: ['src/upload/'] });
        const ttl = Date.parse(o.expiresAt) - Date.now();
        expect(ttl).toBeGreaterThan(1790_000); expect(ttl).toBeLessThan(1810_000);
        const card = (await ctx.db.query('SELECT author_id, content, system_event, system_data, thread_id FROM messages WHERE id = $1', [o.messageId])).rows[0];
        expect(card.author_id.trim()).toBe(a.id);
        expect(card.thread_id.trim()).toBe(t);
        expect(card.system_event).toBe('agent_handoff');
        expect(card.content).toContain(`[HANDOFF offer=${o.id} to=hob]`);
        expect(card.content).toContain(`agora/hoa/${sa} @ ${SHA}`);
        expect(card.system_data).toMatchObject({ kind: 'agent_handoff', offerId: o.id, status: 'pending' });
        expect((await inbox(sb)).filter(r => r.reason !== 'command')).toEqual([expect.objectContaining({ reason: 'handoff', acked: false, system_event: 'agent_handoff' })]);

        // The recipient's wake carries the offer and its branch@sha for the host prompt
        const [wake] = await drain();
        expect(wake.session.id).toBe(sb);
        expect(wake.inbox[0]).toMatchObject({ reason: 'handoff', authorId: a.id, authorBot: true });
        expect(wake.inbox[0].content).toContain(SHA);
        expect(wake.handoffs).toEqual([{ offerId: o.id, threadId: t, from: 'hoa', status: 'pending', branch: `agora/hoa/${sa}`, headSha: SHA, senderRunning: false }]);
    });

    it('says when the sender is mid-turn: the turn in progress is not in the pinned commit', async () => {
        await start(a); await start(b); await drain();
        const t = await thread();
        // Give hoa a run in progress
        await ctx.request.post(`/channels/${channel}/messages`).set(owner.auth).send({ content: '@hoa keep going' });
        const running = await claim();
        expect(running.body.profile.name).toBe('hoa');
        const o = await offerOk(a, { threadId: t, to: 'hob', summary: 'Mid-turn offer' });
        expect(o.senderRunning).toBe(true);
        expect(o.headSha).toBe(SHA);
        const card = (await ctx.db.query('SELECT content FROM messages WHERE id = $1', [o.messageId])).rows[0];
        expect(card.content).toContain('edits from that turn are not in this commit');
    });

    it('refuses recipients that are not live, cannot see the channel, or are the sender; and a second open offer', async () => {
        await start(a);
        const t = await thread();
        expect((await offer(a, { threadId: t, to: 'hob', summary: 'x' })).body.error).toBe('recipient_not_live');
        expect((await offer(a, { threadId: t, to: 'hoa', summary: 'x' })).body.error).toBe('recipient_not_found');
        expect((await offer(a, { threadId: t, to: 'nobody', summary: 'x' })).status).toBe(404);
        await start(b);
        await ctx.db.query('DELETE FROM bot_channel_access WHERE bot_id = $1 AND channel_id = $2', [b.id, channel]);
        try {
            const res = await offer(a, { threadId: t, to: 'hob', summary: 'x' });
            expect(res.status).toBe(403); expect(res.body.error).toBe('recipient_cannot_see_thread');
        } finally {
            await ctx.request.post(`/channels/${channel}/bots/${b.id}`).set(owner.auth);
        }
        await offerOk(a, { threadId: t, to: 'hob', summary: 'x' });
        await start(c);
        expect((await offer(a, { threadId: t, to: 'hoc', summary: 'y' })).body.error).toBe('offer_pending');
        // People and agents without a live session can't offer
        expect((await ctx.request.post(`/channels/${channel}/handoffs`).set(owner.auth).send({ threadId: t, to: 'hob', summary: 'x' })).status).toBe(403);
        expect((await offer(a, { threadId: t, to: 'hob', summary: 'x', ttlSeconds: 10 })).status).toBe(400);
        expect((await offer(a, { threadId: privateChannel.padEnd(26, '0').slice(0, 26), to: 'hob', summary: 'x' })).body.error).toBe('thread_not_found');
    });

    it('applies the plan-owner rule: a subscription recipient takes handoffs only inside work its owner started', async () => {
        const sa = await start(a); await start(b);
        const t = await thread();
        await ctx.db.query('UPDATE agent_sessions SET started_by = $2 WHERE id = $1', [sa, member.userId]);
        const refused = await offer(a, { threadId: t, to: 'hob', summary: 'x' });
        expect(refused.status).toBe(403); expect(refused.body.error).toBe('plan_owner_only');
        expect(refused.body.message).toContain('personal subscription');
        // An API-key recipient follows the ordinary rules
        await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'api_key' WHERE id = $1`, [b.profileId]);
        await offerOk(a, { threadId: t, to: 'hob', summary: 'x' });
    });
});

describe('accept', () => {
    it('makes the recipient the owner, moves reservations with a fresh TTL and posts the notice', async () => {
        const sa = await start(a), sb = await start(b); await drain();
        const t = await thread();
        const r = await reserve(a, ['src/upload/']);
        await ctx.db.query(`UPDATE agent_file_reservations SET expires_at = NOW() + interval '60 seconds' WHERE id = $1`, [r.id]);
        const o = await offerOk(a, { threadId: t, to: 'hob', summary: 'Take it' });
        expect((await answer(c.auth, o.id, 'accept')).status).toBe(403);
        expect((await answer(owner.auth, o.id, 'accept')).status).toBe(403);
        const res = await answer(b.auth, o.id, 'accept');
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toMatchObject({ alreadyAccepted: false, transferred: [r.id], skipped: [], offer: { status: 'accepted' } });
        const moved = (await ctx.db.query('SELECT session_id, expires_at FROM agent_file_reservations WHERE id = $1', [r.id])).rows[0];
        expect(moved.session_id.trim()).toBe(sb);
        expect(Date.parse(moved.expires_at) - Date.now()).toBeGreaterThan(890_000);
        // hob holds it now: hoa conflicts with it
        expect((await ctx.request.post(`/channels/${channel}/file-reservations`).set(a.auth).send({ action: 'reserve', paths: ['src/upload/x.ts'] })).status).toBe(409);
        expect(await notices(t)).toEqual([expect.stringContaining(`hob now owns this (from hoa @ agora/hoa/${sa}@${SHA.slice(0, 12)})`)]);
        const view = await state(t);
        expect(view.body.owner).toMatchObject({ sessionId: sb, botId: b.id, username: 'hob', from: 'hoa', headSha: SHA });
        expect(view.body.offers[0]).toMatchObject({ id: o.id, status: 'accepted' });
        const card = (await ctx.db.query('SELECT system_data FROM messages WHERE id = $1', [o.messageId])).rows[0];
        expect(card.system_data.status).toBe('accepted');
        // Later wakes in that thread remind the owner where the work came from
        expect((await ctx.request.post(`/channels/${channel}/messages/${t}/replies`).set(owner.auth).send({ content: '@hob status?' })).status).toBe(201);
        const later = await drain();
        const wake = later.find(w => w.session.id === sb);
        expect(wake?.handoffs).toEqual([expect.objectContaining({ offerId: o.id, status: 'accepted', headSha: SHA })]);
    });

    it('is idempotent and race-safe: concurrent accepts give one owner and one notice', async () => {
        await start(a); await start(b); await drain();
        const t = await thread();
        const o = await offerOk(a, { threadId: t, to: 'hob', summary: 'race' });
        const results = await Promise.all([answer(b.auth, o.id, 'accept'), answer(b.auth, o.id, 'accept'), answer(b.auth, o.id, 'accept')]);
        expect(results.map(r => r.status)).toEqual([200, 200, 200]);
        expect(results.filter(r => r.body.alreadyAccepted === false)).toHaveLength(1);
        expect(await notices(t)).toHaveLength(1);
        expect((await answer(b.auth, o.id, 'decline')).body.error).toBe('offer_accepted');
    });

    it('only the owner hands off again; the new owner can hand it back', async () => {
        await start(a); await start(b); await start(c); await drain();
        const t = await thread();
        const o = await offerOk(a, { threadId: t, to: 'hob', summary: 'one' });
        expect((await answer(b.auth, o.id, 'accept')).status).toBe(200);
        expect((await offer(a, { threadId: t, to: 'hoc', summary: 'two' })).body.error).toBe('not_task_owner');
        const back = await offerOk(b, { threadId: t, to: 'hoa', summary: 'back' });
        expect((await answer(a.auth, back.id, 'accept')).status).toBe(200);
        expect((await state(t)).body.owner.username).toBe('hoa');
    });

    it('expires: accept after expiry is refused, the card says so and the queued wake is dropped', async () => {
        await start(a); const sb = await start(b); await drain();
        const t = await thread();
        const o = await offerOk(a, { threadId: t, to: 'hob', summary: 'late' });
        await ctx.db.query(`UPDATE agent_handoffs SET expires_at = NOW() - interval '1 second' WHERE id = $1`, [o.id]);
        const res = await answer(b.auth, o.id, 'accept');
        expect(res.status).toBe(410); expect(res.body.error).toBe('offer_expired');
        expect((await ctx.db.query('SELECT status FROM agent_handoffs WHERE id = $1', [o.id])).rows[0].status).toBe('expired');
        expect((await ctx.db.query('SELECT system_data FROM messages WHERE id = $1', [o.messageId])).rows[0].system_data.status).toBe('expired');
        expect((await inbox(sb)).filter(r => r.system_event === 'agent_handoff')).toEqual([expect.objectContaining({ acked: true })]);
        expect((await state(t)).body.owner).toBeNull();
        // A new offer may follow an expired one
        await offerOk(a, { threadId: t, to: 'hob', summary: 'again' });
    });

    it('refuses when the recipient session has ended, and rechecks plan ownership at accept time', async () => {
        await start(a); const sb = await start(b); await drain();
        const t = await thread();
        const o = await offerOk(a, { threadId: t, to: 'hob', summary: 'x' });
        await ctx.db.query('UPDATE agent_sessions SET started_by = $2 WHERE id = $1', [sb, member.userId]);
        const refused = await answer(b.auth, o.id, 'accept');
        expect(refused.status).toBe(403); expect(refused.body.error).toBe('plan_owner_only');
        await ctx.db.query('UPDATE agent_sessions SET started_by = $2 WHERE id = $1', [sb, owner.userId]);
        await end(b);
        const ended = await answer(b.auth, o.id, 'accept');
        expect(ended.status).toBe(409); expect(ended.body.error).toBe('recipient_session_ended');
        expect((await ctx.db.query('SELECT status FROM agent_handoffs WHERE id = $1', [o.id])).rows[0].status).toBe('pending');
    });

    it('moves only reservations the sender still holds: released or re-held paths stay put', async () => {
        await start(a); const sb = await start(b); const sc = await start(c); await drain();
        const t = await thread();
        const kept = await reserve(a, ['docs/']);
        const lost = await reserve(a, ['src/a.ts']);
        const mine = await reserve(a, ['src/b.ts']);
        const o = await offerOk(a, { threadId: t, to: 'hob', summary: 'x' });
        // One lapses and a third agent takes the path; another lapses and the recipient takes it itself
        await ctx.db.query(`UPDATE agent_file_reservations SET expires_at = NOW() - interval '1 second' WHERE id = ANY($1)`, [[lost.id, mine.id]]);
        const third = await reserve(c, ['src/a.ts']);
        const own = await reserve(b, ['src/b.ts']);
        const res = await answer(b.auth, o.id, 'accept');
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.transferred).toEqual([kept.id]);
        expect(res.body.skipped.sort()).toEqual([lost.id, mine.id].sort());
        const holders = Object.fromEntries((await ctx.db.query(`SELECT id, session_id FROM agent_file_reservations
            WHERE released_at IS NULL AND expires_at > NOW()`)).rows.map(r => [r.id.trim(), r.session_id.trim()]));
        expect(holders).toEqual({ [kept.id]: sb, [third.id]: sc, [own.id]: sb });
        expect((await notices(t))[0]).toContain('2 reservations had expired');
    });
});

describe('decline and cancel', () => {
    it('decline: only the recipient, the sender is told, and the offer is closed', async () => {
        const sa = await start(a); await start(b); await drain();
        const t = await thread();
        const o = await offerOk(a, { threadId: t, to: 'hob', summary: 'x' });
        expect((await answer(a.auth, o.id, 'decline')).status).toBe(403);
        const res = await answer(b.auth, o.id, 'decline', { reason: 'busy with #12' });
        expect(res.status).toBe(200); expect(res.body.offer).toMatchObject({ status: 'declined', reason: 'busy with #12' });
        expect((await answer(b.auth, o.id, 'decline')).status).toBe(200);
        expect((await answer(b.auth, o.id, 'accept')).body.error).toBe('offer_declined');
        const told = (await inbox(sa)).filter(r => r.reason === 'command' && r.content.includes('declined'));
        expect(told).toHaveLength(1);
        expect(told[0].content).toContain('busy with #12');
        expect((await state(t)).body.owner).toBeNull();
    });

    it('cancel: the owner, a director or the sender; not a plain member; drops the recipient wake', async () => {
        await start(a); const sb = await start(b); await drain();
        const t = await thread();
        const o = await offerOk(a, { threadId: t, to: 'hob', summary: 'x' });
        expect((await answer(member.auth, o.id, 'cancel')).status).toBe(403);
        expect((await answer(b.auth, o.id, 'cancel')).status).toBe(403);
        const res = await answer(owner.auth, o.id, 'cancel');
        expect(res.status).toBe(200); expect(res.body.offer.status).toBe('cancelled');
        expect((await inbox(sb)).filter(r => r.system_event === 'agent_handoff')).toEqual([expect.objectContaining({ acked: true })]);
        expect((await answer(b.auth, o.id, 'accept')).body.error).toBe('offer_cancelled');
        expect((await notices(t))[0]).toContain('hoowner cancelled the handoff from hoa to hob');
        const again = await offerOk(a, { threadId: t, to: 'hob', summary: 'y' });
        expect((await answer(a.auth, again.id, 'cancel')).status).toBe(200);
        // Anyone who can see the channel can read the offers
        expect((await state(t, member.auth)).body.offers.map((x: any) => x.status)).toEqual(['cancelled', 'cancelled']);
    });
});

/** beta-test-plan §6.1 "Handoffs respect plan owners": a plan_owner_only refusal changes nothing. */
describe('beta §6.1: plan-owner handoff refusals leave nothing behind', () => {
    it('a refused offer creates no offer row, no card and no wake for the recipient', async () => {
        const sa = await start(a); const sb = await start(b); await drain();
        const t = await thread();
        await ctx.db.query('UPDATE agent_sessions SET started_by = $2 WHERE id = $1', [sa, member.userId]);
        const refused = await offer(a, { threadId: t, to: 'hob', summary: 'x' });
        expect(refused.status).toBe(403);
        expect(refused.body.error).toBe('plan_owner_only');
        expect((await ctx.db.query('SELECT count(*)::int AS n FROM agent_handoffs WHERE thread_id = $1', [t])).rows[0].n).toBe(0);
        expect((await ctx.db.query(`SELECT count(*)::int AS n FROM messages WHERE system_event = 'agent_handoff' AND (thread_id = $1 OR id = $1)`, [t])).rows[0].n).toBe(0);
        // Only the drained /start wake, nothing new
        expect((await inbox(sb)).filter((r: any) => !r.acked || r.reason === 'handoff' || r.system_event === 'agent_handoff')).toEqual([]);
        expect((await claim()).status).toBe(204);
        expect((await state(t)).body).toMatchObject({ owner: null, offers: [] });
    });

    it('a refused accept leaves the offer pending, reservations with the sender and no owner', async () => {
        const sa = await start(a); const sb = await start(b); await drain();
        const t = await thread();
        const r = await reserve(a, ['src/plan/']);
        const o = await offerOk(a, { threadId: t, to: 'hob', summary: 'x' });
        await drain();
        await ctx.db.query('UPDATE agent_sessions SET started_by = $2 WHERE id = $1', [sb, member.userId]);
        const refused = await answer(b.auth, o.id, 'accept');
        expect(refused.status).toBe(403);
        expect(refused.body.error).toBe('plan_owner_only');
        expect((await ctx.db.query('SELECT status FROM agent_handoffs WHERE id = $1', [o.id])).rows[0].status).toBe('pending');
        expect((await ctx.db.query('SELECT session_id FROM agent_file_reservations WHERE id = $1', [r.id])).rows[0].session_id.trim()).toBe(sa);
        expect(await notices(t)).toEqual([]);
        expect((await state(t)).body.owner).toBeNull();
        expect((await ctx.db.query('SELECT system_data FROM messages WHERE id = $1', [o.messageId])).rows[0].system_data.status).toBe('pending');
    });
});
