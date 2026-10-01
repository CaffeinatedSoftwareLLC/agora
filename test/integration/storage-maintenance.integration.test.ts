import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'crypto';
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { setupTestApp, cleanDatabase, authedUser, createServer } from '../helpers';
import { diskStore, type ObjectStore } from '../../src/lib/storage';
import { encryptFile, decryptFile, encryptString, decryptString } from '../../src/lib/encryption';
import { keyFingerprint, verifyEncryptionKey } from '../../src/lib/key-fingerprint';
import { stripFilenamesFromStorageKeys, rotateEncryptionKey, KeyRotationError } from '../../src/lib/storage-maintenance';
import { generateUlid } from '../../src/utils/ulid';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let root: string;
let store: ObjectStore;
let userId: string;
let serverId: string;
let channelId: string;

beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await ctx.close(); });

beforeEach(async () => {
    await cleanDatabase(ctx.db);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agora-maint-'));
    store = diskStore(root);
    await store.init();
    const owner = await authedUser(ctx.request, 'maintowner');
    userId = owner.userId;
    const server = await createServer(ctx.request, owner.auth, 'Maintenance');
    serverId = server.serverId;
    channelId = server.generalChannelId;
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

/** Store a file the way pre-0.2.0 uploads were stored: key ends in the file name. */
async function insertFile(content: string, key: Buffer, filename = 'quarterly plan.txt'): Promise<{ id: string; storageKey: string }> {
    const id = generateUlid();
    const storageKey = `${channelId}/${id}/${filename}`;
    const { encrypted, iv, authTag } = encryptFile(Buffer.from(content), key);
    await store.put(storageKey, encrypted);
    await ctx.db.query(
        `INSERT INTO files (id, uploader_id, channel_id, filename, content_type, mime_type, size_bytes, bucket, path, storage_key, encryption_iv, encryption_tag)
         VALUES ($1, $2, $3, $4, 'text/plain', 'text/plain', $5, 'agora-files', $6, $7, $8, $9)`,
        [id, userId, channelId, filename, content.length, storageKey, storageKey, iv, authTag]
    );
    return { id, storageKey };
}

/** Read a file back the way GET /files/:id does. */
async function readFile(id: string, key: Buffer): Promise<string> {
    const row = (await ctx.db.query('SELECT storage_key, encryption_iv, encryption_tag FROM files WHERE id = $1', [id])).rows[0];
    const blob = await store.get(row.storage_key.trim());
    if (!blob) throw new Error('blob missing');
    return decryptFile(blob, key, row.encryption_iv, row.encryption_tag).toString();
}

async function storageKeyOf(id: string): Promise<string> {
    return (await ctx.db.query('SELECT storage_key FROM files WHERE id = $1', [id])).rows[0].storage_key.trim();
}

async function insertProvider(secret: string, key: Buffer): Promise<string> {
    const id = generateUlid();
    const { encrypted, iv, authTag } = encryptString(secret, key);
    await ctx.db.query(
        `INSERT INTO ai_providers (id, server_id, adapter, label, api_key_enc, api_key_iv, api_key_tag)
         VALUES ($1, $2, 'openai', $3, $4, $5, $6)`,
        [id, serverId, `Provider ${id.slice(-4)}`, encrypted, iv, authTag]
    );
    return id;
}

async function providerSecret(id: string, key: Buffer): Promise<string> {
    const row = (await ctx.db.query('SELECT api_key_enc, api_key_iv, api_key_tag FROM ai_providers WHERE id = $1', [id])).rows[0];
    return decryptString(row.api_key_enc, key, row.api_key_iv, row.api_key_tag);
}

/** Every path under the store's root, relative, with forward slashes. */
async function listStore(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else out.push(path.relative(root, full).split(path.sep).join('/'));
        }
    };
    await walk(root);
    return out.sort();
}

describe('stripFilenamesFromStorageKeys', () => {
    const key = randomBytes(32);

    test('moves blobs to a nameless key and the files still open', async () => {
        const a = await insertFile('alpha', key, 'secret merger.txt');
        const b = await insertFile('beta', key, 'salaries 2026.txt');

        const result = await stripFilenamesFromStorageKeys(ctx.db, store);
        expect(result).toEqual({ renamed: 2, alreadyNameless: 0, missing: [] });

        expect(await storageKeyOf(a.id)).toBe(`${channelId}/${a.id}/blob`);
        expect(await readFile(a.id, key)).toBe('alpha');
        expect(await readFile(b.id, key)).toBe('beta');

        // Nothing on disk carries a file name any more
        const paths = await listStore();
        expect(paths).toHaveLength(2);
        expect(paths.join(' ')).not.toMatch(/merger|salaries/);
    });

    test('is safe to re-run and reports missing blobs without touching their rows', async () => {
        const kept = await insertFile('kept', key);
        const lost = await insertFile('lost', key);
        await store.remove(lost.storageKey);

        expect(await stripFilenamesFromStorageKeys(ctx.db, store)).toEqual({ renamed: 1, alreadyNameless: 0, missing: [lost.id] });
        expect(await stripFilenamesFromStorageKeys(ctx.db, store)).toEqual({ renamed: 0, alreadyNameless: 1, missing: [lost.id] });
        expect(await storageKeyOf(lost.id)).toBe(lost.storageKey);
        expect(await readFile(kept.id, key)).toBe('kept');
    });
});

