import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export interface EncryptResult {
    encrypted: Buffer;
    iv: Buffer;
    authTag: Buffer;
}

export function encryptFile(plainBuffer: Buffer, key: Buffer): EncryptResult {
    const iv = randomBytes(12); // 96-bit IV for GCM
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag(); // 16 bytes
    return { encrypted, iv, authTag };
}

export function decryptFile(encryptedBuffer: Buffer, key: Buffer, iv: Buffer, authTag: Buffer): Buffer {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
}
