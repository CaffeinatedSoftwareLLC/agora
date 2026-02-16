import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: any, member: any, channelId: string, serverId: string;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'rxowner');
    const srv = await createServer(ctx.request, owner.auth, 'Reactions Server');
    serverId = srv.serverId;
    channelId = srv.generalChannelId;
    member = await authedUser(ctx.request, 'rxmember');
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
});
afterAll(async () => { await ctx.close(); });

describe('Reactions', () => {
    let messageId: string;

    beforeAll(async () => {
        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'React to me' });
        messageId = res.body.id;
    });

    test('add reaction to a message', async () => {
        const res = await ctx.request
            .put(`/channels/${channelId}/messages/${messageId}/reactions`)
            .set(owner.auth)
            .send({ emoji: '\u{1F44D}' }); // thumbs up

        expect(res.status).toBe(200);
        expect(res.body.messageId).toBe(messageId);
        expect(res.body.emoji).toBe('\u{1F44D}');
        expect(res.body.userId).toBe(owner.userId);
    });

    test('add same reaction again is idempotent', async () => {
        const res = await ctx.request
            .put(`/channels/${channelId}/messages/${messageId}/reactions`)
            .set(owner.auth)
            .send({ emoji: '\u{1F44D}' });

        expect(res.status).toBe(200);
    });

    test('add reaction to non-existent message returns 404', async () => {
        const res = await ctx.request
            .put(`/channels/${channelId}/messages/00000000000000000000000000/reactions`)
            .set(owner.auth)
            .send({ emoji: '\u{1F44D}' });

        expect(res.status).toBe(404);
    });

    test('add reaction without channel membership returns 403', async () => {
        const outsider = await authedUser(ctx.request, 'rxoutsider');
        const res = await ctx.request
            .put(`/channels/${channelId}/messages/${messageId}/reactions`)
            .set(outsider.auth)
            .send({ emoji: '\u{1F44D}' });

        expect(res.status).toBe(403);
    });

    test('list reactions returns grouped by emoji', async () => {
        // member also reacts with the same emoji
        await ctx.request
            .put(`/channels/${channelId}/messages/${messageId}/reactions`)
            .set(member.auth)
            .send({ emoji: '\u{1F44D}' });

        const res = await ctx.request
            .get(`/channels/${channelId}/messages/${messageId}/reactions`)
            .set(owner.auth);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);

        const thumbsUp = res.body.find((r: any) => r.emoji === '\u{1F44D}');
        expect(thumbsUp).toBeDefined();
        expect(thumbsUp.count).toBe(2);
        expect(thumbsUp.userIds).toContain(owner.userId);
        expect(thumbsUp.userIds).toContain(member.userId);
        expect(thumbsUp.me).toBe(true); // owner is the requester
    });

    test('GET messages includes reactions array', async () => {
        const res = await ctx.request
            .get(`/channels/${channelId}/messages?limit=50`)
            .set(owner.auth);

        expect(res.status).toBe(200);
        const msg = res.body.find((m: any) => m.id === messageId);
        expect(msg).toBeDefined();
        expect(Array.isArray(msg.reactions)).toBe(true);
        const thumbsUp = msg.reactions.find((r: any) => r.emoji === '\u{1F44D}');
        expect(thumbsUp).toBeDefined();
        expect(thumbsUp.count).toBe(2);
        expect(thumbsUp.me).toBe(true);
    });

    test('remove reaction', async () => {
        const emoji = encodeURIComponent('\u{1F44D}');
        const res = await ctx.request
            .delete(`/channels/${channelId}/messages/${messageId}/reactions/${emoji}`)
            .set(owner.auth);

        expect(res.status).toBe(200);
        expect(res.body.messageId).toBe(messageId);
        expect(res.body.emoji).toBe('\u{1F44D}');
    });

    test('remove non-existent reaction returns 404', async () => {
        const emoji = encodeURIComponent('\u{2764}'); // heart — never added
        const res = await ctx.request
            .delete(`/channels/${channelId}/messages/${messageId}/reactions/${emoji}`)
            .set(owner.auth);

        expect(res.status).toBe(404);
    });
});
