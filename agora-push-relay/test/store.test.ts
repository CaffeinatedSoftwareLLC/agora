import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { HANDLE_RE, deriveKeys, hashHandle, open, seal } from '../src/crypto.js';
import { normalizeInstance } from '../src/origin.js';
import { FixedWindowLimiter } from '../src/rate-limit.js';
import { HandleStore } from '../src/store.js';

const I = 'https://agora.example.com';

describe('HandleStore', () => {
    it('looks a handle up by its hash and decrypts the token and instance', () => {
        const store = new HandleStore(':memory:', deriveKeys(randomBytes(32)));
        const handle = store.register('ios', I, 'ab'.repeat(32));
        expect(store.lookup(handle)).toEqual({ handleHash: hashHandle(handle), platform: 'ios', instance: I, token: 'ab'.repeat(32) });
        expect(store.lookup('A'.repeat(43))).toBeNull();
        store.close();
    });

    it('gives every registration a new random handle; earlier ones stay valid', () => {
        const store = new HandleStore(':memory:', deriveKeys(randomBytes(32)));
        const a = store.register('android', I, 'tok');
        const b = store.register('android', I, 'tok');
        expect(a).toMatch(HANDLE_RE);
        expect(b).toMatch(HANDLE_RE);
        expect(b).not.toBe(a);
        expect(store.lookup(a)?.token).toBe('tok');
        expect(store.lookup(b)?.token).toBe('tok');
        expect(store.count()).toBe(2);
        store.close();
    });

    it('still reads rows written by the earlier build, whose handles were HMAC-derived', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agora-push-relay-'));
        const path = join(dir, 'relay.db');
        const master = randomBytes(32);
        // What 0.1.0 stored for a registration: same table, same seal key and associated data.
        const handleKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'agora-push-relay/handle/v1', 32));
        const oldHandle = createHmac('sha256', handleKey).update(`v1
${I}
tok`).digest('base64url');
        const store = new HandleStore(path, deriveKeys(master));
        store.close();
        const db = new DatabaseSync(path);
        db.prepare('INSERT INTO handles (handle_hash, platform, sealed, created_at, seen_at) VALUES (?, ?, ?, ?, ?)').run(
            hashHandle(oldHandle),
            'android',
            seal(deriveKeys(master).sealKey, JSON.stringify({ t: 'tok', i: I }), hashHandle(oldHandle)),
            1,
            1,
        );
        db.close();
        const reopened = new HandleStore(path, deriveKeys(master));
        expect(reopened.lookup(oldHandle)).toEqual({ handleHash: hashHandle(oldHandle), platform: 'android', instance: I, token: 'tok' });
        // Registering the same pair now issues a new handle and leaves the old row alone.
        expect(reopened.register('android', I, 'tok')).not.toBe(oldHandle);
        expect(reopened.lookup(oldHandle)).not.toBeNull();
        reopened.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('prunes handles not seen since the cutoff; touch keeps one alive', () => {
        const store = new HandleStore(':memory:', deriveKeys(randomBytes(32)));
        const old = store.register('android', I, 'old', 1_000);
        store.register('android', I, 'new', 5_000);
        const kept = store.register('android', I, 'kept', 1_000);
        store.touch(hashHandle(kept), 6_000);
        expect(store.pruneSeenBefore(2_000)).toBe(1);
        expect(store.lookup(old)).toBeNull();
        expect(store.lookup(kept)).not.toBeNull();
        expect(store.count()).toBe(2);
    });

    it('a handle lives by its own seen_at: re-registering the token does not refresh older handles', () => {
        const store = new HandleStore(':memory:', deriveKeys(randomBytes(32)));
        const old = store.register('android', I, 'tok', 1_000);
        const fresh = store.register('android', I, 'tok', 9_000);
        expect(store.pruneSeenBefore(2_000)).toBe(1);
        expect(store.lookup(old)).toBeNull();
        expect(store.lookup(fresh)).not.toBeNull();
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
