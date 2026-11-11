/**
 * The Agora MCP tools over Streamable HTTP (`agora-mcp http`), for MCP clients that can't start a
 * local stdio process: NemoClaw's managed MCP, hosted agent platforms, anything that only takes
 * an `https://…/mcp` URL. One process serves many agents; each MCP session gets its own McpServer,
 * AgoraApi and cursors, built by the same `registerTools` the stdio server uses (src/serve.ts).
 *
 * Authentication: every request carries the agent's bot token, `Authorization: Bot <token>` or
 * `Authorization: Bearer <token>`. A session is created only by an `initialize` whose token
 * Agora accepts (`GET /bots/@me`), and every later request on it must carry the same token.
 *
 * Client binding (#39): Agora binds a bot token to the MCP client that first names itself. Over
 * HTTP the client must name itself, with an `X-Agora-Client` header or `clientInfo.name` in
 * `initialize` (the header wins: it is what an operator configures). An `initialize` with
 * neither is refused, so a token can't be used here unbound.
 *
 * Hosted semantics, like stdio's `--no-presence`: no terminal-session presence, no socket, no
 * hook state, and no `file_upload` (it would read this server's disk, not the agent's).
 * `chat_wait` works, capped at `maxWaitSeconds`; the proxy in front must allow a response that
 * long (agora-ui/nginx.conf `location /mcp`).
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { AgoraApi, AgoraApiError, mcpClientName } from './api.js';
import { ClientSession, observeTransport } from './client-session.js';
import { CursorTracker } from './cursor.js';
import { MAX_WAIT_SECONDS, registerResources, registerTools } from './tools.js';

export interface HttpServerOptions {
    /** Agora's API, as this process reaches it (in Docker `http://api:3000`). */
    apiUrl: string;
    port: number;
    host?: string;
    /** URL path of the endpoint. */
    path?: string;
    /** Longest chat_wait, in seconds. */
    maxWaitSeconds?: number;
    /** A session with no request for this long is closed. */
    idleMs?: number;
    /** Sessions per bot token; the oldest idle one is closed to make room. */
    maxSessionsPerToken?: number;
    /** Sessions in all. */
    maxSessions?: number;
    /** Largest request body, in bytes. */
    maxBodyBytes?: number;
    /** Server version reported in `initialize`. */
    version?: string;
    log?: (line: string) => void;
}

export const HTTP_DEFAULTS = {
    path: '/mcp',
    maxWaitSeconds: 1500,
    idleMs: 30 * 60_000,
    maxSessionsPerToken: 16,
    maxSessions: 500,
    maxBodyBytes: 16 * 1024 * 1024,
} as const;

interface Session {
    id: string;
    tokenHash: Buffer;
    transport: StreamableHTTPServerTransport;
    server: McpServer;
    lastSeen: number;
    inFlight: number;
}

/** The bot token from `Authorization: Bot <token>` or `Bearer <token>`, else null. */
export function bearerToken(header: string | string[] | undefined): string | null {
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value !== 'string') return null;
    const m = /^\s*(?:Bot|Bearer)\s+(\S+)\s*$/i.exec(value);
    return m ? m[1] : null;
}

/** The client name an `initialize` carries: the `X-Agora-Client` header, else `clientInfo.name`. */
export function initializeClientName(header: string | string[] | undefined, body: unknown): string | null {
    const fromHeader = mcpClientName(Array.isArray(header) ? header[0] : header);
    if (fromHeader) return fromHeader;
    const info = (body as { params?: { clientInfo?: { name?: unknown } } } | null)?.params?.clientInfo;
    return mcpClientName(info?.name);
}

const hashToken = (token: string) => createHash('sha256').update(token).digest();

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

class BodyTooLarge extends Error {}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > limit) throw new BodyTooLarge();
        chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : undefined;
}

