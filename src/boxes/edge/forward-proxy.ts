import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { DOMAIN_ENTRY, domainAllowed } from '../../lib/boxes/contract';
import { boxLoginOpen, domainRecentlyDenied, LOGIN_ONLY_HOSTS, LOGIN_PROVIDER_DOMAINS, OPEN_LOGIN_STATUSES } from '../../lib/boxes/edge-requests';
import { isTelemetryHost } from '../../lib/boxes/domains';
import { frameBody, requestApproval, sendText, TOO_MANY_WAITING, type EdgeDeps } from './common';
import type { EdgeBox, Identify } from './identity';
import { looksLikeIpLiteral, pinAddress, type Resolver, type Subnet } from './ssrf';

/**
 * The forward proxy on :3128 (docs/agent-boxes.md §4.2): `CONNECT host:443` and plain HTTP
 * (`GET http://host/...`, port 80) to the box's allowed domains, through the pinned SSRF guard.
 * An unknown domain gets a 403 and a pending edge request. Telemetry hosts get a 403 and no
 * card. While a CLI login runs, a request to that CLI's own provider domains waits for its card
 * (at most LOGIN_HOLD_MS), so the login can go on once the owner taps Allow.
 */

export type Dial = (address: string, port: number) => net.Socket;
export const systemDial: Dial = (address, port) => net.connect({ host: address, port });

export interface ForwardProxyOptions {
    deps: EdgeDeps;
    identify: Identify;
    resolve?: Resolver;
    subnets?: () => Subnet[];
    dial?: Dial;
    /** Tunnels and upgrades leave the HTTP server's books; the edge tracks them to close them on shutdown. */
    track: (s: Duplex) => void;
    /** Tests: a shorter login hold and poll. */
    loginHoldMs?: number;
    loginHoldPollMs?: number;
    /** How often a connection let through only for a login checks that the login is still open. */
    loginOnlyPollMs?: number;
}

const CONNECT_TIMEOUT_MS = 10_000;
/** How long a login's request waits for its card, how often it looks, and how many wait per box. */
export const LOGIN_HOLD_MS = 120_000;
const LOGIN_HOLD_POLL_MS = 1000;
const MAX_HOLDS_PER_BOX = 4;
const OPEN_LOGIN = OPEN_LOGIN_STATUSES;
const TUNNEL_IDLE_MS = 10 * 60 * 1000;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** `loginOnly`: let through only because the owner's login is open; it ends when the login does. */
type Verdict = { ok: true; address: string; loginOnly?: boolean } | { ok: false; status: number; text: string; headers?: Record<string, string> };

const LOGIN_ONLY_POLL_MS = 2000;
/**
 * A connection admitted only for a login (registry `loginOnly`) lives no longer than that login:
 * the edge looks every few seconds and calls `end` once the login is no longer open (finished,
 * cancelled or expired). Returns the function that stops looking.
 */
function untilLoginCloses(opts: ForwardProxyOptions, box: EdgeBox, end: () => void): () => void {
    let stopped = false;
    const timer = setInterval(() => {
        void boxLoginOpen(opts.deps.db, box.id).then(open => {
            if (!open && !stopped) { stopped = true; clearInterval(timer); end(); }
        }).catch(() => { /* a failed look is retried at the next tick */ });
    }, opts.loginOnlyPollMs ?? LOGIN_ONLY_POLL_MS);
    timer.unref?.();
    return () => { stopped = true; clearInterval(timer); };
}

/** A host name a box may ask for: a plain DNS name, lowercase, no trailing dot, never an IP. */
export function normalizeHost(raw: string): { host: string } | { error: 'ip' | 'invalid' } {
    const host = raw.toLowerCase().replace(/\.$/, '');
    if (host.startsWith('[') || looksLikeIpLiteral(host)) return { error: 'ip' };
    if (host.startsWith('*.') || !DOMAIN_ENTRY.test(host)) return { error: 'invalid' };
    return { host };
}

async function currentAllowlist(opts: ForwardProxyOptions, box: EdgeBox): Promise<string[]> {
    const r = await opts.deps.db.query('SELECT allowed_domains FROM agent_boxes WHERE id = $1 AND generation = $2', [box.id, box.generation]);
    return r.rows[0]?.allowed_domains ?? [];
}

const holds = new Map<string, number>();

/** A name under the box CLI's own provider domains (the only ones a login waits for). */
export function loginProviderHost(adapter: string | null | undefined, host: string): boolean {
    return (LOGIN_PROVIDER_DOMAINS[adapter ?? ''] ?? []).some(d => host === d || host.endsWith(`.${d}`));
}

/**
 * During a CLI login, wait for the owner to decide this domain's card instead of refusing at
 * once: a login can't pick up where a refused request left it (seen live 2026-11-04: Claude's
 * login was refused platform.claude.com while its card was being filed). Only the box CLI's
 * provider domains wait, only while a login is open, for at most LOGIN_HOLD_MS, and at most
 * MAX_HOLDS_PER_BOX at a time. True once the domain is on the box's allowlist.
 */
