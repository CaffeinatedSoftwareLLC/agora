import {
    attemptSecrets, authorizeUrl, discover, listenForCallback, PLAN_SCOPE, RESOURCE, revoke, SiwcError, tokenFields, tokenRequest,
    UNUSABLE_REFRESH, verifyIdToken, type OAuthEnv,
} from './oauth.js';
import { clearTokens, hostId, readRecord, saveRegistration, withLock, writeRecord, type CredentialRecord } from './store.js';

/**
 * One profile's ChatGPT plan connection on this host: sign in, keep the access token fresh,
 * sign out (https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).
 */

export interface SessionOptions extends OAuthEnv {
    dir: string;
    profile: string;
}

export interface LoginOptions extends SessionOptions {
    /** Loopback port for the callback; 0 picks a free one. Falls back to a free port when taken. */
    port: number;
    openBrowser(url: string): Promise<void>;
    /** The Agora user who asked for this sign-in from Settings → Agents, if any. */
    agoraUserId?: string;
    reconsent?: boolean;
    timeoutMs?: number;
}

export type PlanState = 'not_connected' | 'connected' | 'scope_missing' | 'reauth_required';

export interface LoginResult { state: 'connected' | 'scope_missing'; email: string | null; record: CredentialRecord }

/**
 * Run Sign in with ChatGPT in the system browser and save the credentials. Resolves
 * 'scope_missing' when the person signed in but didn't allow plan use: the sign-in is kept,
 * and no run will use it until they allow it.
 */
export async function login(o: LoginOptions): Promise<LoginResult> {
    const host = await hostId(o.dir);
    const previous = await readRecord(o.dir, o.profile);
    const savedClient = previous?.client_id || undefined;
    const config = await discover(o);
    const secrets = attemptSecrets();
    let listener;
    try { listener = await listenForCallback(o.port, secrets.state, savedClient, o.timeoutMs); }
    catch (err) {
        if (!(err instanceof SiwcError) || o.port === 0) throw err;
        // Only the port may vary between sign-ins; take any free one
        listener = await listenForCallback(0, secrets.state, savedClient, o.timeoutMs);
    }
    try {
        await o.openBrowser(authorizeUrl({
            authorizationEndpoint: config.authorization_endpoint, clientId: savedClient, hostId: host,
            redirectUri: listener.redirectUri, state: secrets.state, nonce: secrets.nonce, challenge: secrets.challenge,
            loginHint: previous?.email, reconsent: o.reconsent,
        }));
        const callback = await listener.result;
        // Keep the issued client id even if the one-time code fails, so a retry doesn't register again
        await saveRegistration(o.dir, o.profile, host, callback.clientId);
        let data: Record<string, unknown>;
        try {
            data = await tokenRequest(config.token_endpoint, new URLSearchParams({
                grant_type: 'authorization_code', client_id: callback.clientId, code: callback.code,
                code_verifier: secrets.verifier, redirect_uri: listener.redirectUri, resource: RESOURCE,
            }), o);
        } catch (err) {
            if (err instanceof SiwcError && err.code === 'invalid_grant') throw new SiwcError('invalid_grant', 'The sign-in code expired. Sign in again.');
            throw err;
        }
        const now = (o.now ?? Date.now)();
        const tokens = tokenFields(data, now);
        if (!tokens.idToken) throw new SiwcError('invalid_id_token', 'ChatGPT did not return a verifiable identity.');
        const identity = await verifyIdToken(tokens.idToken, callback.clientId, secrets.nonce, o);
        if (previous?.subject && previous.subject !== identity.subject)
            throw new SiwcError('account_mismatch', 'This sign-in returned a different ChatGPT account than the one saved for this profile.');
        const sameAccount = previous?.subject === identity.subject;
        const record: CredentialRecord = {
            version: 1, issuer: config.issuer, subject: identity.subject, ...(identity.email ? { email: identity.email } : {}),
            client_id: callback.clientId, ext_agent_host_id: host,
            id_token: tokens.idToken, access_token: tokens.accessToken, ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
            token_type: tokens.tokenType, expires_in: tokens.expiresIn, expires_at: tokens.expiresAt,
            ...(tokens.earliestRefreshAt !== undefined ? { earliest_refresh_at: tokens.earliestRefreshAt } : {}),
            scopes: tokens.scopes, saved_at: new Date(now).toISOString(),
            ...(o.agoraUserId ? { agora_user_id: o.agoraUserId } : sameAccount && previous?.agora_user_id ? { agora_user_id: previous.agora_user_id } : {}),
        };
        await writeRecord(o.dir, o.profile, record);
        return { state: tokens.scopes.includes(PLAN_SCOPE) ? 'connected' : 'scope_missing', email: identity.email ?? null, record };
    } finally { listener.close(); }
}