/** The agent's address chain as Agora should record it: what the proxy saw, then the proxy. */
function forwardedChain(req: IncomingMessage): string | null {
    const prior = req.headers['x-forwarded-for'];
    const parts = [Array.isArray(prior) ? prior.join(', ') : prior, req.socket.remoteAddress]
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    return parts.length ? parts.join(', ').slice(0, 500) : null;
}

export class AgoraHttpMcp {
    private sessions = new Map<string, Session>();
    private sweeper: NodeJS.Timeout | undefined;
    private http: Server | undefined;
    private opts: {
        apiUrl: string; port: number; host: string; path: string; maxWaitSeconds: number; idleMs: number;
        maxSessionsPerToken: number; maxSessions: number; maxBodyBytes: number; version: string; log: (line: string) => void;
    };

    constructor(options: HttpServerOptions) {
        this.opts = {
            apiUrl: options.apiUrl.replace(/\/+$/, ''),
            port: options.port,
            host: options.host ?? '0.0.0.0',
            path: (options.path ?? HTTP_DEFAULTS.path).replace(/\/+$/, ''),
            maxWaitSeconds: Math.min(Math.max(options.maxWaitSeconds ?? HTTP_DEFAULTS.maxWaitSeconds, 1), MAX_WAIT_SECONDS),
            idleMs: options.idleMs ?? HTTP_DEFAULTS.idleMs,
            maxSessionsPerToken: options.maxSessionsPerToken ?? HTTP_DEFAULTS.maxSessionsPerToken,
            maxSessions: options.maxSessions ?? HTTP_DEFAULTS.maxSessions,
            maxBodyBytes: options.maxBodyBytes ?? HTTP_DEFAULTS.maxBodyBytes,
            version: options.version ?? packageVersion(),
            log: options.log ?? (line => process.stderr.write(`[agora-mcp http] ${line}
`)),
        };
    }

    get sessionCount(): number { return this.sessions.size; }

    /** Start listening; resolves with the bound port. */
    async listen(): Promise<number> {
        this.http = createServer((req, res) => {
            this.handle(req, res).catch(err => {
                this.opts.log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
                jsonRpcError(res, 500, -32603, 'Internal error');
            });
        });
        // chat_wait holds a response open for minutes: no Node-side request timeout
        this.http.requestTimeout = 0;
        this.http.headersTimeout = 60_000;
        await new Promise<void>((resolve, reject) => {
            this.http!.once('error', reject);
            this.http!.listen(this.opts.port, this.opts.host, () => resolve());
        });
        this.sweeper = setInterval(() => this.sweep(), 60_000);
        this.sweeper.unref();
        const addr = this.http.address();
        return typeof addr === 'object' && addr ? addr.port : this.opts.port;
    }

    async close(): Promise<void> {
        if (this.sweeper) clearInterval(this.sweeper);
        await Promise.all([...this.sessions.values()].map(s => this.end(s)));
        if (this.http) {
            this.http.closeAllConnections?.();
            await new Promise<void>(resolve => this.http!.close(() => resolve()));
        }
    }

    private async end(session: Session): Promise<void> {
        this.sessions.delete(session.id);
        await session.transport.close().catch(() => {});
        await session.server.close().catch(() => {});
    }

    /** Close sessions idle longer than idleMs (never one with a request in flight). */
    sweep(now = Date.now()): void {
        for (const s of this.sessions.values()) {
            if (s.inFlight === 0 && now - s.lastSeen > this.opts.idleMs) void this.end(s);
        }
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const base = this.opts.path;
        if (url.pathname === `${base}/health` && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
            return;
        }
        if (url.pathname !== base && url.pathname !== `${base}/`) {
            jsonRpcError(res, 404, -32601, 'Not found');
            return;
        }
        if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
            jsonRpcError(res, 405, -32601, 'Method not allowed', { Allow: 'GET, POST, DELETE' });
            return;
        }

