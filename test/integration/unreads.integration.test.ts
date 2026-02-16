import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: any, channelId: string;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'unreadowner');
    const srv = await createServer(ctx.request, owner.auth, 'Unreads Server');
    channelId = srv.generalChannelId;
});
afterAll(async () => { await ctx.close(); });

describe('Unreads', () => {
    test('GET /channels/:id/unreads before any ack returns zero state', async () => {
        const res = await ctx.request
            .get(`/channels/${channelId}/unreads`)
            .set(owner.auth);

        expect(res.status).toBe(200);
        expect(res.body.channelId).toBe(channelId);
        expect(res.body.lastReadId).toBeNull();
        expect(res.body.mentionCount).toBe(0);
        expect(res.body.unreadCount).toBe(0);
    });

    test('PUT /channels/:id/ack marks channel as read', async () => {
        // Send a message first
        const msg = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Ack test message' });

        const res = await ctx.request
            .put(`/channels/${channelId}/ack`)
            .set(owner.auth)
            .send({ messageId: msg.body.id });

        expect(res.status).toBe(200);
        expect(res.body.channelId).toBe(channelId);
        expect(res.body.lastReadId).toBe(msg.body.id);
        expect(res.body.mentionCount).toBe(0);
    });

    test('GET /channels/:id/unreads after ack shows zero unreads', async () => {
        const res = await ctx.request
            .get(`/channels/${channelId}/unreads`)
            .set(owner.auth);

        expect(res.status).toBe(200);
        expect(res.body.unreadCount).toBe(0);
    });

    test('new message after ack increments unread count', async () => {
        await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Unread 1' });

        await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Unread 2' });

        const res = await ctx.request
            .get(`/channels/${channelId}/unreads`)
            .set(owner.auth);

        expect(res.status).toBe(200);
        expect(res.body.unreadCount).toBe(2);
    });

    test('GET /unreads returns bulk unread state for all channels', async () => {
        const res = await ctx.request
            .get('/unreads')
            .set(owner.auth);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);

        const channelUnread = res.body.find((u: any) => u.channelId === channelId);
        expect(channelUnread).toBeDefined();
        expect(channelUnread.unreadCount).toBe(2);
        expect(channelUnread.lastReadId).toBeDefined();
    });

    test('ack without membership returns 403', async () => {
        const outsider = await authedUser(ctx.request, 'unreadoutsider');
        const res = await ctx.request
            .put(`/channels/${channelId}/ack`)
            .set(outsider.auth)
            .send({ messageId: '01234567890123456789012345' });

        expect(res.status).toBe(403);
    });

    test('ack does not move read marker backwards', async () => {
        // First, get current state
        const before = await ctx.request
            .get(`/channels/${channelId}/unreads`)
            .set(owner.auth);
        const currentLastReadId = before.body.lastReadId;

        // Try to ack with an older message ID (ULID that sorts before current)
        const res = await ctx.request
            .put(`/channels/${channelId}/ack`)
            .set(owner.auth)
            .send({ messageId: '00000000000000000000000000' });

        expect(res.status).toBe(200);

        // Verify the read marker didn't move backwards
        const after = await ctx.request
            .get(`/channels/${channelId}/unreads`)
            .set(owner.auth);

        expect(after.body.lastReadId).toBe(currentLastReadId);
    });
});
