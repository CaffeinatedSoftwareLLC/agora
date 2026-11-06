import { setupTestApp, authedUser, cleanDatabase, createServer, joinViaInvite } from '../helpers';
import { getRedis } from '../../src/auth/token-blacklist';
import { Permissions } from '../../src/permissions';

// #23: the loop guard is visible and can be resumed from where it fires.

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let botManager: Awaited<ReturnType<typeof authedUser>>;
let outsider: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let otherChannelId: string;
let botAuth: { Authorization: string };

const ULID_ZERO = '0'.repeat(26);
const botPost = (content: string) => ctx.request.post(`/channels/${channelId}/messages`).set(botAuth).send({ content });
const botReply = (parentId: string, content: string) =>
    ctx.request.post(`/channels/${channelId}/messages/${parentId}/replies`).set(botAuth).send({ content });
const resume = (auth: object, body?: object) => {
    const req = ctx.request.post(`/channels/${channelId}/loop-guard/resume`).set(auth);
    return body === undefined ? req : req.send(body);
};

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'lgowner');
    member = await authedUser(ctx.request, 'lgmember');
    botManager = await authedUser(ctx.request, 'lgbotmanager');
    outsider = await authedUser(ctx.request, 'lgoutsider');
    ({ serverId, generalChannelId: channelId } = await createServer(ctx.request, owner.auth, 'Loop Guard Server'));
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    await joinViaInvite(ctx.request, owner.auth, botManager.auth, serverId);

    const role = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth)
        .send({ name: 'Bot keeper', permissions: Permissions.ManageBots.toString() });
    expect(role.status).toBe(201);
    expect((await ctx.request.put(`/servers/${serverId}/members/${botManager.userId}/roles/${role.body.id}`).set(owner.auth)).status).toBe(200);

    const other = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: 'other', channelType: 3 });
    expect(other.status).toBe(201);
    otherChannelId = other.body.id;

    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'lgbot' });
    expect(bot.status).toBe(201);
    const token = await ctx.request.post(`/servers/${serverId}/bots/${bot.body.id}/tokens`).set(owner.auth).send({ name: 't' });
    botAuth = { Authorization: `Bot ${token.body.token}` };
    expect((await ctx.request.post(`/channels/${channelId}/bots/${bot.body.id}`).set(owner.auth)).status).toBe(201);
});

afterAll(async () => { await ctx.close(); });

afterEach(async () => {
    await ctx.db.query('UPDATE channels SET max_bot_hops = 4, max_thread_bot_hops = 0 WHERE id = $1', [channelId]);
    const redis = getRedis();
    for (const pattern of ['loopguard:*', 'botrate:*']) {
        const keys = await redis.keys(pattern);
        if (keys.length > 0) await redis.del(...keys);
    }
});

describe('POST /channels/:id/loop-guard/resume (channel)', () => {
    test('the notice records its scope, and resuming resets the counter and wakes agents', async () => {
        await ctx.db.query('UPDATE channels SET max_bot_hops = 2 WHERE id = $1', [channelId]);
        expect((await botPost('one')).status).toBe(201);
        expect((await botPost('two')).status).toBe(201);
        expect((await botPost('three')).status).toBe(429);
        const notice = await ctx.db.query(
            "SELECT system_data FROM messages WHERE channel_id = $1 AND system_event = 'loop_guard' ORDER BY id DESC LIMIT 1", [channelId]);
        expect(notice.rows[0].system_data).toEqual({ scope: 'channel', threadId: null, limit: 2 });

        // Mid-count: two more bot posts would trip the guard without the reset
        expect((await botPost('four')).status).toBe(201);
        expect((await botPost('five')).status).toBe(201);
        const res = await resume(botManager.auth, {});
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ scope: 'channel', threadId: null, limit: 2 });
        expect(await getRedis().get(`loopguard:${channelId}`)).toBeNull();
        expect((await botPost('six')).status).toBe(201);
        expect((await botPost('seven')).status).toBe(201);

        const row = await ctx.db.query('SELECT content, system_event, system_data, thread_id, author_id FROM messages WHERE id = $1', [res.body.messageId]);
        expect(row.rows[0]).toMatchObject({ system_event: 'loop_guard_resume', thread_id: null, author_id: null });
        expect(row.rows[0].content).toBe('Agents may continue: lgbotmanager resumed this channel after the loop guard (limit 2 bot messages in a row).');
        expect(row.rows[0].system_data).toEqual({ scope: 'channel', threadId: null, limit: 2, by: botManager.userId });

        // Agents read it through the normal history
        const history = await ctx.request.get(`/channels/${channelId}/messages?limit=5`).set(botAuth);
        expect(history.body.find((m: any) => m.id === res.body.messageId)).toMatchObject({ systemEvent: 'loop_guard_resume', authorId: null });
    });

    test('says when the guard is off, and accepts a request with no body', async () => {
        await ctx.db.query('UPDATE channels SET max_bot_hops = 0 WHERE id = $1', [channelId]);
        const res = await resume(owner.auth);
        expect(res.status).toBe(201);
        const row = await ctx.db.query('SELECT content FROM messages WHERE id = $1', [res.body.messageId]);
        expect(row.rows[0].content).toBe('Agents may continue: lgowner resumed this channel after the loop guard (loop guard off).');
    });

    test('only ManageBots humans who can see the channel may resume; nothing is posted otherwise', async () => {
        const before = (await ctx.db.query("SELECT count(*)::int AS n FROM messages WHERE system_event = 'loop_guard_resume'")).rows[0].n;
        expect((await resume(member.auth, {})).status).toBe(403);
        // A non-member can't see the channel at all (RLS), so it's not found rather than forbidden
        expect((await resume(outsider.auth, {})).status).toBe(404);
        expect((await resume(botAuth, {})).status).toBe(403);
        expect((await ctx.request.post(`/channels/${channelId}/loop-guard/resume`).send({})).status).toBe(401);
        expect((await ctx.request.post(`/channels/${ULID_ZERO}/loop-guard/resume`).set(owner.auth).send({})).status).toBe(404);
        const after = (await ctx.db.query("SELECT count(*)::int AS n FROM messages WHERE system_event = 'loop_guard_resume'")).rows[0].n;
        expect(after).toBe(before);
    });

    test('ManageBots without ViewChannel on a hidden channel is refused', async () => {
        // Deny ViewChannel to @everyone in #other; the bot keeper has no role override there
        const everyone = (await ctx.db.query('SELECT everyone_role_id FROM servers WHERE id = $1', [serverId])).rows[0].everyone_role_id.trim();
        const put = await ctx.request.put(`/channels/${otherChannelId}/overrides/roles/${everyone}`).set(owner.auth)
            .send({ allow: '0', deny: Permissions.ViewChannel.toString() });
        expect([200, 201, 204]).toContain(put.status);
        const res = await ctx.request.post(`/channels/${otherChannelId}/loop-guard/resume`).set(botManager.auth).send({});
        expect(res.status).toBe(403);
        expect((await ctx.request.post(`/channels/${otherChannelId}/loop-guard/resume`).set(owner.auth).send({})).status).toBe(201);
    });

    test('validates the body', async () => {
        expect((await resume(owner.auth, { threadId: 'nope' })).status).toBe(400);
        expect((await resume(owner.auth, { threadId: 12345 })).status).toBe(400);
        expect((await resume(owner.auth, [])).status).toBe(400);
        expect((await ctx.request.post('/channels/not-a-ulid/loop-guard/resume').set(owner.auth).send({})).status).toBe(400);
    });
});