        const token = bearerToken(req.headers.authorization);
        if (!token) {
            jsonRpcError(res, 401, -32001, 'Send your Agora bot token: Authorization: Bot <token> (or Bearer <token>).',
                { 'WWW-Authenticate': 'Bearer realm="agora"' });
            return;
        }

        let body: unknown;
        if (req.method === 'POST') {
            try { body = await readJsonBody(req, this.opts.maxBodyBytes); } catch (err) {
                if (err instanceof BodyTooLarge) jsonRpcError(res, 413, -32600, 'Request body too large');
                else jsonRpcError(res, 400, -32700, 'Parse error');
                return;
            }
        }

        const sessionHeader = req.headers['mcp-session-id'];
        const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
        if (sessionId) {
            const session = this.sessions.get(sessionId);
            if (!session) {
                jsonRpcError(res, 404, -32001, 'Session not found; initialize a new one.');
                return;
            }
            const presented = hashToken(token);
            if (!timingSafeEqual(presented, session.tokenHash)) {
                jsonRpcError(res, 403, -32001, 'This session belongs to another bot token.');
                return;
            }
            await this.serve(session, req, res, body);
            return;
        }

        const method = (body as { method?: unknown } | undefined)?.method;
        if (req.method === 'POST' && method === 'initialize' && !initializeClientName(req.headers['x-agora-client'], body)) {
            jsonRpcError(res, 400, -32602, 'Name your MCP client: send an X-Agora-Client header or clientInfo.name in initialize. '
                + 'Agora binds the bot token to that name.');
            return;
        }
        if (req.method !== 'POST' || !isInitializeRequest(body)) {
            jsonRpcError(res, 400, -32600, 'No session: send initialize first, then the Mcp-Session-Id it returns.');
            return;
        }
        await this.initialize(req, res, body, token);
    }

    private async serve(session: Session, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
        session.lastSeen = Date.now();
        // The standalone GET stream stays open for the whole session: only POSTs (tool calls,
        // a long chat_wait among them) keep a session from counting as idle
        if (req.method !== 'POST') {
            await session.transport.handleRequest(req, res, body);
            return;
        }
        session.inFlight++;
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            session.inFlight--;
            session.lastSeen = Date.now();
        };
        res.once('close', done);
        try { await session.transport.handleRequest(req, res, body); } catch (err) { done(); throw err; }
    }

    private async initialize(req: IncomingMessage, res: ServerResponse, body: unknown, token: string): Promise<void> {
        const name = initializeClientName(req.headers['x-agora-client'], body);
        if (!name) {
            jsonRpcError(res, 400, -32602, 'Name your MCP client: send an X-Agora-Client header or clientInfo.name in initialize. '
                + 'Agora binds the bot token to that name.');
            return;
        }

        const tokenHash = hashToken(token);
        if (!this.makeRoom(tokenHash)) {
            jsonRpcError(res, 429, -32001, 'Too many open MCP sessions for this bot token; close one (DELETE) and try again.');
            return;
        }

        const api = new AgoraApi(this.opts.apiUrl, token);
        // Pinned to the name checked here; a later _meta clientInfo can't change it (src/client-session.ts)
        const client = new ClientSession({ initializeName: () => undefined, configured: name, onStart: () => {} });
        api.setClient(() => client.name());
        api.setForwardedFor(forwardedChain(req));

        // The token must work, and for this client, before a session exists
        try {
            await api.getMe();
        } catch (err) {
            if (err instanceof AgoraApiError && (err.status === 401 || err.status === 403)) {
                const reason = err.status === 401 ? 'Agora refused this bot token.'
                    : typeof err.body?.message === 'string' ? err.body.message : `Agora refused this token (${err.code ?? err.status}).`;
                jsonRpcError(res, err.status === 401 ? 401 : 403, -32001, reason,
                    err.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="agora", error="invalid_token"' } : {});
                return;
            }
            this.opts.log(`token check failed: ${err instanceof Error ? err.message : String(err)}`);
            jsonRpcError(res, 502, -32603, 'Agora is not reachable from the MCP endpoint right now.');
            return;
        }

        const server = new McpServer({ name: 'agora', version: this.opts.version });
        registerTools(server, api, new CursorTracker(api), { localFiles: false, maxWaitSeconds: this.opts.maxWaitSeconds });
        registerResources(server, api);

        let session: Session | undefined;
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: id => {
                session = { id, tokenHash, transport, server, lastSeen: Date.now(), inFlight: 1 };
                this.sessions.set(id, session);
                res.once('close', () => { if (session) { session.inFlight--; session.lastSeen = Date.now(); } });
            },
            onsessionclosed: id => {
                const s = this.sessions.get(id);
                if (s) void this.end(s);
            },
        });
        transport.onclose = () => { if (session) this.sessions.delete(session.id); };
        await server.connect(transport);
        observeTransport(transport, client);
        await transport.handleRequest(req, res, body);
        if (!session) await server.close().catch(() => {});
    }

    /** Room for one more session of this token: false when it holds the cap and none is idle. */
    private makeRoom(tokenHash: Buffer): boolean {
        const mine = [...this.sessions.values()].filter(s => s.tokenHash.equals(tokenHash));
        const free = (list: Session[], cap: number): boolean => {
            if (list.length < cap) return true;
            const idle = list.filter(s => s.inFlight === 0).sort((a, b) => a.lastSeen - b.lastSeen)[0];
            if (!idle) return false;
            void this.end(idle);
            return true;
        };
        if (!free(mine, this.opts.maxSessionsPerToken)) return false;
        return free([...this.sessions.values()], this.opts.maxSessions);
    }
}

