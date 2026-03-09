import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { generateBotToken, parseBotToken } from '../../src/auth/bot-tokens';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: any, channelId: string, serverId: string;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'threadowner');
    const srv = await createServer(ctx.request, owner.auth, 'Thread Server');
    channelId = srv.generalChannelId;
    serverId = srv.serverId;
});
afterAll(async () => { await ctx.close(); });

describe('Threads', () => {
    let parentMsgId: string;

    test('create a reply to a message', async () => {
        // Create parent message
        const msg = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Parent message' });
        expect(msg.status).toBe(201);
        parentMsgId = msg.body.id;

        // Create reply
        const reply = await ctx.request
            .post(`/channels/${channelId}/messages/${parentMsgId}/replies`)
            .set(owner.auth)
            .send({ content: 'First reply' });

        expect(reply.status).toBe(201);
        expect(reply.body.content).toBe('First reply');
        expect(reply.body.threadId).toBe(parentMsgId);
        expect(reply.body.authorId).toBe(owner.userId);
        expect(reply.body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    test('parent reply_count increments correctly', async () => {
        // Check parent in DB
        const dbRes = await ctx.db.query(
            'SELECT reply_count, last_reply_at FROM messages WHERE id = $1',
            [parentMsgId]
        );
        expect(dbRes.rows[0].reply_count).toBe(1);
        expect(dbRes.rows[0].last_reply_at).toBeTruthy();
    });

    test('second reply increments count to 2', async () => {
        await ctx.request
            .post(`/channels/${channelId}/messages/${parentMsgId}/replies`)
            .set(owner.auth)
            .send({ content: 'Second reply' });

        const dbRes = await ctx.db.query(
            'SELECT reply_count FROM messages WHERE id = $1',
            [parentMsgId]
        );
        expect(dbRes.rows[0].reply_count).toBe(2);
    });

    test('reply to non-existent message returns 404', async () => {
        const res = await ctx.request
            .post(`/channels/${channelId}/messages/01NONEXISTENT000000000000/replies`)
            .set(owner.auth)
            .send({ content: 'Orphan reply' });
        expect(res.status).toBe(404);
    });

    test('non-member cannot reply', async () => {
        const outsider = await authedUser(ctx.request, 'threadoutsider');
        const res = await ctx.request
            .post(`/channels/${channelId}/messages/${parentMsgId}/replies`)
            .set(outsider.auth)
            .send({ content: 'Sneaky' });
        expect(res.status).toBe(403);
    });

    test('nested reply (reply to a reply) returns 400', async () => {
        // Get a reply ID
        const replies = await ctx.request
            .get(`/channels/${channelId}/messages/${parentMsgId}/replies?limit=1`)
            .set(owner.auth);
        const replyId = replies.body[0].id;

        // Try to reply to the reply
        const res = await ctx.request
            .post(`/channels/${channelId}/messages/${replyId}/replies`)
            .set(owner.auth)
            .send({ content: 'Nested' });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Cannot reply to a reply');
    });

    test('get thread replies with forward pagination', async () => {
        // Create a fresh parent with 5 replies
        const msg = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Paginated parent' });
        const pid = msg.body.id;

        for (let i = 0; i < 5; i++) {
            await ctx.request
                .post(`/channels/${channelId}/messages/${pid}/replies`)
                .set(owner.auth)
                .send({ content: `reply-${i}` });
        }

        // Page 1: limit 2, oldest first
        const page1 = await ctx.request
            .get(`/channels/${channelId}/messages/${pid}/replies?limit=2`)
            .set(owner.auth);
        expect(page1.body).toHaveLength(2);
        const ids1 = page1.body.map((m: any) => m.id);
        expect(ids1).toEqual([...ids1].sort()); // ascending ULIDs

        // Page 2: after last of page 1
        const page2 = await ctx.request
            .get(`/channels/${channelId}/messages/${pid}/replies?limit=2&after=${ids1[ids1.length - 1]}`)
            .set(owner.auth);
        expect(page2.body).toHaveLength(2);

        // No overlap
        const ids2Set = new Set(page2.body.map((m: any) => m.id));
        for (const id of ids1) {
            expect(ids2Set.has(id)).toBe(false);
        }

        // Verify all replies have threadId
        expect(page1.body[0].threadId).toBe(pid);
    });

    test('active threads endpoint returns threads ordered by last_reply_at DESC', async () => {
        // Create 3 threads with staggered replies
        const msgIds: string[] = [];
        for (let i = 0; i < 3; i++) {
            const msg = await ctx.request
                .post(`/channels/${channelId}/messages`)
                .set(owner.auth)
                .send({ content: `Thread parent ${i}` });
            msgIds.push(msg.body.id);
        }

        // Reply to them in order: first, second, third (third has the most recent reply)
        for (const mid of msgIds) {
            await ctx.request
                .post(`/channels/${channelId}/messages/${mid}/replies`)
                .set(owner.auth)
                .send({ content: `Reply to ${mid}` });
        }

        const res = await ctx.request
            .get(`/channels/${channelId}/threads?limit=10`)
            .set(owner.auth);

        expect(res.status).toBe(200);
        expect(res.body.length).toBeGreaterThanOrEqual(3);

        // Verify ordering: most recent last_reply_at first
        for (let i = 1; i < res.body.length; i++) {
            expect(new Date(res.body[i - 1].lastReplyAt).getTime())
                .toBeGreaterThanOrEqual(new Date(res.body[i].lastReplyAt).getTime());
        }

        // Verify preview replies exist
        const thread = res.body[0];
        expect(thread.replyCount).toBeGreaterThanOrEqual(1);
        expect(thread.previewReplies).toBeDefined();
    });

    test('channel messages exclude thread replies', async () => {
        const list = await ctx.request
            .get(`/channels/${channelId}/messages?limit=100`)
            .set(owner.auth);

        // None of the returned messages should have a threadId
        for (const msg of list.body) {
            expect(msg.threadId).toBeUndefined();
        }

        // Parent messages with replies should include replyCount
        const parent = list.body.find((m: any) => m.id === parentMsgId);
        expect(parent).toBeDefined();
        expect(parent.replyCount).toBeGreaterThanOrEqual(2);
        expect(parent.lastReplyAt).toBeDefined();
    });

    test('delete reply decrements parent reply_count', async () => {
        // Create parent + 2 replies
        const msg = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Delete test parent' });
        const pid = msg.body.id;

        const r1 = await ctx.request
            .post(`/channels/${channelId}/messages/${pid}/replies`)
            .set(owner.auth)
            .send({ content: 'Delete reply 1' });
        await ctx.request
            .post(`/channels/${channelId}/messages/${pid}/replies`)
            .set(owner.auth)
            .send({ content: 'Delete reply 2' });

        // Verify count = 2
        let dbRes = await ctx.db.query('SELECT reply_count FROM messages WHERE id = $1', [pid]);
        expect(dbRes.rows[0].reply_count).toBe(2);

        // Delete first reply
        const del = await ctx.request
            .delete(`/channels/${channelId}/messages/${r1.body.id}`)
            .set(owner.auth);
        expect(del.status).toBe(200);

        // Count should be 1
        dbRes = await ctx.db.query('SELECT reply_count FROM messages WHERE id = $1', [pid]);
        expect(dbRes.rows[0].reply_count).toBe(1);
    });

    test('edit reply sets editedAt', async () => {
        // Get a reply
        const replies = await ctx.request
            .get(`/channels/${channelId}/messages/${parentMsgId}/replies?limit=1`)
            .set(owner.auth);
        const replyId = replies.body[0].id;

        const edit = await ctx.request
            .patch(`/channels/${channelId}/messages/${replyId}`)
            .set(owner.auth)
            .send({ content: 'Edited reply' });

        expect(edit.status).toBe(200);
        expect(edit.body.content).toBe('Edited reply');
        expect(edit.body.editedAt).toBeDefined();
    });

    test('soft-delete parent keeps thread replies accessible', async () => {
        // Create parent + reply
        const msg = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Soon deleted parent' });
        const pid = msg.body.id;

        await ctx.request
            .post(`/channels/${channelId}/messages/${pid}/replies`)
            .set(owner.auth)
            .send({ content: 'Orphan reply' });

        // Soft-delete parent
        await ctx.request
            .delete(`/channels/${channelId}/messages/${pid}`)
            .set(owner.auth);

        // Thread replies should still be accessible
        const replies = await ctx.request
            .get(`/channels/${channelId}/messages/${pid}/replies`)
            .set(owner.auth);

        expect(replies.status).toBe(200);
        expect(replies.body).toHaveLength(1);
        expect(replies.body[0].content).toBe('Orphan reply');
    });

    test('soft-deleted parents excluded from active threads', async () => {
        // Create parent + reply, then soft-delete parent
        const msg = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Deleted thread parent' });
        const pid = msg.body.id;

        await ctx.request
            .post(`/channels/${channelId}/messages/${pid}/replies`)
            .set(owner.auth)
            .send({ content: 'Reply on deleted parent' });

        await ctx.request
            .delete(`/channels/${channelId}/messages/${pid}`)
            .set(owner.auth);

        const res = await ctx.request
            .get(`/channels/${channelId}/threads?limit=10`)
            .set(owner.auth);

        expect(res.status).toBe(200);
        const ids = res.body.map((t: any) => t.id);
        expect(ids).not.toContain(pid);
    });

    test('active threads before cursor pagination', async () => {
        // Create 3 threads with staggered replies
        const pids: string[] = [];
        for (let i = 0; i < 3; i++) {
            const msg = await ctx.request
                .post(`/channels/${channelId}/messages`)
                .set(owner.auth)
                .send({ content: `Cursor thread ${i}` });
            pids.push(msg.body.id);
            await ctx.request
                .post(`/channels/${channelId}/messages/${msg.body.id}/replies`)
                .set(owner.auth)
                .send({ content: `Cursor reply ${i}` });
        }

        // Get first page
        const page1 = await ctx.request
            .get(`/channels/${channelId}/threads?limit=2`)
            .set(owner.auth);
        expect(page1.body.length).toBeGreaterThanOrEqual(2);

        // Use last item's lastReplyAt as cursor
        const lastReplyAt = page1.body[page1.body.length - 1].lastReplyAt;
        const page2 = await ctx.request
            .get(`/channels/${channelId}/threads?limit=2&before=${lastReplyAt}`)
            .set(owner.auth);

        expect(page2.status).toBe(200);
        // No overlap: page2 items should have earlier lastReplyAt
        const page1Ids = new Set(page1.body.map((t: any) => t.id));
        for (const thread of page2.body) {
            expect(page1Ids.has(thread.id)).toBe(false);
        }
    });

    test('bot with channel access can create reply', async () => {
        // Helper to wait for COMMIT to settle
        async function waitForRow(table: string, column: string, value: string) {
            for (let i = 0; i < 20; i++) {
                const res = await ctx.db.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [value]);
                if (res.rows.length > 0) return;
                await new Promise(r => setTimeout(r, 50));
            }
            throw new Error(`Row not found in ${table} where ${column} = ${value}`);
        }

        // Create bot
        const botRes = await ctx.request
            .post(`/servers/${serverId}/bots`)
            .set(owner.auth)
            .send({ username: 'thread-bot' });
        expect(botRes.status).toBe(201);
        const botId = botRes.body.id;
        await waitForRow('users', 'id', botId);

        // Generate token
        const tokenRes = await ctx.request
            .post(`/servers/${serverId}/bots/${botId}/tokens`)
            .set(owner.auth)
            .send({ name: 'test' });
        const rawToken = tokenRes.body.token;
        await waitForRow('bot_tokens', 'id', parseBotToken(rawToken)!.tokenId);

        // Grant channel access
        await ctx.request
            .post(`/channels/${channelId}/bots/${botId}`)
            .set(owner.auth);
        await waitForRow('bot_channel_access', 'bot_id', botId);

        // Create a parent message (as owner)
        const msg = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Bot reply test parent' });
        const pid = msg.body.id;

        // Bot creates a reply
        const reply = await ctx.request
            .post(`/channels/${channelId}/messages/${pid}/replies`)
            .set({ Authorization: `Bot ${rawToken}` })
            .send({ content: 'Bot reply' });

        expect(reply.status).toBe(201);
        expect(reply.body.content).toBe('Bot reply');
        expect(reply.body.threadId).toBe(pid);
        expect(reply.body.authorBot).toBe(true);
    });
});
