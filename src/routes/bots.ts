import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { generateBotToken } from '../auth/bot-tokens';
import { Permissions, computePermissions } from '../permissions';
import { getRedis } from '../auth/token-blacklist';

const AVATAR_URL_MAX_LENGTH = 50_000; // 50KB string limit
const AVATAR_DATA_URI_RE = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

function isValidAvatarUrl(value: string): boolean {
    if (value.length > AVATAR_URL_MAX_LENGTH) return false;
    return AVATAR_DATA_URI_RE.test(value);
}

/**
 * Load permission context and compute permissions for a user in a server.
 * Same pattern used in voice.ts and files.ts.
 */
export async function loadAndComputePermissions(db: any, userId: string, serverId: string): Promise<bigint> {
    // Check server ownership first
    const serverRow = await db.query(
        'SELECT owner_id, everyone_role_id FROM servers WHERE id = $1',
        [serverId]
    );
    if (!serverRow.rows[0]) return 0n;

    const server = serverRow.rows[0];

    // Fetch user's assigned roles
    const memberRolesResult = await db.query(
        'SELECT role_id FROM member_roles WHERE server_id = $1 AND user_id = $2',
        [serverId, userId]
    );
    const roleIds = memberRolesResult.rows.map((r: any) => r.role_id.trim());

    // Fetch all roles for this server
    const allRolesResult = await db.query(
        'SELECT id, permissions FROM roles WHERE server_id = $1',
        [serverId]
    );
    const roles = new Map<string, { permissions: bigint }>();
    for (const r of allRolesResult.rows) {
        roles.set(r.id.trim(), { permissions: BigInt(r.permissions) });
    }

    return computePermissions({
        userId: userId.trim(),
        roleIds,
        server: {
            ownerId: server.owner_id.trim(),
            everyoneRoleId: server.everyone_role_id.trim(),
        },
        roles,
        channelRoleOverrides: new Map(),
        channelMemberOverride: undefined,
    });
}

/**
 * PreHandler: require ManageBots permission for /servers/:serverId/bots/* routes
 */
async function requireManageBots(request: FastifyRequest, reply: FastifyReply) {
    if (request.isBot) {
        return reply.status(403).send({ error: 'Bots cannot manage other bots' });
    }
    const { serverId } = request.params as any;
    const userId = request.userId;
    const db = request.dbClient!;

    // Check server membership first
    const member = await db.query(
        'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
        [serverId, userId]
    );
    if (member.rows.length === 0) {
        return reply.status(403).send({ error: 'Not a member of this server' });
    }

    const perms = await loadAndComputePermissions(db, userId, serverId);
    if (!(perms & Permissions.ManageBots) && !(perms & Permissions.Administrator)) {
        return reply.status(403).send({ error: 'Missing ManageBots permission' });
    }
}

/**
 * PreHandler: require ManageBots for /channels/:id/bots/:botId routes
 * Does channel→server lookup, DM rejection, cross-server bot check
 */
async function requireManageBotsForChannel(request: FastifyRequest, reply: FastifyReply) {
    if (request.isBot) {
        return reply.status(403).send({ error: 'Bots cannot manage other bots' });
    }
    const { id: channelId, botId } = request.params as any;
    const userId = request.userId;
    const db = request.dbClient!;

    // Look up which server this channel belongs to
    const channelRow = await db.query(
        'SELECT server_id FROM channels WHERE id = $1',
        [channelId]
    );
    if (!channelRow.rows[0]) {
        return reply.status(404).send({ error: 'Channel not found' });
    }

    // Reject DM/group DM channels
    if (!channelRow.rows[0].server_id) {
        return reply.status(400).send({ error: 'Bots cannot be added to DM channels' });
    }

    const serverId = channelRow.rows[0].server_id.trim();

    // Verify the bot exists and belongs to the same server
    const botRow = await db.query(
        'SELECT server_id FROM users WHERE id = $1 AND bot = true',
        [botId]
    );
    if (!botRow.rows[0]) {
        return reply.status(404).send({ error: 'Bot not found' });
    }
    if (botRow.rows[0].server_id.trim() !== serverId) {
        return reply.status(400).send({ error: 'Bot belongs to a different server' });
    }

    // Check membership
    const member = await db.query(
        'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
        [serverId, userId]
    );
    if (member.rows.length === 0) {
        return reply.status(403).send({ error: 'Not a member of this server' });
    }

    const perms = await loadAndComputePermissions(db, userId, serverId);
    if (!(perms & Permissions.ManageBots) && !(perms & Permissions.Administrator)) {
        return reply.status(403).send({ error: 'Missing ManageBots permission' });
    }
}