function packageVersion(): string {
    try {
        // package.json sits one level above dist/ (and src/) in the package
        return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    } catch { return '0.0.0'; }
}

function intEnv(env: Record<string, string | undefined>, name: string): number | undefined {
    const raw = env[name];
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive whole number.`);
    return n;
}

function argValue(args: string[], flag: string): string | undefined {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    return v;
}

/** Options from `agora-mcp http [--api <url>] [--port <n>] [--host <addr>]` and the environment. */
export function httpOptionsFrom(args: string[], env: Record<string, string | undefined>): HttpServerOptions {
    const apiUrl = argValue(args, '--api') ?? env.AGORA_API_URL;
    if (!apiUrl) throw new Error('agora-mcp http needs the Agora API URL: --api <url> or AGORA_API_URL (in Docker, http://api:3000).');
    const port = argValue(args, '--port') ?? env.AGORA_MCP_HTTP_PORT ?? '3100';
    if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error('--port (AGORA_MCP_HTTP_PORT) must be a port number.');
    const idleMinutes = intEnv(env, 'AGORA_MCP_HTTP_IDLE_MINUTES');
    return {
        apiUrl,
        port: Number(port),
        host: argValue(args, '--host') ?? env.AGORA_MCP_HTTP_HOST ?? '0.0.0.0',
        maxWaitSeconds: intEnv(env, 'AGORA_MCP_HTTP_MAX_WAIT_SECONDS'),
        idleMs: idleMinutes === undefined ? undefined : idleMinutes * 60_000,
        maxSessionsPerToken: intEnv(env, 'AGORA_MCP_HTTP_SESSIONS_PER_TOKEN'),
        maxSessions: intEnv(env, 'AGORA_MCP_HTTP_MAX_SESSIONS'),
    };
}

/** `agora-mcp http`: run until SIGTERM / SIGINT. */
export async function httpMain(args: string[]): Promise<void> {
    const server = new AgoraHttpMcp(httpOptionsFrom(args, process.env));
    const port = await server.listen();
    process.stderr.write(`[agora-mcp http] MCP endpoint listening on port ${port}, path ${HTTP_DEFAULTS.path}\n`);
    const stop = () => { void server.close().finally(() => process.exit(0)); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
}
