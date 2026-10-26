import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/** A push handle: 32 bytes as unpadded base64url (43 characters). */
export const HANDLE_RE = /^[A-Za-z0-9_-]{43}$/;

export interface Keys {
    /** AES-256-GCM key for the sealed device token and instance origin. */
    sealKey: Buffer;
}

/**
 * Derives the subkeys from the one master key in RELAY_SECRET_KEY (HKDF-SHA256). The info
 * string is unchanged since v1, so rows sealed by earlier builds still open.
 */
export function deriveKeys(master: Buffer): Keys {
    if (master.length !== 32) throw new Error('master key must be 32 bytes');
    const sub = (info: string) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
    return { sealKey: sub('agora-push-relay/seal/v1') };
}

/**
 * A new handle: 32 random bytes, unpadded base64url. It is not derived from the device
 * token or the instance, so knowing a token does not let anyone work out, or be handed,
 * the handle another instance holds for it.
 */
export function newHandle(): string {
    return randomBytes(32).toString('base64url');
}

/** What the relay stores and looks up by: SHA-256 of the handle, hex. */
export function hashHandle(handle: string): string {
    return createHash('sha256').update(handle).digest('hex');
}

/** AES-256-GCM; the result is iv (12) | tag (16) | ciphertext. `aad` binds it to its row. */
export function seal(key: Buffer, plaintext: string, aad: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function open(key: Buffer, blob: Uint8Array, aad: string): string {
    const buf = Buffer.from(blob);
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/** base64url of a JSON value, for JWTs. */
export function b64urlJson(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}
