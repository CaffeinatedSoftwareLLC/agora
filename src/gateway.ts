import { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { verifyToken } from './auth/tokens';

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

    // Auth middleware — verify JWT from handshake
    io.use((socket, next) => {
        const token = socket.handshake.auth?.token;
        if (!token) {
            return next(new Error('Authentication required'));
        }
        try {
            const payload = verifyToken(token, jwtSecret);
            (socket as any).userId = payload.userId;
            next();
        } catch {
            next(new Error('Invalid token'));
        }
    });

    io.on('connection', async (socket) => {
        const userId = (socket as any).userId;

        try {
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

            // Join socket rooms for all channels
            for (const ch of channels) {
                socket.join(`channel:${ch.id.trim()}`);
            }

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
            });
        } catch {
            socket.disconnect();
        }
    });

    return io;
}
