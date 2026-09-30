/**
 * Capability gateway entrypoint: `node dist/src/gateway-main.js` (dev: `npm run cap-gateway`).
 * Reachable only from the internal sandbox network; never exposed via nginx/Caddy.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { config } from './config';
import { buildCapGateway } from './gateway/cap-gateway';
import { storage } from './lib/storage';

async function main() {
    const db = new Pool({ connectionString: config.dbUrl, max: 10 });
    const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    await storage.init();

    const app = await buildCapGateway({ db, redis, logger: true });
    const port = Number(process.env.CAP_GATEWAY_PORT ?? 8080);
    await app.listen({ port, host: process.env.CAP_GATEWAY_HOST ?? '0.0.0.0' });

    const shutdown = async () => {
        await app.close();
        await db.end();
        redis.disconnect();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('Capability gateway failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
});
