import http2 from 'node:http2';
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { b64urlJson } from '../crypto.js';
import { APPROVAL_CATEGORY, PUSH_TTL_SECONDS, type PushMessage, type Sender, type SendResult } from './types.js';

export const APNS_PRODUCTION = 'https://api.push.apple.com';
export const APNS_SANDBOX = 'https://api.sandbox.push.apple.com';

export interface ApnsConfig {
    keyPem: string;
    keyId: string;
    teamId: string;
    bundleId: string;
    production: boolean;
}

export function loadApnsKey(path: string): string {
    let pem: string;
    try {
        pem = readFileSync(path, 'utf8');
    } catch {
        throw new Error(`APNS_KEY_FILE: cannot read ${path}`);
    }
    try {
        createPrivateKey(pem);
    } catch {
        throw new Error(`APNS_KEY_FILE: ${path} is not a PEM private key (.p8)`);
    }
    return pem;
}

/** The APNs JSON body: `aps` plus the same three custom keys FCM carries in `data`. */
export function buildApnsPayload(msg: PushMessage) {
    const aps: Record<string, unknown> = { alert: { title: msg.title, body: msg.body }, sound: 'default' };
    if (msg.type === 'approval') aps.category = APPROVAL_CATEGORY;
    return { aps, type: msg.type, url: msg.url, instance: msg.instance };
}

export interface ApnsOptions {
    /** Overrides the Apple host; tests use an h2c stub ("http://127.0.0.1:port"). */
    origin?: string;
    timeoutMs?: number;
    now?: () => number;
}

/**
 * APNs over HTTP/2 with token (.p8) auth. One session is kept open and reopened when it
 * closes. The provider JWT is reused for 50 minutes (Apple rejects tokens older than an
 * hour and refreshes more often than every 20 minutes).
 */
export class ApnsSender implements Sender {
    private readonly origin: string;
    private readonly timeoutMs: number;
    private readonly now: () => number;
    private readonly key: KeyObject;
    private session: http2.ClientHttp2Session | null = null;
    private jwt: { value: string; issuedAt: number } | null = null;

    constructor(private readonly cfg: ApnsConfig, opts: ApnsOptions = {}) {
        this.origin = opts.origin ?? (cfg.production ? APNS_PRODUCTION : APNS_SANDBOX);
        this.timeoutMs = opts.timeoutMs ?? 10_000;
        this.now = opts.now ?? Date.now;
        this.key = createPrivateKey(cfg.keyPem);
    }

    providerToken(): string {
        const now = this.now();
        if (this.jwt && now - this.jwt.issuedAt < 50 * 60_000) return this.jwt.value;
        const unsigned = `${b64urlJson({ alg: 'ES256', kid: this.cfg.keyId })}.${b64urlJson({ iss: this.cfg.teamId, iat: Math.floor(now / 1000) })}`;
        const sig = sign('sha256', Buffer.from(unsigned), { key: this.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
        this.jwt = { value: `${unsigned}.${sig}`, issuedAt: now };
        return this.jwt.value;
    }

    private connect(): http2.ClientHttp2Session {
        if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
        const session = http2.connect(this.origin);
        const drop = () => {
            if (this.session === session) this.session = null;
        };
        session.on('error', drop);
        session.on('goaway', drop);
        session.on('close', drop);
        session.unref();
        this.session = session;
        return session;
    }

    async send(token: string, msg: PushMessage): Promise<SendResult> {
        // The token goes into the request path; anything but hex is not an APNs token.
        if (!/^[0-9a-fA-F]{8,200}$/.test(token)) return { ok: false, gone: true, reason: 'apns_bad_token_format' };
        const body = JSON.stringify(buildApnsPayload(msg));
        const headers = {
            ':method': 'POST',
            ':path': `/3/device/${token}`,
            authorization: `bearer ${this.providerToken()}`,
            'apns-topic': this.cfg.bundleId,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-expiration': String(Math.floor(this.now() / 1000) + PUSH_TTL_SECONDS),
            'content-type': 'application/json',
        };
        let status: number;
        let text: string;
        try {
            ({ status, text } = await this.request(headers, body));
        } catch (err) {
            this.session?.destroy();
            this.session = null;
            return { ok: false, gone: false, reason: err instanceof Error && err.message === 'timeout' ? 'apns_timeout' : 'apns_network' };
        }
        if (status === 200) return { ok: true };
        let reason = 'Unknown';
        try {
            reason = String((JSON.parse(text) as { reason?: string }).reason ?? 'Unknown').replace(/[^A-Za-z]/g, '').slice(0, 40) || 'Unknown';
        } catch {
            /* keep Unknown */
        }
        if (status === 403 && (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken')) this.jwt = null;
        // 410 (Unregistered, ExpiredToken) and BadDeviceToken mean the token will never work.
        // DeviceTokenNotForTopic and auth errors usually mean relay misconfiguration.
        const gone = status === 410 || (status === 400 && reason === 'BadDeviceToken');
        return { ok: false, gone, reason: `apns_${status}_${reason}` };
    }

    private request(headers: http2.OutgoingHttpHeaders, body: string): Promise<{ status: number; text: string }> {
        return new Promise((resolve, reject) => {
            const req = this.connect().request(headers);
            let status = 0;
            const chunks: Buffer[] = [];
            req.setTimeout(this.timeoutMs, () => {
                req.close(http2.constants.NGHTTP2_CANCEL);
                reject(new Error('timeout'));
            });
            req.on('response', (h) => {
                status = Number(h[':status']);
            });
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => resolve({ status, text: Buffer.concat(chunks).toString('utf8') }));
            req.on('error', reject);
            req.end(body);
        });
    }

    async close(): Promise<void> {
        const s = this.session;
        this.session = null;
        if (s && !s.closed) await new Promise<void>((r) => s.close(() => r()));
    }
}
