import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature, type webcrypto } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';

type JsonWebKey = webcrypto.JsonWebKey;

/**
 * Sign in with ChatGPT, open-source token sharing (docs/codex-chatgpt-plan.md), exactly as
 * OpenAI documents it:
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 *
 * - Authorization code + PKCE (S256) in the system browser, fresh state, nonce and verifier
 *   per attempt, a loopback callback on http://127.0.0.1:<port>/auth/callback (never
 *   "localhost"), scope `openid profile email offline_access resource.invoke
 *   chatgpt.tokens.use.direct`, resource https://api.openai.com/v1.
 * - First registration uses client_id=dynamic_agent_client with agent_name_hint=Agora and the
 *   host's stable ext_agent_host_id; the callback returns the issued `oaiapp_…` client_id, which
 *   is saved and used for the token exchange and every later sign-in (without agent_name_hint).
 * - No client secret. The ID token is verified against OpenAI's JWKS (RS256, issuer, audience
 *   = issued client id, expiry, nonce), and plan use needs the granted
 *   `chatgpt.tokens.use.direct` scope; a valid ID token alone does not grant it.
 *
 * Nothing here logs or returns a token in an error message.
 */

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const DYNAMIC_CLIENT = 'dynamic_agent_client';
export const AGENT_NAME = 'Agora';
export const CALLBACK_PATH = '/auth/callback';
export const USAGE_URL = 'https://chatgpt.com/settings/usage';

/** A sign-in failure. `code` is fixed text, safe to print and to send to Agora. */
export class SiwcError extends Error {
    constructor(public readonly code: string, message: string, public readonly retryable = false) { super(message); }
}

export interface OAuthEnv {
    /** Injected in tests; never real network there. */
    fetch?: typeof fetch;
    issuer?: string;
    now?: () => number;
}

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; revocation_endpoint?: string; jwks_uri: string }

const random = () => randomBytes(32).toString('base64url');

/** PKCE verifier and its S256 challenge (base64url, no padding). */
export function pkce(): { verifier: string; challenge: string } {
    const verifier = random();
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Fresh per-attempt values: state, OIDC nonce and the PKCE pair. */
export function attemptSecrets() {
    return { state: random(), nonce: random(), ...pkce() };
}

async function readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length > 256 * 1024) throw new SiwcError('invalid_response', 'ChatGPT returned an oversized response.');
    try { return text ? JSON.parse(text) : null; } catch { return null; }
}
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const discoveries = new Map<string, Promise<Discovery>>();
/** OpenID configuration; every endpoint must be on the issuer's own origin. */
export async function discover(env: OAuthEnv = {}): Promise<Discovery> {
    const issuer = env.issuer ?? ISSUER;
    const f = env.fetch ?? fetch;
    const key = issuer + (env.fetch ? ':injected' : '');
    let found = env.fetch ? undefined : discoveries.get(key);
    if (!found) {
        found = (async () => {
            let response: Response;
            try { response = await f(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000), redirect: 'error' }); }
            catch { throw new SiwcError('network_error', 'ChatGPT sign-in could not be reached.', true); }
            const data = await readJson(response);
            if (!response.ok || !isObject(data) || data.issuer !== issuer) throw new SiwcError('discovery_failed', 'ChatGPT sign-in configuration could not be verified.', true);
            for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
                const v = data[k];
                if (k === 'revocation_endpoint' && v === undefined) continue;
                if (typeof v !== 'string' || new URL(v).origin !== new URL(issuer).origin)
                    throw new SiwcError('discovery_failed', 'ChatGPT sign-in configuration could not be verified.', true);
            }
            return data as unknown as Discovery;
        })();
        if (!env.fetch) { discoveries.set(key, found); found.catch(() => discoveries.delete(key)); }
    }
    return found;
}

export interface AuthorizeParams {
    authorizationEndpoint: string;
    /** The saved issued client id, or undefined for a first registration. */
    clientId?: string;
    hostId: string;
    redirectUri: string;
    state: string; nonce: string; challenge: string;
    /** Saved email from the account's validated ID token. */
    loginHint?: string;
    /** Ask for consent again, e.g. to enable plan use after an earlier decline. */
    reconsent?: boolean;
}

