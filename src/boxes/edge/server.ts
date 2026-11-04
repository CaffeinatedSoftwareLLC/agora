import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { publishEvents, type BridgedEvent } from '../../lib/event-bridge';
import { consoleLog, sendText, type EdgeDeps, type EdgeLog } from './common';
import { createForwardProxy, type Dial } from './forward-proxy';
import { handleGit } from './git-broker';
import { handleGithub } from './github-broker';
import { BoxDirectory, plainAddress, type Identify } from './identity';
import { expireOnce, retireOrphans } from './maintenance';
import { brokerPrefix, matchGitPath, matchGithubPath } from './paths';
import { createApiProxy, proxyRequest, proxyUpgrade } from './reverse-proxy';
import type { Resolver, Subnet } from './ssrf';
import { allowUpstreamOrigin } from './upstream';

/**
 * The box edge (docs/agent-boxes.md §4, §5): the box's only way out. Two listeners:
 * `agora` (:8080: the API reverse proxy, the git broker, the GitHub broker) and `proxy`
 * (:3128: CONNECT and plain HTTP to allowed domains).
 */

export const HEARTBEAT_KEY = 'agora:edge:heartbeat';

export interface EdgeOptions {
    db: Pool;
    redis?: Redis;
    /** Overrides publishing (tests); defaults to the Redis event bridge. */
    publish?: (events: BridgedEvent[]) => Promise<void>;
    encryptionKey: Buffer;
    edgeSecret: string;
    apiUpstream: string;
    /** https://github.com and https://api.github.com in production (box-edge-main passes the constants). */
    githubBase: string;
    githubApiBase: string;
    /** Box identity for a connection; production uses the local/remote address rule. */
    identify?: Identify;
    directoryTtlMs?: number;
    resolve?: Resolver;
    subnets?: () => Subnet[];
    dial?: Dial;
    log?: EdgeLog;
}

export interface Edge {
    agora: http.Server;
    proxy: http.Server;
    directory: BoxDirectory;
    deps: EdgeDeps;
    /** One maintenance pass (expiry); the interval runs it every minute. */
    maintain(): Promise<void>;
    start(ports: { agora: number; proxy: number; host?: string }): Promise<void>;
    /** Stop accepting, let brokered operations finish (up to `graceMs`), then cut what's left. */
    close(graceMs?: number): Promise<void>;
}

const isLoopback = (address: string) => address === '127.0.0.1' || address === '::1';

