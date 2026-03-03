import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateBotToken, parseBotToken } from '../../src/auth/bot-tokens';

/**
 * Wait for onResponse COMMIT to settle by polling the DB for a row.
 * The Fastify onResponse hook COMMITs the transaction after the response
 * is sent, creating a race when the next request depends on committed data.
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

// ─── Bot Token Parsing (unit-level, no DB) ───
describe('Bot token parsing', () => {
    test('parses valid token', () => {
        const parsed = parseBotToken('bot_01ABCDEFGHIJK.secretvalue123');
        expect(parsed).toEqual({ tokenId: '01ABCDEFGHIJK', secret: 'secretvalue123' });
    });

    test('rejects missing bot_ prefix', () => {
        expect(parseBotToken('01ABCDEFGHIJK.secretvalue123')).toBeNull();
    });

    test('rejects missing dot separator', () => {
        expect(parseBotToken('bot_01ABCDEFGHIJKsecretvalue123')).toBeNull();
    });

    test('rejects empty tokenId', () => {
        expect(parseBotToken('bot_.secretvalue123')).toBeNull();
    });

    test('rejects empty secret', () => {
        expect(parseBotToken('bot_01ABCDEFGHIJK.')).toBeNull();
    });
});

// ─── Bot Token Generation (unit-level) ───
describe('Bot token generation', () => {
    test('generates token with correct format', async () => {
        const { tokenId, secret, secretHash, raw } = await generateBotToken();
        expect(tokenId.length).toBe(26);
        expect(secret.length).toBe(64); // 32 bytes hex
        expect(secretHash).toBeTruthy();
        expect(raw).toBe(`bot_${tokenId}.${secret}`);
    });
});

// ─── Full bot integration flow ───
// Uses a single cleanDatabase to avoid inter-suite auth issues
describe('Bot integration', () => {
    let owner: Awaited<ReturnType<typeof authedUser>>;
    let serverId: string;
    let generalChannelId: string;
    let everyoneRoleId: string;

    beforeAll(async () => {
        owner = await authedUser(ctx.request, 'botowner');

        // Retry server creation — the onResponse COMMIT from authedUser may not
        // have settled yet, causing the auth middleware to 401.
        let serverRes: any;
        for (let attempt = 0; attempt < 10; attempt++) {
            serverRes = await ctx.request.post('/servers').set(owner.auth).send({ name: 'Bot Test Server' });
            if (serverRes.status === 201) break;
            await new Promise(r => setTimeout(r, 50));
        }
        if (serverRes.status !== 201) throw new Error(`Server create failed: ${serverRes.status} ${JSON.stringify(serverRes.body)}`);
        serverId = serverRes.body.id;
        everyoneRoleId = serverRes.body.everyoneRoleId;

        // Wait for server creation COMMIT to settle, then query DB for channel
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
        if (!generalChannelId) throw new Error('No general channel found after retries');
    });

    // ─── Bot CRUD ───
    describe('Bot CRUD', () => {
        let botId: string;

        test('create bot returns 201', async () => {
            const res = await ctx.request
                .post(`/servers/${serverId}/bots`)
                .set(owner.auth)
                .send({ username: 'test-bot' });

            expect(res.status).toBe(201);
            expect(res.body.username).toBe('test-bot');
            expect(res.body.bot).toBe(true);
            expect(res.body.serverId).toBe(serverId);
            botId = res.body.id;
        });

        test('list bots returns created bot', async () => {
            await waitForRow('users', 'id', botId);
            const res = await ctx.request
                .get(`/servers/${serverId}/bots`)
                .set(owner.auth);

            expect(res.status).toBe(200);
            expect(res.body.length).toBeGreaterThanOrEqual(1);
            expect(res.body.some((b: any) => b.username === 'test-bot')).toBe(true);
        });

        test('duplicate bot username returns 409', async () => {
            const res = await ctx.request
                .post(`/servers/${serverId}/bots`)
                .set(owner.auth)
                .send({ username: 'test-bot' });

            expect(res.status).toBe(409);
        });

        test('update bot username', async () => {
            const res = await ctx.request
                .patch(`/servers/${serverId}/bots/${botId}`)
                .set(owner.auth)
                .send({ username: 'renamed-bot' });

            expect(res.status).toBe(200);
            expect(res.body.username).toBe('renamed-bot');

            // Rename back for other tests
            await ctx.request
                .patch(`/servers/${serverId}/bots/${botId}`)
                .set(owner.auth)
                .send({ username: 'test-bot' });
        });

        test('unauthenticated bot creation returns 401', async () => {
            const res = await ctx.request
                .post(`/servers/${serverId}/bots`)
                .send({ username: 'noauth-bot' });

            expect(res.status).toBe(401);
        });
    });

    // ─── Bot Token Management ───
    describe('Bot Token Management', () => {
        let botId: string;
        let rawToken: string;

        beforeAll(async () => {
            const botRes = await ctx.request
                .post(`/servers/${serverId}/bots`)
                .set(owner.auth)
                .send({ username: 'token-bot' });
            botId = botRes.body.id;
            await waitForRow('users', 'id', botId);
        });

        test('create token returns raw token once', async () => {
            const res = await ctx.request
                .post(`/servers/${serverId}/bots/${botId}/tokens`)
                .set(owner.auth)
                .send({ name: 'Dev Laptop' });

            expect(res.status).toBe(201);
            expect(res.body.token).toMatch(/^bot_/);
            expect(res.body.name).toBe('Dev Laptop');
            rawToken = res.body.token;
        });

        test('list tokens does not expose secrets', async () => {
            const res = await ctx.request
                .get(`/servers/${serverId}/bots/${botId}/tokens`)
                .set(owner.auth);

            expect(res.status).toBe(200);
            expect(res.body.length).toBeGreaterThanOrEqual(1);
            for (const t of res.body) {
                expect(t).not.toHaveProperty('secret_hash');
                expect(t).not.toHaveProperty('token');
                expect(t).toHaveProperty('id');
                expect(t).toHaveProperty('name');
            }
        });

        test('revoke token', async () => {
            const list = await ctx.request
                .get(`/servers/${serverId}/bots/${botId}/tokens`)
                .set(owner.auth);
            const tokenId = list.body[0].id;

            const res = await ctx.request
                .delete(`/servers/${serverId}/bots/${botId}/tokens/${tokenId}`)
                .set(owner.auth);

            expect(res.status).toBe(200);
            expect(res.body.revoked).toBe(true);
        });

        test('revoked token cannot authenticate', async () => {
            // Wait for revocation COMMIT to settle
            await new Promise(r => setTimeout(r, 100));

            const res = await ctx.request
                .get('/bots/@me')
                .set({ Authorization: `Bot ${rawToken}` });

            expect(res.status).toBe(401);
        });

        test('non-owner with ManageBots cannot manage tokens', async () => {
            // Create a second user with ManageBots permission
            const other = await authedUser(ctx.request, 'tokenintruder');
            await waitForRow('users', 'id', other.userId);

            // Join the server via invite (with COMMIT waits between steps)
            const inviteRes = await ctx.request
                .post(`/servers/${serverId}/invites`)
                .set(owner.auth)
                .send({});

            // Wait for invite COMMIT, then join
            for (let i = 0; i < 20; i++) {
                const joinRes = await ctx.request
                    .post(`/invites/${inviteRes.body.code}`)
                    .set(other.auth);
                if (joinRes.status === 200 || joinRes.status === 201) break;
                await new Promise(r => setTimeout(r, 50));
            }

            // Grant ManageBots to @everyone role (direct DB, bypasses COMMIT race)
            await ctx.db.query(
                `UPDATE roles SET permissions = permissions | (1::bigint << 27) WHERE id = $1`,
                [everyoneRoleId]
            );

            // Wait for join COMMIT so requireManageBots can find server_members row
            await new Promise(r => setTimeout(r, 100));

            // Non-owner tries to create a token — should be denied
            const res = await ctx.request
                .post(`/servers/${serverId}/bots/${botId}/tokens`)
                .set(other.auth)
                .send({ name: 'stolen-token' });

            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/owner/i);

            // Clean up: remove ManageBots from @everyone
            await ctx.db.query(
                `UPDATE roles SET permissions = permissions & ~(1::bigint << 27) WHERE id = $1`,
                [everyoneRoleId]
            );
        });
    });

    // ─── Bot Auth & Channel Access ───
    describe('Bot Auth & Channel Access', () => {
        let botId: string;
        let rawToken: string;

        beforeAll(async () => {
            const botRes = await ctx.request
                .post(`/servers/${serverId}/bots`)
                .set(owner.auth)
                .send({ username: 'access-bot' });
            botId = botRes.body.id;
            await waitForRow('users', 'id', botId);

            const tokenRes = await ctx.request
                .post(`/servers/${serverId}/bots/${botId}/tokens`)
                .set(owner.auth)
                .send({ name: 'test' });
            rawToken = tokenRes.body.token;
            await waitForRow('bot_tokens', 'id', parseBotToken(rawToken)!.tokenId);
        });

        test('bot with no channel access is denied message read', async () => {
            const res = await ctx.request
                .get(`/channels/${generalChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}` });

            expect(res.status).toBe(403);
        });

        test('grant bot channel access', async () => {
            const res = await ctx.request
                .post(`/channels/${generalChannelId}/bots/${botId}`)
                .set(owner.auth);

            expect(res.status).toBe(201);
            expect(res.body.botId).toBe(botId);
            expect(res.body.channelId).toBe(generalChannelId);
        });

        test('bot with channel access can read messages', async () => {
            const res = await ctx.request
                .get(`/channels/${generalChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}` });

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });

        test('bot can send message to authorized channel', async () => {
            const res = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}` })
                .send({ content: 'Hello from bot!' });

            expect(res.status).toBe(201);
            expect(res.body.content).toBe('Hello from bot!');
        });

        test('bot @me returns bot info and channels', async () => {
            const res = await ctx.request
                .get('/bots/@me')
                .set({ Authorization: `Bot ${rawToken}` });

            expect(res.status).toBe(200);
            expect(res.body.id).toBe(botId);
            expect(res.body.bot).toBe(true);
            expect(res.body.channels.length).toBeGreaterThanOrEqual(1);
            expect(res.body.channels[0].id).toBe(generalChannelId);
        });

        test('bot cannot access disallowed route', async () => {
            const res = await ctx.request
                .get(`/servers/${serverId}/channels`)
                .set({ Authorization: `Bot ${rawToken}` });

            expect(res.status).toBe(403);
            expect(res.body.error).toBe('Bots cannot access this endpoint');
        });

        test('remove bot channel access', async () => {
            const res = await ctx.request
                .delete(`/channels/${generalChannelId}/bots/${botId}`)
                .set(owner.auth);

            expect(res.status).toBe(200);
            expect(res.body.removed).toBe(true);
        });

        test('bot denied after channel access removed', async () => {
            const res = await ctx.request
                .get(`/channels/${generalChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}` });

            expect(res.status).toBe(403);
        });

        test('duplicate channel access returns 409', async () => {
            // Re-grant first
            await ctx.request
                .post(`/channels/${generalChannelId}/bots/${botId}`)
                .set(owner.auth);

            const res = await ctx.request
                .post(`/channels/${generalChannelId}/bots/${botId}`)
                .set(owner.auth);

            expect(res.status).toBe(409);
        });
    });

    // ─── Bot Cursors ───
    describe('Bot Cursors', () => {
        let rawToken: string;
        let messageId: string;

        beforeAll(async () => {
            const botRes = await ctx.request
                .post(`/servers/${serverId}/bots`)
                .set(owner.auth)
                .send({ username: 'cursor-bot' });
            const botId = botRes.body.id;
            await waitForRow('users', 'id', botId);

            const tokenRes = await ctx.request
                .post(`/servers/${serverId}/bots/${botId}/tokens`)
                .set(owner.auth)
                .send({});
            rawToken = tokenRes.body.token;
            await waitForRow('bot_tokens', 'id', parseBotToken(rawToken)!.tokenId);

            await ctx.request
                .post(`/channels/${generalChannelId}/bots/${botId}`)
                .set(owner.auth);
            await waitForRow('bot_channel_access', 'bot_id', botId);

            const msgRes = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set(owner.auth)
                .send({ content: 'Track this' });
            messageId = msgRes.body.id;
        });

        test('get cursors returns empty initially', async () => {
            const res = await ctx.request
                .get('/bots/@me/cursors')
                .set({ Authorization: `Bot ${rawToken}` });

            expect(res.status).toBe(200);
            expect(res.body).toEqual([]);
        });

        test('update cursor', async () => {
            const res = await ctx.request
                .put(`/bots/@me/cursors/${generalChannelId}`)
                .set({ Authorization: `Bot ${rawToken}` })
                .send({ lastReadId: messageId });

            expect(res.status).toBe(200);
            expect(res.body.channelId).toBe(generalChannelId);
            expect(res.body.lastReadId).toBe(messageId);
        });

        test('get cursors returns updated cursor', async () => {
            const res = await ctx.request
                .get('/bots/@me/cursors')
                .set({ Authorization: `Bot ${rawToken}` });

            expect(res.status).toBe(200);
            expect(res.body.length).toBe(1);
            expect(res.body[0].channelId).toBe(generalChannelId);
            expect(res.body[0].lastReadId).toBe(messageId);
        });

        test('human cannot use cursor endpoints', async () => {
            const res = await ctx.request
                .get('/bots/@me/cursors')
                .set(owner.auth);

            expect(res.status).toBe(403);
        });
    });

    // ─── Cross-Server Bot Rejection ───
    describe('Cross-server bot rejection', () => {
        test('cannot add bot from server 1 to channel in server 2', async () => {
            // Create a second server
            const s2Res = await ctx.request.post('/servers').set(owner.auth).send({ name: 'Server Two' });

            // Wait for server creation COMMIT to settle
            let s2ChannelId: string | undefined;
            for (let attempt = 0; attempt < 20; attempt++) {
                const dbRes = await ctx.db.query(
                    "SELECT id FROM channels WHERE server_id = $1 AND name = 'general'",
                    [s2Res.body.id]
                );
                if (dbRes.rows.length > 0) {
                    s2ChannelId = dbRes.rows[0].id.trim();
                    break;
                }
                await new Promise(r => setTimeout(r, 50));
            }
            if (!s2ChannelId) throw new Error('Server 2 general channel not found');
            const server2 = { serverId: s2Res.body.id, generalChannelId: s2ChannelId };

            // Create bot in the first server
            const botRes = await ctx.request
                .post(`/servers/${serverId}/bots`)
                .set(owner.auth)
                .send({ username: 'cross-bot' });
            await waitForRow('users', 'id', botRes.body.id);

            // Try to add it to second server's channel
            const res = await ctx.request
                .post(`/channels/${server2.generalChannelId}/bots/${botRes.body.id}`)
                .set(owner.auth);

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Bot belongs to a different server');
        });
    });

    // ─── DM Bot Rejection ───
    describe('DM bot rejection', () => {
        test('cannot create DM with a bot', async () => {
            const botRes = await ctx.request
                .post(`/servers/${serverId}/bots`)
                .set(owner.auth)
                .send({ username: 'dm-target-bot' });

            // Wait for bot creation COMMIT to settle so DM route can see the bot
            for (let i = 0; i < 20; i++) {
                const check = await ctx.db.query('SELECT 1 FROM users WHERE id = $1', [botRes.body.id]);
                if (check.rows.length > 0) break;
                await new Promise(r => setTimeout(r, 50));
            }

            const res = await ctx.request
                .post('/channels/dm')
                .set(owner.auth)
                .send({ recipientId: botRes.body.id });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Cannot create DM with a bot');
        });
    });

    // ─── Bot Deletion ───
    describe('Bot deletion', () => {
        test('delete bot cascades tokens', async () => {
            const botRes = await ctx.request
                .post(`/servers/${serverId}/bots`)
                .set(owner.auth)
                .send({ username: 'del-bot' });

            const tokenRes = await ctx.request
                .post(`/servers/${serverId}/bots/${botRes.body.id}/tokens`)
                .set(owner.auth)
                .send({});

            const res = await ctx.request
                .delete(`/servers/${serverId}/bots/${botRes.body.id}`)
                .set(owner.auth);

            expect(res.status).toBe(200);

            // Wait for DELETE COMMIT to cascade-delete token
            await new Promise(r => setTimeout(r, 100));

            // Token no longer works (CASCADE deletes bot_tokens)
            const authRes = await ctx.request
                .get('/bots/@me')
                .set({ Authorization: `Bot ${tokenRes.body.token}` });

            expect(authRes.status).toBe(401);
        });
    });

    // ─── User Search Bot Filtering ───
    describe('User search bot filtering', () => {
        test('bots do not appear in user search', async () => {
            await ctx.request
                .post(`/servers/${serverId}/bots`)
                .set(owner.auth)
                .send({ username: 'searchable-bot' });

            const res = await ctx.request
                .get('/users/search?q=searchable')
                .set(owner.auth);

            expect(res.status).toBe(200);
            expect(res.body.find((u: any) => u.username === 'searchable-bot')).toBeUndefined();
        });
    });

    // ─── DB Constraint Enforcement ───
    describe('DB constraint enforcement', () => {
        test('ck_human_no_server: humans cannot have server_id', async () => {
            await expect(
                ctx.db.query(
                    'UPDATE users SET server_id = $2 WHERE id = $1',
                    [owner.userId, serverId]
                )
            ).rejects.toThrow(/ck_human_no_server/);
        });

        test('ck_human_no_owner: humans cannot have bot_owner_id', async () => {
            await expect(
                ctx.db.query(
                    'UPDATE users SET bot_owner_id = $1 WHERE id = $1',
                    [owner.userId]
                )
            ).rejects.toThrow(/ck_human_no_owner/);
        });

        test('ck_bot_has_server: bot without server_id rejected', async () => {
            const { generateUlid } = await import('../../src/utils/ulid');
            const botId = generateUlid();
            await expect(
                ctx.db.query(
                    `INSERT INTO users (id, username, bot) VALUES ($1, 'no-server-bot', true)`,
                    [botId]
                )
            ).rejects.toThrow(/ck_bot_has_server/);
        });
    });

    // ─── Idempotency ───
    describe('Idempotency', () => {
        let rawToken: string;
        let deniedChannelId: string; // channel the bot does NOT have access to

        beforeAll(async () => {
            const botRes = await ctx.request
                .post(`/servers/${serverId}/bots`)
                .set(owner.auth)
                .send({ username: 'idem-bot' });
            await waitForRow('users', 'id', botRes.body.id);

            const tokenRes = await ctx.request
                .post(`/servers/${serverId}/bots/${botRes.body.id}/tokens`)
                .set(owner.auth)
                .send({});
            rawToken = tokenRes.body.token;
            await waitForRow('bot_tokens', 'id', parseBotToken(rawToken)!.tokenId);

            await ctx.request
                .post(`/channels/${generalChannelId}/bots/${botRes.body.id}`)
                .set(owner.auth);
            await waitForRow('bot_channel_access', 'bot_id', botRes.body.id);

            // Create a second channel the bot is NOT granted access to
            const chRes = await ctx.request
                .post(`/servers/${serverId}/channels`)
                .set(owner.auth)
                .send({ name: 'no-bot-access', channelType: 3 });
            // Wait for channel COMMIT
            for (let i = 0; i < 20; i++) {
                const dbRes = await ctx.db.query(
                    "SELECT id FROM channels WHERE server_id = $1 AND name = 'no-bot-access'",
                    [serverId]
                );
                if (dbRes.rows.length > 0) {
                    deniedChannelId = dbRes.rows[0].id.trim();
                    break;
                }
                await new Promise(r => setTimeout(r, 50));
            }
            if (!deniedChannelId) throw new Error('Denied channel not found');
        });

        test('same idempotency key returns same response', async () => {
            const idempotencyKey = 'test-key-' + Date.now();

            const res1 = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}`, 'Idempotency-Key': idempotencyKey })
                .send({ content: 'Idempotent message' });

            expect(res1.status).toBe(201);

            // Small delay for Redis cache write
            await new Promise(r => setTimeout(r, 100));

            const res2 = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}`, 'Idempotency-Key': idempotencyKey })
                .send({ content: 'Idempotent message' });

            expect(res2.status).toBe(201);
            expect(res2.body.id).toBe(res1.body.id);
        });

        test('different idempotency keys create different messages', async () => {
            const res1 = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}`, 'Idempotency-Key': 'key-a-' + Date.now() })
                .send({ content: 'Message A' });

            const res2 = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}`, 'Idempotency-Key': 'key-b-' + Date.now() })
                .send({ content: 'Message B' });

            expect(res1.body.id).not.toBe(res2.body.id);
        });

        test('human requests without idempotency key work normally', async () => {
            const res = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set(owner.auth)
                .send({ content: 'Normal human message' });

            expect(res.status).toBe(201);
        });

        test('failed request clears in-flight lock so retry succeeds', async () => {
            const key = 'fail-retry-' + Date.now();

            // Send to a channel the bot lacks access to — passes schema
            // validation, idempotency preHandler claims the key, then the
            // route handler returns 403 (not a member).
            const failRes = await ctx.request
                .post(`/channels/${deniedChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}`, 'Idempotency-Key': key })
                .send({ content: 'Should be denied' });

            expect(failRes.status).toBe(403);

            // Wait for onResponse to clear the in-flight marker
            await new Promise(r => setTimeout(r, 100));

            // Retry with the same key on the authorized channel —
            // should succeed, not 409 (lock was cleared after the 403).
            const retryRes = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}`, 'Idempotency-Key': key })
                .send({ content: 'Retry after failure' });

            expect(retryRes.status).toBe(201);
            expect(retryRes.body.content).toBe('Retry after failure');
        });

        test('concurrent duplicate gets 409 in-flight response', async () => {
            const key = 'concurrent-' + Date.now();

            // Directly set an in-flight marker in Redis to simulate a concurrent request
            const { getRedis } = await import('../../src/auth/token-blacklist');
            const cacheKey = `idempotent:${parseBotToken(rawToken)!.tokenId}:POST:/channels/:id/messages:${generalChannelId}:${key}`;

            // Wait — the cacheKey format uses userId, not tokenId.
            // Reconstruct the real key format from the preHandler:
            // `idempotent:${userId}:${method}:${routeUrl}:${channelId}:${key}`
            // We need the bot's userId. Get it from @me.
            const meRes = await ctx.request.get('/bots/@me').set({ Authorization: `Bot ${rawToken}` });
            const botUserId = meRes.body.id;
            const realCacheKey = `idempotent:${botUserId}:POST:/channels/:id/messages:${generalChannelId}:${key}`;

            await getRedis().set(realCacheKey, JSON.stringify({ inflight: true }), 'EX', 30);

            const res = await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set({ Authorization: `Bot ${rawToken}`, 'Idempotency-Key': key })
                .send({ content: 'Should be blocked' });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('Duplicate request in flight');

            // Clean up
            await getRedis().del(realCacheKey);
        });
    });
});
