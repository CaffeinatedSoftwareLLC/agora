import type { Pool } from 'pg';
import type { ObjectStore } from './storage';
import { decryptFile, encryptFile, decryptString, encryptString } from './encryption';
import { keyFingerprint } from './key-fingerprint';

/**
 * One-off maintenance over stored files: dropping file names from storage keys, and
 * re-encrypting everything under a new key. Both run with the API, cap-gateway and
 * runner stopped, and both can be re-run after an interruption.
 *
 * Each file is moved by writing the new blob first, then pointing the row at it, then
 * deleting the old blob. A crash in between leaves a file that still opens (and at
 * worst one unreferenced blob), never a row whose blob or IV no longer match.
 */

interface Queryable {
    query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** Leaf name of a storage key that carries no file name. New uploads use it. */
export const BLOB_LEAF = 'blob';

const FINGERPRINT_KEY = 'encryption_key_fingerprint';

/** Leaf for blobs written by a rotation to `key`, so a re-run can tell which files are done. */
function rotatedLeaf(key: Buffer): string {
    return `${BLOB_LEAF}-${keyFingerprint(key).slice(0, 8)}`;
}

function leafOf(storageKey: string): string {
    return storageKey.slice(storageKey.lastIndexOf('/') + 1);
}

function withLeaf(storageKey: string, fileId: string, leaf: string): string {
    const slash = storageKey.lastIndexOf('/');
    return slash === -1 ? `${fileId}/${leaf}` : `${storageKey.slice(0, slash)}/${leaf}`;
}

function isNameless(storageKey: string): boolean {
    return /^blob(-[0-9a-f]{8})?$/.test(leafOf(storageKey));
}

async function liveFiles(db: Queryable): Promise<any[]> {
    const res = await db.query(
        `SELECT id, storage_key, encryption_iv, encryption_tag FROM files
         WHERE deleted_at IS NULL AND storage_key IS NOT NULL ORDER BY id`
    );
    return res.rows;
}

export interface StripResult { renamed: number; alreadyNameless: number; missing: string[] }

/**
 * Move blobs stored under `<channel>/<file>/<original file name>` to
 * `<channel>/<file>/blob`, so a listing of the volume or bucket no longer shows file
 * names. The blobs are copied as they are (still encrypted); no key is needed.
 */
export async function stripFilenamesFromStorageKeys(db: Queryable, store: ObjectStore): Promise<StripResult> {
    const result: StripResult = { renamed: 0, alreadyNameless: 0, missing: [] };
    for (const row of await liveFiles(db)) {
        const id = row.id.trim();
        const oldKey = row.storage_key.trim();
        if (isNameless(oldKey)) { result.alreadyNameless++; continue; }

        const blob = await store.get(oldKey);
        if (!blob) { result.missing.push(id); continue; }

        const newKey = withLeaf(oldKey, id, BLOB_LEAF);
        await store.put(newKey, blob);
        await db.query('UPDATE files SET storage_key = $1, path = $2 WHERE id = $3', [newKey, newKey, id]);
        await store.remove(oldKey);
        result.renamed++;
    }
    return result;
}

export interface RotateResult {
    status: 'rotated' | 'already_rotated';
    files: number;
    filesAlreadyDone: number;
    providerKeys: number;
    missing: string[];
}

export class KeyRotationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'KeyRotationError';
    }
}

/**
 * Re-encrypt every stored file and AI provider key from `oldKey` to `newKey`, then
 * record `newKey`'s fingerprint so the server starts with it. Files go first, one at a
 * time; provider keys and the fingerprint follow in a single transaction, so until
 * every file has been rotated the instance still belongs to the old key and a re-run
 * (with the same two keys) picks up where it stopped.
 */
export async function rotateEncryptionKey(
    db: Pool,
    store: ObjectStore,
    oldKey: Buffer,
    newKey: Buffer,
): Promise<RotateResult> {
    if (oldKey.length !== 32 || newKey.length !== 32) throw new KeyRotationError('Both keys must be 32 bytes (64 hex characters).');
    if (oldKey.equals(newKey)) throw new KeyRotationError('The new key is the same as the current key.');

    const stored = (await db.query('SELECT value FROM instance_config WHERE key = $1', [FINGERPRINT_KEY])).rows[0]?.value ?? null;
    if (stored === keyFingerprint(newKey)) {
        return { status: 'already_rotated', files: 0, filesAlreadyDone: 0, providerKeys: 0, missing: [] };
    }
    if (stored !== null && stored !== keyFingerprint(oldKey)) {
        throw new KeyRotationError('AGORA_ENCRYPTION_KEY is not the key this instance was set up with. Rotation needs the current key.');
    }

    const leaf = rotatedLeaf(newKey);
    const result: RotateResult = { status: 'rotated', files: 0, filesAlreadyDone: 0, providerKeys: 0, missing: [] };

    for (const row of await liveFiles(db)) {
        const id = row.id.trim();
        const currentKey = row.storage_key.trim();
        if (leafOf(currentKey) === leaf) { result.filesAlreadyDone++; continue; }

        const blob = await store.get(currentKey);
        if (!blob) { result.missing.push(id); continue; }

        let plain: Buffer;
        try {
            plain = decryptFile(blob, oldKey, row.encryption_iv, row.encryption_tag);
        } catch {
            throw new KeyRotationError(`File ${id} cannot be decrypted with the current key. Nothing was changed for it; rotation stopped.`);
        }
        const { encrypted, iv, authTag } = encryptFile(plain, newKey);
        const nextKey = withLeaf(currentKey, id, leaf);
        await store.put(nextKey, encrypted);
        await db.query(
            'UPDATE files SET storage_key = $1, path = $2, encryption_iv = $3, encryption_tag = $4 WHERE id = $5',
            [nextKey, nextKey, iv, authTag, id]
        );
        await store.remove(currentKey);
        result.files++;
    }

    // Provider keys and the fingerprint switch together: after this the instance is on the new key.
    // One connection for the whole transaction (a Pool would spread it over several).
    const tx = await db.connect();
    try {
        await tx.query('BEGIN');
        const providers = await tx.query(
            `SELECT id, api_key_enc, api_key_iv, api_key_tag FROM ai_providers
             WHERE api_key_enc IS NOT NULL AND api_key_iv IS NOT NULL AND api_key_tag IS NOT NULL ORDER BY id`
        );
        for (const p of providers.rows) {
            let secret: string;
            try {
                secret = decryptString(p.api_key_enc, oldKey, p.api_key_iv, p.api_key_tag);
            } catch {
                throw new KeyRotationError(`The API key of provider ${p.id.trim()} cannot be decrypted with the current key.`);
            }
            const next = encryptString(secret, newKey);
            await tx.query(
                'UPDATE ai_providers SET api_key_enc = $1, api_key_iv = $2, api_key_tag = $3 WHERE id = $4',
                [next.encrypted, next.iv, next.authTag, p.id]
            );
            result.providerKeys++;
        }
        await tx.query(
            `INSERT INTO instance_config (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [FINGERPRINT_KEY, keyFingerprint(newKey)]
        );
        await tx.query('COMMIT');
    } catch (err) {
        await tx.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        tx.release();
    }
    return result;
}