export function createEdge(opts: EdgeOptions): Edge {
    const log = opts.log ?? consoleLog;
    const publish = opts.publish ?? (async (events: BridgedEvent[]) => {
        if (!opts.redis || events.length === 0) return;
        try { await publishEvents(opts.redis, events); } catch (err) { log.warn({ err: (err as Error).message }, 'Event publish failed'); }
    });
    // The brokers' upstreams: GitHub's constants in production (box-edge-main), a fake in tests
    allowUpstreamOrigin(opts.githubBase);
    allowUpstreamOrigin(opts.githubApiBase);
    const deps: EdgeDeps = {
        db: opts.db, encryptionKey: opts.encryptionKey, githubBase: opts.githubBase.replace(/\/$/, ''),
        githubApiBase: opts.githubApiBase.replace(/\/$/, ''), log,
        publish: async (events) => { try { await publish(events); } catch (err) { log.warn({ err: (err as Error).message }, 'Event publish failed'); } },
    };
    const directory = new BoxDirectory(opts.db, opts.directoryTtlMs ?? 3000);
    const identifyCached = opts.identify ?? directory.identify;
    // The directory is a few seconds old, but a box's generation must be today's: right after a
    // rebuild the new container already holds the new generation's tokens, and signing with the
    // old one gets them refused (and its agora-host stops). One primary-key read per request.
    const identify = async (local: string, remote: string) => {
        const box = await identifyCached(local, remote);
        if (!box) return null;
        const row = (await opts.db.query(`SELECT generation FROM agent_boxes WHERE id = $1 AND deleted_at IS NULL`, [box.id])).rows[0];
        return row ? { ...box, generation: Number(row.generation) } : null;
    };
    const api = createApiProxy(opts.apiUpstream, opts.edgeSecret);

    const raw = new Set<Duplex>();
    const track = (s: Duplex) => { raw.add(s); s.once('close', () => raw.delete(s)); };
    let active = 0;
    let idle: (() => void) | null = null;
    const busy = async (fn: () => Promise<void>) => {
        active++;
        try { await fn(); } finally {
            active--;
            if (active === 0 && idle) idle();
        }
    };

    const agora = http.createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 20_000, requestTimeout: 30 * 60 * 1000 });
    agora.maxHeadersCount = 100;
    agora.on('request', (req: IncomingMessage, res: ServerResponse) => {
        void busy(async () => {
            const local = plainAddress(req.socket.localAddress);
            const remote = plainAddress(req.socket.remoteAddress);
            if (req.url === '/healthz' && req.method === 'GET' && isLoopback(remote)) {
                req.resume();
                res.writeHead(200, { 'content-type': 'application/json' });
                return void res.end('{"ok":true}');
            }
            const box = await identify(local, remote);
            if (!box) { req.resume(); return sendText(res, 403, 'not a box'); }
            const url = req.url ?? '';
            if (!url.startsWith('/')) { req.resume(); return sendText(res, 400, 'bad request'); }
            const prefix = brokerPrefix(url);
            if (prefix === 'git') {
                const route = matchGitPath(req.method ?? '', url);
                if (!route) { req.resume(); return sendText(res, 404, 'not found'); }
                return handleGit(deps, box, req, res, route);
            }
            if (prefix === 'github') {
                const route = matchGithubPath(req.method ?? '', url);
                if (!route) { req.resume(); return sendText(res, 404, 'not found'); }
                return handleGithub(deps, box, req, res, route);
            }
            proxyRequest(api, box, remote, req, res);
        }).catch(err => {
            log.warn({ err: (err as Error).message, url: req.url?.slice(0, 200) }, 'Edge request failed');
            if (!res.headersSent) sendText(res, 500, 'edge error');
            else res.destroy();
        });
    });
    agora.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        track(socket);
        socket.on('error', () => socket.destroy());
        void (async () => {
            const s = socket as Socket;
            const remote = plainAddress(s.remoteAddress);
            const box = await identify(plainAddress(s.localAddress), remote);
            if (!box) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            if (brokerPrefix(req.url ?? '') || !(req.url ?? '').startsWith('/')) {
                return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            }
            proxyUpgrade(api, box, remote, req, socket, head, track);
        })().catch(() => socket.destroy());
    });

    const proxy = createForwardProxy({ deps, identify, resolve: opts.resolve, subnets: opts.subnets, dial: opts.dial, track });

    let expiry: NodeJS.Timeout | null = null;
    let heartbeat: NodeJS.Timeout | null = null;

    const maintain = async () => {
        try {
            await deps.publish(await expireOnce(opts.db));
        } catch (err) {
            log.warn({ err: (err as Error).message }, 'Edge request expiry failed');
        }
    };
    const beat = async () => {
        if (!opts.redis) return;
        try { await opts.redis.set(HEARTBEAT_KEY, String(Date.now()), 'EX', 120); } catch { /* the doctor reports it stale */ }
    };

    const listen = (server: http.Server, port: number, host: string) => new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });

    return {
        agora, proxy, directory, deps, maintain,
        async start(ports) {
            const host = ports.host ?? '0.0.0.0';
            try { await deps.publish(await retireOrphans(opts.db)); } catch (err) { log.warn({ err: (err as Error).message }, 'Orphan cleanup failed'); }
            await listen(agora, ports.agora, host);
            await listen(proxy, ports.proxy, host);
            await maintain();
            await beat();
            expiry = setInterval(() => void maintain(), 60_000);
            heartbeat = setInterval(() => void beat(), 30_000);
        },
        async close(graceMs = 30_000) {
            if (expiry) clearInterval(expiry);
            if (heartbeat) clearInterval(heartbeat);
            const closed = Promise.all([agora, proxy].map(s => new Promise<void>(r => (s.listening ? s.close(() => r()) : r()))));
            agora.closeIdleConnections(); proxy.closeIdleConnections();
            if (active > 0) {
                await Promise.race([new Promise<void>(r => { idle = r; }), new Promise(r => setTimeout(r, graceMs).unref())]);
            }
            agora.closeAllConnections(); proxy.closeAllConnections();
            for (const s of raw) s.destroy();
            api.agent.destroy();
            await closed;
        },
    };
}
