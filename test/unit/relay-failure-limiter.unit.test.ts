import { describe, expect, it } from 'vitest';
import { RelayFailureLimiter } from '../../src/lib/boxes/shell-hub';

describe('relay handshake failure limiter', () => {
    it('blocks an id after its fifth failure in a minute, only that id, and forgets after the window', () => {
        let t = 1_000_000;
        const l = new RelayFailureLimiter(5, 60_000, () => t);
        for (let i = 0; i < 4; i++) { expect(l.blocked('A')).toBe(false); l.fail('A'); t += 1000; }
        expect(l.blocked('A')).toBe(false);
        l.fail('A');
        expect(l.blocked('A')).toBe(true);
        expect(l.blocked('B')).toBe(false);
        t += 56_000;                      // the first failure is now more than a minute old
        expect(l.blocked('A')).toBe(false);
        for (let i = 0; i < 5; i++) l.fail('A');
        expect(l.blocked('A')).toBe(true);
        t += 61_000;
        expect(l.blocked('A')).toBe(false);
    });

    it('stays bounded when many ids fail', () => {
        const t = 5_000;
        const l = new RelayFailureLimiter(5, 60_000, () => t);
        for (let i = 0; i < 12_000; i++) l.fail(`id-${i}`);
        expect((l as any).failures.size).toBeLessThanOrEqual(10_001);
        expect(l.blocked('id-1')).toBe(false);
    });
});
