import Fastify from 'fastify';
import { Pool } from 'pg';
import { instanceRoutes } from './routes/instance';
import { authRoutes } from './routes/auth';
import { serverRoutes } from './routes/servers';
import { channelRoutes } from './routes/channels';
import { messageRoutes } from './routes/messages';
import { dmRoutes } from './routes/dms';
import { requireAuth } from './auth/middleware';
import { isInstanceInitialized } from './instance/check-initialized';
import { setupGateway } from './gateway';

export async function buildApp(opts?: {
    logger?: boolean;
    jwtSecret?: string;
    dbUrl?: string;
}) {
    const app = Fastify({ logger: opts?.logger ?? false });

    const db = new Pool({
        connectionString: opts?.dbUrl ?? process.env.DATABASE_URL,
    });

    const jwtSecret = opts?.jwtSecret ?? process.env.JWT_SECRET ?? 'dev-secret-do-not-use-in-prod';

    // Decorate app so routes can access db pool and jwtSecret
    app.decorate('db', db);
    app.decorate('jwtSecret', jwtSecret);

    // Health endpoint (no auth required)
    app.get('/health', async () => {
        return { status: 'ok' };
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
        if (url === '/health' || url.startsWith('/instance/')) {
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
        if (url === '/health' || url.startsWith('/auth/') || url.startsWith('/instance/')) {
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
                        io.to(evt.room).emit(evt.event, evt.data);
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
    await app.register(dmRoutes);

    // Setup WebSocket gateway (Socket.IO)
    const io = await setupGateway(app);
    app.decorate('io', io);

    return { app, db };
}
