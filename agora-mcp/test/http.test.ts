import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgoraHttpMcp, bearerToken, httpOptionsFrom, initializeClientName } from '../src/http.js';

describe('bearerToken', () => {
    it('reads Bot and Bearer tokens, any case', () => {
        expect(bearerToken('Bot abc.def')).toBe('abc.def');
        expect(bearerToken('Bearer xyz')).toBe('xyz');
        expect(bearerToken('bearer  xyz ')).toBe('xyz');
    });
    it('refuses anything else', () => {
        expect(bearerToken(undefined)).toBeNull();
        expect(bearerToken('Basic dXNlcjpwYXNz')).toBeNull();
        expect(bearerToken('Bot')).toBeNull();
        expect(bearerToken('Bot a b')).toBeNull();
    });
});

describe('initializeClientName', () => {
    const init = (name?: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: name === undefined ? {} : { name } } });
    it('prefers the X-Agora-Client header', () => {
        expect(initializeClientName('nemoclaw', init('openclaw'))).toBe('nemoclaw');
    });
    it('falls back to clientInfo.name', () => {
        expect(initializeClientName(undefined, init('openclaw'))).toBe('openclaw');
    });
    it('is null when neither names a client, or the name could not be a header', () => {
        expect(initializeClientName(undefined, init())).toBeNull();
        expect(initializeClientName('', init('bad\nname'))).toBeNull();
    });
});

describe('httpOptionsFrom', () => {
    it('needs the API URL', () => {
        expect(() => httpOptionsFrom([], {})).toThrow(/AGORA_API_URL/);
    });
    it('reads flags and environment', () => {
        const o = httpOptionsFrom(['--api', 'http://api:3000', '--port', '3200'], { AGORA_MCP_HTTP_MAX_WAIT_SECONDS: '600', AGORA_MCP_HTTP_IDLE_MINUTES: '5' });
        expect(o).toMatchObject({ apiUrl: 'http://api:3000', port: 3200, maxWaitSeconds: 600, idleMs: 300_000 });
    });
    it('refuses a bad number', () => {
        expect(() => httpOptionsFrom([], { AGORA_API_URL: 'http://x', AGORA_MCP_HTTP_MAX_SESSIONS: '-1' })).toThrow(/positive/);
    });
});

/** A stand-in for Agora's API: one bot, one channel, records what it was sent. */
interface Seen { method: string; path: string; auth?: string; client?: string; forwarded?: string; body?: unknown }
const GOOD = 'good-token';
const BOUND = 'bound-token';
let fake: Server;
let apiUrl: string;
const seen: Seen[] = [];

async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const t = Buffer.concat(chunks).toString('utf8');
    return t ? JSON.parse(t) : undefined;
}

