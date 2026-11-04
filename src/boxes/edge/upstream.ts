import http, { type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import { gunzipSync } from 'node:zlib';

/**
 * Requests to GitHub. Node's http client never follows redirects, which is the point: a
 * redirect is never followed with the owner's token attached (the brokers answer 502).
 */

export const GITHUB_BASE = 'https://github.com';
export const GITHUB_API_BASE = 'https://api.github.com';
export const USER_AGENT = 'agora-edge';

export interface Upstream { req: ClientRequest; response: Promise<IncomingMessage> }

/**
 * The only origins the edge sends a request to (they get the owner's token). Production uses
 * GitHub's two; createEdge adds the bases a test injects. Checked on every request, after the
 * brokers' own path rules, so a URL built wrongly can never carry the token anywhere else.
 */
const UPSTREAM_ORIGINS = new Set([new URL(GITHUB_BASE).origin, new URL(GITHUB_API_BASE).origin]);
export function allowUpstreamOrigin(base: string) { UPSTREAM_ORIGINS.add(new URL(base).origin); }

/** Open a request; the caller writes the body and ends `req`. Idle sockets time out after `idleMs`. */
export function openUpstream(url: string, method: string, headers: OutgoingHttpHeaders, idleMs = 60_000): Upstream {
    const target = new URL(url);
    if (!UPSTREAM_ORIGINS.has(target.origin) || target.username || target.password) throw new Error('upstream origin not allowed');
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(target, { method, headers, agent: false });
    const response = new Promise<IncomingMessage>((resolve, reject) => {
        req.on('response', resolve);
        req.on('error', reject);
    });
    // Unhandled until someone awaits it; keep a rejection from crashing the process meanwhile
    response.catch(() => undefined);
    req.setTimeout(idleMs, () => req.destroy(new Error('upstream timeout')));
    return { req, response };
}

export class BodyTooLarge extends Error {
    constructor() { super('upstream body too large'); }
}

/** Read a whole response (bounded), gunzipping if GitHub compressed it. */
export async function readBody(res: IncomingMessage, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res) {
        total += chunk.length;
        if (total > maxBytes) { res.destroy(); throw new BodyTooLarge(); }
        chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);
    const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
    if (enc === 'gzip' || enc === 'x-gzip') {
        const out = gunzipSync(body, { maxOutputLength: maxBytes });
        return out;
    }
    return body;
}

export interface Buffered { status: number; headers: IncomingHttpHeaders; body: Buffer }

export async function requestBuffered(url: string, opts: { method?: string; headers?: OutgoingHttpHeaders; body?: Buffer | string; maxBytes?: number; timeoutMs?: number } = {}): Promise<Buffered> {
    const body = opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');
    const headers: OutgoingHttpHeaders = { ...opts.headers };
    if (body) headers['content-length'] = body.length;
    const up = openUpstream(url, opts.method ?? 'GET', headers, opts.timeoutMs ?? 30_000);
    up.req.end(body);
    const res = await up.response;
    return { status: res.statusCode ?? 0, headers: res.headers, body: await readBody(res, opts.maxBytes ?? 10 * 1024 * 1024) };
}

export const isRedirect = (status: number | undefined) => status !== undefined && status >= 300 && status < 400;

/** `Authorization` for git over HTTPS with a GitHub token. */
export const gitAuth = (token: string) => `Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`;

export function apiHeaders(token: string, extra: OutgoingHttpHeaders = {}): OutgoingHttpHeaders {
    return {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': USER_AGENT,
        ...extra,
    };
}