/** The browser URL for one attempt. Never carries a token (no id_token_hint: URLs reach process args). */
export function authorizeUrl(p: AuthorizeParams): string {
    const url = new URL(p.authorizationEndpoint);
    const q = new URLSearchParams({
        client_id: p.clientId ?? DYNAMIC_CLIENT,
        response_type: 'code',
        redirect_uri: p.redirectUri,
        scope: SCOPES,
        resource: RESOURCE,
        state: p.state,
        nonce: p.nonce,
        code_challenge_method: 'S256',
        code_challenge: p.challenge,
        ext_agent_host_id: p.hostId,
    });
    // agent_name_hint only on the first, dynamic registration
    if (!p.clientId) q.set('agent_name_hint', AGENT_NAME);
    if (p.loginHint) q.set('login_hint', p.loginHint);
    if (p.reconsent) q.set('prompt', 'consent');
    url.search = q.toString();
    return url.toString();
}

export interface CallbackResult { code: string; clientId: string }
export interface Listener { redirectUri: string; port: number; result: Promise<CallbackResult>; close(): void }

const CLIENT_ID = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Validate one callback request. Returns null for a request that must not consume the
 * attempt (wrong path/host/state), else the outcome.
 */
export function checkCallback(rawUrl: string, hostHeader: string | undefined, port: number, state: string, savedClientId: string | undefined):
    { status: number; outcome: CallbackResult | SiwcError | null } {
    let url: URL;
    try { url = new URL(rawUrl, `http://127.0.0.1:${port}`); } catch { return { status: 400, outcome: null }; }
    // Exact redirect: 127.0.0.1, this port, /auth/callback ("/callback" or "localhost" don't match)
    if (hostHeader !== `127.0.0.1:${port}` || url.origin !== `http://127.0.0.1:${port}` || url.pathname !== CALLBACK_PATH) return { status: 404, outcome: null };
    const returned = Buffer.from(url.searchParams.get('state') ?? '');
    const expected = Buffer.from(state);
    if (url.searchParams.getAll('state').length !== 1 || returned.length !== expected.length || !timingSafeEqual(returned, expected))
        return { status: 400, outcome: null };
    const error = url.searchParams.get('error');
    if (error) {
        return { status: 200, outcome: error === 'access_denied'
            ? new SiwcError('consent_declined', 'ChatGPT sign-in was declined.')
            : new SiwcError('authorization_failed', 'ChatGPT sign-in did not complete.') };
    }
    const code = url.searchParams.get('code');
    const returnedClient = url.searchParams.get('client_id');
    const clientId = returnedClient ?? savedClientId;
    if (!code || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('client_id').length > 1
        || !clientId || !CLIENT_ID.test(clientId) || clientId === DYNAMIC_CLIENT
        // A reauthorization that comes back with another client id must not replace the registration
        || (savedClientId !== undefined && returnedClient !== null && returnedClient !== savedClientId))
        return { status: 200, outcome: new SiwcError('registration_incomplete', 'ChatGPT did not complete app registration. Try signing in again.') };
    return { status: 200, outcome: { code, clientId } };
}

const PAGE = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Return to Agora</title>'
    + '<style>body{font:17px system-ui;max-width:32rem;margin:18vh auto;padding:24px}</style>'
    + '<h1>Return to Agora</h1><p>The agent host is finishing your ChatGPT connection. You can close this tab.</p></html>';

