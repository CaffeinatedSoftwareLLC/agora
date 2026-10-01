import { Pool } from 'pg';
import { config } from '../config';
import { storage } from '../lib/storage';
import { rotateEncryptionKey } from '../lib/storage-maintenance';

/**
 * Re-encrypt every stored file and AI provider key under a new key.
 *
 *   AGORA_ENCRYPTION_KEY       the current key (as the server uses it)
 *   AGORA_NEW_ENCRYPTION_KEY   the key to move to (64 hex characters)
 *
 * Stop the API, cap-gateway and runner first, and back up the database and the file
 * store. If the run is interrupted, run it again with the same two keys: it picks up
 * where it stopped. When it reports success, put the new key in AGORA_ENCRYPTION_KEY
 * and start the server.
 *
 *   npm run key:rotate
 *   Docker: docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm --no-deps \
 *             -e AGORA_NEW_ENCRYPTION_KEY=<new key> api node dist/src/tools/rotate-encryption-key.js
 */
async function main() {
    const rawNew = process.env.AGORA_NEW_ENCRYPTION_KEY ?? '';
    if (!/^[0-9a-fA-F]{64}$/.test(rawNew) || /^0+$/.test(rawNew)) {
        throw new Error('Set AGORA_NEW_ENCRYPTION_KEY to the new key: 64 hex characters, not all zeros.');
    }

    await storage.init();
    const db = new Pool({ connectionString: config.dbUrl });
    try {
        const result = await rotateEncryptionKey(db, storage, config.encryptionKey, Buffer.from(rawNew, 'hex'));
        if (result.status === 'already_rotated') {
            console.log('This instance is already on the new key. Nothing to do.');
            return;
        }
        console.log(`Rotated ${result.files} file(s) and ${result.providerKeys} provider key(s); `
            + `${result.filesAlreadyDone} file(s) were already done; ${result.missing.length} missing from storage.`);
        for (const id of result.missing) console.log(`  missing blob for file ${id} (left as it was)`);
        console.log('Now set AGORA_ENCRYPTION_KEY to the new key and start the server. Keep the old key until you have checked that files open.');
    } finally {
        await db.end();
    }
}

main().catch((err) => {
    console.error('Key rotation failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
