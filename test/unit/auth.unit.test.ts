import { hashPassword, verifyPassword } from '../../src/auth/passwords';
import { generateToken, verifyToken } from '../../src/auth/tokens';

describe('Password Hashing', () => {
    test('produces argon2id hash', async () => {
        const hash = await hashPassword('test-password');
        expect(hash).toMatch(/^\$argon2id\$/);
    });

    test('verifies correct password', async () => {
        const hash = await hashPassword('my-password');
        expect(await verifyPassword('my-password', hash)).toBe(true);
    });

    test('rejects wrong password', async () => {
        const hash = await hashPassword('my-password');
        expect(await verifyPassword('wrong', hash)).toBe(false);
    });
});

describe('JWT', () => {
    test('generates three-segment token', () => {
        const token = generateToken({ userId: 'test-id' }, 'test-secret');
        expect(token.split('.')).toHaveLength(3);
    });

    test('round-trips userId through payload', () => {
        const token = generateToken({ userId: 'abc123' }, 'test-secret');
        const payload = verifyToken(token, 'test-secret');
        expect(payload.userId).toBe('abc123');
    });

    test('rejects tampered token', () => {
        const token = generateToken({ userId: 'abc123' }, 'test-secret');
        const tampered = token.slice(0, -4) + 'XXXX';
        expect(() => verifyToken(tampered, 'test-secret')).toThrow();
    });
});
