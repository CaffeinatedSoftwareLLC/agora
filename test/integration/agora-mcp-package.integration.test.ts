import { setupTestApp, authedUser, cleanDatabase } from '../helpers';
import { AgoraApi } from '../../agora-mcp/src/api';
import { CursorTracker } from '../../agora-mcp/src/cursor';
import { fetchUnreadMessages, formatMessages } from '../../agora-mcp/src/tools';

/**
 * Tests the actual agora-mcp package code (AgoraApi, CursorTracker,
 * fetchUnreadMessages) against a real Agora backend.
 *
 * Uses Fastify listen() so AgoraApi can make real HTTP fetch() calls.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let baseUrl: string;

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

    // Start listening so AgoraApi can make real HTTP requests
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = ctx.app.server.address();
    if (typeof addr === 'string' || !addr) throw new Error('Failed to get server address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
    await ctx.close();
});

describe('agora-mcp package: AgoraApi + CursorTracker + fetchUnreadMessages', () => {
    let botToken: string;
    let botId: string;
    let channelId: string;
    let channelName: string;

    beforeAll(async () => {
        // Create admin + server via supertest (admin setup)
        const admin = await authedUser(ctx.request, 'pkgadmin');

        let serverRes: any;
        for (let attempt = 0; attempt < 10; attempt++) {
            serverRes = await ctx.request.post('/servers').set(admin.auth).send({ name: 'Pkg Test Server' });
            if (serverRes.status === 201) break;
            await new Promise(r => setTimeout(r, 50));
        }
        expect(serverRes.status).toBe(201);
        const serverId = serverRes.body.id;

        // Find #general
        for (let attempt = 0; attempt < 10; attempt++) {
            const dbRes = await ctx.db.query(
                "SELECT id, name FROM channels WHERE server_id = $1 AND name = 'general'",
                [serverId]
            );
            if (dbRes.rows.length > 0) {
                channelId = dbRes.rows[0].id.trim();
                channelName = dbRes.rows[0].name;
                break;
            }
            await new Promise(r => setTimeout(r, 50));
        }
        expect(channelId).toBeTruthy();

        // Create bot + token + channel access
        const botRes = await ctx.request.post(`/servers/${serverId}/bots`)
            .set(admin.auth).send({ username: 'pkg-test-bot' });
        expect(botRes.status).toBe(201);
        botId = botRes.body.id;
        await waitForRow('users', 'id', botId);

        const tokenRes = await ctx.request.post(`/servers/${serverId}/bots/${botId}/tokens`)
            .set(admin.auth).send({ name: 'test' });
        expect(tokenRes.status).toBe(201);
        botToken = tokenRes.body.token;
        await waitForRow('bot_tokens', 'bot_id', botId);

        const accessRes = await ctx.request.post(`/channels/${channelId}/bots/${botId}`)
            .set(admin.auth).send({});
        expect(accessRes.status).toBe(201);
        await waitForRow('bot_channel_access', 'bot_id', botId);

        // Raise loop guard + rate limit so bulk sends in tests don't trigger them
        await ctx.db.query(
            'UPDATE channels SET max_bot_hops = 100, bot_rate_limit = 100 WHERE id = $1',
            [channelId]
        );
    });

    // ─── AgoraApi ───

    describe('AgoraApi', () => {
        test('getMe returns bot info with channels', async () => {
            const api = new AgoraApi(baseUrl, botToken);
            const me = await api.getMe();

            expect(me.id).toBe(botId);
            expect(me.username).toBe('pkg-test-bot');
            expect(me.bot).toBe(true);
            expect(me.channels).toHaveLength(1);
            expect(me.channels[0].name).toBe('general');
            expect(me.channels[0].id).toBe(channelId);
        });

        test('sendMessage sends with idempotency header and returns message', async () => {
            const api = new AgoraApi(baseUrl, botToken);
            const msg = await api.sendMessage(channelId, 'Hello from AgoraApi', 'api-idem-1');

            expect(msg.id).toBeTruthy();
            expect(msg.content).toBe('Hello from AgoraApi');
            expect(msg.authorId).toBe(botId);
            expect(msg.authorBot).toBe(true);
            expect(msg.channelId).toBe(channelId);

            await waitForRow('messages', 'id', msg.id);
        });

        test('getMessages returns messages in DESC order', async () => {
            const api = new AgoraApi(baseUrl, botToken);
            const messages = await api.getMessages(channelId, { limit: 10 });

            expect(messages.length).toBeGreaterThanOrEqual(1);
            // DESC order: first message has newest ID
            for (let i = 1; i < messages.length; i++) {
                expect(messages[i - 1].id > messages[i].id).toBe(true);
            }
        });

        test('getMessages before param paginates correctly', async () => {
            const api = new AgoraApi(baseUrl, botToken);

            // Send two more messages to ensure pagination works
            const m1 = await api.sendMessage(channelId, 'Pagination msg 1', 'pag-1');
            await waitForRow('messages', 'id', m1.id);
            const m2 = await api.sendMessage(channelId, 'Pagination msg 2', 'pag-2');
            await waitForRow('messages', 'id', m2.id);

            // Fetch with before=m2.id should not include m2
            const page = await api.getMessages(channelId, { limit: 10, before: m2.id });
            const ids = page.map(m => m.id);
            expect(ids).not.toContain(m2.id);
            expect(ids).toContain(m1.id);
        });

        test('getCursors returns empty array initially', async () => {
            const api = new AgoraApi(baseUrl, botToken);
            const cursors = await api.getCursors();
            expect(Array.isArray(cursors)).toBe(true);
        });

        test('updateCursor and getCursors round-trip', async () => {
            const api = new AgoraApi(baseUrl, botToken);
            const messages = await api.getMessages(channelId, { limit: 1 });
            const latestId = messages[0].id;

            const ack = await api.updateCursor(channelId, latestId);
            expect(ack.channelId).toBe(channelId);
            expect(ack.lastReadId).toBe(latestId);

            // Wait for commit
            await new Promise(r => setTimeout(r, 100));

            const cursors = await api.getCursors();
            const cursor = cursors.find(c => c.channelId === channelId);
            expect(cursor).toBeTruthy();
            expect(cursor!.lastReadId).toBe(latestId);
        });

        test('sendMessage to unassigned channel returns error', async () => {
            const api = new AgoraApi(baseUrl, botToken);
            await expect(api.sendMessage('00000000000000000000000000', 'nope'))
                .rejects.toThrow(/403/);
        });
    });

    // ─── CursorTracker ───

    describe('CursorTracker', () => {
        test('load fetches cursors from API', async () => {
            const api = new AgoraApi(baseUrl, botToken);
            const tracker = new CursorTracker(api);

            await tracker.load();
            // We set a cursor in the AgoraApi tests above
            const cursor = tracker.getCursor(channelId);
            expect(cursor).toBeTruthy();
        });

        test('ack advances cursor and persists', async () => {
            const api = new AgoraApi(baseUrl, botToken);
            const tracker = new CursorTracker(api);
            await tracker.load();

            // Send a new message to get a fresh ID
            const msg = await api.sendMessage(channelId, 'Cursor advance test', 'cursor-adv-1');
            await waitForRow('messages', 'id', msg.id);

            await tracker.ack(channelId, msg.id);
            expect(tracker.getCursor(channelId)).toBe(msg.id);

            // Verify persisted via API
            await new Promise(r => setTimeout(r, 100));
            const cursors = await api.getCursors();
            const cursor = cursors.find(c => c.channelId === channelId);
            expect(cursor!.lastReadId).toBe(msg.id);
        });

        test('ack does not go backwards', async () => {
            const api = new AgoraApi(baseUrl, botToken);
            const tracker = new CursorTracker(api);
            await tracker.load();

            const current = tracker.getCursor(channelId);
            expect(current).toBeTruthy();

            // Try to ack an older ID (all zeros — lexicographically smaller than any ULID)
            await tracker.ack(channelId, '00000000000000000000000000');
            expect(tracker.getCursor(channelId)).toBe(current);
        });
    });

    // ─── fetchUnreadMessages (P1 paging fix) ───

    describe('fetchUnreadMessages', () => {
        test('returns all unread messages across multiple pages', async () => {
            const api = new AgoraApi(baseUrl, botToken);
            const tracker = new CursorTracker(api);

            // Mark everything read so far
            const latest = await api.getMessages(channelId, { limit: 1 });
            if (latest.length > 0) {
                await tracker.ack(channelId, latest[0].id);
            }
            await new Promise(r => setTimeout(r, 100));

            // Send 5 new messages
            const sentIds: string[] = [];
            for (let i = 0; i < 5; i++) {
                const msg = await api.sendMessage(channelId, `Page test ${i}`, `page-test-${i}`);
                await waitForRow('messages', 'id', msg.id);
                sentIds.push(msg.id);
            }

            // Fetch with pageSize=2 — forces 3 pages to get all 5 messages
            const freshTracker = new CursorTracker(api);
            const { messages: unread, skipped } = await fetchUnreadMessages(api, freshTracker, channelId, 200, 2);

            expect(skipped).toBe(0);
            expect(unread.length).toBe(5);
            expect(unread[0].content).toBe('Page test 0');
            expect(unread[4].content).toBe('Page test 4');

            // IDs should be in ascending order (chronological)
            for (let i = 1; i < unread.length; i++) {
                expect(unread[i].id > unread[i - 1].id).toBe(true);
            }

            // Cursor should now be at the latest message
            expect(freshTracker.getCursor(channelId)).toBe(sentIds[4]);
        });

        test('returns empty when no unread messages', async () => {
            const api = new AgoraApi(baseUrl, botToken);
            const tracker = new CursorTracker(api);

            // Mark everything read
            const latest = await api.getMessages(channelId, { limit: 1 });
            if (latest.length > 0) {
                await tracker.ack(channelId, latest[0].id);
            }
            await new Promise(r => setTimeout(r, 100));

            const freshTracker = new CursorTracker(api);
            const { messages } = await fetchUnreadMessages(api, freshTracker, channelId, 200);
            expect(messages).toEqual([]);
        });

        test('maxMessages returns oldest chunk and preserves remaining for next call', async () => {
            const api = new AgoraApi(baseUrl, botToken);

            // Mark everything read
            const latest = await api.getMessages(channelId, { limit: 1 });
            const tracker = new CursorTracker(api);
            if (latest.length > 0) {
                await tracker.ack(channelId, latest[0].id);
            }
            await new Promise(r => setTimeout(r, 100));

            // Send 5 new messages
            for (let i = 0; i < 5; i++) {
                const msg = await api.sendMessage(channelId, `Limit test ${i}`, `limit-test-${i}`);
                await waitForRow('messages', 'id', msg.id);
            }

            // First call: maxMessages=3 → returns OLDEST 3 (msg 0,1,2), skipped=0
            const tracker1 = new CursorTracker(api);
            const { messages: batch1, skipped: s1 } = await fetchUnreadMessages(api, tracker1, channelId, 3);
            expect(s1).toBe(0);
            expect(batch1.length).toBe(3);
            expect(batch1[0].content).toBe('Limit test 0');
            expect(batch1[1].content).toBe('Limit test 1');
            expect(batch1[2].content).toBe('Limit test 2');

            // Wait for cursor commit
            await new Promise(r => setTimeout(r, 100));

            // Second call: remaining 2 messages (msg 3,4) are still accessible
            const tracker2 = new CursorTracker(api);
            const { messages: batch2 } = await fetchUnreadMessages(api, tracker2, channelId, 200);
            expect(batch2.length).toBe(2);
            expect(batch2[0].content).toBe('Limit test 3');
            expect(batch2[1].content).toBe('Limit test 4');
        });

        test('first read with no cursor returns newest messages', async () => {
            const api = new AgoraApi(baseUrl, botToken);
            const tracker = new CursorTracker(api);

            // Reset cursor in DB so it's truly fresh
            await ctx.db.query('DELETE FROM bot_read_cursors WHERE bot_id = $1', [botId]);
            await new Promise(r => setTimeout(r, 100));

            // Channel has many messages from prior tests. Request only 3.
            const { messages, skipped } = await fetchUnreadMessages(api, tracker, channelId, 3);
            expect(skipped).toBe(0);
            expect(messages.length).toBe(3);

            // Verify these are the NEWEST 3 messages (not oldest)
            const allMsgs = await api.getMessages(channelId, { limit: 3 });
            const newestIds = allMsgs.map(m => m.id).sort();
            const returnedIds = messages.map(m => m.id).sort();
            expect(returnedIds).toEqual(newestIds);

            // Cursor set to newest returned
            expect(tracker.getCursor(channelId)).toBe(messages[messages.length - 1].id);
        });

        test('incomplete scan: skips gap, makes progress, reports skip', async () => {
            const api = new AgoraApi(baseUrl, botToken);

            // Mark everything read
            const latest = await api.getMessages(channelId, { limit: 1 });
            const setupTracker = new CursorTracker(api);
            if (latest.length > 0) {
                await setupTracker.ack(channelId, latest[0].id);
            }
            await new Promise(r => setTimeout(r, 100));
            const cursorBefore = setupTracker.getCursor(channelId)!;

            // Send 5 messages — more than maxScan=3
            for (let i = 0; i < 5; i++) {
                const msg = await api.sendMessage(channelId, `Overflow ${i}`, `overflow-${i}`);
                await waitForRow('messages', 'id', msg.id);
            }

            // maxScan=3: scan sees only newest 3 (Overflow 2,3,4), can't reach cursor
            const tracker1 = new CursorTracker(api);
            const { messages: batch1, skipped: s1 } = await fetchUnreadMessages(
                api, tracker1, channelId, 2, /* pageSize */ 1, /* maxScan */ 3
            );

            // Returns oldest 2 from the scanned window (Overflow 2,3)
            expect(batch1.length).toBe(2);
            expect(batch1[0].content).toBe('Overflow 2');
            expect(batch1[1].content).toBe('Overflow 3');
            expect(s1).not.toBe(0); // signals incomplete scan

            // Cursor advanced past the gap to make forward progress
            const newCursor = tracker1.getCursor(channelId)!;
            expect(newCursor > cursorBefore).toBe(true);
            expect(newCursor).toBe(batch1[1].id);

            // Wait for cursor commit
            await new Promise(r => setTimeout(r, 100));

            // Next call: cursor is now past the gap, Overflow 4 is accessible
            const tracker2 = new CursorTracker(api);
            const { messages: batch2, skipped: s2 } = await fetchUnreadMessages(
                api, tracker2, channelId, 200, 1
            );
            expect(s2).toBe(0);
            expect(batch2.length).toBe(1);
            expect(batch2[0].content).toBe('Overflow 4');
        });

        test('complete scan with small pageSize still works', async () => {
            const api = new AgoraApi(baseUrl, botToken);

            // Mark everything read
            const latest = await api.getMessages(channelId, { limit: 1 });
            const setupTracker = new CursorTracker(api);
            if (latest.length > 0) {
                await setupTracker.ack(channelId, latest[0].id);
            }
            await new Promise(r => setTimeout(r, 100));

            // Send 4 messages
            for (let i = 0; i < 4; i++) {
                const msg = await api.sendMessage(channelId, `Small page ${i}`, `small-page-${i}`);
                await waitForRow('messages', 'id', msg.id);
            }

            // pageSize=1, maxScan=10 (big enough to reach cursor)
            const tracker = new CursorTracker(api);
            const { messages, skipped } = await fetchUnreadMessages(api, tracker, channelId, 2, 1, 10);
            expect(skipped).toBe(0);
            expect(messages.length).toBe(2);
            expect(messages[0].content).toBe('Small page 0');
            expect(messages[1].content).toBe('Small page 1');

            // Cursor advanced (complete scan)
            expect(tracker.getCursor(channelId)).toBe(messages[1].id);

            // Wait for cursor commit
            await new Promise(r => setTimeout(r, 100));

            // Remaining accessible
            const tracker2 = new CursorTracker(api);
            const { messages: remaining } = await fetchUnreadMessages(api, tracker2, channelId, 200, 1, 10);
            expect(remaining.length).toBe(2);
            expect(remaining[0].content).toBe('Small page 2');
            expect(remaining[1].content).toBe('Small page 3');
        });
    });

    // ─── formatMessages ───

    describe('formatMessages', () => {
        test('formats bot and human messages', () => {
            const result = formatMessages([
                {
                    id: '1', content: 'hello', authorId: 'a', authorUsername: 'alice',
                    authorBot: false, channelId: 'c', createdAt: '2024-01-01T00:00:00Z',
                },
                {
                    id: '2', content: 'hi there', authorId: 'b', authorUsername: 'test-bot',
                    authorBot: true, channelId: 'c', createdAt: '2024-01-01T00:01:00Z',
                },
            ]);
            expect(result).toContain('alice:');
            expect(result).toContain('test-bot [BOT]:');
            expect(result).not.toContain('[SYSTEM]');
        });

        test('formats system messages', () => {
            const result = formatMessages([
                {
                    id: '1', content: 'Loop guard triggered', authorId: null, authorUsername: null,
                    authorBot: false, channelId: 'c', createdAt: '2024-01-01T00:00:00Z',
                    systemEvent: 'loop_guard',
                },
            ]);
            expect(result).toContain('[SYSTEM]');
        });

        test('formats deleted messages', () => {
            const result = formatMessages([
                {
                    id: '1', content: null, authorId: 'a', authorUsername: 'alice',
                    authorBot: false, channelId: 'c', createdAt: '2024-01-01T00:00:00Z',
                    deletedAt: '2024-01-01T00:05:00Z',
                },
            ]);
            expect(result).toContain('[deleted]');
        });

        test('returns "No messages." for empty array', () => {
            expect(formatMessages([])).toBe('No messages.');
        });
    });
});