async function holdForLogin(opts: ForwardProxyOptions, box: EdgeBox, host: string, requestId: string, gone: () => boolean): Promise<boolean> {
    if (!loginProviderHost(box.adapter, host)) return false;
    const held = holds.get(box.id) ?? 0;
    if (held >= MAX_HOLDS_PER_BOX) return false;
    holds.set(box.id, held + 1);
    try {
        const deadline = Date.now() + (opts.loginHoldMs ?? LOGIN_HOLD_MS);
        const poll = opts.loginHoldPollMs ?? LOGIN_HOLD_POLL_MS;
        for (;;) {
            const r = (await opts.deps.db.query(
                `SELECT b.allowed_domains,
                        EXISTS (SELECT 1 FROM box_login_requests l WHERE l.box_id = b.id AND l.status = ANY($3::text[]) AND l.expires_at > NOW()) AS login_open,
                        (SELECT e.status FROM box_edge_requests e WHERE e.id = $4 AND e.box_id = b.id) AS card
                 FROM agent_boxes b WHERE b.id = $1 AND b.generation = $2`,
                [box.id, box.generation, OPEN_LOGIN, requestId]
            )).rows[0];
            if (!r) return false;
            if (domainAllowed(host, r.allowed_domains ?? [])) return true;
            // No login (or it ended), or the owner denied the card, or it expired: refuse as usual
            if (!r.login_open || r.card !== 'pending') return false;
            if (gone() || Date.now() + poll > deadline) return false;
            await new Promise(resolve => setTimeout(resolve, poll));
        }
    } finally {
        const n = (holds.get(box.id) ?? 1) - 1;
        if (n > 0) holds.set(box.id, n); else holds.delete(box.id);
    }
}

async function decide(opts: ForwardProxyOptions, box: EdgeBox, rawHost: string, gone: () => boolean = () => false): Promise<Verdict> {
    const norm = normalizeHost(rawHost);
    if ('error' in norm) {
        return norm.error === 'ip'
            ? { ok: false, status: 403, text: 'IP addresses can\'t be reached from a box; use a domain name' }
            : { ok: false, status: 400, text: 'invalid host name' };
    }
    const { host } = norm;
    // Telemetry is refused without a card, unless the owner listed that exact name: a wildcard
    // allowed for a provider (`*.chatgpt.com`) doesn't reach its metrics host
    if (isTelemetryHost(host) && !box.allowedDomains.includes(host) && !(await currentAllowlist(opts, box)).includes(host)) {
        return { ok: false, status: 403, text: `domain ${host} sends telemetry, which boxes don't send; add its exact name to the box's allowlist to allow it` };
    }
    // The directory is a few seconds old; before refusing, read the allowlist itself, so a
    // retry right after the owner allows a domain goes through instead of making a new card
    // A host the box CLI needs only to sign in (Devin's app.devin.ai): no card while the owner's
    // login for this box is open; any other time it is an unknown domain like the rest
    const allowed = domainAllowed(host, box.allowedDomains) || domainAllowed(host, await currentAllowlist(opts, box));
    const loginOnly = !allowed && (LOGIN_ONLY_HOSTS[box.adapter ?? ''] ?? []).includes(host) && await boxLoginOpen(opts.deps.db, box.id);
    if (!allowed && !loginOnly) {
        if (await domainRecentlyDenied(opts.deps.db, box.id, host)) {
            return { ok: false, status: 403, text: `domain ${host} was denied by the owner` };
        }
        const id = await requestApproval(opts.deps, box, 'domain', { host });
        if (!id) return { ok: false, status: 429, text: TOO_MANY_WAITING };
        if (!await holdForLogin(opts, box, host, id, gone)) {
            return { ok: false, status: 403, text: `domain ${host} needs the owner's approval; request ${id} was sent`, headers: { 'X-Agora-Edge-Request': id } };
        }
    }
    const pin = await pinAddress(host, { resolve: opts.resolve, subnets: opts.subnets });
    if (!pin.ok) {
        return pin.reason === 'blocked'
            ? { ok: false, status: 403, text: `domain ${host} resolves to an address a box can't reach` }
            : { ok: false, status: 502, text: `domain ${host} could not be resolved` };
    }
    return { ok: true, address: pin.address, ...(loginOnly ? { loginOnly: true } : {}) };
}

