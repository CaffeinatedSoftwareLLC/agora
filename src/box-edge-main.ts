/**
 * Box edge entrypoint: `node dist/src/box-edge-main.js` (docs/agent-boxes.md §4, §5).
 * Sits on every box network (at .2) and on the default network; never exposed via nginx/Caddy.
 * :8080 Agora reverse proxy + git and GitHub brokers, :3128 forward proxy.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { config } from './config';
import { EDGE_AGORA_PORT, EDGE_PROXY_PORT, instanceName } from './lib/boxes/contract';
import { verifyEncryptionKeyAtStartup } from './lib/key-fingerprint';
import { createEdge } from './boxes/edge/server';
import { GITHUB_API_BASE, GITHUB_BASE } from './boxes/edge/upstream';

async function main() {
    const secret = process.env.AGORA_EDGE_SECRET ?? '';
    if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error('AGORA_EDGE_SECRET must be 64 hex characters');
    const instance = instanceName();
    const db = new Pool({ connectionString: config.dbUrl, max: 20 });
    const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    // The edge decrypts the owner's GitHub token: it must hold the instance's key
    await verifyEncryptionKeyAtStartup(db, config.encryptionKey);

    const edge = createEdge({
        db, redis, encryptionKey: config.encryptionKey, edgeSecret: secret,
        apiUpstream: process.env.AGORA_API_UPSTREAM || 'http://api:3000',
        // Fixed upstreams (§5): never configurable in production
        githubBase: GITHUB_BASE, githubApiBase: GITHUB_API_BASE,
    });
    await edge.start({ agora: EDGE_AGORA_PORT, proxy: EDGE_PROXY_PORT });
    console.log(JSON.stringify({ level: 'info', msg: 'Box edge listening', instance, agora: EDGE_AGORA_PORT, proxy: EDGE_PROXY_PORT }));

    let stopping = false;
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        await edge.close(30_000);
        await db.end();
        redis.disconnect();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('Box edge failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
});
