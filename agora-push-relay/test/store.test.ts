import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveKeys, hashHandle, open, seal } from '../src/crypto.js';
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

    it('derives the same handle across restarts with the same key, a different one with another key', () => {
        const key = randomBytes(32);
        const a = new HandleStore(':memory:', deriveKeys(key)).register('android', I, 'tok');
        const b = new HandleStore(':memory:', deriveKeys(key)).register('android', I, 'tok');
        const c = new HandleStore(':memory:', deriveKeys(randomBytes(32))).register('android', I, 'tok');
        expect(b).toBe(a);
        expect(c).not.toBe(a);
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

    it('re-registering refreshes seen_at', () => {
        const store = new HandleStore(':memory:', deriveKeys(randomBytes(32)));
        const h = store.register('android', I, 'tok', 1_000);
        store.register('android', I, 'tok', 9_000);
        expect(store.pruneSeenBefore(2_000)).toBe(0);
        expect(store.lookup(h)).not.toBeNull();
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
