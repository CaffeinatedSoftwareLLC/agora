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

export function encryptString(plaintext: string, key: Buffer): { encrypted: string; iv: string; authTag: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { encrypted: encrypted.toString('hex'), iv: iv.toString('hex'), authTag: authTag.toString('hex') };
}

export function decryptString(encrypted: string, key: Buffer, iv: string, authTag: string): string {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString('utf8');
}
