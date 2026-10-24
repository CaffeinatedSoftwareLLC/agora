import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/** A push handle: 32 bytes as unpadded base64url (43 characters). */
export const HANDLE_RE = /^[A-Za-z0-9_-]{43}$/;

export interface Keys {
    /** AES-256-GCM key for the sealed device token and instance origin. */
    sealKey: Buffer;
    /** HMAC-SHA256 key the handle is derived with. */
    handleKey: Buffer;
}

/** Splits the one master key from RELAY_SECRET_KEY into independent subkeys (HKDF-SHA256). */
export function deriveKeys(master: Buffer): Keys {
    if (master.length !== 32) throw new Error('master key must be 32 bytes');
    const sub = (info: string) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
    return { sealKey: sub('agora-push-relay/seal/v1'), handleKey: sub('agora-push-relay/handle/v1') };
}

/**
 * The handle for a (instance, token) pair. It is deterministic, so registering the same
 * token for the same instance again returns the same handle without the relay ever
 * storing the handle itself. Without the key it is indistinguishable from 32 random bytes.
 * Neither input can contain a newline (the origin is URL-normalised, the token is
 * printable ASCII), so the encoding is unambiguous.
 */
export function deriveHandle(handleKey: Buffer, instance: string, token: string): string {
    return createHmac('sha256', handleKey).update(`v1\n${instance}\n${token}`).digest('base64url');
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
