import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HANDLE_RE, deriveKeys, hashHandle, open, seal } from '../src/crypto.js';
import { normalizeInstance } from '../src/origin.js';
import { FixedWindowLimiter } from '../src/rate-limit.js';
import pg from 'pg';
import { SqliteHandleStore } from '../src/store.js';
import { PgHandleStore } from '../src/store-pg.js';
import { PG_URL, backends, pgBackend } from './backends.js';

const I = 'https://agora.example.com';
const keys = () => deriveKeys(randomBytes(32));

// Every store test runs against SQLite and, when TEST_DATABASE_URL is set (always in CI), Postgres.
describe.each(backends())('HandleStore ($name)', (backend) => {
    beforeAll(() => backend.setup());
    afterEach(() => backend.closeAll());
    afterAll(() => backend.teardown());

    it('looks a handle up by its hash and decrypts the token and instance', async () => {
        const store = await backend.fresh(keys());
        const handle = await store.register('ios', I, 'ab'.repeat(32));
        expect(await store.lookup(handle)).toEqual({ handleHash: hashHandle(handle), platform: 'ios', instance: I, token: 'ab'.repeat(32) });
        expect(await store.lookup('A'.repeat(43))).toBeNull();
    });

    it('gives every registration a new random handle; earlier ones stay valid', async () => {
        const store = await backend.fresh(keys());
        const a = await store.register('android', I, 'tok');
        const b = await store.register('android', I, 'tok');
        expect(a).toMatch(HANDLE_RE);
        expect(b).toMatch(HANDLE_RE);
        expect(b).not.toBe(a);
        expect((await store.lookup(a))?.token).toBe('tok');
        expect((await store.lookup(b))?.token).toBe('tok');
        expect(await store.count()).toBe(2);
    });

    it('prunes handles not seen since the cutoff; touch keeps one alive', async () => {
        const store = await backend.fresh(keys());
        const old = await store.register('android', I, 'old', 1_000);
        await store.register('android', I, 'new', 5_000);
        const kept = await store.register('android', I, 'kept', 1_000);
        await store.touch(hashHandle(kept), 6_000);
        expect(await store.pruneSeenBefore(2_000)).toBe(1);
        expect(await store.lookup(old)).toBeNull();
        expect(await store.lookup(kept)).not.toBeNull();
        expect(await store.count()).toBe(2);
    });

    it('keeps millisecond timestamps past 2^31 (seen_at is a 64-bit integer)', async () => {
        const store = await backend.fresh(keys());
        const now = Date.UTC(2026, 10, 3);
        const h = await store.register('android', I, 'tok', now);
        expect(await store.pruneSeenBefore(now)).toBe(0);
        expect(await store.pruneSeenBefore(now + 1)).toBe(1);
        expect(await store.lookup(h)).toBeNull();
    });

    it('deletes by hash, once', async () => {
        const store = await backend.fresh(keys());
        const h = await store.register('android', I, 'tok');
        expect(await store.deleteByHash(hashHandle(h))).toBe(true);
        expect(await store.deleteByHash(hashHandle(h))).toBe(false);
        expect(await store.lookup(h)).toBeNull();
    });

    it('keeps registrations across a restart with the same key', async () => {
        const k = keys();
        const before = await backend.fresh(k);
        const handle = await before.register('android', I, 'tok');
        await before.close();
        const after = await backend.reopen(k);
        expect((await after.lookup(handle))?.token).toBe('tok');
    });

    it('treats a row sealed under another RELAY_SECRET_KEY as unknown', async () => {
        const before = await backend.fresh(keys());
        const handle = await before.register('android', I, 'tok');
        const after = await backend.reopen(keys());
        expect(await after.lookup(handle)).toBeNull();
    });

    it('a handle lives by its own seen_at: re-registering the token does not refresh older handles', async () => {
        const store = await backend.fresh(keys());
        const old = await store.register('android', I, 'tok', 1_000);
        const fresh = await store.register('android', I, 'tok', 9_000);
        expect(await store.pruneSeenBefore(2_000)).toBe(1);
        expect(await store.lookup(old)).toBeNull();
        expect(await store.lookup(fresh)).not.toBeNull();
    });

    it('stores neither the handle nor the token or instance in the clear', async () => {
        const store = await backend.fresh(keys());
        const token = 'TOKEN-CANARY-' + 'q'.repeat(60);
        const handle = await store.register('android', 'https://instance-canary.example.com', token);
        const bytes = await backend.raw();
        expect(bytes.length).toBeGreaterThan(0);
        for (const secret of [handle, token, 'TOKEN-CANARY', 'instance-canary']) expect(bytes.includes(Buffer.from(secret))).toBe(false);
        // The row key is the handle's hash.
        expect(bytes.includes(Buffer.from(hashHandle(handle)))).toBe(true);
    });

    describe('renew', () => {
        it('keeps the handle and refreshes its seen_at when platform, instance and token all match', async () => {
            const store = await backend.fresh(keys());
            const h = await store.register('android', I, 'tok', 1_000);
            expect(await store.renew(h, 'android', I, 'tok', 9_000)).toBe(true);
            // seen_at is now 9000, so a prune at 2000 keeps it.
            expect(await store.pruneSeenBefore(2_000)).toBe(0);
            expect(await store.lookup(h)).not.toBeNull();
            expect(await store.count()).toBe(1);
        });

        it('refuses, and changes nothing, for an unknown handle or any mismatch', async () => {
            const store = await backend.fresh(keys());
            const h = await store.register('android', I, 'tok', 1_000);
            const before = await store.lookup(h);
            expect(await store.renew('A'.repeat(43), 'android', I, 'tok', 9_000)).toBe(false);
            expect(await store.renew(h, 'ios', I, 'tok', 9_000)).toBe(false);
            expect(await store.renew(h, 'android', 'https://other.example.com', 'tok', 9_000)).toBe(false);
            expect(await store.renew(h, 'android', I, 'other-token', 9_000)).toBe(false);
            expect(await store.renew(h, 'android', I, 'to', 9_000)).toBe(false);
            expect(await store.lookup(h)).toEqual(before);
            // None of them refreshed seen_at.
            expect(await store.pruneSeenBefore(2_000)).toBe(1);
        });

        it('refuses when the row is deleted between its lookup and its touch (TTL sweep or DELETE)', async () => {
            const store = await backend.fresh(keys());
            const h = await store.register('android', I, 'tok', 1_000);
            // Run the sweep in the gap renew awaits between reading the row and refreshing it.
            const lookup = store.lookup.bind(store);
            let pruned = -1;
            store.lookup = async (handle) => {
                const reg = await lookup(handle);
                pruned = await store.pruneSeenBefore(2_000);
                return reg;
            };
            expect(await store.renew(h, 'android', I, 'tok', 9_000)).toBe(false);
            expect(pruned).toBe(1);
            expect(await lookup(h)).toBeNull();
        });

        it('touch says whether a row was refreshed', async () => {
            const store = await backend.fresh(keys());
            const h = await store.register('android', I, 'tok', 1_000);
            expect(await store.touch(hashHandle(h), 2_000)).toBe(true);
            expect(await store.touch(hashHandle('A'.repeat(43)), 2_000)).toBe(false);
        });

        it('refuses a handle sealed under another RELAY_SECRET_KEY', async () => {
            const before = await backend.fresh(keys());
            const h = await before.register('android', I, 'tok');
            const after = await backend.reopen(keys());
            expect(await after.renew(h, 'android', I, 'tok')).toBe(false);
        });
    });
});

