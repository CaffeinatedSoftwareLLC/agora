import { setupTestApp, authedUser, cleanDatabase } from '../helpers';
import { parseBotToken } from '../../src/auth/bot-tokens';
import { getRedis } from '../../src/auth/token-blacklist';

/**
 * Wait for onResponse COMMIT to settle by polling the DB for a row.
 */
async function waitForRow(table: string, column: string, value: string) {
    for (let i = 0; i < 20; i++) {
        const res = await ctx.db.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [value]);
        if (res.rows.length > 0) return;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`Row never appeared: ${table}.${column} = ${value}`);
}

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
});

afterAll(async () => {
    await ctx.close();
});

describe('Sprint B: Coordination Core', () => {
    let owner: Awaited<ReturnType<typeof authedUser>>;
    let nonAdmin: Awaited<ReturnType<typeof authedUser>>;
    let serverId: string;
    let generalChannelId: string;
    let everyoneRoleId: string;
    let botId: string;
    let rawToken: string;

    beforeAll(async () => {
        owner = await authedUser(ctx.request, 'coordowner');

        // Create server with retries (onResponse COMMIT race)
        let serverRes: any;
        for (let attempt = 0; attempt < 10; attempt++) {
            serverRes = await ctx.request.post('/servers').set(owner.auth).send({ name: 'Coord Test Server' });
            if (serverRes.status === 201) break;
            await new Promise(r => setTimeout(r, 50));
        }
        if (serverRes.status !== 201) throw new Error(`Server create failed: ${serverRes.status}`);
        serverId = serverRes.body.id;
        everyoneRoleId = serverRes.body.everyoneRoleId;

        // Wait for server COMMIT, get general channel from DB
        for (let attempt = 0; attempt < 10; attempt++) {
            const dbRes = await ctx.db.query(
                "SELECT id FROM channels WHERE server_id = $1 AND name = 'general'",
                [serverId]
            );
            if (dbRes.rows.length > 0) {
                generalChannelId = dbRes.rows[0].id.trim();
                break;
            }
            await new Promise(r => setTimeout(r, 50));
        }
        if (!generalChannelId) throw new Error('No general channel found');

        // Create a bot in this server
        const botRes = await ctx.request
            .post(`/servers/${serverId}/bots`)
            .set(owner.auth)
            .send({ username: 'coordbot' });
        botId = botRes.body.id;
        await waitForRow('users', 'id', botId);

        // Create bot token
        const tokenRes = await ctx.request
            .post(`/servers/${serverId}/bots/${botId}/tokens`)
            .set(owner.auth)
            .send({ name: 'test-token' });
        rawToken = tokenRes.body.token;
        await waitForRow('bot_tokens', 'id', parseBotToken(rawToken)!.tokenId);

        // Grant bot access to general channel
        await ctx.request
            .post(`/channels/${generalChannelId}/bots/${botId}`)
            .set(owner.auth);
        await waitForRow('bot_channel_access', 'bot_id', botId);

        // Create non-admin user and join server
        nonAdmin = await authedUser(ctx.request, 'coordmember');
        await waitForRow('users', 'id', nonAdmin.userId);

        const inviteRes = await ctx.request
            .post(`/servers/${serverId}/invites`)
            .set(owner.auth)
            .send({});
        for (let i = 0; i < 20; i++) {
            const joinRes = await ctx.request
                .post(`/invites/${inviteRes.body.code}`)
                .set(nonAdmin.auth);
            if (joinRes.status === 200 || joinRes.status === 201) break;
            await new Promise(r => setTimeout(r, 50));
        }
        // Wait for join COMMIT
        await new Promise(r => setTimeout(r, 100));
    });

    // Clean up Redis keys between tests
    afterEach(async () => {
        try {
            const redis = getRedis();
            const keys = await redis.keys('loopguard:*');
            if (keys.length > 0) await redis.del(...keys);
            const rateKeys = await redis.keys('botrate:*');
            if (rateKeys.length > 0) await redis.del(...rateKeys);
        } catch { /* non-fatal */ }
    });

    // ─── Mention Resolution ───
    describe('Mention resolution finds bots', () => {
        test('bot is mentioned via UNION query in server channel', async () => {
            const res = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set(owner.auth)
                .send({ content: 'Hello @coordbot!' });

            expect(res.status).toBe(201);
            // mentions array should include the bot's ID
            expect(res.body.mentions).toContain(botId);
        });

        test('mentioning a human still works', async () => {
            const res = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set(owner.auth)
                .send({ content: 'Hello @coordmember!' });

            expect(res.status).toBe(201);
            expect(res.body.mentions).toContain(nonAdmin.userId);
        });

        test('mentioning both humans and bots works', async () => {
            const res = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set(owner.auth)
                .send({ content: '@coordbot please help @coordmember' });

            expect(res.status).toBe(201);
            expect(res.body.mentions).toContain(botId);
            expect(res.body.mentions).toContain(nonAdmin.userId);
        });
    });

    // ─── authorBot field ───
    describe('authorBot field', () => {
        test('bot messages have authorBot: true', async () => {
            const res = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}` })
                .send({ content: 'Bot message here' });

            expect(res.status).toBe(201);
            expect(res.body.authorBot).toBe(true);
        });

        test('human messages have authorBot: false', async () => {
            const res = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set(owner.auth)
                .send({ content: 'Human message here' });

            expect(res.status).toBe(201);
            expect(res.body.authorBot).toBe(false);
        });

        test('GET messages includes authorBot', async () => {
            // Wait for commits to settle
            await new Promise(r => setTimeout(r, 100));

            const res = await ctx.request
                .get(`/channels/${generalChannelId}/messages`)
                .set(owner.auth);

            expect(res.status).toBe(200);
            const botMsg = res.body.find((m: any) => m.content === 'Bot message here');
            const humanMsg = res.body.find((m: any) => m.content === 'Human message here');
            expect(botMsg?.authorBot).toBe(true);
            expect(humanMsg?.authorBot).toBe(false);
        });
    });

    // ─── Skip channel_unreads for bots ───
    describe('Channel unreads skip bots', () => {
        test('mentioning a bot does not increment channel_unreads', async () => {
            // Clear any existing unreads
            await ctx.db.query(
                'DELETE FROM channel_unreads WHERE user_id = $1 AND channel_id = $2',
                [botId, generalChannelId]
            );

            await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set(owner.auth)
                .send({ content: 'Hey @coordbot do something' });

            // Wait for COMMIT
            await new Promise(r => setTimeout(r, 100));

            // Bot should NOT have a channel_unreads entry
            const unreads = await ctx.db.query(
                'SELECT mention_count FROM channel_unreads WHERE user_id = $1 AND channel_id = $2',
                [botId, generalChannelId]
            );
            expect(unreads.rows.length).toBe(0);
        });

        test('mentioning a human DOES increment channel_unreads', async () => {
            await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set(owner.auth)
                .send({ content: 'Hey @coordmember check this' });

            // Wait for COMMIT
            await new Promise(r => setTimeout(r, 100));

            const unreads = await ctx.db.query(
                'SELECT mention_count FROM channel_unreads WHERE user_id = $1 AND channel_id = $2',
                [nonAdmin.userId, generalChannelId]
            );
            expect(unreads.rows.length).toBeGreaterThan(0);
            expect(unreads.rows[0].mention_count).toBeGreaterThan(0);
        });
    });

    // ─── UseBots permission gate ───
    describe('UseBots permission gate', () => {
        test('admin @mention of bot includes bot ID in mentions (events fire)', async () => {
            // Owner is admin (server owner) — has UseBots
            const res = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set(owner.auth)
                .send({ content: 'Hey @coordbot respond!' });

            expect(res.status).toBe(201);
            expect(res.body.mentions).toContain(botId);
        });

        test('non-admin @mention of bot still resolves mention (UI rendering)', async () => {
            // Non-admin does NOT have UseBots, but the mention should still resolve
            // for UI purposes (Phase 1). Only Phase 2 events are gated.
            const res = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set(nonAdmin.auth)
                .send({ content: 'Hey @coordbot can you help?' });

            expect(res.status).toBe(201);
            // Bot should still be in mentions (for display purposes)
            expect(res.body.mentions).toContain(botId);
        });
    });

    // ─── Loop Guard ───
    describe('Loop guard', () => {
        test('bot messages count toward loop guard', async () => {
            // Set max_bot_hops to 3 for this test
            await ctx.db.query(
                'UPDATE channels SET max_bot_hops = 3 WHERE id = $1',
                [generalChannelId]
            );

            // Send 3 bot messages (under threshold)
            for (let i = 0; i < 3; i++) {
                const res = await ctx.request
                    .post(`/channels/${generalChannelId}/messages`)
                    .set({ Authorization: `Bot ${rawToken}` })
                    .send({ content: `Bot message ${i + 1}` });
                expect(res.status).toBe(201);
            }

            // 4th message should trigger loop guard
            const res = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}` })
                .send({ content: 'This should be blocked' });

            expect(res.status).toBe(429);
            expect(res.body.error).toBe('Loop guard triggered');

            // Verify system message was created
            await new Promise(r => setTimeout(r, 100));
            const sysMsg = await ctx.db.query(
                "SELECT content, system_event FROM messages WHERE channel_id = $1 AND system_event = 'loop_guard' ORDER BY id DESC LIMIT 1",
                [generalChannelId]
            );
            expect(sysMsg.rows.length).toBe(1);
            expect(sysMsg.rows[0].content).toContain('Loop guard');
            expect(sysMsg.rows[0].content).toContain('3 consecutive');

            // Reset for other tests
            await ctx.db.query(
                'UPDATE channels SET max_bot_hops = 4 WHERE id = $1',
                [generalChannelId]
            );
        });

        test('human message resets loop guard counter', async () => {
            // Send 2 bot messages
            for (let i = 0; i < 2; i++) {
                await ctx.request
                    .post(`/channels/${generalChannelId}/messages`)
                    .set({ Authorization: `Bot ${rawToken}` })
                    .send({ content: `Before reset ${i}` });
            }

            // Human message resets counter
            await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set(owner.auth)
                .send({ content: 'Human breaks the chain' });

            // Bot can send 4 more messages (default threshold) without triggering guard
            for (let i = 0; i < 4; i++) {
                const res = await ctx.request
                    .post(`/channels/${generalChannelId}/messages`)
                    .set({ Authorization: `Bot ${rawToken}` })
                    .send({ content: `After reset ${i}` });
                expect(res.status).toBe(201);
            }
        });

        test('loop guard counter resets after trigger', async () => {
            // Set low threshold
            await ctx.db.query(
                'UPDATE channels SET max_bot_hops = 2 WHERE id = $1',
                [generalChannelId]
            );

            // Trigger loop guard
            for (let i = 0; i < 2; i++) {
                await ctx.request
                    .post(`/channels/${generalChannelId}/messages`)
                    .set({ Authorization: `Bot ${rawToken}` })
                    .send({ content: `Pre-trigger ${i}` });
            }
            const triggerRes = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}` })
                .send({ content: 'Trigger' });
            expect(triggerRes.status).toBe(429);

            // After trigger, counter is reset — bot can send again
            // (but needs human input first in real usage — we just test counter reset)
            // The del() call in the guard resets it
            const res = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}` })
                .send({ content: 'After trigger reset' });
            expect(res.status).toBe(201);

            // Reset threshold
            await ctx.db.query(
                'UPDATE channels SET max_bot_hops = 4 WHERE id = $1',
                [generalChannelId]
            );
        });
    });

    // ─── Rate Limiting ───
    describe('Rate limiting', () => {
        test('bot exceeding rate limit gets 429', async () => {
            // Set low rate limit
            await ctx.db.query(
                'UPDATE channels SET bot_rate_limit = 3 WHERE id = $1',
                [generalChannelId]
            );

            // Send 3 messages (at limit)
            for (let i = 0; i < 3; i++) {
                const res = await ctx.request
                    .post(`/channels/${generalChannelId}/messages`)
                    .set({ Authorization: `Bot ${rawToken}` })
                    .send({ content: `Rate test ${i}` });
                expect(res.status).toBe(201);
            }

            // 4th should be rate limited
            const res = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}` })
                .send({ content: 'Should be rate limited' });

            expect(res.status).toBe(429);
            expect(res.body.error).toBe('Rate limited');
            expect(res.body.retryAfter).toBeGreaterThan(0);

            // Reset
            await ctx.db.query(
                'UPDATE channels SET bot_rate_limit = 10 WHERE id = $1',
                [generalChannelId]
            );
        });

        test('human messages are not rate limited', async () => {
            // Set very low rate limit
            await ctx.db.query(
                'UPDATE channels SET bot_rate_limit = 1 WHERE id = $1',
                [generalChannelId]
            );

            // Humans can send freely regardless of bot rate limit
            for (let i = 0; i < 3; i++) {
                const res = await ctx.request
                    .post(`/channels/${generalChannelId}/messages`)
                    .set(owner.auth)
                    .send({ content: `Human rate test ${i}` });
                expect(res.status).toBe(201);
            }

            // Reset
            await ctx.db.query(
                'UPDATE channels SET bot_rate_limit = 10 WHERE id = $1',
                [generalChannelId]
            );
        });
    });

    // ─── Message mentions table ───
    describe('Message mentions include bots', () => {
        test('bot mention creates message_mentions row', async () => {
            const res = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set(owner.auth)
                .send({ content: 'Hey @coordbot' });

            expect(res.status).toBe(201);

            // Wait for COMMIT
            await new Promise(r => setTimeout(r, 100));

            const mentions = await ctx.db.query(
                'SELECT user_id FROM message_mentions WHERE message_id = $1',
                [res.body.id]
            );
            const mentionedIds = mentions.rows.map((r: any) => r.user_id.trim());
            expect(mentionedIds).toContain(botId);
        });
    });
});
