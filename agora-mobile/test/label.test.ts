import { describe, expect, it } from 'vitest';
import { deviceLabel } from '../src/lib/label';

describe('deviceLabel', () => {
    it.each([
        [{ model: 'Pixel 8', manufacturer: 'Google' }, 'android', 'Pixel 8 (Android)'],
        [{ model: 'SM-S918B', manufacturer: 'samsung' }, 'android', 'samsung SM-S918B (Android)'],
        [{ model: 'OnePlus 12', manufacturer: 'OnePlus' }, 'android', 'OnePlus 12 (Android)'],
        [{ name: 'iPhone', model: 'iPhone16,2' }, 'ios', 'iPhone (iOS)'],
        [{ model: 'iPad13,1' }, 'ios', 'iPad (iOS)'],
        [{}, 'android', 'Phone (Android)'],
        [null, 'ios', 'iPhone (iOS)'],
    ] as const)('%j on %s is %s', (info, platform, expected) => {
        expect(deviceLabel(info, platform)).toBe(expected);
    });

    it('strips control characters and caps the length', () => {
        expect(deviceLabel({ model: 'Pix\nel', manufacturer: 'Google' }, 'android')).toBe('Pixel (Android)');
        expect(deviceLabel({ model: 'x'.repeat(200) }, 'android')).toHaveLength(64);
    });
});