describe.skipIf(!PG_URL)('PgHandleStore', () => {
    const backend = pgBackend();
    beforeAll(() => backend.setup());
    afterEach(() => backend.closeAll());
    afterAll(() => backend.teardown());

    it('gives up on a query stuck behind a locked row instead of hanging the request', async () => {
        const k = keys();
        const store = await backend.fresh(k);
        const h = await store.register('android', I, 'tok', 1_000);
        const short = await PgHandleStore.open(backend.url(), k, { ssl: false, queryTimeoutMs: 300 });
        const locker = new pg.Client({ connectionString: backend.url() });
        await locker.connect();
        try {
            await locker.query('BEGIN');
            await locker.query('SELECT 1 FROM handles WHERE handle_hash = $1 FOR UPDATE', [hashHandle(h)]);
            const started = Date.now();
            await expect(short.touch(hashHandle(h), 9_000)).rejects.toThrow();
            expect(Date.now() - started).toBeLessThan(3_000);
        } finally {
            await locker.query('ROLLBACK');
            await locker.end();
            await short.close();
        }
    }, 10_000);
});

describe('SqliteHandleStore', () => {
    it('still reads rows written by the earlier build, whose handles were HMAC-derived', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'agora-push-relay-'));
        const path = join(dir, 'relay.db');
        const master = randomBytes(32);
        // What 0.1.0 stored for a registration: same table, same seal key and associated data.
        const handleKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'agora-push-relay/handle/v1', 32));
        const oldHandle = createHmac('sha256', handleKey).update(`v1
${I}
tok`).digest('base64url');
        const store = new SqliteHandleStore(path, deriveKeys(master));
        await store.close();
        const db = new DatabaseSync(path);
        db.prepare('INSERT INTO handles (handle_hash, platform, sealed, created_at, seen_at) VALUES (?, ?, ?, ?, ?)').run(
            hashHandle(oldHandle),
            'android',
            seal(deriveKeys(master).sealKey, JSON.stringify({ t: 'tok', i: I }), hashHandle(oldHandle)),
            1,
            1,
        );
        db.close();
        const reopened = new SqliteHandleStore(path, deriveKeys(master));
        expect(await reopened.lookup(oldHandle)).toEqual({ handleHash: hashHandle(oldHandle), platform: 'android', instance: I, token: 'tok' });
        // Registering the same pair now issues a new handle and leaves the old row alone.
        expect(await reopened.register('android', I, 'tok')).not.toBe(oldHandle);
        expect(await reopened.lookup(oldHandle)).not.toBeNull();
        await reopened.close();
        rmSync(dir, { recursive: true, force: true });
    });
});

