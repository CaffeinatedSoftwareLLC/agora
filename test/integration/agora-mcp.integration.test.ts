import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';

/**
 * End-to-end test for the agora-mcp API contract.
 *
 * Tests the REST API surface that the agora-mcp package depends on:
 * - GET /bots/@me (channel list)
 * - GET /channels/:id/messages (read)
 * - POST /channels/:id/messages (send with idempotency)
 * - GET /bots/@me/cursors + PUT /bots/@me/cursors/:channelId (cursor tracking)
 *
 * Simulates two bots coordinating through a shared channel.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

/** Wait for onResponse COMMIT to settle */
async function waitForRow(table: string, column: string, value: string) {
    for (let i = 0; i < 20; i++) {
        const res = await ctx.db.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [value]);
        if (res.rows.length > 0) return;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`Row never appeared: ${table}.${column} = ${value}`);
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
});

afterAll(async () => {
    await ctx.close();
});

describe('agora-mcp e2e: two-bot coordination', () => {
    let admin: Awaited<ReturnType<typeof authedUser>>;
    let serverId: string;
    let channelId: string;
    let botAToken: string;
    let botBToken: string;
    let botAId: string;
    let botBId: string;

    beforeAll(async () => {
        // Create admin + server
        admin = await authedUser(ctx.request, 'mcpadmin');

        let serverRes: any;
        for (let attempt = 0; attempt < 10; attempt++) {
            serverRes = await ctx.request.post('/servers').set(admin.auth).send({ name: 'MCP Test Server' });
            if (serverRes.status === 201) break;
            await new Promise(r => setTimeout(r, 50));
        }
        expect(serverRes.status).toBe(201);
        serverId = serverRes.body.id;

        // Find #general channel
        for (let attempt = 0; attempt < 10; attempt++) {
            const dbRes = await ctx.db.query(
                "SELECT id FROM channels WHERE server_id = $1 AND name = 'general'",
                [serverId]
            );
            if (dbRes.rows.length > 0) {
                channelId = dbRes.rows[0].id.trim();
                break;
            }
            await new Promise(r => setTimeout(r, 50));
        }
        expect(channelId).toBeTruthy();

        // Create two bots
        const botARes = await ctx.request.post(`/servers/${serverId}/bots`)
            .set(admin.auth).send({ username: 'mac-agent' });
        expect(botARes.status).toBe(201);
        botAId = botARes.body.id;

        const botBRes = await ctx.request.post(`/servers/${serverId}/bots`)
            .set(admin.auth).send({ username: 'windows-agent' });
        expect(botBRes.status).toBe(201);
        botBId = botBRes.body.id;

        // Wait for bot users to exist
        await waitForRow('users', 'id', botAId);
        await waitForRow('users', 'id', botBId);

        // Generate tokens
        const tokenARes = await ctx.request.post(`/servers/${serverId}/bots/${botAId}/tokens`)
            .set(admin.auth).send({ name: 'Mac token' });
        expect(tokenARes.status).toBe(201);
        botAToken = tokenARes.body.token;

        const tokenBRes = await ctx.request.post(`/servers/${serverId}/bots/${botBId}/tokens`)
            .set(admin.auth).send({ name: 'Windows token' });
        expect(tokenBRes.status).toBe(201);
        botBToken = tokenBRes.body.token;

        // Wait for tokens to commit
        await waitForRow('bot_tokens', 'bot_id', botAId);
        await waitForRow('bot_tokens', 'bot_id', botBId);

        // Grant both bots access to #general
        const accessARes = await ctx.request.post(`/channels/${channelId}/bots/${botAId}`)
            .set(admin.auth).send({});
        expect(accessARes.status).toBe(201);

        const accessBRes = await ctx.request.post(`/channels/${channelId}/bots/${botBId}`)
            .set(admin.auth).send({});
        expect(accessBRes.status).toBe(201);

        // Wait for access grants
        await waitForRow('bot_channel_access', 'bot_id', botAId);
        await waitForRow('bot_channel_access', 'bot_id', botBId);
    });

    function botAuth(token: string) {
        return { Authorization: `Bot ${token}` };
    }

    // ─── GET /bots/@me: channel_list equivalent ───

    test('bot can list its channels via GET /bots/@me', async () => {
        const res = await ctx.request.get('/bots/@me').set(botAuth(botAToken));
        expect(res.status).toBe(200);
        expect(res.body.id).toBe(botAId);
        expect(res.body.username).toBe('mac-agent');
        expect(res.body.bot).toBe(true);
        expect(res.body.channels).toHaveLength(1);
        expect(res.body.channels[0].name).toBe('general');
        expect(res.body.channels[0].id).toBe(channelId);
    });

    // ─── POST /channels/:id/messages: chat_send equivalent ───

    test('bot A sends a message to the channel', async () => {
        const res = await ctx.request.post(`/channels/${channelId}/messages`)
            .set(botAuth(botAToken))
            .set('idempotency-key', 'test-idem-key-1')
            .send({ content: 'Pushed abc123. @windows-agent pull and run tests' });

        expect(res.status).toBe(201);
        expect(res.body.content).toBe('Pushed abc123. @windows-agent pull and run tests');
        expect(res.body.authorId).toBe(botAId);
        expect(res.body.authorBot).toBe(true);
        expect(res.body.channelId).toBe(channelId);
    });

    // ─── Idempotency: duplicate sends return same response ───

    test('duplicate idempotency key returns cached response', async () => {
        const key = 'test-idem-key-dedup';
        const first = await ctx.request.post(`/channels/${channelId}/messages`)
            .set(botAuth(botAToken))
            .set('idempotency-key', key)
            .send({ content: 'Idempotent message' });
        expect(first.status).toBe(201);

        // Wait for commit + idempotency cache write
        await waitForRow('messages', 'id', first.body.id);
        await new Promise(r => setTimeout(r, 100));

        const second = await ctx.request.post(`/channels/${channelId}/messages`)
            .set(botAuth(botAToken))
            .set('idempotency-key', key)
            .send({ content: 'Idempotent message' });
        expect(second.status).toBe(201);
        expect(second.body.id).toBe(first.body.id);
    });

    // ─── GET /channels/:id/messages: chat_read / chat_history equivalent ───

    test('bot B reads messages from the channel', async () => {
        const res = await ctx.request.get(`/channels/${channelId}/messages?limit=50`)
            .set(botAuth(botBToken));

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThanOrEqual(1);

        // Messages returned in DESC order (newest first)
        const botAMessage = res.body.find(
            (m: any) => m.authorId === botAId && m.content?.includes('Pushed abc123')
        );
        expect(botAMessage).toBeTruthy();
        expect(botAMessage.authorBot).toBe(true);
    });

    test('bot B reads messages with before param for pagination', async () => {
        // Get all messages first
        const all = await ctx.request.get(`/channels/${channelId}/messages?limit=50`)
            .set(botAuth(botBToken));
        expect(all.status).toBe(200);

        if (all.body.length >= 2) {
            // Use the oldest message's ID as "before" — should return nothing
            const oldest = all.body[all.body.length - 1];
            const paginated = await ctx.request
                .get(`/channels/${channelId}/messages?limit=50&before=${oldest.id}`)
                .set(botAuth(botBToken));
            expect(paginated.status).toBe(200);
            expect(paginated.body.length).toBe(0);
        }
    });

    // ─── Cursor tracking: GET/PUT /bots/@me/cursors ───

    test('bot cursor starts empty', async () => {
        const res = await ctx.request.get('/bots/@me/cursors').set(botAuth(botBToken));
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    test('bot updates cursor after reading', async () => {
        // Get latest message ID
        const msgs = await ctx.request.get(`/channels/${channelId}/messages?limit=1`)
            .set(botAuth(botBToken));
        expect(msgs.status).toBe(200);
        const latestId = msgs.body[0].id;

        // ACK it
        const ack = await ctx.request.put(`/bots/@me/cursors/${channelId}`)
            .set(botAuth(botBToken))
            .send({ lastReadId: latestId });
        expect(ack.status).toBe(200);
        expect(ack.body.channelId).toBe(channelId);
        expect(ack.body.lastReadId).toBe(latestId);

        // Wait for cursor commit
        await new Promise(r => setTimeout(r, 100));

        // Verify cursor is persisted
        const cursors = await ctx.request.get('/bots/@me/cursors').set(botAuth(botBToken));
        expect(cursors.status).toBe(200);
        expect(cursors.body).toHaveLength(1);
        expect(cursors.body[0].channelId).toBe(channelId);
        expect(cursors.body[0].lastReadId).toBe(latestId);
    });

    // ─── Two-bot coordination flow ───

    test('full coordination: bot A sends, bot B reads and replies, bot A reads reply', async () => {
        // Bot A sends a coordination message
        const send1 = await ctx.request.post(`/channels/${channelId}/messages`)
            .set(botAuth(botAToken))
            .set('idempotency-key', 'coord-1')
            .send({ content: 'Pushed abc123 — new auth middleware. @windows-agent pull and run tests' });
        expect(send1.status).toBe(201);

        // Wait for commit
        await waitForRow('messages', 'id', send1.body.id);

        // Bot B reads and sees the message
        const read1 = await ctx.request.get(`/channels/${channelId}/messages?limit=50`)
            .set(botAuth(botBToken));
        expect(read1.status).toBe(200);
        const coordMsg = read1.body.find((m: any) => m.id === send1.body.id);
        expect(coordMsg).toBeTruthy();
        expect(coordMsg.content).toContain('@windows-agent');

        // Bot B ACKs the message
        await ctx.request.put(`/bots/@me/cursors/${channelId}`)
            .set(botAuth(botBToken))
            .send({ lastReadId: send1.body.id });

        // Bot B replies
        const send2 = await ctx.request.post(`/channels/${channelId}/messages`)
            .set(botAuth(botBToken))
            .set('idempotency-key', 'coord-2')
            .send({ content: 'Pulled. 47/47 passing. @mac-agent all green' });
        expect(send2.status).toBe(201);

        // Wait for commit
        await waitForRow('messages', 'id', send2.body.id);

        // Bot A reads and sees the reply
        const read2 = await ctx.request.get(`/channels/${channelId}/messages?limit=50`)
            .set(botAuth(botAToken));
        expect(read2.status).toBe(200);
        const replyMsg = read2.body.find((m: any) => m.id === send2.body.id);
        expect(replyMsg).toBeTruthy();
        expect(replyMsg.content).toContain('47/47 passing');
        expect(replyMsg.authorBot).toBe(true);
    });

    // ─── Route allowlist: bots are blocked from non-allowed routes ───

    test('bot cannot access non-allowed routes', async () => {
        const res = await ctx.request.get(`/servers/${serverId}/channels`)
            .set(botAuth(botAToken));
        expect(res.status).toBe(403);
    });

    // ─── Bot cannot access channels it is not assigned to ───

    test('bot cannot read from unassigned channel', async () => {
        // Create a second server (which has its own #general channel)
        const otherServer = await ctx.request.post('/servers')
            .set(admin.auth).send({ name: 'Other Server' });
        expect(otherServer.status).toBe(201);

        // Wait for server commit, then find its #general channel
        let otherChannelId: string | undefined;
        for (let attempt = 0; attempt < 10; attempt++) {
            const dbRes = await ctx.db.query(
                "SELECT id FROM channels WHERE server_id = $1 AND name = 'general'",
                [otherServer.body.id]
            );
            if (dbRes.rows.length > 0) {
                otherChannelId = dbRes.rows[0].id.trim();
                break;
            }
            await new Promise(r => setTimeout(r, 50));
        }
        expect(otherChannelId).toBeTruthy();

        // Bot A tries to read from the other server's channel — should fail (no access)
        const res = await ctx.request.get(`/channels/${otherChannelId}/messages`)
            .set(botAuth(botAToken));
        expect(res.status).toBe(403);
    });
});
