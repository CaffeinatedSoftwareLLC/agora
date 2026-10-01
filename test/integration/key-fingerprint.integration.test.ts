import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'crypto';
import { setupTestApp, cleanDatabase, authedUser, createServer } from '../helpers';
import { encryptString } from '../../src/lib/encryption';
import { generateUlid } from '../../src/utils/ulid';
import { verifyEncryptionKey, keyFingerprint, EncryptionKeyMismatchError } from '../../src/lib/key-fingerprint';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => { ctx = await setupTestApp(); await cleanDatabase(ctx.db); });
afterAll(async () => { await ctx.close(); });

async function storedFingerprint(): Promise<string | undefined> {
    const res = await ctx.db.query("SELECT value FROM instance_config WHERE key = 'encryption_key_fingerprint'");
    return res.rows[0]?.value;
}

/** A provider whose API key is encrypted with `key`. */
async function insertProvider(key: Buffer) {
    const owner = await authedUser(ctx.request, `owner${generateUlid().slice(-8).toLowerCase()}`);
    const { serverId } = await createServer(ctx.request, owner.auth, 'Key Test');
    const { encrypted, iv, authTag } = encryptString('sk-test-provider-key', key);
    await ctx.db.query(
        `INSERT INTO ai_providers (id, server_id, adapter, label, api_key_enc, api_key_iv, api_key_tag)
         VALUES ($1, $2, 'openai', 'Test', $3, $4, $5)`,
        [generateUlid(), serverId, encrypted, iv, authTag]
    );
}

describe('encryption key fingerprint', () => {
    const key = randomBytes(32);
    const otherKey = randomBytes(32);

    beforeEach(async () => { await cleanDatabase(ctx.db); });

    test('the fingerprint is stable, differs per key, and is not the key', () => {
        expect(keyFingerprint(key)).toBe(keyFingerprint(Buffer.from(key)));
        expect(keyFingerprint(key)).not.toBe(keyFingerprint(otherKey));
        expect(keyFingerprint(key)).not.toContain(key.toString('hex'));
    });

    test('records the fingerprint on first start and matches it afterwards', async () => {
        expect(await verifyEncryptionKey(ctx.db, key)).toBe('recorded');
        expect(await storedFingerprint()).toBe(keyFingerprint(key));
        expect(await verifyEncryptionKey(ctx.db, key)).toBe('matched');
    });

    test('refuses a different key and leaves the stored fingerprint alone', async () => {
        await verifyEncryptionKey(ctx.db, key);

        await expect(verifyEncryptionKey(ctx.db, otherKey)).rejects.toThrow(EncryptionKeyMismatchError);
        await expect(verifyEncryptionKey(ctx.db, otherKey)).rejects.toThrow(/AGORA_ACCEPT_NEW_ENCRYPTION_KEY=1/);
        expect(await storedFingerprint()).toBe(keyFingerprint(key));
    });

    test('acceptNew records the new key, after which the old one is refused', async () => {
        await verifyEncryptionKey(ctx.db, key);

        expect(await verifyEncryptionKey(ctx.db, otherKey, { acceptNew: true })).toBe('replaced');
        expect(await verifyEncryptionKey(ctx.db, otherKey)).toBe('matched');
        await expect(verifyEncryptionKey(ctx.db, key)).rejects.toThrow(EncryptionKeyMismatchError);
    });

    test('two processes starting together agree on one fingerprint', async () => {
        const results = await Promise.all([verifyEncryptionKey(ctx.db, key), verifyEncryptionKey(ctx.db, key)]);
        expect(results.every(r => r === 'recorded' || r === 'matched')).toBe(true);
        expect(await storedFingerprint()).toBe(keyFingerprint(key));
    });

    test('an existing instance: a key that cannot decrypt the stored provider key is not recorded', async () => {
        await insertProvider(key);

        await expect(verifyEncryptionKey(ctx.db, otherKey)).rejects.toThrow(/cannot decrypt/);
        expect(await storedFingerprint()).toBeUndefined();

        expect(await verifyEncryptionKey(ctx.db, key)).toBe('recorded');
    });
});