/**
 * PreHandler: require ManageBots for /channels/:id/bot-config
 * Channel→server lookup, membership check, no botId needed.
 */
async function requireManageBotsForChannelConfig(request: FastifyRequest, reply: FastifyReply) {
    if (request.isBot) {
        return reply.status(403).send({ error: 'Bots cannot manage bot config' });
    }
    const { id: channelId } = request.params as any;
    const userId = request.userId;
    const db = request.dbClient!;

    const channelRow = await db.query(
        'SELECT server_id FROM channels WHERE id = $1',
        [channelId]
    );
    if (!channelRow.rows[0]) {
        return reply.status(404).send({ error: 'Channel not found' });
    }
    if (!channelRow.rows[0].server_id) {
        return reply.status(400).send({ error: 'Cannot configure bot settings on DM channels' });
    }

    const serverId = channelRow.rows[0].server_id.trim();

    const member = await db.query(
        'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
        [serverId, userId]
    );
    if (member.rows.length === 0) {
        return reply.status(403).send({ error: 'Not a member of this server' });
    }

    const perms = await loadAndComputePermissions(db, userId, serverId);
    if (!(perms & Permissions.ManageBots) && !(perms & Permissions.Administrator)) {
        return reply.status(403).send({ error: 'Missing ManageBots permission' });
    }
}