/** Start the loopback listener before the browser opens. Port 0 picks a free one. */
export async function listenForCallback(port: number, state: string, savedClientId: string | undefined, timeoutMs = 300000): Promise<Listener> {
    let finish!: (v: CallbackResult | SiwcError) => void;
    let settled = false;
    const result = new Promise<CallbackResult>((resolve, reject) => {
        finish = v => { if (settled) return; settled = true; if (v instanceof SiwcError) reject(v); else resolve(v); };
    });
    result.catch(() => undefined);
    let bound = port;
    const handler: RequestListener = (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
        if (req.method !== 'GET' || settled) { res.writeHead(404).end('Not found'); return; }
        const { status, outcome } = checkCallback(req.url ?? '/', req.headers.host, bound, state, savedClientId);
        if (!outcome) { res.writeHead(status).end(status === 400 ? 'Invalid sign-in state. Return to the tab that started sign-in.' : 'Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
        finish(outcome);
    };
    const server = createServer(handler);
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen({ port, host: '127.0.0.1' }, () => {
                server.removeListener('error', reject);
                const address = server.address();
                if (address && typeof address !== 'string') bound = address.port;
                resolve();
            });
        });
    } catch { throw new SiwcError('callback_port_unavailable', 'The sign-in port is in use. Close the other sign-in or pick another callbackPort.'); }
    const timer = setTimeout(() => finish(new SiwcError('sign_in_timeout', 'ChatGPT sign-in timed out.')), timeoutMs);
    const close = () => { clearTimeout(timer); finish(new SiwcError('cancelled', 'Sign-in was cancelled.')); server.close(); server.closeAllConnections(); };
    return { redirectUri: `http://127.0.0.1:${bound}${CALLBACK_PATH}`, port: bound, result, close };
}

/** An OAuth error from the token endpoint, mapped to a fixed code. */
function tokenError(data: unknown, status: number): SiwcError {
    const raw = isObject(data) ? (typeof data.error === 'string' ? data.error : isObject(data.error) && typeof data.error.code === 'string' ? data.error.code : '') : '';
    const code = /^[a-z][a-z0-9_]{0,63}$/.test(raw) ? raw : `http_${status}`;
    return new SiwcError(code, 'ChatGPT rejected the token request.', status >= 500);
}

export async function tokenRequest(endpoint: string, body: URLSearchParams, env: OAuthEnv = {}): Promise<Record<string, unknown>> {
    let response: Response;
    try {
        response = await (env.fetch ?? fetch)(endpoint, {
            method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body, redirect: 'error', signal: AbortSignal.timeout(30000),
        });
    } catch { throw new SiwcError('network_error', 'ChatGPT sign-in could not be reached.', true); }
    const data = await readJson(response);
    if (!response.ok) throw tokenError(data, response.status);
    if (!isObject(data)) throw new SiwcError('invalid_token_response', 'ChatGPT returned an invalid token response.');
    return data;
}

export interface TokenSet {
    accessToken: string; refreshToken?: string; idToken?: string;
    tokenType: string; expiresIn: number; expiresAt: number; scopes: string[];
    earliestRefreshAt?: string | number;
}

/** Check a token response: Bearer, positive expiry, a refresh token with offline_access, granted scopes. */
export function tokenFields(data: Record<string, unknown>, now: number, previousScopes?: string[]): TokenSet {
    const scopeText = typeof data.scope === 'string' ? data.scope : previousScopes?.join(' ');
    if (typeof scopeText !== 'string') throw new SiwcError('invalid_token_response', 'ChatGPT did not confirm the granted permissions.');
    const scopes = scopeText.split(/\s+/).filter(Boolean);
    if (typeof data.access_token !== 'string' || !data.access_token
        || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'
        || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0
        || (scopes.includes('offline_access') && (typeof data.refresh_token !== 'string' || !data.refresh_token)))
        throw new SiwcError('invalid_token_response', 'ChatGPT returned incomplete credentials.');
    return {
        accessToken: data.access_token, tokenType: 'Bearer', expiresIn: data.expires_in, expiresAt: now + data.expires_in * 1000, scopes,
        ...(typeof data.refresh_token === 'string' && data.refresh_token ? { refreshToken: data.refresh_token } : {}),
        ...(typeof data.id_token === 'string' && data.id_token ? { idToken: data.id_token } : {}),
        ...(typeof data.earliest_refresh_at === 'string' || typeof data.earliest_refresh_at === 'number' ? { earliestRefreshAt: data.earliest_refresh_at } : {}),
    };
}

