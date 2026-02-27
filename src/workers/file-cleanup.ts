import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Pool } from 'pg';
import { Client as MinioClient } from 'minio';

export async function startFileCleanupWorker(opts: {
    redisUrl: string;
    dbUrl: string;
    minioClient: MinioClient;
    bucketName: string;
}) {
    const redis = new IORedis(opts.redisUrl, { maxRetriesPerRequest: null });
    const db = new Pool({ connectionString: opts.dbUrl });

    const queue = new Queue('file-cleanup', { connection: redis });

    // Distributed lock for scheduler registration
    const lockToken = `${Date.now()}:${Math.random()}`;
    const acquired = await redis.set('file-cleanup:scheduler-lock', lockToken, 'EX', 60, 'NX');

    if (acquired) {
        try {
            // Remove existing repeatable jobs
            const existing = await queue.getRepeatableJobs();
            for (const job of existing) {
                if (job.name === 'cleanup-expired') {
                    await queue.removeRepeatableByKey(job.key);
                }
            }
            // Add new repeatable job
            await queue.add('cleanup-expired', {}, {
                repeat: { every: 3600000 }, // hourly
                jobId: 'cleanup-expired-singleton',
            });
        } finally {
            // Release lock with compare-and-delete
            await redis.eval(
                `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
                1, 'file-cleanup:scheduler-lock', lockToken
            );
        }
    }

    const worker = new Worker('file-cleanup', async (job) => {
        // 1. Delete expired files
        const expired = await db.query(`
            SELECT id, storage_key FROM files
            WHERE expires_at IS NOT NULL AND expires_at < NOW() AND deleted_at IS NULL
            LIMIT 100
        `);

        for (const file of expired.rows) {
            try {
                await opts.minioClient.removeObject(opts.bucketName, file.storage_key);
            } catch { /* Object may already be gone */ }
            await db.query('UPDATE files SET deleted_at = NOW() WHERE id = $1', [file.id]);
        }

        // 2. Clean orphan files (no message_id, >1 hour old)
        const orphans = await db.query(`
            SELECT id, storage_key FROM files
            WHERE message_id IS NULL AND created_at < NOW() - INTERVAL '1 hour' AND deleted_at IS NULL
            LIMIT 100
        `);

        for (const file of orphans.rows) {
            try {
                if (file.storage_key) {
                    await opts.minioClient.removeObject(opts.bucketName, file.storage_key);
                }
            } catch { /* Expected for crash recovery */ }
            await db.query('UPDATE files SET deleted_at = NOW() WHERE id = $1', [file.id]);
        }

        // 3. Hard-delete soft-deleted files older than 24h
        await db.query(`
            DELETE FROM files WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '24 hours'
        `);

        return { expired: expired.rows.length, orphans: orphans.rows.length };
    }, { connection: redis });

    return { queue, worker };
}
