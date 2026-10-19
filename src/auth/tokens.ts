import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';

/** Lifetime of a login token handed to an API client in the response body (Bearer). */
export const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Browser (cookie) sessions: a session dies after this long without activity. Each
 * cookie-authenticated request renews it (see SESSION_RENEW_AFTER_SECONDS).
 */
export const SESSION_IDLE_SECONDS = 24 * 60 * 60;
/** Browser sessions: hard cap from the original login, however active the user is. */
export const SESSION_MAX_SECONDS = 30 * 24 * 60 * 60;
/**
 * A cookie session is re-issued once its token is older than this, so an active
 * user is not sent a new cookie on every request. Inactivity is therefore measured
 * to within this much: a session can end up to this long before 24 h after the
 * last request, never after.
 */
export const SESSION_RENEW_AFTER_SECONDS = 60 * 60;

/** The only algorithm we sign with, and so the only one verify accepts. */
const ALGORITHM = 'HS256';

export interface TokenPayload {
    userId: string;
    jti?: string;
    tokenVersion?: number;
    /**
     * Unix seconds of the login that started this session. Set on cookie sessions and
     * carried through renewals, so SESSION_MAX_SECONDS holds.
     */
    authTime?: number;
}

export type VerifiedToken = TokenPayload & { jti: string; exp: number; iat: number };

export function generateToken(payload: TokenPayload, secret: string): string {
    const jti = randomBytes(16).toString('hex');
    return jwt.sign({ tokenVersion: 0, ...payload, jti }, secret, { expiresIn: TOKEN_TTL_SECONDS, algorithm: ALGORITHM });
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

/** Absolute end of a cookie session (login time + SESSION_MAX_SECONDS). */
export function sessionHardExpiry(payload: { authTime?: number; iat: number }): number {
    return (payload.authTime ?? payload.iat) + SESSION_MAX_SECONDS;
}

/**
 * Sign a browser session token. A new session starts now; a renewal keeps the
 * session's jti (so its CSRF token and any blacklist entry still apply) and its
 * login time, and gets a fresh idle window clipped to the absolute cap.
 */
export function generateSessionToken(
    payload: { userId: string; tokenVersion?: number },
    secret: string,
    renew?: { jti: string; authTime: number },
): { token: string; jti: string; exp: number } {
    const now = nowSeconds();
    const authTime = renew?.authTime ?? now;
    const jti = renew?.jti ?? randomBytes(16).toString('hex');
    const exp = Math.min(now + SESSION_IDLE_SECONDS, authTime + SESSION_MAX_SECONDS);
    const token = jwt.sign(
        { tokenVersion: 0, ...payload, authTime, jti, iat: now, exp },
        secret,
        { algorithm: ALGORITHM },
    );
    return { token, jti, exp };
}

/**
 * Why a cookie session may no longer be used, or null. `exp` is already checked by
 * verifyToken; this also covers cookies issued before the idle limit existed (7-day
 * tokens with no authTime), whose iat is the last time they were issued.
 */
export function sessionLimitError(payload: { authTime?: number; iat: number }): string | null {
    const now = nowSeconds();
    if (now >= payload.iat + SESSION_IDLE_SECONDS) return 'session_idle_timeout';
    if (now >= sessionHardExpiry(payload)) return 'session_expired';
    return null;
}

/** When a cookie session ends if nothing renews it (ms since epoch). */
export function sessionEndsAt(payload: { authTime?: number; iat: number; exp: number }): number {
    return Math.min(payload.exp, payload.iat + SESSION_IDLE_SECONDS, sessionHardExpiry(payload)) * 1000;
}

/** True when a cookie session's token is old enough to be re-issued and doing so extends it. */
export function sessionNeedsRenewal(payload: { authTime?: number; iat: number; exp: number }): boolean {
    const now = nowSeconds();
    if (now - payload.iat < SESSION_RENEW_AFTER_SECONDS) return false;
    return Math.min(now + SESSION_IDLE_SECONDS, sessionHardExpiry(payload)) * 1000 > sessionEndsAt(payload);
}

export function verifyToken(token: string, secret: string): VerifiedToken {
    return jwt.verify(token, secret, { algorithms: [ALGORITHM] }) as VerifiedToken;
}

/** Extract the raw token string from an Authorization header. */
export function extractToken(authHeader: string | undefined): string | null {
    if (!authHeader?.startsWith('Bearer ')) return null;
    return authHeader.slice(7);
}
