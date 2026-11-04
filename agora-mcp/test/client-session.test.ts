import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { AgoraApi } from '../src/api.js';
import { CLIENT_INFO_META, ClientSession, configuredClientName, observeTransport } from '../src/client-session.js';

/**
 * #299: MCP 2026-07-28 drops `initialize`. agora-mcp must still learn the client's name (the
 * #39 token binding) and start its socket, from per-request `_meta`, and keep today's clients
 * (initialize + notifications/initialized) working exactly as before.
 */

/** A server like serve.ts builds: one tool that reports the client name it sees while it runs. */
async function harness(configured: string | null = null) {
    const server = new McpServer({ name: 'agora', version: 'test' });
    const onStart = vi.fn();
    const session = new ClientSession({ initializeName: () => server.server.getClientVersion()?.name, configured, onStart });
    const seen: (string | null)[] = [];
    server.registerTool('whoami', { description: 'client name' }, async () => {
        seen.push(session.name());
        return { content: [{ type: 'text', text: session.name() ?? '(none)' }] };
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    observeTransport(serverSide, session);
    return { server, session, onStart, seen, clientSide };
}

/** A 2026-07-28 client: no initialize, everything in each request's _meta. */
function statelessClient(transport: InMemoryTransport, clientInfo?: { name: string; version: string }) {
    const replies = new Map<number, JSONRPCMessage>();
    transport.onmessage = m => { if ('id' in m && typeof m.id === 'number') replies.set(m.id, m); };
    let id = 0;
    const meta = () => ({
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        ...(clientInfo ? { [CLIENT_INFO_META]: clientInfo } : {}),
    });
    return {
        async call(method: string, params: Record<string, unknown> = {}) {
            const n = ++id;
            await transport.start();
            await transport.send({ jsonrpc: '2.0', id: n, method, params: { ...params, _meta: meta() } });
            await vi.waitFor(() => expect(replies.has(n)).toBe(true));
            return replies.get(n) as any;
        },
    };
}

describe('a stateless (2026-07-28) client', () => {
    it('starts the session on its first request and names itself from _meta before the tool runs', async () => {
        const h = await harness();
        const client = statelessClient(h.clientSide, { name: 'modern-cli', version: '9.0.0' });

        const list = await client.call('tools/list');
        expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['whoami']);
        expect(h.onStart).toHaveBeenCalledTimes(1);

        const call = await client.call('tools/call', { name: 'whoami', arguments: {} });
        expect(call.result.content[0].text).toBe('modern-cli');
        expect(h.seen).toEqual(['modern-cli']);
        expect(h.onStart).toHaveBeenCalledTimes(1);
        expect(h.server.server.getClientVersion()).toBeUndefined();
    });

    it('sends that name to Agora as X-Agora-Client', async () => {
        const h = await harness();
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'b' }), { status: 200, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetcher);
        try {
            const api = new AgoraApi('http://agora.test', 'bot_x.y');
            api.setClient(() => h.session.name());
            h.server.registerTool('me', { description: 'me' }, async () => { await api.getMe(); return { content: [] }; });
            await statelessClient(h.clientSide, { name: 'modern-cli', version: '1' }).call('tools/call', { name: 'me', arguments: {} });
            const headers = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
            expect(headers['X-Agora-Client']).toBe('modern-cli');
        } finally { vi.unstubAllGlobals(); }
    });

    it('does not start on ping or on a server/discover probe, which agora-mcp does not answer yet', async () => {
        const h = await harness();
        const client = statelessClient(h.clientSide, { name: 'modern-cli', version: '1' });
        await client.call('ping');
        expect(h.onStart).not.toHaveBeenCalled();
        // The 1.x SDK has no server/discover: a dual-era client gets "method not found" and falls back to initialize
        const discover = await client.call('server/discover');
        expect(discover.error.code).toBe(-32601);
        // The client may now fall back to initialize: nothing may start before it has
        expect(h.onStart).not.toHaveBeenCalled();
        await client.call('tools/list');
        expect(h.onStart).toHaveBeenCalledTimes(1);
    });

    it('falls back to --client, and names no client when there is none', async () => {
        const configured = await harness('codex-mcp-client');
        await statelessClient(configured.clientSide).call('tools/call', { name: 'whoami', arguments: {} });
        expect(configured.seen).toEqual(['codex-mcp-client']);

        const bare = await harness();
        await statelessClient(bare.clientSide).call('tools/call', { name: 'whoami', arguments: {} });
        expect(bare.seen).toEqual([null]);
        expect(bare.onStart).toHaveBeenCalledTimes(1);
    });

    it('ignores a clientInfo name that could not be sent as a header', async () => {
        const h = await harness('fallback');
        await statelessClient(h.clientSide, { name: 'a\nX-Evil: 1', version: '1' }).call('tools/call', { name: 'whoami', arguments: {} });
        expect(h.seen).toEqual(['fallback']);
    });
});

