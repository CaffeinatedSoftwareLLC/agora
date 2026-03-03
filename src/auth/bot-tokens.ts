import { randomBytes } from 'crypto';
import { generateUlid } from '../utils/ulid';
import { hashPassword, verifyPassword } from './passwords';

/**
 * Token format: bot_<tokenId>.<secret>
 * - tokenId is a ULID (26 chars) used as PK for O(1) lookup
 * - secret is 32 random bytes (hex-encoded, 64 chars) verified with Argon2
 */

export interface ParsedBotToken {
    tokenId: string;
    secret: string;
}

export function parseBotToken(raw: string): ParsedBotToken | null {
    if (!raw.startsWith('bot_')) return null;

    const dotIndex = raw.indexOf('.');
    if (dotIndex === -1) return null;

    const tokenId = raw.slice(4, dotIndex);
    if (!tokenId) return null;

    const secret = raw.slice(dotIndex + 1);
    if (!secret) return null;

    return { tokenId, secret };
}

export async function generateBotToken(): Promise<{
    tokenId: string;
    secret: string;
    secretHash: string;
    raw: string;
}> {
    const tokenId = generateUlid();
    const secret = randomBytes(32).toString('hex');
    const secretHash = await hashPassword(secret);
    const raw = `bot_${tokenId}.${secret}`;

    return { tokenId, secret, secretHash, raw };
}

export async function verifyBotSecret(secret: string, hash: string): Promise<boolean> {
    return verifyPassword(secret, hash);
}