describe('seal/open', () => {
    it('round-trips and is bound to its row', () => {
        const { sealKey } = deriveKeys(randomBytes(32));
        const blob = seal(sealKey, 'secret', 'row-1');
        expect(open(sealKey, blob, 'row-1')).toBe('secret');
        expect(() => open(sealKey, blob, 'row-2')).toThrow();
        const tampered = Buffer.from(blob);
        tampered[tampered.length - 1] ^= 1;
        expect(() => open(sealKey, tampered, 'row-1')).toThrow();
    });
});

describe('normalizeInstance', () => {
    it.each([
        ['https://agora.example.com', I],
        ['https://AGORA.example.com/', I],
        ['https://agora.example.com:443', I],
        ['https://agora.example.com:8443', 'https://agora.example.com:8443'],
        ['http://agora.example.com', null],
        ['https://agora.example.com/x', null],
        ['https://agora.example.com/?', null],
        ['https://agora.example.com#', null],
        ['https://user@agora.example.com', null],
        ['', null],
    ])('%s -> %s', (input, out) => {
        expect(normalizeInstance(input)).toBe(out);
    });
});

describe('FixedWindowLimiter', () => {
    it('allows `limit` hits per window per key', () => {
        let now = 0;
        const l = new FixedWindowLimiter(2, 60_000, () => now);
        expect(l.take('a').ok).toBe(true);
        expect(l.take('a').ok).toBe(true);
        expect(l.take('a')).toEqual({ ok: false, retryAfter: 60 });
        expect(l.take('b').ok).toBe(true);
        now = 59_000;
        expect(l.take('a')).toEqual({ ok: false, retryAfter: 1 });
        now = 60_000;
        expect(l.take('a').ok).toBe(true);
    });
});
