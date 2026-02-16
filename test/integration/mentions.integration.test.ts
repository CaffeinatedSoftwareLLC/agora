import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: any, member: any, channelId: string, serverId: string;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'mentionowner');
    const srv = await createServer(ctx.request, owner.auth, 'Mentions Server');
    serverId = srv.serverId;
    channelId = srv.generalChannelId;
    member = await authedUser(ctx.request, 'mentionmember');
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
});
afterAll(async () => { await ctx.close(); });

describe('Mentions', () => {
    test('message with @username creates mention row and returns mentions array', async () => {
        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: `Hey @mentionmember check this out` });

        expect(res.status).toBe(201);
        expect(Array.isArray(res.body.mentions)).toBe(true);
        expect(res.body.mentions).toContain(member.userId);
        expect(res.body.mentionsEveryone).toBe(false);

        // Verify message_mentions row in DB
        const dbResult = await ctx.db.query(
            'SELECT user_id FROM message_mentions WHERE message_id = $1',
            [res.body.id]
        );
        expect(dbResult.rows.length).toBe(1);
        expect(dbResult.rows[0].user_id.trim()).toBe(member.userId);
    });

    test('message with @nonexistent does not create mention row', async () => {
        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Hey @nobodyhere123' });

        expect(res.status).toBe(201);
        expect(res.body.mentions).toEqual([]);

        const dbResult = await ctx.db.query(
            'SELECT user_id FROM message_mentions WHERE message_id = $1',
            [res.body.id]
        );
        expect(dbResult.rows.length).toBe(0);
    });

    test('message with @everyone sets mentionsEveryone flag', async () => {
        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Attention @everyone!' });

        expect(res.status).toBe(201);
        expect(res.body.mentionsEveryone).toBe(true);

        // Verify flag in DB
        const dbResult = await ctx.db.query(
            'SELECT mentions_everyone FROM messages WHERE id = $1',
            [res.body.id]
        );
        expect(dbResult.rows[0].mentions_everyone).toBe(true);
    });

    test('mention increments mention_count in channel_unreads', async () => {
        // First, mark channel as read for the member
        const latestMsg = await ctx.request
            .get(`/channels/${channelId}/messages?limit=1`)
            .set(member.auth);
        await ctx.request
            .put(`/channels/${channelId}/ack`)
            .set(member.auth)
            .send({ messageId: latestMsg.body[0].id });

        // Owner mentions member
        await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: `@mentionmember you have a mention` });

        // Check unread state for member
        const unreads = await ctx.request
            .get(`/channels/${channelId}/unreads`)
            .set(member.auth);

        expect(unreads.status).toBe(200);
        expect(unreads.body.mentionCount).toBeGreaterThanOrEqual(1);
    });

    test('@everyone mention increments mention_count for other members', async () => {
        // Mark channel as read for the member
        const latestMsg = await ctx.request
            .get(`/channels/${channelId}/messages?limit=1`)
            .set(member.auth);
        await ctx.request
            .put(`/channels/${channelId}/ack`)
            .set(member.auth)
            .send({ messageId: latestMsg.body[0].id });

        // Owner sends @everyone
        await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: '@everyone important update' });

        // Check member's unread state — should have mention count incremented
        const unreads = await ctx.request
            .get(`/channels/${channelId}/unreads`)
            .set(member.auth);

        expect(unreads.status).toBe(200);
        expect(unreads.body.mentionCount).toBeGreaterThanOrEqual(1);
    });

    test('message with no mentions returns empty mentions array', async () => {
        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'No mentions here' });

        expect(res.status).toBe(201);
        expect(res.body.mentions).toEqual([]);
        expect(res.body.mentionsEveryone).toBe(false);
    });
});