export async function botRoutes(app: FastifyInstance) {

    // ─── Bot Management (human auth, requires ManageBots) ───

    // POST /servers/:serverId/bots → 201 { id, username, serverId }
    app.post('/servers/:serverId/bots', {
        preHandler: [requireManageBots],
        schema: {
            body: {
                type: 'object',
                required: ['username'],
                properties: {
                    username: { type: 'string', minLength: 1, maxLength: 32 },
                    avatarUrl: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const userId = request.userId;
        const db = request.dbClient!;
        const { username, avatarUrl } = request.body as any;

        if (avatarUrl !== undefined && avatarUrl !== null) {
            if (!isValidAvatarUrl(avatarUrl)) {
                return reply.status(400).send({ error: 'Invalid avatar URL. Must be a data:image URI (png, jpeg, webp, gif, svg+xml) under 50KB.' });
            }
        }

        const botId = generateUlid();

        try {
            await db.query(
                `INSERT INTO users (id, username, bot, bot_owner_id, server_id, avatar_url)
                 VALUES ($1, $2, true, $3, $4, $5)`,
                [botId, username, userId, serverId, avatarUrl || null]
            );
        } catch (err: any) {
            if (err.code === '23505') {
                return reply.status(409).send({ error: 'Username already taken' });
            }
            throw err;
        }

        return reply.status(201).send({
            id: botId,
            username,
            serverId: serverId.trim(),
            ownerId: userId.trim(),
            bot: true,
            avatarUrl: avatarUrl || null,
        });
    });

    // GET /servers/:serverId/bots → 200 [{ id, username, ownerId, createdAt }]
    app.get('/servers/:serverId/bots', {
        preHandler: [requireManageBots],
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;

        const result = await db.query(
            `SELECT id, username, bot_owner_id, created_at, avatar_url
             FROM users
             WHERE bot = true AND server_id = $1
             ORDER BY created_at`,
            [serverId]
        );

        const bots = result.rows.map((r: any) => ({
            id: r.id.trim(),
            username: r.username,
            ownerId: r.bot_owner_id?.trim() || null,
            createdAt: r.created_at,
            avatarUrl: r.avatar_url || null,
        }));

        return reply.status(200).send(bots);
    });

    // GET /servers/:serverId/bots/:id → 200 { id, username, ownerId, createdAt, canManageTokens, channels }
    app.get('/servers/:serverId/bots/:id', {
        preHandler: [requireManageBots],
    }, async (request, reply) => {
        const { serverId, id: botId } = request.params as any;
        const userId = request.userId;
        const db = request.dbClient!;

        const botRow = await db.query(
            `SELECT id, username, bot_owner_id, created_at, avatar_url
             FROM users
             WHERE id = $1 AND bot = true AND server_id = $2`,
            [botId, serverId]
        );
        if (!botRow.rows[0]) {
            return reply.status(404).send({ error: 'Bot not found in this server' });
        }

        const bot = botRow.rows[0];
        const isOwner = bot.bot_owner_id?.trim() === userId.trim();
        let canManageTokens = isOwner;
        if (!isOwner) {
            const perms = await loadAndComputePermissions(db, userId, serverId);
            canManageTokens = !!(perms & Permissions.Administrator);
        }

        const channelsResult = await db.query(
            `SELECT c.id, c.name, c.channel_type
             FROM bot_channel_access bca
             JOIN channels c ON c.id = bca.channel_id
             WHERE bca.bot_id = $1`,
            [botId]
        );

        return reply.status(200).send({
            id: bot.id.trim(),
            username: bot.username,
            ownerId: bot.bot_owner_id?.trim() || null,
            createdAt: bot.created_at,
            avatarUrl: bot.avatar_url || null,
            canManageTokens,
            channels: channelsResult.rows.map((c: any) => ({
                id: c.id.trim(),
                name: c.name,
                channelType: c.channel_type,
            })),
        });
    });

    // PATCH /servers/:serverId/bots/:id → 200 { id, username, avatarUrl }
    app.patch('/servers/:serverId/bots/:id', {
        preHandler: [requireManageBots],
        schema: {
            body: {
                type: 'object',
                properties: {
                    username: { type: 'string', minLength: 1, maxLength: 32 },
                    avatarUrl: { type: ['string', 'null'] },
                },
            },
        },
    }, async (request, reply) => {
        const { serverId, id: botId } = request.params as any;
        const { username, avatarUrl } = request.body as any;
        const db = request.dbClient!;

        // Verify bot belongs to this server
        const botRow = await db.query(
            'SELECT id, username, avatar_url FROM users WHERE id = $1 AND bot = true AND server_id = $2',
            [botId, serverId]
        );
        if (!botRow.rows[0]) {
            return reply.status(404).send({ error: 'Bot not found in this server' });
        }

        if (avatarUrl !== undefined && avatarUrl !== null) {
            if (!isValidAvatarUrl(avatarUrl)) {
                return reply.status(400).send({ error: 'Invalid avatar URL. Must be a data:image URI (png, jpeg, webp, gif, svg+xml) under 50KB.' });
            }
        }

        if (username) {
            try {
                await db.query(
                    'UPDATE users SET username = $1 WHERE id = $2',
                    [username, botId]
                );
            } catch (err: any) {
                if (err.code === '23505') {
                    return reply.status(409).send({ error: 'Username already taken' });
                }
                throw err;
            }
        }

        if (avatarUrl !== undefined) {
            await db.query(
                'UPDATE users SET avatar_url = $1 WHERE id = $2',
                [avatarUrl, botId]
            );
        }

        return reply.status(200).send({
            id: botId.trim(),
            username: username || botRow.rows[0].username,
            avatarUrl: avatarUrl !== undefined ? (avatarUrl || null) : (botRow.rows[0].avatar_url || null),
        });
    });

    // DELETE /servers/:serverId/bots/:id → 200 { deleted: true }
    app.delete('/servers/:serverId/bots/:id', {
        preHandler: [requireManageBots],
    }, async (request, reply) => {
        const { serverId, id: botId } = request.params as any;
        const db = request.dbClient!;

        const result = await db.query(
            'DELETE FROM users WHERE id = $1 AND bot = true AND server_id = $2 RETURNING id',
            [botId, serverId]
        );
        if (result.rows.length === 0) {
            return reply.status(404).send({ error: 'Bot not found in this server' });
        }

        return reply.status(200).send({ deleted: true });
    });

    // ─── Bot Token Management (human auth, bot owner or Administrator) ───

    // Inline preHandler: verify caller is the bot's owner or has Administrator
    async function requireBotOwnerOrAdmin(request: FastifyRequest, reply: FastifyReply) {
        const { serverId, id: botId } = request.params as any;
        const userId = request.userId;
        const db = request.dbClient!;

        const botRow = await db.query(
            'SELECT bot_owner_id FROM users WHERE id = $1 AND bot = true AND server_id = $2',
            [botId, serverId]
        );
        if (!botRow.rows[0]) {
            return reply.status(404).send({ error: 'Bot not found in this server' });
        }

        const isOwner = botRow.rows[0].bot_owner_id?.trim() === userId.trim();
        if (!isOwner) {
            const perms = await loadAndComputePermissions(db, userId, serverId);
            if (!(perms & Permissions.Administrator)) {
                return reply.status(403).send({ error: 'Only the bot owner or an Administrator can manage tokens' });
            }
        }
    }

    // POST /servers/:serverId/bots/:id/tokens → 201 { tokenId, token, name }
    app.post('/servers/:serverId/bots/:id/tokens', {
        preHandler: [requireBotOwnerOrAdmin],
        schema: {
            body: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 100 },
                },
            },
        },
    }, async (request, reply) => {
        const { id: botId } = request.params as any;
        const { name } = (request.body as any) || {};
        const db = request.dbClient!;

        // Bot existence already verified by requireBotOwnerOrAdmin preHandler

        const { tokenId, secretHash, raw } = await generateBotToken();

        await db.query(
            `INSERT INTO bot_tokens (id, bot_id, secret_hash, name)
             VALUES ($1, $2, $3, $4)`,
            [tokenId, botId, secretHash, name || null]
        );

        // Return the raw token ONCE — it cannot be retrieved later
        return reply.status(201).send({
            tokenId,
            token: raw,
            name: name || null,
        });
    });

    // GET /servers/:serverId/bots/:id/tokens → 200 [{ id, name, lastUsedAt, createdAt, revokedAt }]
    app.get('/servers/:serverId/bots/:id/tokens', {
        preHandler: [requireBotOwnerOrAdmin],
    }, async (request, reply) => {
        const { id: botId } = request.params as any;
        const db = request.dbClient!;

        // Bot existence already verified by requireBotOwnerOrAdmin preHandler

        const result = await db.query(
            `SELECT id, name, last_used_at, created_at, revoked_at
             FROM bot_tokens
             WHERE bot_id = $1
             ORDER BY created_at`,
            [botId]
        );

        const tokens = result.rows.map((r: any) => ({
            id: r.id.trim(),
            name: r.name,
            lastUsedAt: r.last_used_at,
            createdAt: r.created_at,
            revokedAt: r.revoked_at,
        }));

        return reply.status(200).send(tokens);
    });

    // DELETE /servers/:serverId/bots/:id/tokens/:tokenId → 200 { revoked: true }
    app.delete('/servers/:serverId/bots/:id/tokens/:tokenId', {
        preHandler: [requireBotOwnerOrAdmin],
    }, async (request, reply) => {
        const { id: botId, tokenId } = request.params as any;
        const db = request.dbClient!;

        // Bot existence already verified by requireBotOwnerOrAdmin preHandler

        const result = await db.query(
            `UPDATE bot_tokens SET revoked_at = NOW()
             WHERE id = $1 AND bot_id = $2 AND revoked_at IS NULL
             RETURNING id`,
            [tokenId, botId]
        );
        if (result.rows.length === 0) {
            return reply.status(404).send({ error: 'Token not found or already revoked' });
        }

        return reply.status(200).send({ revoked: true });
    });

    // ─── Bot Channel Assignment (human auth, requires ManageBots) ───

    // POST /channels/:id/bots/:botId → 201 { botId, channelId }
    app.post('/channels/:id/bots/:botId', {
        preHandler: [requireManageBotsForChannel],
    }, async (request, reply) => {
        const { id: channelId, botId } = request.params as any;
        const userId = request.userId;
        const db = request.dbClient!;

        try {
            await db.query(
                `INSERT INTO bot_channel_access (bot_id, channel_id, granted_by)
                 VALUES ($1, $2, $3)`,
                [botId, channelId, userId]
            );
        } catch (err: any) {
            if (err.code === '23505') {
                return reply.status(409).send({ error: 'Bot already has access to this channel' });
            }
            throw err;
        }

        return reply.status(201).send({
            botId: botId.trim(),
            channelId: channelId.trim(),
        });
    });

    // DELETE /channels/:id/bots/:botId → 200 { removed: true }
    app.delete('/channels/:id/bots/:botId', {
        preHandler: [requireManageBotsForChannel],
    }, async (request, reply) => {
        const { id: channelId, botId } = request.params as any;
        const db = request.dbClient!;

        const result = await db.query(
            'DELETE FROM bot_channel_access WHERE bot_id = $1 AND channel_id = $2 RETURNING bot_id',
            [botId, channelId]
        );
        if (result.rows.length === 0) {
            return reply.status(404).send({ error: 'Bot does not have access to this channel' });
        }

        // Eject bot sockets from the channel room after commit
        request.pendingEvents = request.pendingEvents || [];
        request.pendingEvents.push({
            event: '_leaveRoom',
            room: `user:${botId.trim()}`,
            data: { channelId: channelId.trim() },
        });

        return reply.status(200).send({ removed: true });
    });

    // ─── Channel Bot Config (human auth, requires ManageBots) ───

    // PATCH /channels/:id/bot-config → 200 { channelId, maxBotHops }
    app.patch('/channels/:id/bot-config', {
        preHandler: [requireManageBotsForChannelConfig],
        schema: {
            body: {
                type: 'object',
                required: ['maxBotHops'],
                properties: {
                    maxBotHops: { type: 'integer', minimum: 0, maximum: 1000 },
                },
            },
        },
    }, async (request, reply) => {
        const { id: channelId } = request.params as any;
        const { maxBotHops } = request.body as any;
        const db = request.dbClient!;

        await db.query(
            'UPDATE channels SET max_bot_hops = $1 WHERE id = $2',
            [maxBotHops, channelId]
        );

        // Clear stale Redis loop guard counter so new limit applies immediately
        try {
            await getRedis().del(`loopguard:${channelId}`);
        } catch { /* Redis failure is non-fatal */ }

        return reply.status(200).send({
            channelId: channelId.trim(),
            maxBotHops,
        });
    });

    // ─── Bot Self-Info (bot auth) ───

    // GET /bots/@me → 200 { id, username, serverId, channels }
    app.get('/bots/@me', async (request, reply) => {
        const userId = request.userId;
        const isBot = request.isBot;
        const db = request.dbClient!;

        if (!isBot) {
            return reply.status(403).send({ error: 'This endpoint is for bots only' });
        }

        const botRow = await db.query(
            'SELECT id, username, server_id, avatar_url FROM users WHERE id = $1 AND bot = true',
            [userId]
        );
        if (!botRow.rows[0]) {
            return reply.status(404).send({ error: 'Bot not found' });
        }

        const channelsResult = await db.query(
            `SELECT c.id, c.name, c.channel_type
             FROM bot_channel_access bca
             JOIN channels c ON c.id = bca.channel_id
             WHERE bca.bot_id = $1`,
            [userId]
        );

        return reply.status(200).send({
            id: botRow.rows[0].id.trim(),
            username: botRow.rows[0].username,
            serverId: botRow.rows[0].server_id?.trim() || null,
            bot: true,
            avatarUrl: botRow.rows[0].avatar_url || null,
            channels: channelsResult.rows.map((c: any) => ({
                id: c.id.trim(),
                name: c.name,
                channelType: c.channel_type,
            })),
        });
    });

    // ─── Bot Cursor Management (bot auth) ───

    // GET /bots/@me/cursors → 200 [{ channelId, lastReadId, updatedAt }]
    app.get('/bots/@me/cursors', async (request, reply) => {
        const userId = request.userId;
        const isBot = request.isBot;
        const db = request.dbClient!;

        if (!isBot) {
            return reply.status(403).send({ error: 'This endpoint is for bots only' });
        }

        const result = await db.query(
            `SELECT channel_id, last_read_id, updated_at
             FROM bot_read_cursors
             WHERE bot_id = $1`,
            [userId]
        );

        const cursors = result.rows.map((r: any) => ({
            channelId: r.channel_id.trim(),
            lastReadId: r.last_read_id.trim(),
            updatedAt: r.updated_at,
        }));

        return reply.status(200).send(cursors);
    });

    // PUT /bots/@me/cursors/:channelId → 200 { channelId, lastReadId }
    app.put('/bots/@me/cursors/:channelId', {
        schema: {
            body: {
                type: 'object',
                required: ['lastReadId'],
                properties: {
                    lastReadId: { type: 'string', minLength: 26, maxLength: 26 },
                },
            },
        },
    }, async (request, reply) => {
        const { channelId } = request.params as any;
        const userId = request.userId;
        const isBot = request.isBot;
        const { lastReadId } = request.body as any;
        const db = request.dbClient!;

        if (!isBot) {
            return reply.status(403).send({ error: 'This endpoint is for bots only' });
        }

        // Verify bot has access to this channel
        const access = await db.query(
            'SELECT 1 FROM bot_channel_access WHERE bot_id = $1 AND channel_id = $2',
            [userId, channelId]
        );
        if (access.rows.length === 0) {
            return reply.status(403).send({ error: 'Bot does not have access to this channel' });
        }

        await db.query(
            `INSERT INTO bot_read_cursors (bot_id, channel_id, last_read_id, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (bot_id, channel_id) DO UPDATE
                SET last_read_id = $3, updated_at = NOW()`,
            [userId, channelId, lastReadId]
        );

        return reply.status(200).send({
            channelId: channelId.trim(),
            lastReadId: lastReadId.trim(),
        });
    });
}
