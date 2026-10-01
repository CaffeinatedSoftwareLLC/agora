import { Pool } from 'pg';
import { config } from '../config';
import { diskStore, s3Store } from '../lib/storage';

/**
 * One-time copy of file blobs from S3/MinIO to the disk store (#32).
 *
 * Reads the live rows in `files`, fetches each blob from the S3 endpoint
 * (S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY, or the old MINIO_* names) and
 * writes it under STORAGE_DIR. Blobs already on disk are skipped, so it is safe
 * to re-run. Blobs stay encrypted; no key is needed to copy them.
 *
 *   npm run storage:migrate-from-s3
 *   (Docker: see docker-compose.minio-migrate.yml)
 */
async function main() {
    const source = s3Store(config.storage.s3);
    const target = diskStore(config.storage.dir);
    await target.init();

    const db = new Pool({ connectionString: config.dbUrl });
    const { rows } = await db.query<{ storage_key: string }>(
        'SELECT storage_key FROM files WHERE deleted_at IS NULL AND storage_key IS NOT NULL ORDER BY id'
    );
    console.log(`Copying ${rows.length} file(s) from ${config.storage.s3.endpoint} (bucket ${config.storage.s3.bucket}) to ${config.storage.dir}`);

    let copied = 0;
    let present = 0;
    const missing: string[] = [];
    for (const row of rows) {
        const key = row.storage_key.trim();
        if (await target.get(key)) {
            present++;
            continue;
        }
        const blob = await source.get(key);
        if (!blob) {
            missing.push(key);
            continue;
        }
        await target.put(key, blob);
        copied++;
    }
    await db.end();

    console.log(`Done: ${copied} copied, ${present} already on disk, ${missing.length} missing from S3.`);
    // Missing blobs were already unreadable; the API soft-deletes such rows on first access
    for (const key of missing) console.log(`  missing: ${key}`);
}

main().catch((err) => {
    console.error('Storage migration failed:', err);
    process.exit(1);
});
