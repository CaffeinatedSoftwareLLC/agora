import { setupTestApp, authedUser, cleanDatabase } from '../helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
});
afterAll(async () => { await ctx.close(); });

describe('Direct Messages', () => {
    test('create DM deduplicates: same pair both directions returns same channel', async () => {
        const user1 = await authedUser(ctx.request, 'dm1');
        const user2 = await authedUser(ctx.request, 'dm2');

        const dm1 = await ctx.request
            .post('/channels/dm')
            .set(user1.auth)
            .send({ recipientId: user2.userId });
        expect(dm1.status).toBe(201);
        expect(dm1.body.channelType).toBe(1); // DM

        // Same direction again
        const dm2 = await ctx.request
            .post('/channels/dm')
            .set(user1.auth)
            .send({ recipientId: user2.userId });
        expect(dm2.body.id).toBe(dm1.body.id);

        // Reverse direction
        const dm3 = await ctx.request
            .post('/channels/dm')
            .set(user2.auth)
            .send({ recipientId: user1.userId });
        expect(dm3.body.id).toBe(dm1.body.id);
    });

    test('both members can send and read messages in DM', async () => {
        const user1 = await authedUser(ctx.request, 'dmsend1');
        const user2 = await authedUser(ctx.request, 'dmsend2');

        const dm = await ctx.request
            .post('/channels/dm')
            .set(user1.auth)
            .send({ recipientId: user2.userId });

        // User1 sends
        const msg = await ctx.request
            .post(`/channels/${dm.body.id}/messages`)
            .set(user1.auth)
            .send({ content: 'Hey!' });
        expect(msg.status).toBe(201);

        // User2 reads
        const read = await ctx.request
            .get(`/channels/${dm.body.id}/messages`)
            .set(user2.auth);
        expect(read.body.some((m: any) => m.content === 'Hey!')).toBe(true);
    });
});
