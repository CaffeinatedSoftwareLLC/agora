import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';

const TOKEN_EXPIRY = '7d';
/** The only algorithm we sign with, and so the only one verify accepts. */
const ALGORITHM = 'HS256';

export interface TokenPayload {
    userId: string;
    jti?: string;
    tokenVersion?: number;
}

export function generateToken(payload: TokenPayload, secret: string): string {
    const jti = randomBytes(16).toString('hex');
    return jwt.sign({ tokenVersion: 0, ...payload, jti }, secret, { expiresIn: TOKEN_EXPIRY, algorithm: ALGORITHM });
}

export function verifyToken(token: string, secret: string): TokenPayload & { jti: string; exp: number } {
    return jwt.verify(token, secret, { algorithms: [ALGORITHM] }) as TokenPayload & { jti: string; exp: number };
}

/** Extract the raw token string from an Authorization header. */
export function extractToken(authHeader: string | undefined): string | null {
    if (!authHeader?.startsWith('Bearer ')) return null;
    return authHeader.slice(7);
}
