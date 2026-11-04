import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { signEdge } from '../../lib/boxes/contract';
import type { EdgeBox } from './identity';
import { sendText } from './common';

/**
 * The Agora half of :8080 (docs/agent-boxes.md §4.1): everything but /git and /github goes to
 * the API, WebSocket upgrades included. Spoofable provenance is stripped and the edge signs
 * what it forwards, so the API knows which box (and generation) a request came through.
 */

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** The request headers the API gets: no hop-by-hop, no X-Forwarded-*, no X-Agora-Edge-*; then ours. */
export function apiRequestHeaders(headers: IncomingHttpHeaders, box: EdgeBox, boxAddress: string, secret: string, upgrade = false): OutgoingHttpHeaders {
    const named = String(headers.connection ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const out: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        const n = name.toLowerCase();
        if (n.startsWith('x-agora-edge-') || n.startsWith('x-forwarded-') || n === 'forwarded' || n === 'x-real-ip') continue;
        if (HOP_BY_HOP.has(n) || named.includes(n)) continue;
        out[n] = value;
    }
    if (upgrade) {
        out.connection = 'Upgrade';
        out.upgrade = String(headers.upgrade ?? '');
    }
    out['x-forwarded-for'] = boxAddress;
    Object.assign(out, signEdge(secret, box.id, box.generation));
    return out;
}

function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
    const named = String(headers.connection ?? '').split(',').map(s => s.trim().toLowerCase());
    const out: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || HOP_BY_HOP.has(name) || named.includes(name)) continue;
        out[name] = value;
    }
    return out;
}

export interface ApiProxy {
    upstream: URL;
    secret: string;
    agent: http.Agent;
}

export function createApiProxy(upstream: string, secret: string): ApiProxy {
    const url = new URL(upstream);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('AGORA_API_UPSTREAM must be an http(s) URL');
    return { upstream: url, secret, agent: new http.Agent({ keepAlive: true, maxSockets: 256 }) };
}

const upstreamPort = (u: URL) => Number(u.port || (u.protocol === 'https:' ? 443 : 80));

export function proxyRequest(proxy: ApiProxy, box: EdgeBox, boxAddress: string, req: IncomingMessage, res: ServerResponse) {
    const headers = apiRequestHeaders(req.headers, box, boxAddress, proxy.secret);
    const mod = proxy.upstream.protocol === 'https:' ? https : http;
    const upReq = mod.request({
        protocol: proxy.upstream.protocol, hostname: proxy.upstream.hostname, port: upstreamPort(proxy.upstream),
        method: req.method, path: req.url, headers,
        agent: proxy.upstream.protocol === 'https:' ? undefined : proxy.agent,
    });
    upReq.on('response', (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, responseHeaders(upRes.headers));
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
    });
    upReq.on('error', () => {
        if (!res.headersSent) sendText(res, 502, 'Agora API unreachable');
        else res.destroy();
    });
    // The client went away: stop the upstream request too (long polls hold it open)
    res.on('close', () => { if (!res.writableFinished) upReq.destroy(); });
    req.pipe(upReq);
}

/** A WebSocket (or other) upgrade: rewrite the request head, then pipe raw bytes both ways. */
export function proxyUpgrade(proxy: ApiProxy, box: EdgeBox, boxAddress: string, req: IncomingMessage, socket: Duplex, head: Buffer, track: (s: Duplex) => void) {
    const headers = apiRequestHeaders(req.headers, box, boxAddress, proxy.secret, true);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
    }
    const opts = { host: proxy.upstream.hostname, port: upstreamPort(proxy.upstream) };
    const upstream = proxy.upstream.protocol === 'https:' ? tls.connect({ ...opts, servername: proxy.upstream.hostname }) : net.connect(opts);
    track(upstream);
    const fail = () => { socket.destroy(); upstream.destroy(); };
    upstream.setTimeout(10_000, () => fail());
    upstream.once(proxy.upstream.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        upstream.setTimeout(0);
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    upstream.on('error', () => {
        if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        upstream.destroy();
    });
    socket.on('error', fail);
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
}