describe('rotateEncryptionKey', () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);

    test('re-encrypts files and provider keys, and moves the instance to the new key', async () => {
        const a = await insertFile('first file', oldKey);
        const b = await insertFile('second file', oldKey);
        const provider = await insertProvider('sk-live-provider-key', oldKey);
        await verifyEncryptionKey(ctx.db, oldKey);

        const result = await rotateEncryptionKey(ctx.db, store, oldKey, newKey);
        expect(result).toMatchObject({ status: 'rotated', files: 2, filesAlreadyDone: 0, providerKeys: 1, missing: [] });

        // Readable with the new key, not with the old one
        expect(await readFile(a.id, newKey)).toBe('first file');
        expect(await readFile(b.id, newKey)).toBe('second file');
        await expect(readFile(a.id, oldKey)).rejects.toThrow();
        expect(await providerSecret(provider, newKey)).toBe('sk-live-provider-key');
        await expect(providerSecret(provider, oldKey)).rejects.toThrow();

        // The server now starts with the new key and refuses the old one
        expect(await verifyEncryptionKey(ctx.db, newKey)).toBe('matched');
        await expect(verifyEncryptionKey(ctx.db, oldKey)).rejects.toThrow();

        // Old blobs are gone and no path carries the file name
        const paths = await listStore();
        expect(paths).toHaveLength(2);
        expect(paths.every(p => /\/blob-[0-9a-f]{8}$/.test(p))).toBe(true);
    });

    test('running it again is a no-op', async () => {
        const a = await insertFile('once', oldKey);
        await rotateEncryptionKey(ctx.db, store, oldKey, newKey);
        const keyAfterFirst = await storageKeyOf(a.id);

        const again = await rotateEncryptionKey(ctx.db, store, oldKey, newKey);
        expect(again.status).toBe('already_rotated');
        expect(await storageKeyOf(a.id)).toBe(keyAfterFirst);
        expect(await readFile(a.id, newKey)).toBe('once');
    });

    test('an interrupted run resumes: files already rotated are skipped, the rest finish', async () => {
        const done = await insertFile('rotated before the crash', oldKey);
        await insertProvider('sk-resume', oldKey);
        await verifyEncryptionKey(ctx.db, oldKey);

        // Simulate a crash after the first file: rotate it by hand exactly as the tool does,
        // leaving the provider key and the fingerprint on the old key
        const leaf = `blob-${keyFingerprint(newKey).slice(0, 8)}`;
        const next = encryptFile(Buffer.from('rotated before the crash'), newKey);
        const nextKey = `${channelId}/${done.id}/${leaf}`;
        await store.put(nextKey, next.encrypted);
        await ctx.db.query('UPDATE files SET storage_key = $1, path = $2, encryption_iv = $3, encryption_tag = $4 WHERE id = $5',
            [nextKey, nextKey, next.iv, next.authTag, done.id]);
        await store.remove(done.storageKey);
        const pending = await insertFile('not yet rotated', oldKey);

        const result = await rotateEncryptionKey(ctx.db, store, oldKey, newKey);
        expect(result).toMatchObject({ status: 'rotated', files: 1, filesAlreadyDone: 1, providerKeys: 1 });
        expect(await readFile(done.id, newKey)).toBe('rotated before the crash');
        expect(await readFile(pending.id, newKey)).toBe('not yet rotated');
        expect(await verifyEncryptionKey(ctx.db, newKey)).toBe('matched');
    });

    test('refuses a wrong current key and changes nothing', async () => {
        const a = await insertFile('untouched', oldKey);
        const provider = await insertProvider('sk-untouched', oldKey);
        await verifyEncryptionKey(ctx.db, oldKey);
        const wrongKey = randomBytes(32);

        await expect(rotateEncryptionKey(ctx.db, store, wrongKey, newKey)).rejects.toThrow(KeyRotationError);
        expect(await storageKeyOf(a.id)).toBe(a.storageKey);
        expect(await readFile(a.id, oldKey)).toBe('untouched');
        expect(await providerSecret(provider, oldKey)).toBe('sk-untouched');
        expect(await verifyEncryptionKey(ctx.db, oldKey)).toBe('matched');
    });

    test('with no fingerprint recorded, a wrong current key stops at the first file', async () => {
        const a = await insertFile('still old', oldKey);
        await expect(rotateEncryptionKey(ctx.db, store, randomBytes(32), newKey)).rejects.toThrow(/cannot be decrypted with the current key/);
        expect(await readFile(a.id, oldKey)).toBe('still old');
    });

    test('rejects identical or malformed keys', async () => {
        await expect(rotateEncryptionKey(ctx.db, store, oldKey, oldKey)).rejects.toThrow(/same as the current key/);
        await expect(rotateEncryptionKey(ctx.db, store, oldKey, Buffer.alloc(16))).rejects.toThrow(/32 bytes/);
    });
});

describe('new uploads', () => {
    test('are stored under a key without the file name', async () => {
        const owner = await authedUser(ctx.request, 'uploader');
        const server = await createServer(ctx.request, owner.auth, 'Uploads');
        const res = await ctx.request.post('/files/upload')
            .set(owner.auth)
            .field('channel_id', server.generalChannelId)
            .attach('file', Buffer.from('plain text body'), 'confidential offer.txt');
        expect(res.status).toBe(201);
        expect(res.body.name).toBe('confidential offer.txt');

        const key = await storageKeyOf(res.body.id);
        expect(key).toBe(`${server.generalChannelId}/${res.body.id}/blob`);
        expect(key).not.toContain('confidential');

        // The download still carries the real name
        const download = await ctx.request.get(`/files/${res.body.id}`).set(owner.auth);
        expect(download.status).toBe(200);
        expect(download.headers['content-disposition']).toContain('confidential offer.txt');
        expect(download.text ?? download.body.toString()).toContain('plain text body');
    });
});