describe('POST /channels/:id/loop-guard/resume (thread)', () => {
    let parentId: string;
    beforeAll(async () => {
        const parent = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'thread root' });
        expect(parent.status).toBe(201);
        parentId = parent.body.id;
    });

    test('resumes one thread: posts the notice in it, bumps its reply count and resets only its counter', async () => {
        await ctx.db.query('UPDATE channels SET max_thread_bot_hops = 2 WHERE id = $1', [channelId]);
        expect((await botReply(parentId, 'a')).status).toBe(201);
        expect((await botReply(parentId, 'b')).status).toBe(201);
        expect((await botReply(parentId, 'c')).status).toBe(429);
        const notice = await ctx.db.query(
            "SELECT system_data FROM messages WHERE thread_id = $1 AND system_event = 'loop_guard' ORDER BY id DESC LIMIT 1", [parentId]);
        expect(notice.rows[0].system_data).toEqual({ scope: 'thread', threadId: parentId, limit: 2 });

        expect((await botReply(parentId, 'd')).status).toBe(201);
        await getRedis().set(`loopguard:${channelId}`, '3');
        const replies = (await ctx.db.query('SELECT reply_count FROM messages WHERE id = $1', [parentId])).rows[0].reply_count;
        const res = await resume(botManager.auth, { threadId: parentId });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ scope: 'thread', threadId: parentId, limit: 2 });
        expect(await getRedis().get(`loopguard:${channelId}:${parentId}`)).toBeNull();
        expect(await getRedis().get(`loopguard:${channelId}`), 'channel counter untouched').toBe('3');

        const row = await ctx.db.query('SELECT content, thread_id, system_data FROM messages WHERE id = $1', [res.body.messageId]);
        expect(row.rows[0].thread_id.trim()).toBe(parentId);
        expect(row.rows[0].content).toBe('Agents may continue: lgbotmanager resumed this thread after the loop guard (limit 2 bot replies in a row).');
        expect((await ctx.db.query('SELECT reply_count FROM messages WHERE id = $1', [parentId])).rows[0].reply_count).toBe(replies + 1);
        expect((await botReply(parentId, 'e')).status).toBe(201);
        expect((await botReply(parentId, 'f')).status).toBe(201);

        const listed = await ctx.request.get(`/channels/${channelId}/messages/${parentId}/replies`).set(botAuth);
        expect(listed.body.find((m: any) => m.id === res.body.messageId)).toMatchObject({ systemEvent: 'loop_guard_resume' });
    });

    test('refuses a thread that is not a root in this channel, or is closed', async () => {
        const reply = await ctx.request.post(`/channels/${channelId}/messages/${parentId}/replies`).set(owner.auth).send({ content: 'a reply' });
        expect((await resume(owner.auth, { threadId: reply.body.id })).status).toBe(404);
        expect((await resume(owner.auth, { threadId: ULID_ZERO })).status).toBe(404);
        const elsewhere = await ctx.request.post(`/channels/${otherChannelId}/messages`).set(owner.auth).send({ content: 'elsewhere' });
        expect((await resume(owner.auth, { threadId: elsewhere.body.id })).status).toBe(404);

        const closed = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'closed root' });
        await ctx.db.query('UPDATE messages SET thread_closed_at = NOW() WHERE id = $1', [closed.body.id]);
        expect((await resume(owner.auth, { threadId: closed.body.id })).status).toBe(409);
    });
});

describe('PATCH /channels/:id/bot-config', () => {
    test('a ManageBots member can turn the thread guard on and the channel guard off', async () => {
        const res = await ctx.request.patch(`/channels/${channelId}/bot-config`).set(botManager.auth).send({ maxBotHops: 0, maxThreadBotHops: 6 });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ channelId, maxBotHops: 0, maxThreadBotHops: 6 });
        expect((await ctx.request.patch(`/channels/${channelId}/bot-config`).set(member.auth).send({ maxBotHops: 1 })).status).toBe(403);
    });
});
