import { afterEach, expect, it, vi } from 'vitest';
import { AgoraApi, mcpClientName } from '../src/api.js';

/**
 * #39: every request names the MCP client that launched agora-mcp (`X-Agora-Client`).
 * Agora binds the bot token to the first client named and refuses it from any other.
 */

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); });

const headersOf = (fetcher: ReturnType<typeof vi.fn>) =>
    fetcher.mock.calls.map(call => (call as unknown as [string, RequestInit])[1].headers as Record<string, string>);

it('sends no client name before the MCP client has initialized, and its clientInfo.name after', async () => {
    const fetcher = vi.fn(async () => json({ id: 'b', username: 'scout' }));
    vi.stubGlobal('fetch', fetcher);
    const api = new AgoraApi('http://agora.test', 'bot_x.y');
    let name: string | undefined;
    api.setClient(() => mcpClientName(name));

    await api.getMe();
    name = 'claude-code';
    await api.getMe();

    const [before, after] = headersOf(fetcher);
    expect(before).toEqual({ Authorization: 'Bot bot_x.y' });
    expect(after).toEqual({ Authorization: 'Bot bot_x.y', 'X-Agora-Client': 'claude-code' });
});

it('names the client on code runs and screenshots too, which bypass request()', async () => {
    const fetcher = vi.fn(async () => json({ id: 'run', status: 'queued' }, 201));
    vi.stubGlobal('fetch', fetcher);
    const api = new AgoraApi('http://agora.test', 'bot_x.y');
    api.setClient(() => 'codex-mcp-client');
    await api.submitRun({ code: '1', channelId: 'c' });
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    await api.getPreviewScreenshot('c', 'p');
    for (const headers of headersOf(fetcher)) expect(headers['X-Agora-Client']).toBe('codex-mcp-client');
});

it('drops a client name that could not be sent as a header', () => {
    expect(mcpClientName(' claude-code ')).toBe('claude-code');
    for (const bad of [undefined, '', '   ', 'a\nX-Evil: 1', 'ключ', 'x'.repeat(101), 42]) expect(mcpClientName(bad)).toBeNull();
});
