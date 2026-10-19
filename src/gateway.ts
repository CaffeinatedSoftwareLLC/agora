import { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { verifyToken, sessionEndsAt, sessionHardExpiry, sessionLimitError } from './auth/tokens';
import { isTokenBlacklisted } from './auth/token-blacklist';
import { parseBotToken, verifyBotSecret } from './auth/bot-tokens';
import { config } from './config';
import { originAllowed, sessionTokenFromHeaders } from './auth/session-cookie';
import { socketAccountError, visibleChannels, gatewayAccessRevision, revalidateHumanSessions } from './lib/gateway-access';
import { canViewChannel } from './lib/channel-access';
import { installGatewayGate, readGatewayAccess } from './lib/gateway-gate';
import { agentPresence, type AgentPresencePayload } from './lib/agent-presence';

/** How often open human sockets are re-checked against revocation and account state. */
const SESSION_SWEEP_MS = 5 * 60 * 1000;

// In-memory presence: userId → Set of socket IDs (supports multiple tabs/devices)
export const onlineUsers = new Map<string, Set<string>>();

export async function setupGateway(app: FastifyInstance): Promise<Server> {
    const io = new Server(app.server, {
        transports: ['websocket'],
        cors: { origin: config.corsOrigin ?? false },
    });

    installGatewayGate(io);
    const jwtSecret = app.jwtSecret;
    const db = app.db;

    // Revocation is pushed to sockets when it happens (gatewayAccessChanged); this
    // sweep is the backstop for anything that changed without going through a request
    // here (another API process, a direct DB edit, a Redis blacklist entry).
    const sweep = setInterval(() => {
        void readGatewayAccess(io, () => revalidateHumanSessions(io, db)).catch(() => {});
    }, SESSION_SWEEP_MS);
    sweep.unref();
    app.addHook('onClose', async () => { clearInterval(sweep); });

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
        socket.data.accessRevision = gatewayAccessRevision(io);
        const type = socket.handshake.auth?.type;
        let token = socket.handshake.auth?.token;
        let fromCookie = false;

        // Browsers authenticate with the httpOnly session cookie instead of a token in
        // the handshake. Socket.IO's CORS setting does not cover the websocket transport,
        // so the handshake's Origin is checked here (cross-site WebSocket hijacking).
        if ((typeof token !== 'string' || !token) && type !== 'bot') {
            token = sessionTokenFromHeaders(socket.handshake.headers);
            fromCookie = !!token;
            if (token && !originAllowed(socket.handshake.headers)) {
                return next(new Error('Origin not allowed'));
            }
        }

        if (typeof token !== 'string' || !token) {
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

                const botId = tokenRow.rows[0].bot_id.trim();
                const error = await socketAccountError(db, botId, true);
                if (error) return next(new Error(error));
                socket.data.userId = botId;
                socket.data.isBot = true;
                socket.data.botTokenId = parsed.tokenId;
                (socket as any).userId = botId;
                (socket as any).isBot = true;

                // Record use before completing authentication
                await db.query('UPDATE bot_tokens SET last_used_at = NOW() WHERE id = $1', [parsed.tokenId]);

                return next();
            } catch {
                return next(new Error('Invalid bot token'));
            }
        }

        // Human JWT auth path
        try {
            const payload = verifyToken(token, jwtSecret);
            (socket as any).userId = payload.userId;
            socket.data.userId = payload.userId;
            socket.data.isBot = false;
            socket.data.tokenVersion = payload.tokenVersion ?? 0;
            socket.data.jti = payload.jti;
            socket.data.tokenExpiresAt = payload.exp * 1000;
            socket.data.cookieSession = fromCookie;
            if (fromCookie) {
                // The handshake is not activity: it never renews the session, it only
                // checks it. The socket ends when the cookie would, see 'connection'.
                if (sessionLimitError(payload)) return next(new Error('token_expired'));
                socket.data.tokenExpiresAt = sessionEndsAt(payload);
                socket.data.sessionHardExpiresAt = sessionHardExpiry(payload) * 1000;
            }

            // Check token blacklist (logout revocation)
            if (payload.jti && await isTokenBlacklisted(payload.jti)) {
                return next(new Error('Token revoked'));
            }

            // Check account_status using pool directly (no per-request transaction in WS)
            const result = await db.query(
                'SELECT account_status, token_version FROM users WHERE id = $1',
                [payload.userId]
            );
            if (result.rows.length === 0) {
                return next(new Error('Invalid token'));
            }
            if (socket.data.tokenVersion !== result.rows[0].token_version) return next(new Error('Token revoked'));
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

    io.on('connection', (socket) => { void readGatewayAccess(io, async () => {
        const userId = (socket as any).userId;
        if (!socket.data.isBot) {
            const remaining = socket.data.tokenExpiresAt - Date.now();
            // A cookie session within seconds of its end is treated as ended, so a
            // reconnect right at the deadline can't spin
            const floor = socket.data.cookieSession ? 5_000 : 0;
            if (!Number.isFinite(remaining) || remaining <= floor) {
                socket.emit('error', { code: 'token_expired' });
                socket.disconnect(true);
                return;
            }
            const expiry = setTimeout(() => {
                // A cookie session may have been renewed over HTTP since this socket
                // connected, and the socket can't see the new cookie. Ask the client to
                // reconnect: the handshake reads the current cookie, and fails if the
                // session really is over. At the 30-day cap there is nothing to renew.
                const renewable = socket.data.cookieSession && socket.data.tokenExpiresAt < socket.data.sessionHardExpiresAt;
                socket.emit('error', { code: renewable ? 'session_renew' : 'token_expired' });
                socket.disconnect(true);
            }, Math.min(remaining, 2_147_483_647));
            expiry.unref();
            socket.once('disconnect', () => clearTimeout(expiry));
        }

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
                if (!socket.connected || socket.data.accessRevision !== gatewayAccessRevision(io)) {
                    socket.disconnect(true);
                    return;
                }
                for (const row of channels.rows) {
                    socket.join(`channel:${row.channel_id.trim()}`);
                }

                const channelIds: string[] = channels.rows.map((r: any) => r.channel_id.trim());

                // Emit simplified BotReady (not human Ready)
                socket.emit('BotReady', {
                    botId: userId.trim(),
                    channels: channelIds,
                });

                // Bring-your-own-session presence (src/lib/agent-presence.ts): agora-mcp says
                // whether it is the Claude Code Channel or the plain MCP server.
                const mode = socket.handshake.auth?.mode;
                if (mode === 'channel' || mode === 'mcp') {
                    const botId = userId.trim();
                    const name = await db.query('SELECT username FROM users WHERE id = $1', [botId]);
                    if (!socket.connected) return;
                    const broadcast = (events: AgentPresencePayload[]) => {
                        for (const e of events) socket.to(`channel:${e.channelId}`).emit('AgentPresence', e);
                    };
                    broadcast(agentPresence.connect(botId, name.rows[0]?.username ?? '', socket.id, mode, channelIds));
                    socket.on('Listening', (data: { listening?: unknown }) => {
                        if (typeof data?.listening !== 'boolean') return;
                        broadcast(agentPresence.setListening(botId, socket.id, data.listening));
                    });
                    socket.on('disconnect', () => { broadcast(agentPresence.disconnect(botId, socket.id)); });
                }
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
                channels = await visibleChannels(db, channelsResult.rows, userId);
            }

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

            if (!socket.connected || socket.data.accessRevision !== gatewayAccessRevision(io)) {
                socket.disconnect(true);
                return;
            }

            // Join only authorized channel rooms
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
                unreads: unreadResult.rows.filter((r: any) => channelRoomIds.includes(r.channel_id.trim())).map((r: any) => ({
                    channelId: r.channel_id.trim(),
                    lastReadId: r.last_read_id ? r.last_read_id.trim() : null,
                    mentionCount: r.mention_count,
                })),
                onlineUserIds,
                agentPresence: agentPresence.inChannels(channelRoomIds),
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
            socket.on('Typing', async (data: { channelId: string }) => {
                if (!data || typeof data.channelId !== 'string') return;
                const channelId = data.channelId.trim();
                if (!socket.rooms.has(`channel:${channelId}`)) return;
                try {
                    if (!(await canViewChannel(db, channelId, userId, false)).allowed || !socket.connected) return;
                } catch { return; }
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
    }); });

    return io;
}
