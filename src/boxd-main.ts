/**
 * boxd, the box runner (docs/agent-boxes.md §7): `node dist/src/boxd-main.js`.
 * The only box component with Docker access, and only through its own socket proxy
 * (AGORA_BOX_DOCKER_HOST). Reconciles every 15 seconds; SIGTERM finishes the box it is
 * working on and exits, which install/backup.sh relies on to quiesce (§9.4).
 */
import 'dotenv/config';
import { Pool, type PoolClient } from 'pg';
import Redis from 'ioredis';
import { config } from './config';
import { publishEvents } from './lib/event-bridge';
import { DEFAULT_BOX_SUBNETS, LABEL_BOX_VERSION, instanceName } from './lib/boxes/contract';
import { BoxDocker, boxDockerFromEnv, type BoxDockerApi } from './boxes/boxd/docker';
import { Reconciler } from './boxes/boxd/reconcile';
import { DbBoxStore } from './boxes/boxd/store';
import { parsePools } from './boxes/boxd/subnets';
import { BOX_IMAGE_VERSION } from './boxes/boxd/version';
import { retryWhileUnavailable } from './lib/startup-retry';

export const PASS_INTERVAL_MS = 15_000;
export const HEARTBEAT_KEY = 'agora:boxd:heartbeat';
/** One boxd per instance database: a second one waits for this lock. */
const LOCK_KEY = 'agora-boxd';

/** Refuses to run unless the engine and the image are what boxes need. Returns the runtime and image version. */
export async function preflight(docker: BoxDockerApi, opts: { image: string; insecureDev: boolean }): Promise<{ runtime: 'runsc' | 'runc'; imageVersion: number }> {
    const info = await docker.info();
    const hasGvisor = !!info.Runtimes && 'runsc' in info.Runtimes;
    if (!hasGvisor && !opts.insecureDev) {
        throw new Error('gVisor (runsc) is not registered with Docker. boxd refuses to run boxes without it. '
            + 'Install it (docs/getting-started.md) or, for development only, set AGORA_BOX_INSECURE_DEV=1.');
    }
    const image = await docker.imageInspect(opts.image);
    if (!image) throw new Error(`Box image "${opts.image}" is not on this engine; build it with the stack (box-image service)`);
    const label = image.Config?.Labels?.[LABEL_BOX_VERSION];
    const imageVersion = label !== undefined && /^\d+$/.test(label) ? Number(label) : BOX_IMAGE_VERSION;
    if (label !== undefined && imageVersion !== BOX_IMAGE_VERSION) {
        console.warn(`[boxd] image ${opts.image} is box version ${imageVersion}; this boxd was built for ${BOX_IMAGE_VERSION}`);
    }
    // An image VOLUME would add a mount next to the home volume, which the start check refuses
    if (image.Config?.Volumes && Object.keys(image.Config.Volumes).length > 0) {
        throw new Error(`Box image "${opts.image}" declares VOLUME ${Object.keys(image.Config.Volumes).join(', ')}; box images must not`);
    }
    return { runtime: opts.insecureDev ? 'runc' : 'runsc', imageVersion };
}

async function holdLock(db: Pool): Promise<PoolClient> {
    for (;;) {
        const client = await db.connect();
        let r;
        try {
            r = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK_KEY]);
        } catch (err) {
            // Destroy it, don't return it: startup retries must not leak the pool's 4 connections
            client.release(err as Error);
            throw err;
        }
        if (r.rows[0].ok) return client;
        client.release();
        console.warn('[boxd] another boxd holds the lock; waiting');
        await new Promise(res => setTimeout(res, PASS_INTERVAL_MS));
    }
}

async function main() {
    const insecureDev = process.env.AGORA_BOX_INSECURE_DEV === '1';
    const instance = instanceName();
    const image = process.env.AGORA_BOX_IMAGE || `agora/box:${BOX_IMAGE_VERSION}`;
    const subnets = parsePools(process.env.AGORA_BOX_SUBNETS || DEFAULT_BOX_SUBNETS);
    const edgeContainer = process.env.AGORA_EDGE_CONTAINER || `${instance}-box-edge-1`;

    const docker = new BoxDocker(boxDockerFromEnv());
    // After a reboot Docker starts boxd beside its socket proxy and Postgres (depends_on doesn't
    // apply then): wait for them instead of exiting and being restarted
    const { runtime, imageVersion } = await retryWhileUnavailable('boxd', () => preflight(docker, { image, insecureDev }));
    if (runtime !== 'runsc') {
        console.warn('\n  ⚠️  BOXES RUNNING WITHOUT gVISOR (AGORA_BOX_INSECURE_DEV=1).');
        console.warn('     Boxed agents share the host kernel. Never use this in production.\n');
    }

    const db = new Pool({ connectionString: config.dbUrl, max: 4 });
    const lock = await retryWhileUnavailable('boxd', () => holdLock(db));
    const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    const store = new DbBoxStore(db, config.encryptionKey, events => publishEvents(redis, events));
    const reconciler = new Reconciler({
        docker, store,
        config: { instance, image, imageVersion, runtime, edgeContainer, subnets },
        log: {
            info: (...a) => console.log('[boxd]', ...a),
            warn: (...a) => console.warn('[boxd]', ...a),
            error: (...a) => console.error('[boxd]', ...a),
        },
    });
    console.log(`boxd: instance=${instance} runtime=${runtime} image=${image} (v${imageVersion}) edge=${edgeContainer}`);

    let stopping = false;
    let current: Promise<void> = Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    const loop = async () => {
        try {
            await reconciler.pass();
            await redis.set(HEARTBEAT_KEY, String(Date.now()), 'EX', 120).catch(() => { /* Redis down: the doctor falls back to last_seen_at */ });
        } catch (err) {
            console.error('[boxd] pass failed:', err instanceof Error ? err.message : err);
        }
        if (!stopping) timer = setTimeout(() => { current = loop(); }, PASS_INTERVAL_MS);
    };
    current = loop();

    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        clearTimeout(timer);
        reconciler.stop();
        console.log('[boxd] stopping after the current operation');
        await current;
        lock.release();
        redis.disconnect();
        await db.end();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    main().catch((err) => {
        console.error('boxd failed to start:', err instanceof Error ? err.message : err);
        process.exit(1);
    });
}