export async function planState(o: SessionOptions): Promise<{ state: PlanState; email: string | null; agoraUserId: string | null }> {
    const r = await readRecord(o.dir, o.profile);
    const email = r?.email ?? null; const agoraUserId = r?.agora_user_id ?? null;
    if (!r?.access_token) return { state: r?.subject ? 'reauth_required' : 'not_connected', email, agoraUserId };
    if (!r.scopes.includes(PLAN_SCOPE)) return { state: 'scope_missing', email, agoraUserId };
    return { state: 'connected', email, agoraUserId };
}

/** Remember which Agora user the server bound this plan to. */
export async function bindAgoraUser(o: SessionOptions, agoraUserId: string): Promise<void> {
    await withLock(o.dir, o.profile, async () => {
        const r = await readRecord(o.dir, o.profile);
        if (r && r.agora_user_id !== agoraUserId) await writeRecord(o.dir, o.profile, { ...r, agora_user_id: agoraUserId });
    });
}

export interface AccessToken { accessToken: string; expiresAt: number; agoraUserId: string | null }

/**
 * A usable access token for a run. Refreshes it (rotating the refresh token, serialised
 * across processes) when it expires within `minValidityMs` or when `force` is set after a 401.
 */
export async function accessToken(o: SessionOptions & { minValidityMs?: number; force?: boolean }): Promise<AccessToken> {
    return withLock(o.dir, o.profile, async () => {
        const r = await readRecord(o.dir, o.profile);
        if (!r?.access_token) throw new SiwcError(r?.subject ? 'siwc_reauth_required' : 'siwc_not_connected', 'This profile is not signed in to ChatGPT.');
        if (!r.scopes.includes(PLAN_SCOPE)) throw new SiwcError('siwc_scope_missing', 'ChatGPT plan use was not allowed for this sign-in.');
        const now = (o.now ?? Date.now)();
        const minValidity = o.minValidityMs ?? 10 * 60_000;
        if (!o.force && (r.expires_at ?? 0) - now > minValidity) return { accessToken: r.access_token, expiresAt: r.expires_at!, agoraUserId: r.agora_user_id ?? null };
        if (!r.refresh_token) { await clearTokens(o.dir, o.profile); throw new SiwcError('siwc_reauth_required', 'The ChatGPT sign-in expired.'); }
        const config = await discover(o);
        let data: Record<string, unknown>;
        try {
            data = await tokenRequest(config.token_endpoint, new URLSearchParams({
                grant_type: 'refresh_token', client_id: r.client_id, refresh_token: r.refresh_token, resource: RESOURCE,
            }), o);
        } catch (err) {
            if (err instanceof SiwcError && (UNUSABLE_REFRESH.has(err.code) || err.code === 'invalid_client')) {
                // Unusable refresh token: clear the tokens; the registration stays for the next sign-in
                await clearTokens(o.dir, o.profile);
                throw new SiwcError('siwc_reauth_required', 'The ChatGPT sign-in expired or was disconnected.');
            }
            // Network or 5xx: keep the credentials
            throw new SiwcError('siwc_refresh_unavailable', 'ChatGPT token refresh is unavailable right now.', true);
        }
        // OAuth may omit scope on refresh when the grant is unchanged
        const tokens = tokenFields(data, now, r.scopes);
        if (tokens.idToken) {
            const identity = await verifyIdToken(tokens.idToken, r.client_id, undefined, o);
            if (identity.subject !== r.subject) throw new SiwcError('account_mismatch', 'The refreshed ChatGPT identity does not match this profile.');
        }
        // Replace the access token, expiry, scopes and rotating refresh token together
        const next: CredentialRecord = {
            ...r, access_token: tokens.accessToken, expires_in: tokens.expiresIn, expires_at: tokens.expiresAt, scopes: tokens.scopes,
            ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}), ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
            ...(tokens.earliestRefreshAt !== undefined ? { earliest_refresh_at: tokens.earliestRefreshAt } : {}),
            saved_at: new Date(now).toISOString(),
        };
        await writeRecord(o.dir, o.profile, next);
        if (!tokens.scopes.includes(PLAN_SCOPE)) throw new SiwcError('siwc_scope_missing', 'ChatGPT plan use is no longer allowed for this sign-in.');
        return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, agoraUserId: r.agora_user_id ?? null };
    });
}

/** Sign out: revoke the renewable session, then clear the tokens (the registration stays). */
export async function logout(o: SessionOptions): Promise<{ revoked: boolean }> {
    return withLock(o.dir, o.profile, async () => {
        const r = await readRecord(o.dir, o.profile);
        if (!r) return { revoked: true };
        const revoked = r.refresh_token ? await revoke(r.refresh_token, r.client_id, o) : true;
        await clearTokens(o.dir, o.profile);
        const { agora_user_id: _u, ...rest } = (await readRecord(o.dir, o.profile))!;
        await writeRecord(o.dir, o.profile, rest as CredentialRecord);
        return { revoked };
    });
}
