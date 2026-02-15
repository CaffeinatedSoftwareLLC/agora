import Fastify from 'fastify';
import { Pool } from 'pg';
import { authRoutes } from './routes/auth';
import { serverRoutes } from './routes/servers';
import { channelRoutes } from './routes/channels';
import { messageRoutes } from './routes/messages';
import { dmRoutes } from './routes/dms';
import { requireAuth } from './auth/middleware';

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

    // Decorate app so routes can access db and jwtSecret
    app.decorate('db', db);
    app.decorate('jwtSecret', jwtSecret);

    // Health endpoint (no auth required)
    app.get('/health', async () => {
        return { status: 'ok' };
    });

    // Auth middleware for all routes except /auth/* and /health
    app.addHook('preHandler', async (request, reply) => {
        const url = request.url.split('?')[0];
        if (url === '/health' || url.startsWith('/auth/')) {
            return;
        }
        await requireAuth(request, reply);
    });

    // Register route modules
    await app.register(authRoutes);
    await app.register(serverRoutes);
    await app.register(channelRoutes);
    await app.register(messageRoutes);
    await app.register(dmRoutes);

    return { app, db };
}
