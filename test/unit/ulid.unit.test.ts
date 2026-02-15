import { generateUlid } from '../../src/utils/ulid';

describe('ULID', () => {
    test('26-char Crockford base32, monotonic pair sorts correctly', () => {
        const a = generateUlid();
        const b = generateUlid();

        expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(b).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        // Monotonic factory guarantees this even within same millisecond
        expect(a < b).toBe(true);
    });
});
