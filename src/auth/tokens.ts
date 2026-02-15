import jwt from 'jsonwebtoken';

export interface TokenPayload {
    userId: string;
}

export function generateToken(payload: TokenPayload, secret: string): string {
    return jwt.sign(payload, secret);
}

export function verifyToken(token: string, secret: string): TokenPayload {
    return jwt.verify(token, secret) as TokenPayload;
}
