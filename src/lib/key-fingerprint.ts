import { createHmac } from 'node:crypto';
import { decryptString } from './encryption';

/**
 * Startup guard against a changed AGORA_ENCRYPTION_KEY.
 *
 * Every file and stored provider key is encrypted with that key, and nothing else
 * notices when it changes: downloads and provider calls just start failing. So the
 * first process to start records a fingerprint of the key in `instance_config`, and
 * every later start (API, cap-gateway) compares against it and refuses to run on a
 * mismatch. The fingerprint is an HMAC of a fixed label: it identifies the key
 * without revealing it.
 */

const CONFIG_KEY = 'encryption_key_fingerprint';
const LABEL = 'agora:encryption-key-fingerprint:v1';

interface Queryable {
    query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export class EncryptionKeyMismatchError extends Error {
    constructor(detail: string) {
        super(
            `AGORA_ENCRYPTION_KEY ${detail}\n`
            + 'Files and AI provider keys encrypted with the instance\'s key cannot be read with this one.\n'
            + 'Set the key this instance uses (in .env.prod for Docker): the original one, or the new one if you have just '
            + 'rotated keys. If that key is lost and you accept losing that data, '
            + 'start once with AGORA_ACCEPT_NEW_ENCRYPTION_KEY=1 to record the current key instead.'
        );
        this.name = 'EncryptionKeyMismatchError';
    }
}

export function keyFingerprint(key: Buffer): string {
    return createHmac('sha256', key).update(LABEL).digest('hex');
}

async function storedFingerprint(db: Queryable): Promise<string | null> {
    const res = await db.query('SELECT value FROM instance_config WHERE key = $1', [CONFIG_KEY]);
    return res.rows[0]?.value ?? null;
}

/** True unless a stored provider key exists and this key can't decrypt it. */
async function decryptsExistingData(db: Queryable, key: Buffer): Promise<boolean> {
    const res = await db.query(
        `SELECT api_key_enc, api_key_iv, api_key_tag FROM ai_providers
         WHERE api_key_enc IS NOT NULL AND api_key_iv IS NOT NULL AND api_key_tag IS NOT NULL
         ORDER BY id LIMIT 1`
    );
    const row = res.rows[0];
    if (!row) return true;
    try {
        decryptString(row.api_key_enc, key, row.api_key_iv, row.api_key_tag);
        return true;
    } catch {
        return false;
    }
}

/**
 * Record the key's fingerprint on first run, verify it on every later one.
 * Throws EncryptionKeyMismatchError unless `acceptNew` is set.
 */
export async function verifyEncryptionKey(
    db: Queryable,
    key: Buffer,
    opts: { acceptNew?: boolean } = {},
): Promise<'recorded' | 'matched' | 'replaced'> {
    const fingerprint = keyFingerprint(key);
    let stored = await storedFingerprint(db);

    if (stored === null) {
        // An instance from before this check: don't record a key that already fails on its data
        if (!opts.acceptNew && !(await decryptsExistingData(db, key))) {
            throw new EncryptionKeyMismatchError('cannot decrypt the AI provider key already stored in this database.');
        }
        // Several processes start together; the first insert wins and the rest compare against it
        await db.query(
            'INSERT INTO instance_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
            [CONFIG_KEY, fingerprint]
        );
        stored = await storedFingerprint(db);
        if (stored === fingerprint) return 'recorded';
    }

    if (stored === fingerprint) return 'matched';

    if (!opts.acceptNew) {
        throw new EncryptionKeyMismatchError('does not match the key this instance was set up with.');
    }
    await db.query('UPDATE instance_config SET value = $2 WHERE key = $1', [CONFIG_KEY, fingerprint]);
    return 'replaced';
}

/** `verifyEncryptionKey` for process entrypoints: reads the override from the environment and logs. */
export async function verifyEncryptionKeyAtStartup(db: Queryable, key: Buffer): Promise<void> {
    const result = await verifyEncryptionKey(db, key, {
        acceptNew: process.env.AGORA_ACCEPT_NEW_ENCRYPTION_KEY === '1',
    });
    if (result === 'recorded') console.log('Recorded the encryption key fingerprint for this instance.');
    if (result === 'replaced') {
        console.warn('WARNING: AGORA_ACCEPT_NEW_ENCRYPTION_KEY=1: recorded a new encryption key. '
            + 'Data encrypted with the previous key is unreadable. Remove the setting now.');
    }
}
