import Fastify from 'fastify';
import { Pool } from 'pg';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { config } from './config';
import { instanceRoutes } from './routes/instance';
import { authRoutes } from './routes/auth';
import { serverRoutes } from './routes/servers';
import { channelRoutes } from './routes/channels';
import { messageRoutes } from './routes/messages';
import { reactionRoutes } from './routes/reactions';
import { unreadRoutes } from './routes/unreads';
import { dmRoutes } from './routes/dms';
import { adminRoutes } from './routes/admin';
import { userRoutes } from './routes/users';
import { voiceRoutes } from './routes/voice';
import { voiceWebhookRoutes } from './routes/voice-webhooks';
import { dmCallRoutes } from './routes/dm-calls';
import { fileRoutes } from './routes/files';
import { requireAuth } from './auth/middleware';
import { isInstanceInitialized } from './instance/check-initialized';
import { setupGateway } from './gateway';

export async function buildApp(opts?: {
    logger?: boolean;
    jwtSecret?: string;
    dbUrl?: string;
    rateLimit?: boolean;
    callTimeoutMs?: number;
}) {
    const app = Fastify({ logger: opts?.logger ?? false, trustProxy: config.trustProxy });

    const db = new Pool({
        connectionString: opts?.dbUrl ?? process.env.DATABASE_URL,
    });

    const jwtSecret = opts?.jwtSecret ?? process.env.JWT_SECRET ?? 'dev-secret-do-not-use-in-prod';

    // Decorate app so routes can access db pool and jwtSecret
    app.decorate('db', db);
    app.decorate('jwtSecret', jwtSecret);
    app.decorate('ipEncryptionKey', config.ipEncryptionKey);

    // Health endpoint (no auth required)
    app.get('/health', async () => {
        return { status: 'ok' };
    });

    // Rate limiting (disabled in test mode)
    if (opts?.rateLimit !== false) {
        await app.register(rateLimit, { global: false });
    }

    // Multipart file upload support
    await app.register(multipart, {
        limits: { fileSize: 104857600, files: 1 },
    });

    // ─── Per-request DB client lifecycle (RLS enforcement) ───
    app.addHook('onRequest', async (request) => {
        const client = await db.connect();
        await client.query('BEGIN');
        (request as any).dbClient = client;
    });

    // Initialization gate — block everything except bootstrap routes when not initialized
    app.addHook('preHandler', async (request, reply) => {
        const url = request.url.split('?')[0];
        if (url === '/health' || url.startsWith('/instance/') || url.startsWith('/webhooks/')) {
            return;
        }
        const ready = await isInstanceInitialized((app as any).db);
        if (!ready) {
            return reply.status(503).send({ error: 'instance_not_initialized' });
        }
    });

    // Auth middleware for all routes except /auth/*, /instance/*, and /health
    app.addHook('preHandler', async (request, reply) => {
        const url = request.url.split('?')[0];
        if (url === '/health' || url.startsWith('/auth/') || url.startsWith('/instance/') || url.startsWith('/webhooks/')) {
            return;
        }
        await requireAuth(request, reply);
    });

    // RLS context: after auth sets userId, switch to app_user role
    app.addHook('preHandler', async (request) => {
        const client = (request as any).dbClient;
        const userId = (request as any).userId;
        if (client && userId) {
            await client.query('SET LOCAL ROLE app_user');
            await client.query(
                `SELECT set_config('app.current_user_id', $1, true)`,
                [userId]
            );
        }
    });

    // Commit + release on success, then flush pending socket events
    app.addHook('onResponse', async (request) => {
        const client = (request as any).dbClient;
        if (client) {
            (request as any).dbClient = null;
            try {
                await client.query('COMMIT');

                // Emit socket events only after successful commit
                const pendingEvents = (request as any).pendingEvents;
                const io = (app as any).io;
                if (io && pendingEvents) {
                    for (const evt of pendingEvents) {
                        // For ServerJoin, join user's sockets to new channel rooms BEFORE emitting
                        // so they don't miss early channel events
                        if (evt.event === 'ServerJoin' && evt.data?.channels) {
                            try {
                                const sockets = await io.in(evt.room).fetchSockets();
                                for (const s of sockets) {
                                    for (const ch of evt.data.channels) {
                                        s.join(`channel:${ch.id}`);
                                    }
                                }
                            } catch { /* best-effort room join */ }
                        }

                        // For DMCreated, join user's sockets to the new DM channel room
                        if (evt.event === 'DMCreated' && evt.data?.channelId) {
                            try {
                                const sockets = await io.in(evt.room).fetchSockets();
                                for (const s of sockets) {
                                    s.join(`channel:${evt.data.channelId}`);
                                }
                            } catch { /* best-effort room join */ }
                        }

                        io.to(evt.room).emit(evt.event, evt.data);
                    }
                }

                // Force-disconnect suspended users only after successful commit
                // (best-effort — WS failures must not affect the committed suspension)
                const pendingDisconnects = (request as any).pendingDisconnects;
                if (io && pendingDisconnects) {
                    for (const targetId of pendingDisconnects) {
                        try {
                            const sockets = await io.fetchSockets();
                            for (const s of sockets) {
                                if ((s as any).userId === targetId) {
                                    s.emit('error', { code: 'account_suspended' });
                                    s.disconnect(true);
                                }
                            }
                        } catch { /* WS disconnect is best-effort */ }
                    }
                }
            } catch {
                await client.query('ROLLBACK').catch(() => {});
            }
            client.release();
        }
    });

    // Rollback + release on error
    app.addHook('onError', async (request) => {
        const client = (request as any).dbClient;
        if (client) {
            (request as any).dbClient = null;
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    // Register route modules
    await app.register(instanceRoutes);
    await app.register(authRoutes);
    await app.register(serverRoutes);
    await app.register(channelRoutes);
    await app.register(messageRoutes);
    await app.register(reactionRoutes);
    await app.register(unreadRoutes);
    await app.register(dmRoutes);
    await app.register(adminRoutes);
    await app.register(userRoutes);
    await app.register(voiceRoutes);
    await app.register(voiceWebhookRoutes);
    await app.register(dmCallRoutes, { timeoutMs: opts?.callTimeoutMs });
    await app.register(fileRoutes);

    // Setup WebSocket gateway (Socket.IO)
    const io = await setupGateway(app);
    app.decorate('io', io);

    return { app, db };
}