beforeAll(async () => {
    fake = createServer(async (req, res) => {
        const body = await readBody(req);
        const entry: Seen = { method: req.method!, path: req.url!, auth: req.headers.authorization,
            client: req.headers['x-agora-client'] as string | undefined, forwarded: req.headers['x-forwarded-for'] as string | undefined, body };
        seen.push(entry);
        const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
        const token = req.headers.authorization?.replace(/^Bot /, '');
        if (token !== GOOD && token !== BOUND) return json(401, { error: 'unauthorized' });
        if (token === BOUND && entry.client !== 'codex-mcp-client') {
            return json(403, { error: 'token_bound', message: 'This bot token belongs to codex-mcp-client.' });
        }
        if (req.url === '/bots/@me') return json(200, { id: 'bot1', username: 'nemo', channels: [{ id: 'ch1', name: 'general', serverId: 's1' }] });
        if (req.url?.startsWith('/channels/ch1/messages') && req.method === 'POST') {
            return json(201, { id: '01HX', content: (body as { content: string }).content, authorId: 'bot1', channelId: 'ch1', createdAt: '2026-01-01T00:00:00Z' });
        }
        json(404, { error: 'not_found' });
    });
    await new Promise<void>(r => fake.listen(0, '127.0.0.1', () => r()));
    const addr = fake.address();
    apiUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>(r => fake.close(() => r())));

describe('AgoraHttpMcp', () => {
    let mcp: AgoraHttpMcp;
    let url: URL;
    const clients: Client[] = [];

    beforeEach(async () => {
        seen.length = 0;
        mcp = new AgoraHttpMcp({ apiUrl, port: 0, host: '127.0.0.1', maxSessionsPerToken: 2, log: () => {} });
        url = new URL(`http://127.0.0.1:${await mcp.listen()}/mcp`);
        return async () => {
            await Promise.all(clients.splice(0).map(c => c.close().catch(() => {})));
            await mcp.close();
        };
    });

    async function connect(token: string, name = 'openclaw', headers: Record<string, string> = {}) {
        const client = new Client({ name, version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bot ${token}`, ...headers } } });
        await client.connect(transport);
        clients.push(client);
        return { client, transport };
    }

    const post = (body: unknown, headers: Record<string, string> = {}) => fetch(url, {
        method: 'POST', body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    });
    const initBody = (name?: string) => ({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: name ? { name, version: '1' } : { version: '1' } } });

    it('answers its health check without a token', async () => {
        const res = await fetch(new URL('/mcp/health', url));
        expect(res.status).toBe(200);
    });

    it('refuses a request without a token, with WWW-Authenticate', async () => {
        const res = await post(initBody('openclaw'));
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
    });

    it('refuses a token Agora refuses', async () => {
        const res = await post(initBody('openclaw'), { Authorization: 'Bearer nope' });
        expect(res.status).toBe(401);
        expect(mcp.sessionCount).toBe(0);
    });

    it('refuses an initialize that names no client', async () => {
        const res = await post(initBody(), { Authorization: `Bot ${GOOD}` });
        expect(res.status).toBe(400);
        expect((await res.json()).error.message).toMatch(/X-Agora-Client/);
        expect(seen).toHaveLength(0);
    });

    it('passes on Agora\'s binding refusal', async () => {
        const res = await post(initBody('openclaw'), { Authorization: `Bot ${BOUND}` });
        expect(res.status).toBe(403);
        expect((await res.json()).error.message).toMatch(/belongs to codex-mcp-client/);
    });

    it('serves the stdio tool set without file_upload, as the named client', async () => {
        const { client } = await connect(GOOD, 'openclaw');
        const tools = (await client.listTools()).tools.map(t => t.name);
        expect(tools).toEqual(expect.arrayContaining(['chat_send', 'chat_read', 'chat_wait', 'thread_start', 'file_read']));
        expect(tools).not.toContain('file_upload');
        const wait = (await client.listTools()).tools.find(t => t.name === 'chat_wait');
        expect(wait?.description).toMatch(/up to 1500s/);

        const result = await client.callTool({ name: 'chat_send', arguments: { channel: 'general', message: 'hello over http' } });
        expect(JSON.stringify(result.content)).toMatch(/01HX/);
        const sent = seen.find(s => s.method === 'POST' && s.path.startsWith('/channels/ch1/messages'));
        expect(sent).toMatchObject({ auth: `Bot ${GOOD}`, client: 'openclaw' });
        expect(sent?.forwarded).toMatch(/127\.0\.0\.1/);
    });

    it('lets the X-Agora-Client header name the client', async () => {
        await connect(BOUND, 'something-else', { 'X-Agora-Client': 'codex-mcp-client' });
        expect(seen.every(s => s.client === 'codex-mcp-client')).toBe(true);
    });

    it('refuses a session id used with another token, and an unknown one', async () => {
        const { transport } = await connect(GOOD);
        const id = transport.sessionId!;
        const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
        const other = await post(list, { Authorization: `Bot ${BOUND}`, 'Mcp-Session-Id': id, 'MCP-Protocol-Version': '2025-06-18' });
        expect(other.status).toBe(403);
        const unknown = await post(list, { Authorization: `Bot ${GOOD}`, 'Mcp-Session-Id': 'nope', 'MCP-Protocol-Version': '2025-06-18' });
        expect(unknown.status).toBe(404);
    });

    it('closes the oldest idle session past the per-token cap', async () => {
        const a = await connect(GOOD);
        await connect(GOOD);
        await connect(GOOD);
        expect(mcp.sessionCount).toBe(2);
        await expect(a.client.listTools()).rejects.toThrow();
    });

    it('refuses an oversized initialize before reading it, without a session', async () => {
        const big = { ...initBody('openclaw'), params: { ...initBody('openclaw').params, padding: 'x'.repeat(100 * 1024) } };
        const res = await post(big, { Authorization: `Bot ${GOOD}` });
        expect(res.status).toBe(413);
        expect(seen).toHaveLength(0);
    });

    it('never lets a refused token close another bot\'s session at the endpoint cap', async () => {
        await mcp.close();
        mcp = new AgoraHttpMcp({ apiUrl, port: 0, host: '127.0.0.1', maxSessions: 1, log: () => {} });
        url = new URL(`http://127.0.0.1:${await mcp.listen()}/mcp`);
        const first = await connect(GOOD);
        expect((await post(initBody('openclaw'), { Authorization: 'Bot garbage' })).status).toBe(401);
        expect((await post(initBody('x'), { Authorization: `Bot ${BOUND}`, 'X-Agora-Client': 'codex-mcp-client' })).status).toBe(429);
        expect(mcp.sessionCount).toBe(1);
        expect((await first.client.listTools()).tools.length).toBeGreaterThan(5);
    });

    it('holds the per-token cap under concurrent initializes', async () => {
        const results = await Promise.allSettled(Array.from({ length: 6 }, () => post(initBody('openclaw'), { Authorization: `Bot ${GOOD}` })));
        const ok = results.filter(r => r.status === 'fulfilled' && r.value.status === 200).length;
        expect(ok).toBeGreaterThan(0);
        expect(mcp.sessionCount).toBeLessThanOrEqual(2);
    });

    it('ends a session on DELETE and on idle', async () => {
        const { transport } = await connect(GOOD);
        expect(mcp.sessionCount).toBe(1);
        await transport.terminateSession();
        await new Promise(r => setTimeout(r, 20));
        expect(mcp.sessionCount).toBe(0);

        await connect(GOOD);
        mcp.sweep(Date.now() + 31 * 60_000);
        await new Promise(r => setTimeout(r, 20));
        expect(mcp.sessionCount).toBe(0);
    });
});
