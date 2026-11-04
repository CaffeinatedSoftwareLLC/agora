import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { DOMAIN_ENTRY, domainAllowed } from '../../lib/boxes/contract';
import { domainRecentlyDenied } from '../../lib/boxes/edge-requests';
import { frameBody, requestApproval, sendText, TOO_MANY_WAITING, type EdgeDeps } from './common';
import type { EdgeBox, Identify } from './identity';
import { looksLikeIpLiteral, pinAddress, type Resolver, type Subnet } from './ssrf';

/**
 * The forward proxy on :3128 (docs/agent-boxes.md §4.2): `CONNECT host:443` and plain HTTP
 * (`GET http://host/...`, port 80) to the box's allowed domains, through the pinned SSRF guard.
 * An unknown domain gets a 403 and a pending edge request; nothing is held open.
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
}

const CONNECT_TIMEOUT_MS = 10_000;
const TUNNEL_IDLE_MS = 10 * 60 * 1000;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

type Verdict = { ok: true; address: string } | { ok: false; status: number; text: string; headers?: Record<string, string> };

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

async function decide(opts: ForwardProxyOptions, box: EdgeBox, rawHost: string): Promise<Verdict> {
    const norm = normalizeHost(rawHost);
    if ('error' in norm) {
        return norm.error === 'ip'
            ? { ok: false, status: 403, text: 'IP addresses can\'t be reached from a box; use a domain name' }
            : { ok: false, status: 400, text: 'invalid host name' };
    }
    const { host } = norm;
    // The directory is a few seconds old; before refusing, read the allowlist itself, so a
    // retry right after the owner allows a domain goes through instead of making a new card
    if (!domainAllowed(host, box.allowedDomains) && !domainAllowed(host, await currentAllowlist(opts, box))) {
        if (await domainRecentlyDenied(opts.deps.db, box.id, host)) {
            return { ok: false, status: 403, text: `domain ${host} was denied by the owner` };
        }
        const id = await requestApproval(opts.deps, box, 'domain', { host });
        if (!id) return { ok: false, status: 429, text: TOO_MANY_WAITING };
        return { ok: false, status: 403, text: `domain ${host} needs the owner's approval; request ${id} was sent`, headers: { 'X-Agora-Edge-Request': id } };
    }
    const pin = await pinAddress(host, { resolve: opts.resolve, subnets: opts.subnets });
    if (!pin.ok) {
        return pin.reason === 'blocked'
            ? { ok: false, status: 403, text: `domain ${host} resolves to an address a box can't reach` }
            : { ok: false, status: 502, text: `domain ${host} could not be resolved` };
    }
    return { ok: true, address: pin.address };
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
            const verdict = await decide(opts, box, m[1]);
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
            socket.on('close', () => upstream.destroy());
            upstream.on('close', () => socket.destroy());
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
    const verdict = await decide(opts, box, url.hostname);
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
    req.pipe(upReq);
}
