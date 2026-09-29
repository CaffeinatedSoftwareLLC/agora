/**
 * Sandbox runner entrypoint: `node dist/src/runner-main.js` (dev: `npm run runner`).
 * The only Agora process that talks to Docker, and only through the socket proxy.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { config } from './config';
import { dockerFromEnv, SandboxDocker } from './runtime/docker';
import { reconcileInterruptedRuns, startRunnerWorker } from './runtime/runner';

async function main() {
    const insecureDev = process.env.AGORA_SANDBOX_INSECURE_DEV === '1';
    const image = process.env.AGORA_SANDBOX_IMAGE ?? 'agora/sandbox-deno:dev';
    const network = process.env.AGORA_SANDBOX_NETWORK ?? 'agora_sandbox';

    const sandbox = new SandboxDocker(dockerFromEnv());
    const { runtime } = await sandbox.preflight({ image, network, requireGvisor: !insecureDev });
    if (runtime !== 'runsc') {
        console.warn('\n  ⚠️  SANDBOX RUNNING WITHOUT gVISOR (AGORA_SANDBOX_INSECURE_DEV=1).');
        console.warn('     Agent code shares the host kernel. Never use this in production.\n');
    }

    const db = new Pool({ connectionString: config.dbUrl, max: 5 });
    const orphans = await sandbox.removeOrphans();
    const interrupted = await reconcileInterruptedRuns(db);
    console.log(`Sandbox runner: runtime=${runtime} image=${image} network=${network}; `
        + `removed ${orphans} orphan container(s), marked ${interrupted} interrupted run(s) as error`);

    const redisUrl = new URL(config.redisUrl);
    const worker = startRunnerWorker(
        {
            db,
            sandbox,
            config: {
                image,
                network,
                runtime,
                capUrl: process.env.AGORA_CAP_URL ?? 'http://cap-gateway:8080',
                perServerConcurrency: Number(process.env.RUNTIME_PER_SERVER_CONCURRENCY ?? 2),
                capacityRetryMs: 2000,
            },
            log: {
                info: (...a) => console.log('[runner]', ...a),
                warn: (...a) => console.warn('[runner]', ...a),
                error: (...a) => console.error('[runner]', ...a),
            },
        },
        {
            host: redisUrl.hostname,
            port: Number(redisUrl.port || 6379),
            db: redisUrl.pathname.length > 1 ? Number(redisUrl.pathname.slice(1)) : 0,
            password: redisUrl.password || undefined,
            maxRetriesPerRequest: null,
        },
        Number(process.env.RUNTIME_INSTANCE_CONCURRENCY ?? 4),
    );

    const shutdown = async () => {
        await worker.close();
        await db.end();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('Sandbox runner failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
});
