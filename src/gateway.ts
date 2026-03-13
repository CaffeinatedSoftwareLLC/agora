import { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { verifyToken } from './auth/tokens';
import { isTokenBlacklisted } from './auth/token-blacklist';
import { parseBotToken, verifyBotSecret } from './auth/bot-tokens';
import { config } from './config';

// In-memory presence: userId → Set of socket IDs (supports multiple tabs/devices)
export const onlineUsers = new Map<string, Set<string>>();

export async function setupGateway(app: FastifyInstance): Promise<Server> {
    const io = new Server(app.server, {
        transports: ['websocket'],
        cors: { origin: config.corsOrigin ?? false },
    });

    const jwtSecret = app.jwtSecret;
    const db = app.db;

    // Initialization gate — reject connections before instance is set up
    io.use(async (_socket, next) => {
        try {
            const result = await db.query(
                "SELECT value FROM instance_config WHERE key = 'setup_complete'"
            );
            if (result.rows.length === 0 || result.rows[0].value !== 'true') {
                return next(new Error('instance_not_initialized'));
            }
            next();
        } catch {
            next(new Error('instance_not_initialized'));
        }
    });

    // Auth middleware — verify JWT or bot token from handshake
    io.use(async (socket, next) => {
        const token = socket.handshake.auth?.token;
        const type = socket.handshake.auth?.type;

        if (!token) {
            return next(new Error('Authentication required'));
        }

        // Bot auth path
        if (type === 'bot') {
            try {
                const parsed = parseBotToken(token);
                if (!parsed) {
                    return next(new Error('Malformed bot token'));
                }

                const tokenRow = await db.query(
                    'SELECT id, bot_id, secret_hash FROM bot_tokens WHERE id = $1 AND revoked_at IS NULL',
                    [parsed.tokenId]
                );
                if (!tokenRow.rows[0]) {
                    return next(new Error('Invalid bot token'));
                }

                const valid = await verifyBotSecret(parsed.secret, tokenRow.rows[0].secret_hash);
                if (!valid) {
                    return next(new Error('Invalid bot token'));
                }

                (socket as any).userId = tokenRow.rows[0].bot_id;
                (socket as any).isBot = true;

                // Update last_used_at (fire and forget)
                db.query('UPDATE bot_tokens SET last_used_at = NOW() WHERE id = $1', [parsed.tokenId]);

                return next();
            } catch {
                return next(new Error('Invalid bot token'));
            }
        }

        // Human JWT auth path
        try {
            const payload = verifyToken(token, jwtSecret);
            (socket as any).userId = payload.userId;

            // Check token blacklist (logout revocation)
            if (payload.jti && await isTokenBlacklisted(payload.jti)) {
                return next(new Error('Token revoked'));
            }

            // Check account_status using pool directly (no per-request transaction in WS)
            const result = await db.query(
                'SELECT account_status FROM users WHERE id = $1',
                [payload.userId]
            );
            if (result.rows.length === 0) {
                return next(new Error('Invalid token'));
            }
            const status = result.rows[0].account_status;
            if (status === 'pending') {
                return next(new Error('account_pending'));
            }
            if (status === 'suspended') {
                return next(new Error('account_suspended'));
            }
            next();
        } catch (err: any) {
            if (err.message === 'account_pending' || err.message === 'account_suspended') {
                return next(err);
            }
            next(new Error('Invalid token'));
        }
    });

    io.on('connection', async (socket) => {
        const userId = (socket as any).userId;

        // === BOT BRANCH — early return, skip human hydration ===
        if ((socket as any).isBot) {
            try {
                // Join user:{id} room (for MessageMention delivery)
                socket.join(`user:${userId.trim()}`);

                // Join channel rooms from bot_channel_access
                const channels = await db.query(
                    'SELECT channel_id FROM bot_channel_access WHERE bot_id = $1',
                    [userId]
                );
                for (const row of channels.rows) {
                    socket.join(`channel:${row.channel_id.trim()}`);
                }

                // Emit simplified BotReady (not human Ready)
                socket.emit('BotReady', {
                    botId: userId.trim(),
                    channels: channels.rows.map((r: any) => r.channel_id.trim()),
                });
            } catch {
                socket.disconnect();
            }
            return;  // CRITICAL: skip human hydration below
        }

        // === HUMAN PATH — existing code unchanged ===
        try {
            // Join user-specific room for targeted events (e.g. ServerJoin)
            socket.join(`user:${userId.trim()}`);

            // Fetch user info
            const userResult = await db.query(
                'SELECT id, username FROM users WHERE id = $1',
                [userId]
            );

            if (userResult.rows.length === 0) {
                socket.disconnect();
                return;
            }

            const user = userResult.rows[0];

            // Fetch user's servers
            const serversResult = await db.query(
                `SELECT s.id, s.name, s.owner_id
                 FROM servers s
                 JOIN server_members sm ON sm.server_id = s.id
                 WHERE sm.user_id = $1`,
                [userId]
            );

            const serverIds = serversResult.rows.map((s: any) => s.id);

            // Fetch server channels
            let channels: any[] = [];
            if (serverIds.length > 0) {
                const channelsResult = await db.query(
                    `SELECT id, name, channel_type, server_id
                     FROM channels
                     WHERE server_id = ANY($1)`,
                    [serverIds]
                );
                channels = channelsResult.rows;
            }

            // Fetch DM channels with the OTHER user's username as the channel name
            const dmChannelsResult = await db.query(
                `SELECT c.id, u.username AS name, c.channel_type, c.server_id
                 FROM channels c
                 JOIN channel_members cm ON cm.channel_id = c.id
                 JOIN channel_members cm2 ON cm2.channel_id = c.id AND cm2.user_id != $1
                 JOIN users u ON u.id = cm2.user_id
                 WHERE cm.user_id = $1 AND c.server_id IS NULL`,
                [userId]
            );
            channels = channels.concat(dmChannelsResult.rows);

            // Fetch unread state for all user's channels
            const unreadResult = await db.query(
                `SELECT cu.channel_id, cu.last_read_id, cu.mention_count
                 FROM channel_unreads cu
                 WHERE cu.user_id = $1`,
                [userId]
            );

            // Collect co-member user IDs (users in the same servers) for online filtering
            let coMemberIds: Set<string> = new Set();
            if (serverIds.length > 0) {
                const coMembersResult = await db.query(
                    `SELECT DISTINCT user_id FROM server_members WHERE server_id = ANY($1)`,
                    [serverIds]
                );
                for (const row of coMembersResult.rows) {
                    coMemberIds.add(row.user_id.trim());
                }
            }

            // Join socket rooms for all channels
            const channelRoomIds = channels.map((c: any) => c.id.trim());
            for (const ch of channels) {
                socket.join(`channel:${ch.id.trim()}`);
            }

            // Store channel rooms on socket for disconnect cleanup
            (socket as any).channelRooms = channelRoomIds;
            (socket as any).trimmedUserId = userId.trim();

            // Filter online users to only those in shared servers
            const onlineUserIds = Array.from(onlineUsers.keys()).filter(
                (uid) => coMemberIds.has(uid)
            );

            // Emit Ready
            socket.emit('Ready', {
                user: {
                    id: user.id.trim(),
                    username: user.username,
                },
                servers: serversResult.rows.map((s: any) => ({
                    id: s.id.trim(),
                    name: s.name,
                    ownerId: s.owner_id.trim(),
                })),
                channels: channels.map((c: any) => ({
                    id: c.id.trim(),
                    name: c.name,
                    channelType: c.channel_type,
                    serverId: c.server_id ? c.server_id.trim() : null,
                })),
                unreads: unreadResult.rows.map((r: any) => ({
                    channelId: r.channel_id.trim(),
                    lastReadId: r.last_read_id ? r.last_read_id.trim() : null,
                    mentionCount: r.mention_count,
                })),
                onlineUserIds,
            });

            // --- Presence: track this connection ---
            const trimmedUserId = userId.trim();
            const wasOnline = onlineUsers.has(trimmedUserId);
            const sockets = onlineUsers.get(trimmedUserId) || new Set<string>();
            sockets.add(socket.id);
            onlineUsers.set(trimmedUserId, sockets);

            if (!wasOnline) {
                // Broadcast PresenceUpdate 'online' to all channel rooms
                for (const roomId of channelRoomIds) {
                    socket.to(`channel:${roomId}`).emit('PresenceUpdate', {
                        userId: trimmedUserId,
                        status: 'online',
                    });
                }
            }

            // --- Typing handler ---
            socket.on('Typing', (data: { channelId: string }) => {
                if (!data || !data.channelId) return;
                const channelId = data.channelId.trim();
                socket.to(`channel:${channelId}`).emit('Typing', {
                    channelId,
                    userId: trimmedUserId,
                    username: user.username,
                });
            });

            // --- Disconnect handler ---
            socket.on('disconnect', () => {
                try {
                    const sockets = onlineUsers.get(trimmedUserId);
                    if (sockets) {
                        sockets.delete(socket.id);
                        if (sockets.size === 0) {
                            onlineUsers.delete(trimmedUserId);
                            // Broadcast PresenceUpdate 'offline' to all their channel rooms
                            const rooms = (socket as any).channelRooms as string[] | undefined;
                            if (rooms) {
                                for (const roomId of rooms) {
                                    socket.to(`channel:${roomId}`).emit('PresenceUpdate', {
                                        userId: trimmedUserId,
                                        status: 'offline',
                                    });
                                }
                            }
                        }
                    }
                } catch {
                    // Presence is best-effort — don't crash on disconnect cleanup
                }
            });

        } catch {
            socket.disconnect();
        }
    });

    return io;
}
