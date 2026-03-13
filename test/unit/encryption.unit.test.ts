import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import { encryptString, decryptString } from '../../src/lib/encryption';

describe('encryptString / decryptString', () => {
    const key = randomBytes(32);

    it('round-trips correctly', () => {
        const plaintext = 'sk-ant-api03-test-key-12345';
        const { encrypted, iv, authTag } = encryptString(plaintext, key);
        const decrypted = decryptString(encrypted, key, iv, authTag);
        expect(decrypted).toBe(plaintext);
    });

    it('handles empty string', () => {
        const { encrypted, iv, authTag } = encryptString('', key);
        const decrypted = decryptString(encrypted, key, iv, authTag);
        expect(decrypted).toBe('');
    });

    it('handles unicode', () => {
        const plaintext = 'API key with unicode: \u{1F511}';
        const { encrypted, iv, authTag } = encryptString(plaintext, key);
        const decrypted = decryptString(encrypted, key, iv, authTag);
        expect(decrypted).toBe(plaintext);
    });

    it('throws with wrong key', () => {
        const plaintext = 'secret';
        const { encrypted, iv, authTag } = encryptString(plaintext, key);
        const wrongKey = randomBytes(32);
        expect(() => decryptString(encrypted, wrongKey, iv, authTag)).toThrow();
    });

    it('throws with tampered ciphertext', () => {
        const plaintext = 'secret';
        const { encrypted, iv, authTag } = encryptString(plaintext, key);
        // Tamper with the encrypted data
        const tampered = 'ff' + encrypted.slice(2);
        expect(() => decryptString(tampered, key, iv, authTag)).toThrow();
    });

    it('produces different ciphertexts for same plaintext (random IV)', () => {
        const plaintext = 'same input';
        const a = encryptString(plaintext, key);
        const b = encryptString(plaintext, key);
        expect(a.encrypted).not.toBe(b.encrypted);
        expect(a.iv).not.toBe(b.iv);
    });
});
