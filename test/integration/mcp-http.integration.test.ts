import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { AgoraHttpMcp } from '../../agora-mcp/src/http';
import { Client } from '../../agora-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../agora-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';

/**
 * The Streamable HTTP MCP endpoint (`agora-mcp http`, docs/mcp-http.md) against a real Agora:
 * bot-token auth, the client binding (#39), the shared tool set, and chat_wait inside one
 * HTTP request.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let mcp: AgoraHttpMcp;
let url: URL;
const clients: Client[] = [];

async function makeBot(username: string) {
    const created = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    const token = await ctx.request.post(`/servers/${serverId}/bots/${id}/tokens`).set(owner.auth).send({ name: 'nemoclaw' });
    expect(token.status).toBe(201);
    expect((await ctx.request.post(`/channels/${channelId}/bots/${id}`).set(owner.auth)).status).toBe(201);
    return { id, token: token.body.token as string, tokenId: token.body.tokenId as string };
}

async function connect(token: string, name: string, headers: Record<string, string> = {}) {
    const client = new Client({ name, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } } });
    await client.connect(transport);
    clients.push(client);
    return client;
}

const text = (result: any) => (result.content as { type: string; text: string }[]).map(c => c.text).join('\n');

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = ctx.app.server.address();
    if (typeof addr === 'string' || !addr) throw new Error('no server address');
    owner = await authedUser(ctx.request, 'httpowner');
    const server = await createServer(ctx.request, owner.auth, 'MCP over HTTP');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 1000, max_bot_hops = 1000 WHERE id = $1', [channelId]);

    mcp = new AgoraHttpMcp({ apiUrl: `http://127.0.0.1:${addr.port}`, port: 0, host: '127.0.0.1', maxWaitSeconds: 20, log: () => {} });
    url = new URL(`http://127.0.0.1:${await mcp.listen()}/mcp`);
});

afterEach(async () => {
    await Promise.all(clients.splice(0).map(c => c.close().catch(() => {})));
});

afterAll(async () => {
    await mcp?.close();
    await ctx.close();
});

describe('agora-mcp http', () => {
    test('a bot posts and reads through the endpoint, and its token binds to the client it named', async () => {
        const bot = await makeBot('nemo-http');
        const client = await connect(bot.token, 'openclaw');

        const tools = (await client.listTools()).tools.map(t => t.name);
        expect(tools).toEqual(expect.arrayContaining(['chat_send', 'chat_read', 'chat_wait', 'channel_list', 'thread_start']));
        expect(tools).not.toContain('file_upload');

        const sent = await client.callTool({ name: 'chat_send', arguments: { channel: 'general', message: 'hello from http' } });
        expect(sent.isError).toBeFalsy();
        const row = await ctx.db.query('SELECT content FROM messages WHERE author_id = $1', [bot.id]);
        expect(row.rows.map((r: any) => r.content)).toEqual(['hello from http']);

        await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'human reply' });
        const read = await client.callTool({ name: 'chat_read', arguments: { channel: 'general' } });
        expect(text(read)).toContain('human reply');

        const token = await ctx.db.query('SELECT bound_client FROM bot_tokens WHERE id = $1', [bot.tokenId]);
        expect(token.rows[0].bound_client.trim()).toBe('openclaw');
    });

    test('a token bound to another client is refused at initialize', async () => {
        const bot = await makeBot('nemo-bound');
        await ctx.db.query("UPDATE bot_tokens SET bound_client = 'codex-mcp-client' WHERE id = $1", [bot.tokenId]);
        await expect(connect(bot.token, 'openclaw')).rejects.toThrow(/403|belongs to codex-mcp-client/);
        // The header names the client instead of clientInfo
        const client = await connect(bot.token, 'openclaw', { 'X-Agora-Client': 'codex-mcp-client' });
        expect((await client.listTools()).tools.length).toBeGreaterThan(5);
    });

    test('a bad token, a missing token and an unnamed client are refused before any session exists', async () => {
        const before = mcp.sessionCount;
        await expect(connect('not-a-token', 'openclaw')).rejects.toThrow(/401|refused/);
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }) });
        expect(res.status).toBe(401);
        const bot = await makeBot('nemo-unnamed');
        const unnamed = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bot ${bot.token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { version: '1' } } }) });
        expect(unnamed.status).toBe(400);
        expect(mcp.sessionCount).toBe(before);
        const token = await ctx.db.query('SELECT bound_client FROM bot_tokens WHERE id = $1', [bot.tokenId]);
        expect(token.rows[0].bound_client).toBeNull();
    });

    test('chat_wait returns a message posted while it waits, inside one HTTP request', async () => {
        const bot = await makeBot('nemo-wait');
        const client = await connect(bot.token, 'openclaw');
        // Catch up first, so the wait sees only what is posted next
        await client.callTool({ name: 'chat_read', arguments: { channel: 'general' } });

        const waiting = client.callTool({ name: 'chat_wait', arguments: { channel: 'general', timeout: 15 } }, undefined, { timeout: 30_000 });
        await new Promise(r => setTimeout(r, 1500));
        await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'ping while you wait' });
        const result = await waiting;
        expect(text(result)).toContain('ping while you wait');
    });

    test('a chat_wait whose client disconnects stops and leaves later messages unread', async () => {
        const bot = await makeBot('nemo-drop');
        const client = new Client({ name: 'openclaw', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bot ${bot.token}` } } });
        await client.connect(transport);
        clients.push(client);
        await client.callTool({ name: 'chat_read', arguments: { channel: 'general' } });

        // A raw tools/call on the session, dropped mid-wait with no notifications/cancelled
        const abort = new AbortController();
        const call = fetch(url, { method: 'POST', signal: abort.signal, headers: {
            'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bot ${bot.token}`,
            'Mcp-Session-Id': transport.sessionId!, 'MCP-Protocol-Version': '2025-06-18',
        }, body: JSON.stringify({ jsonrpc: '2.0', id: 'drop-1', method: 'tools/call', params: { name: 'chat_wait', arguments: { channel: 'general', timeout: 15 } } }) });
        const res = await call;
        expect(res.status).toBe(200);
        await new Promise(r => setTimeout(r, 500));
        abort.abort();
        await new Promise(r => setTimeout(r, 500));

        await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'posted after the drop' });
        // Longer than chat_wait's 2 s poll: an orphaned wait would have read (and acknowledged) it by now
        await new Promise(r => setTimeout(r, 4500));
        const read = await client.callTool({ name: 'chat_read', arguments: { channel: 'general' } });
        expect(text(read)).toContain('posted after the drop');
    });

    test('chat_wait times out cleanly and is capped at the endpoint maximum', async () => {
        const bot = await makeBot('nemo-timeout');
        const client = await connect(bot.token, 'openclaw');
        await client.callTool({ name: 'chat_read', arguments: { channel: 'general' } });
        const wait = (await client.listTools()).tools.find(t => t.name === 'chat_wait');
        expect(wait?.description).toMatch(/up to 20s/);
        const result = await client.callTool({ name: 'chat_wait', arguments: { channel: 'general', timeout: 2 } });
        expect(text(result)).toMatch(/no new messages after 2s/);
    });
});
