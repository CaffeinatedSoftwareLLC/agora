import { createHmac, timingSafeEqual } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'http';
import { config } from '../config';
import { generateSessionToken, generateToken } from './tokens';

/**
 * Browser sessions (issue #77).
 *
 * The login JWT lives in an httpOnly cookie that page scripts can't read. Bots, agent
 * hosts, agora-mcp and API clients keep sending `Authorization` headers and never see
 * these cookies.
 *
 * - `agora_session`: the JWT. httpOnly, Secure, SameSite=Strict, Path=/.
 * - `agora_csrf`: readable by the UI, which echoes it in `X-CSRF-Token` on every
 *   state-changing request. Its value is an HMAC of the session's jti, so it is bound
 *   to that one session: a cookie planted from a sibling host can't produce a valid
 *   pair, and the server keeps no CSRF state.
 *
 * Lifetime: a cookie session dies after SESSION_IDLE_SECONDS (24 h) without a
 * request and SESSION_MAX_SECONDS (30 days) after login. requireAuth re-issues the
 * cookie (same jti, so the CSRF token is unchanged) once it is an hour old.
 *
 * A client opts into cookies by sending `X-Agora-Session: cookie` to the login,
 * register and setup routes. A custom header can't be sent cross-site without a CORS
 * preflight, which this API never grants, so a forged form can't log a victim's
 * browser into the attacker's account either. Without the header those routes reply
 * as before, with the token in the body.
 */
export const SESSION_COOKIE = 'agora_session';
export const CSRF_COOKIE = 'agora_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const SESSION_MODE_HEADER = 'x-agora-session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
    return SAFE_METHODS.has(method.toUpperCase());
}

/** Parse a Cookie header. Later duplicates do not override the first value. */
export function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const name = part.slice(0, eq).trim();
        if (!name || name in out) continue;
        const raw = part.slice(eq + 1).trim();
        try {
            out[name] = decodeURIComponent(raw);
        } catch {
            out[name] = raw;
        }
    }
    return out;
}

export function sessionTokenFromHeaders(headers: IncomingHttpHeaders): string | null {
    return parseCookies(headers.cookie)[SESSION_COOKIE] || null;
}

export function csrfTokenFor(jti: string, secret: string): string {
    return createHmac('sha256', secret).update(`csrf:${jti}`).digest('base64url');
}

/** True when the request carries the CSRF token that belongs to this session. */
export function validCsrf(request: FastifyRequest, jti: string, secret: string): boolean {
    const sent = request.headers[CSRF_HEADER];
    if (typeof sent !== 'string' || !sent) return false;
    const expected = Buffer.from(csrfTokenFor(jti, secret));
    const given = Buffer.from(sent);
    return expected.length === given.length && timingSafeEqual(expected, given);
}

export function wantsCookieSession(request: FastifyRequest): boolean {
    return request.headers[SESSION_MODE_HEADER] === 'cookie';
}

function cookie(name: string, value: string, maxAge: number, httpOnly: boolean): string {
    const parts = [`${name}=${value}`, 'Path=/', `Max-Age=${maxAge}`, 'SameSite=Strict'];
    if (httpOnly) parts.push('HttpOnly');
    if (config.cookieSecure) parts.push('Secure');
    return parts.join('; ');
}

/** Set the session and CSRF cookies for a freshly issued session token expiring at `exp`. */
export function setSessionCookies(reply: FastifyReply, token: string, jti: string, exp: number, secret: string): void {
    const maxAge = Math.max(0, exp - Math.floor(Date.now() / 1000));
    reply.header('set-cookie', [
        cookie(SESSION_COOKIE, token, maxAge, true),
        cookie(CSRF_COOKIE, csrfTokenFor(jti, secret), maxAge, false),
    ]);
}

export function clearSessionCookies(reply: FastifyReply): void {
    reply.header('set-cookie', [
        cookie(SESSION_COOKIE, '', 0, true),
        cookie(CSRF_COOKIE, '', 0, false),
    ]);
}

/**
 * Cross-site WebSocket hijacking guard for cookie-authenticated sockets. Browsers
 * always send Origin on a WebSocket handshake; it must name this host (what the
 * proxies forward as Host) or one of the CORS_ORIGIN values. Non-browser clients
 * send no Origin, and can't hold a browser's cookie anyway.
 */
export function originAllowed(headers: IncomingHttpHeaders): boolean {
    const origin = headers.origin;
    if (!origin) return true;
    const allowed = (config.corsOrigin ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.includes(origin)) return true;
    try {
        return new URL(origin).host === headers.host;
    } catch {
        return false;
    }
}

/**
 * Sign in: a browser that asked for cookies gets a new cookie session (24 h idle,
 * 30-day cap) and no token in the body; anyone else gets a 7-day Bearer token in the
 * body as `accessToken`.
 */
export function deliverToken(
    request: FastifyRequest,
    reply: FastifyReply,
    payload: { userId: string; tokenVersion?: number },
    secret: string,
): { accessToken?: string } {
    if (!wantsCookieSession(request)) return { accessToken: generateToken(payload, secret) };
    const { token, jti, exp } = generateSessionToken(payload, secret);
    setSessionCookies(reply, token, jti, exp, secret);
    return {};
}
