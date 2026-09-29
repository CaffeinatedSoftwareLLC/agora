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

        describe('per-thread loop guard', () => {
            let parentId: string;

            async function botReply(content: string) {
                return ctx.request
                    .post(`/channels/${generalChannelId}/messages/${parentId}/replies`)
                    .set({ Authorization: `Bot ${rawToken}` })
                    .send({ content });
            }

            beforeEach(async () => {
                const res = await ctx.request
                    .post(`/channels/${generalChannelId}/messages`)
                    .set(owner.auth)
                    .send({ content: 'Thread for loop guard' });
                parentId = res.body.id;
                await waitForRow('messages', 'id', parentId);
            });

            afterEach(async () => {
                await ctx.db.query(
                    'UPDATE channels SET max_bot_hops = 4, max_thread_bot_hops = 0 WHERE id = $1',
                    [generalChannelId]
                );
            });

            test('disabled by default: bots can reply past the channel limit', async () => {
                const cfg = await ctx.db.query('SELECT max_thread_bot_hops FROM channels WHERE id = $1', [generalChannelId]);
                expect(cfg.rows[0].max_thread_bot_hops).toBe(0);

                for (let i = 0; i < 6; i++) {
                    const res = await botReply(`Unguarded reply ${i}`);
                    expect(res.status).toBe(201);
                }
            });

            test('thread replies do not count toward the channel guard', async () => {
                await ctx.db.query('UPDATE channels SET max_bot_hops = 2 WHERE id = $1', [generalChannelId]);

                for (let i = 0; i < 3; i++) {
                    expect((await botReply(`Thread reply ${i}`)).status).toBe(201);
                }
                for (let i = 0; i < 2; i++) {
                    const res = await ctx.request
                        .post(`/channels/${generalChannelId}/messages`)
                        .set({ Authorization: `Bot ${rawToken}` })
                        .send({ content: `Top-level ${i}` });
                    expect(res.status).toBe(201);
                }
            });

            test('when enabled, triggers within the thread and posts the notice there', async () => {
                await ctx.db.query('UPDATE channels SET max_thread_bot_hops = 2 WHERE id = $1', [generalChannelId]);

                expect((await botReply('One')).status).toBe(201);
                expect((await botReply('Two')).status).toBe(201);
                const blocked = await botReply('Three');
                expect(blocked.status).toBe(429);
                expect(blocked.body.error).toBe('Loop guard triggered');

                let notice: any;
                for (let i = 0; i < 20 && !notice; i++) {
                    const rows = await ctx.db.query(
                        "SELECT content, thread_id FROM messages WHERE thread_id = $1 AND system_event = 'loop_guard'",
                        [parentId]
                    );
                    notice = rows.rows[0];
                    if (!notice) await new Promise(r => setTimeout(r, 50));
                }
                expect(notice.content).toContain('2 consecutive bot replies in this thread');
            });

            test('threads have independent counters', async () => {
                await ctx.db.query('UPDATE channels SET max_thread_bot_hops = 2 WHERE id = $1', [generalChannelId]);
                const firstParent = parentId;
                expect((await botReply('A1')).status).toBe(201);
                expect((await botReply('A2')).status).toBe(201);

                const other = await ctx.request
                    .post(`/channels/${generalChannelId}/messages`)
                    .set(owner.auth)
                    .send({ content: 'Second thread' });
                await waitForRow('messages', 'id', other.body.id);
                parentId = other.body.id;
                expect((await botReply('B1')).status).toBe(201);
                expect((await botReply('B2')).status).toBe(201);

                parentId = firstParent;
                expect((await botReply('A3')).status).toBe(429);
            });

            test('human reply in the thread resets its counter', async () => {
                await ctx.db.query('UPDATE channels SET max_thread_bot_hops = 2 WHERE id = $1', [generalChannelId]);
                expect((await botReply('One')).status).toBe(201);
                expect((await botReply('Two')).status).toBe(201);

                const human = await ctx.request
                    .post(`/channels/${generalChannelId}/messages/${parentId}/replies`)
                    .set(owner.auth)
                    .send({ content: 'Human steps in' });
                expect(human.status).toBe(201);

                expect((await botReply('Three')).status).toBe(201);
                expect((await botReply('Four')).status).toBe(201);
            });
        });

        describe('PATCH /channels/:id/bot-config', () => {
            afterEach(async () => {
                await ctx.db.query(
                    'UPDATE channels SET max_bot_hops = 4, max_thread_bot_hops = 0 WHERE id = $1',
                    [generalChannelId]
                );
            });

            test('updates the thread limit without touching the channel limit', async () => {
                const res = await ctx.request
                    .patch(`/channels/${generalChannelId}/bot-config`)
                    .set(owner.auth)
                    .send({ maxThreadBotHops: 7 });

                expect(res.status).toBe(200);
                expect(res.body).toEqual({ channelId: generalChannelId, maxBotHops: 4, maxThreadBotHops: 7 });
            });

            test('updates the channel limit alone (existing clients)', async () => {
                const res = await ctx.request
                    .patch(`/channels/${generalChannelId}/bot-config`)
                    .set(owner.auth)
                    .send({ maxBotHops: 9 });

                expect(res.status).toBe(200);
                expect(res.body.maxBotHops).toBe(9);
                expect(res.body.maxThreadBotHops).toBe(0);
            });

            test('rejects empty and unknown bodies', async () => {
                const empty = await ctx.request
                    .patch(`/channels/${generalChannelId}/bot-config`)
                    .set(owner.auth)
                    .send({});
                expect(empty.status).toBe(400);

                const unknown = await ctx.request
                    .patch(`/channels/${generalChannelId}/bot-config`)
                    .set(owner.auth)
                    .send({ maxThreadBotHops: -1 });
                expect(unknown.status).toBe(400);
            });

            test('non-admin member is forbidden', async () => {
                const res = await ctx.request
                    .patch(`/channels/${generalChannelId}/bot-config`)
                    .set(nonAdmin.auth)
                    .send({ maxThreadBotHops: 3 });
                expect(res.status).toBe(403);
            });

            test('channel listing exposes both limits', async () => {
                const res = await ctx.request
                    .get(`/servers/${serverId}/channels`)
                    .set(owner.auth);
                const general = res.body.find((c: any) => c.id === generalChannelId);
                expect(general.maxBotHops).toBe(4);
                expect(general.maxThreadBotHops).toBe(0);
            });
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
