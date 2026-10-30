import { readFileSync } from 'node:fs';
import { sign } from 'node:crypto';
import { b64urlJson } from '../crypto.js';
import { PUSH_TTL_SECONDS, type PushMessage, type Sender, type SendResult } from './types.js';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DEFAULT_ENDPOINT = 'https://fcm.googleapis.com';

export interface ServiceAccount {
    project_id: string;
    client_email: string;
    private_key: string;
    token_uri: string;
}

/** Reads the Firebase service-account JSON. The error never echoes the file's contents. */
export function loadServiceAccount(path: string): ServiceAccount {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        throw new Error(`FCM_SERVICE_ACCOUNT_FILE: cannot read or parse ${path}`);
    }
    const sa = raw as Partial<ServiceAccount> & { type?: string };
    if (sa.type !== 'service_account' || !sa.project_id || !sa.client_email || !sa.private_key) {
        throw new Error(`FCM_SERVICE_ACCOUNT_FILE: ${path} is not a service-account key (needs type, project_id, client_email, private_key)`);
    }
    return { project_id: sa.project_id, client_email: sa.client_email, private_key: sa.private_key, token_uri: sa.token_uri || DEFAULT_TOKEN_URI };
}

/** The FCM HTTP v1 request body. All `data` values must be strings. */
export function buildFcmMessage(token: string, msg: PushMessage) {
    return {
        message: {
            token,
            notification: { title: msg.title, body: msg.body },
            data: { type: msg.type, url: msg.url, instance: msg.instance },
            android: { priority: 'HIGH', ttl: `${PUSH_TTL_SECONDS}s`, notification: { channel_id: 'agora' } },
        },
    };
}

export interface FcmOptions {
    /** Tests point these at local stubs. */
    endpoint?: string;
    tokenUri?: string;
    timeoutMs?: number;
    now?: () => number;
}

/** FCM HTTP v1 with an OAuth2 access token minted from the service account (JWT bearer grant), cached until near expiry. */
export class FcmSender implements Sender {
    private readonly endpoint: string;
    private readonly tokenUri: string;
    private readonly timeoutMs: number;
    private readonly now: () => number;
    private cached: { token: string; expiresAt: number } | null = null;
    private pending: Promise<string> | null = null;

    constructor(private readonly sa: ServiceAccount, opts: FcmOptions = {}) {
        this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
        this.tokenUri = opts.tokenUri ?? sa.token_uri;
        this.timeoutMs = opts.timeoutMs ?? 10_000;
        this.now = opts.now ?? Date.now;
        if (!opts.tokenUri && !this.tokenUri.startsWith('https://')) throw new Error('FCM service account token_uri must be https');
    }

    private assertion(): string {
        const iat = Math.floor(this.now() / 1000);
        const unsigned = `${b64urlJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlJson({ iss: this.sa.client_email, scope: SCOPE, aud: this.tokenUri, iat, exp: iat + 3600 })}`;
        return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), this.sa.private_key).toString('base64url')}`;
    }

    async accessToken(): Promise<string> {
        if (this.cached && this.cached.expiresAt > this.now()) return this.cached.token;
        this.pending ??= (async () => {
            try {
                const res = await fetch(this.tokenUri, {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: this.assertion() }).toString(),
                    signal: AbortSignal.timeout(this.timeoutMs),
                });
                if (!res.ok) throw new Error(`fcm_oauth_${res.status}`);
                const json = (await res.json()) as { access_token?: string; expires_in?: number };
                if (!json.access_token) throw new Error('fcm_oauth_no_token');
                // Refresh a minute early so a token never expires mid-request.
                this.cached = { token: json.access_token, expiresAt: this.now() + Math.max(0, (json.expires_in ?? 3600) - 60) * 1000 };
                return json.access_token;
            } finally {
                this.pending = null;
            }
        })();
        return this.pending;
    }

    async send(token: string, msg: PushMessage): Promise<SendResult> {
        let access: string;
        try {
            access = await this.accessToken();
        } catch (err) {
            const code = err instanceof Error && err.message.startsWith('fcm_oauth') ? err.message : 'fcm_oauth_failed';
            return { ok: false, gone: false, reason: code };
        }
        let res: Response;
        try {
            res = await fetch(`${this.endpoint}/v1/projects/${encodeURIComponent(this.sa.project_id)}/messages:send`, {
                method: 'POST',
                headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
                body: JSON.stringify(buildFcmMessage(token, msg)),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (err) {
            return { ok: false, gone: false, reason: err instanceof Error && err.name === 'TimeoutError' ? 'fcm_timeout' : 'fcm_network' };
        }
        if (res.ok) {
            await res.body?.cancel();
            return { ok: true };
        }
        if (res.status === 401) this.cached = null;
        const errorCode = await fcmErrorCode(res);
        return { ok: false, gone: errorCode.gone, reason: `fcm_${res.status}_${errorCode.code}` };
    }
}

/**
 * Only UNREGISTERED, or INVALID_ARGUMENT about the registration token, means the token is gone.
 * SENDER_ID_MISMATCH and auth errors usually mean relay misconfiguration, so they never
 * delete handles.
 */
async function fcmErrorCode(res: Response): Promise<{ code: string; gone: boolean }> {
    let body: { error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> } } = {};
    try {
        body = (await res.json()) as typeof body;
    } catch {
        return { code: 'UNKNOWN', gone: false };
    }
    const detail = body.error?.details?.find((d) => typeof d?.errorCode === 'string')?.errorCode;
    const code = (detail ?? body.error?.status ?? 'UNKNOWN').replace(/[^A-Z_]/g, '').slice(0, 40) || 'UNKNOWN';
    const gone = code === 'UNREGISTERED' || (code === 'INVALID_ARGUMENT' && /registration token/i.test(body.error?.message ?? ''));
    return { code, gone };
}
