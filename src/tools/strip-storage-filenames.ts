import { Pool } from 'pg';
import { config } from '../config';
import { storage } from '../lib/storage';
import { stripFilenamesFromStorageKeys } from '../lib/storage-maintenance';

/**
 * One-time rename of blobs stored before 0.2.0, whose storage path ends in the
 * original file name, to `<channel>/<file>/blob`. Run with the API and cap-gateway
 * stopped. Safe to re-run; blobs stay encrypted and no key is used.
 *
 *   npm run storage:strip-filenames
 *   Docker: docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm --no-deps api node dist/src/tools/strip-storage-filenames.js
 */
async function main() {
    await storage.init();
    const db = new Pool({ connectionString: config.dbUrl });
    try {
        const result = await stripFilenamesFromStorageKeys(db, storage);
        console.log(`Done: ${result.renamed} renamed, ${result.alreadyNameless} already without a file name, ${result.missing.length} missing from storage.`);
        for (const id of result.missing) console.log(`  missing blob for file ${id}`);
    } finally {
        await db.end();
    }
}

main().catch((err) => {
    console.error('Renaming storage keys failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
