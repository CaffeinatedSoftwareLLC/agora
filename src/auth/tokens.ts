import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';

const TOKEN_EXPIRY = '7d';

export interface TokenPayload {
    userId: string;
    jti?: string;
}

export function generateToken(payload: TokenPayload, secret: string): string {
    const jti = randomBytes(16).toString('hex');
    return jwt.sign({ ...payload, jti }, secret, { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token: string, secret: string): TokenPayload & { jti: string; exp: number } {
    return jwt.verify(token, secret) as TokenPayload & { jti: string; exp: number };
}

/** Extract the raw token string from an Authorization header. */
export function extractToken(authHeader: string | undefined): string | null {
    if (!authHeader?.startsWith('Bearer ')) return null;
    return authHeader.slice(7);
}