describe('one client identity per process', () => {
    it('keeps the first name used when a later request names another client', async () => {
        const h = await harness();
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            await statelessClient(h.clientSide, { name: 'first-cli', version: '1' }).call('tools/call', { name: 'whoami', arguments: {} });
            const replies: JSONRPCMessage[] = [];
            h.clientSide.onmessage = m => { replies.push(m); };
            await h.clientSide.send({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'whoami', arguments: {},
                _meta: { [CLIENT_INFO_META]: { name: 'other-cli', version: '1' } } } });
            await vi.waitFor(() => expect(replies).toHaveLength(1));
            expect(h.seen).toEqual(['first-cli', 'first-cli']);
            expect(stderr.mock.calls.map(c => String(c[0])).join('')).toMatch(/named itself other-cli after first-cli/);
        } finally { stderr.mockRestore(); }
    });
});

describe('a dual-era client that probes, then initializes', () => {
    it('starts nothing on the failed probe or initialize, then exactly once on initialized', async () => {
        const h = await harness();
        const replies: JSONRPCMessage[] = [];
        h.clientSide.onmessage = m => { replies.push(m); };
        await h.clientSide.start();
        await h.clientSide.send({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28', [CLIENT_INFO_META]: { name: 'claude-code', version: '3' } } } });
        await vi.waitFor(() => expect(replies).toHaveLength(1));
        expect((replies[0] as any).error.code).toBe(-32601);
        await h.clientSide.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {
            protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '3' } } });
        await vi.waitFor(() => expect(replies).toHaveLength(2));
        expect(h.onStart).not.toHaveBeenCalled();
        await h.clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await vi.waitFor(() => expect(h.onStart).toHaveBeenCalledTimes(1));
        await h.clientSide.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
        await vi.waitFor(() => expect(replies).toHaveLength(3));
        expect(h.onStart).toHaveBeenCalledTimes(1);
        expect(h.session.name()).toBe('claude-code');
    });
});

describe('a client that initializes (every client today)', () => {
    it('starts once, on notifications/initialized, and is named by initialize', async () => {
        const h = await harness('configured-name');
        const client = new Client({ name: 'claude-code', version: '2.1.0' });
        const connecting = client.connect(h.clientSide);
        await connecting;
        await vi.waitFor(() => expect(h.onStart).toHaveBeenCalledTimes(1));

        const result = await client.callTool({ name: 'whoami', arguments: {} });
        expect((result.content as { text: string }[])[0].text).toBe('claude-code');
        await client.listTools();
        expect(h.onStart).toHaveBeenCalledTimes(1);
        await client.close();
    });

    it('does not start before initialized: initialize alone is not a start', async () => {
        const h = await harness();
        const replies: JSONRPCMessage[] = [];
        h.clientSide.onmessage = m => { replies.push(m); };
        await h.clientSide.start();
        await h.clientSide.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
            protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' },
        } });
        await vi.waitFor(() => expect(replies).toHaveLength(1));
        expect(h.onStart).not.toHaveBeenCalled();
        expect(h.session.name()).toBe('claude-code');
        await h.clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await vi.waitFor(() => expect(h.onStart).toHaveBeenCalledTimes(1));
    });
});

it('reads --client before AGORA_CLIENT and refuses a name that is not a header value', () => {
    expect(configuredClientName(['--client', 'codex-mcp-client'], { AGORA_CLIENT: 'other' })).toBe('codex-mcp-client');
    expect(configuredClientName([], { AGORA_CLIENT: ' claude-code ' })).toBe('claude-code');
    expect(configuredClientName([], {})).toBeNull();
    expect(() => configuredClientName(['--client', 'ключ'], {})).toThrow(/printable ASCII/);
});
