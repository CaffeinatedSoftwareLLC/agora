import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: any, channelId: string;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'msgowner');
    const srv = await createServer(ctx.request, owner.auth, 'Msg Server');
    channelId = srv.generalChannelId;
});
afterAll(async () => { await ctx.close(); });

describe('Messages', () => {
    test('send a message', async () => {
        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Hello world!' });

        expect(res.status).toBe(201);
        expect(res.body.content).toBe('Hello world!');
        expect(res.body.authorId).toBe(owner.userId);
        expect(res.body.channelId).toBe(channelId);
        // ULID: 26 chars, Crockford base32
        expect(res.body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    test('pagination: newest first, cursor produces no overlap', async () => {
        // Send 5 messages with known content
        for (let i = 0; i < 5; i++) {
            await ctx.request
                .post(`/channels/${channelId}/messages`)
                .set(owner.auth)
                .send({ content: `page-msg-${i}` });
        }

        // Page 1: limit 3, newest first
        const page1 = await ctx.request
            .get(`/channels/${channelId}/messages?limit=3`)
            .set(owner.auth);

        expect(page1.body).toHaveLength(3);
        const ids1 = page1.body.map((m: any) => m.id);
        expect(ids1).toEqual([...ids1].sort().reverse()); // descending ULIDs

        // Page 2: before oldest in page 1
        const cursor = ids1[ids1.length - 1];
        const page2 = await ctx.request
            .get(`/channels/${channelId}/messages?limit=3&before=${cursor}`)
            .set(owner.auth);

        // No overlap
        const ids2Set = new Set(page2.body.map((m: any) => m.id));
        for (const id of ids1) {
            expect(ids2Set.has(id)).toBe(false);
        }
    });

    test('edit own message sets editedAt', async () => {
        const msg = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Original' });

        const edit = await ctx.request
            .patch(`/channels/${channelId}/messages/${msg.body.id}`)
            .set(owner.auth)
            .send({ content: 'Edited' });

        expect(edit.status).toBe(200);
        expect(edit.body.content).toBe('Edited');
        expect(edit.body.editedAt).toBeDefined();
    });

    test('soft delete nulls content, row persists with deletedAt', async () => {
        const msg = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Delete me' });

        const del = await ctx.request
            .delete(`/channels/${channelId}/messages/${msg.body.id}`)
            .set(owner.auth);
        expect(del.status).toBe(200);

        const list = await ctx.request
            .get(`/channels/${channelId}/messages?limit=50`)
            .set(owner.auth);

        const deleted = list.body.find((m: any) => m.id === msg.body.id);
        expect(deleted).toBeDefined();
        expect(deleted.content).toBeNull();
        expect(deleted.deletedAt).toBeDefined();
    });

    test('non-member cannot send messages', async () => {
        const outsider = await authedUser(ctx.request, 'msgoutsider');

        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(outsider.auth)
            .send({ content: 'Sneaky' });

        expect(res.status).toBe(403);
    });
});
