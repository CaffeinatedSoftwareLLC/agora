import { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { verifyToken } from './auth/tokens';

// In-memory presence: userId → Set of socket IDs (supports multiple tabs/devices)
export const onlineUsers = new Map<string, Set<string>>();

export async function setupGateway(app: FastifyInstance): Promise<Server> {
    const io = new Server(app.server, {
        transports: ['websocket'],
        cors: { origin: '*' },
    });

    const jwtSecret = (app as any).jwtSecret;
    const db = (app as any).db;

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

    // Auth middleware — verify JWT from handshake + check account_status
    io.use(async (socket, next) => {
        const token = socket.handshake.auth?.token;
        if (!token) {
            return next(new Error('Authentication required'));
        }
        try {
            const payload = verifyToken(token, jwtSecret);
            (socket as any).userId = payload.userId;

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

            // Fetch DM channels
            const dmChannelsResult = await db.query(
                `SELECT c.id, c.name, c.channel_type, c.server_id
                 FROM channels c
                 JOIN channel_members cm ON cm.channel_id = c.id
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