function rawReply(socket: Duplex, status: number, text: string, headers: Record<string, string> = {}) {
    const reason = http.STATUS_CODES[status] ?? 'Error';
    const body = Buffer.from(`${text}\n`, 'utf8');
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\n${extra}Connection: close\r\n\r\n${body.toString('utf8')}`);
}

export function createForwardProxy(opts: ForwardProxyOptions): http.Server {
    const dial = opts.dial ?? systemDial;
    const log = opts.deps.log;
    const server = http.createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 20_000, requestTimeout: 0 });
    server.maxHeadersCount = 100;

    server.on('connect', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        opts.track(socket);
        socket.on('error', () => socket.destroy());
        void (async () => {
            const box = await opts.identify((socket as net.Socket).localAddress ?? '', (socket as net.Socket).remoteAddress ?? '');
            if (!box) return rawReply(socket, 403, 'not a box');
            const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]\s]+):(\d{1,5})$/.exec(req.url ?? '');
            if (!m) return rawReply(socket, 400, 'CONNECT needs host:port');
            if (m[2] !== '443') return rawReply(socket, 403, 'only port 443 can be reached through CONNECT');
            let gone = false;
            socket.once('close', () => { gone = true; });
            const verdict = await decide(opts, box, m[1], () => gone || socket.destroyed);
            if (socket.destroyed) return;
            if (!verdict.ok) return rawReply(socket, verdict.status, verdict.text, verdict.headers);
            const upstream = dial(verdict.address, 443);
            opts.track(upstream);
            upstream.setTimeout(CONNECT_TIMEOUT_MS, () => { upstream.destroy(); rawReply(socket, 504, 'connection timed out'); });
            upstream.once('connect', () => {
                upstream.setTimeout(TUNNEL_IDLE_MS, () => { upstream.destroy(); socket.destroy(); });
                socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length > 0) upstream.write(head);
                upstream.pipe(socket);
                socket.pipe(upstream);
            });
            upstream.on('error', () => {
                if (upstream.connecting || !upstream.remoteAddress) rawReply(socket, 502, 'connection failed');
                else socket.destroy();
            });
            // A tunnel let through only for a login is closed when the login ends
            const stop = verdict.loginOnly ? untilLoginCloses(opts, box, () => { upstream.destroy(); socket.destroy(); }) : () => {};
            socket.on('close', () => { stop(); upstream.destroy(); });
            upstream.on('close', () => { stop(); socket.destroy(); });
        })().catch(err => {
            log.warn({ err: (err as Error).message }, 'CONNECT failed');
            rawReply(socket, 500, 'edge error');
        });
    });

    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
        void plainHttp(opts, dial, req, res).catch(err => {
            log.warn({ err: (err as Error).message }, 'proxy request failed');
            sendText(res, 500, 'edge error');
        });
    });

    // Upgrades through the forward proxy (ws:// to an allowed domain) aren't brokered
    server.on('upgrade', (_req, socket: Duplex) => rawReply(socket, 403, 'upgrades are not proxied'));
    return server;
}

async function plainHttp(opts: ForwardProxyOptions, dial: Dial, req: IncomingMessage, res: ServerResponse) {
    const box = await opts.identify(req.socket.localAddress ?? '', req.socket.remoteAddress ?? '');
    if (!box) { req.resume(); return sendText(res, 403, 'not a box'); }
    let url: URL;
    try {
        if (!/^http:\/\//i.test(req.url ?? '')) throw new Error('not absolute');
        url = new URL(req.url!);
    } catch {
        req.resume();
        return sendText(res, 400, 'this is a proxy: send an absolute http:// URL, or CONNECT for https');
    }
    if (url.username || url.password) { req.resume(); return sendText(res, 400, 'credentials in proxy URLs are not accepted'); }
    if (url.port && url.port !== '80') { req.resume(); return sendText(res, 403, 'only port 80 can be reached for plain HTTP'); }
    const verdict = await decide(opts, box, url.hostname, () => req.socket.destroyed);
    if (req.socket.destroyed) return;
    if (!verdict.ok) { req.resume(); return sendText(res, verdict.status, verdict.text, verdict.headers); }

    const named = String(req.headers.connection ?? '').split(',').map(s => s.trim().toLowerCase());
    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name) || named.includes(name) || name.startsWith('x-agora-edge-')) continue;
        headers[name] = value;
    }
    headers.host = url.host;
    if (!frameBody(req, headers)) { req.resume(); return sendText(res, 400, 'ambiguous request body framing'); }
    const address = verdict.address;
    const upReq = http.request({
        host: address, port: 80, method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false,
        createConnection: () => dial(address, 80),
    });
    upReq.setTimeout(TUNNEL_IDLE_MS, () => upReq.destroy(new Error('timeout')));
    upReq.on('response', (upRes) => {
        const out: OutgoingHttpHeaders = {};
        const hop = String(upRes.headers.connection ?? '').split(',').map(s => s.trim().toLowerCase());
        for (const [name, value] of Object.entries(upRes.headers)) {
            if (value !== undefined && !HOP_BY_HOP.has(name) && !hop.includes(name)) out[name] = value;
        }
        res.writeHead(upRes.statusCode ?? 502, out);
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
    });
    upReq.on('error', () => {
        if (!res.headersSent) sendText(res, 502, 'upstream unreachable');
        else res.destroy();
    });
    if (verdict.loginOnly) {
        const stop = untilLoginCloses(opts, box, () => { upReq.destroy(); res.destroy(); });
        res.on('close', stop);
    }
    req.pipe(upReq);
}
