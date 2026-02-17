import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export function normalizeIp(ip: string): string {
    // Strip IPv4-mapped IPv6 prefix (::ffff:)
    let normalized = ip;
    if (normalized.startsWith('::ffff:')) {
        normalized = normalized.slice(7);
    }
    // Normalize IPv6 loopback to IPv4 loopback
    if (normalized === '::1') {
        normalized = '127.0.0.1';
    }
    return normalized;
}

export function hmacIp(ip: string, key: Buffer): string {
    const normalized = normalizeIp(ip);
    return createHmac('sha256', key).update(normalized).digest('hex');
}

export function encryptIp(ip: string, key: Buffer): string {
    const normalized = normalizeIp(ip);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptIp(encoded: string, key: Buffer): string | null {
    try {
        const [ivHex, authTagHex, ciphertextHex] = encoded.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const ciphertext = Buffer.from(ciphertextHex, 'hex');
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return decrypted.toString('utf8');
    } catch {
        return null;
    }
}