const jwksCache = new Map<string, { keys: JsonWebKey[]; at: number }>();
async function jwks(uri: string, env: OAuthEnv, refresh: boolean): Promise<JsonWebKey[]> {
    const cached = env.fetch ? undefined : jwksCache.get(uri);
    if (cached && !refresh && Date.now() - cached.at < 3600_000) return cached.keys;
    let response: Response;
    try { response = await (env.fetch ?? fetch)(uri, { signal: AbortSignal.timeout(15000), redirect: 'error' }); }
    catch { throw new SiwcError('identity_verification_unavailable', 'ChatGPT identity verification is unavailable; try again shortly.', true); }
    const data = await readJson(response);
    if (response.status !== 200 || !isObject(data) || !Array.isArray(data.keys))
        throw new SiwcError('identity_verification_unavailable', 'ChatGPT identity verification is unavailable; try again shortly.', true);
    const keys = data.keys as JsonWebKey[];
    if (!env.fetch) jwksCache.set(uri, { keys, at: Date.now() });
    return keys;
}

export interface Identity { subject: string; email?: string; name?: string }

/**
 * Verify an ID token: RS256 signature against the issuer's JWKS, iss, aud = issued client id
 * (and azp when present), exp/iat with 5 s tolerance, sub, and the attempt's nonce.
 */
export async function verifyIdToken(idToken: string, clientId: string, nonce: string | undefined, env: OAuthEnv = {}): Promise<Identity> {
    const invalid = () => new SiwcError('invalid_id_token', 'The ChatGPT identity could not be verified. Sign in again.');
    const parts = idToken.split('.');
    if (parts.length !== 3) throw invalid();
    let header: any, payload: any;
    try {
        header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { throw invalid(); }
    if (header?.alg !== 'RS256' || !isObject(payload)) throw invalid();
    const config = await discover(env);
    const pick = (keys: JsonWebKey[]) => keys.find(k => k.kty === 'RSA' && (header.kid === undefined || (k as any).kid === header.kid) && ((k as any).use === undefined || (k as any).use === 'sig'));
    let jwk = pick(await jwks(config.jwks_uri, env, false));
    if (!jwk) jwk = pick(await jwks(config.jwks_uri, env, true));
    if (!jwk) throw new SiwcError('identity_verification_unavailable', 'ChatGPT identity verification is unavailable; try again shortly.', true);
    let ok = false;
    try {
        ok = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    } catch { throw invalid(); }
    if (!ok) throw invalid();
    const now = Math.floor((env.now ?? Date.now)() / 1000);
    const aud = payload.aud;
    const audOk = typeof aud === 'string' ? aud === clientId : Array.isArray(aud) && aud.includes(clientId) && (aud.length === 1 || payload.azp === clientId);
    if (payload.iss !== config.issuer || !audOk || (payload.azp !== undefined && payload.azp !== clientId)
        || typeof payload.exp !== 'number' || payload.exp + 5 < now || typeof payload.iat !== 'number' || payload.iat - 5 > now
        || typeof payload.sub !== 'string' || !payload.sub
        || (nonce !== undefined && payload.nonce !== nonce)) throw invalid();
    return {
        subject: payload.sub,
        ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
        ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
    };
}

/** Revoke the renewable session (refresh token). An empty 200 is success, even for an already-invalid token. */
export async function revoke(refreshToken: string, clientId: string, env: OAuthEnv = {}): Promise<boolean> {
    let config: Discovery;
    try { config = await discover(env); } catch { return false; }
    if (!config.revocation_endpoint) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await (env.fetch ?? fetch)(config.revocation_endpoint, {
                method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'error',
                body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }),
                signal: AbortSignal.timeout(10000),
            });
            await response.body?.cancel().catch(() => undefined);
            if (response.status === 200) return true;
            if (response.status < 500) return false;
        } catch { /* network: retry with backoff */ }
        await new Promise(r => setTimeout(r, 300 * 2 ** attempt));
    }
    return false;
}

/** Refresh errors that mean the refresh token is unusable: sign in again. */
export const UNUSABLE_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
