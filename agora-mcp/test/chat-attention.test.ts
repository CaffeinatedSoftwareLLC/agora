import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerTools } from '../src/tools.js';
import { CursorTracker } from '../src/cursor.js';
import { AgoraApiError, AgoraApi, type Message } from '../src/api.js';

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }>;
const message = (id: string, threadId: string | null, content = '@claude please read this'): Message => ({
    id, threadId, content, authorId: 'peer', authorUsername: 'codex', authorBot: true,
    channelId: 'C', createdAt: '2026-10-21T00:00:00Z',
});

function fixture(attention: Message[], initialAck?: string, native: Message[] = []) {
    let attentionAck = initialAck;
    const api = {
        getMe: vi.fn().mockResolvedValue({ id: 'self', username: 'claude', serverId: 'S', bot: true,
            channels: [{ id: 'C', name: 'general', channelType: 3 }] }),
        getCursors: vi.fn().mockResolvedValue([{ channelId: 'C', lastReadId: '000', updatedAt: '' }]),
        getThreadCursors: vi.fn().mockResolvedValue([{ threadId: 'A', channelId: 'C', lastReadId: '000', updatedAt: '' }]),
        updateCursor: vi.fn().mockResolvedValue({}),
        updateThreadCursor: vi.fn().mockResolvedValue({}),
        getReplies: vi.fn(async (_channel: string, thread: string, opts?: { after?: string; limit?: number }) =>
            native.filter(m => m.threadId === thread && (!opts?.after || m.id > opts.after)).slice(0, opts?.limit ?? 100)),
        getMessages: vi.fn(async (_channel: string, opts?: { before?: string; limit?: number }) =>
            native.filter(m => !m.threadId && (!opts?.before || m.id < opts.before)).slice().reverse().slice(0, opts?.limit ?? 100)),
        getAttentionCursors: vi.fn(async () => attentionAck ? [{ channelId: 'C', lastReadId: attentionAck, updatedAt: '' }] : []),
        updateAttentionCursor: vi.fn(async (_channel: string, id: string) => { attentionAck = id; return { channelId: 'C', lastReadId: id }; }),
        getAttention: vi.fn(async (_channel: string, opts?: { after?: string; limit?: number }) =>
            attention.filter(m => !opts?.after || m.id > opts.after).slice(0, Math.min(opts?.limit ?? 100, 100))),
    };
    function register() {
        const handlers = new Map<string, Handler>();
        const server = { tool: (name: string, ...args: unknown[]) => handlers.set(name, args[args.length - 1] as Handler) };
        registerTools(server as never, api as unknown as AgoraApi, new CursorTracker(api as unknown as AgoraApi), { defaultChannel: 'general' });
        return handlers.get('chat_wait')!;
    }
    async function read(wait: Handler, args: Record<string, unknown> = { thread: 'A' }) {
        const pending = wait({ timeout: 1, until: 'turn', ...args }, {
            signal: new AbortController().signal, sendNotification: vi.fn().mockResolvedValue(undefined),
        });
        const [result] = await Promise.all([pending, vi.runAllTimersAsync()]);
        return result.content[0].text;
    }
    return { api, read, wait: register(), restart: register };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('a wait in A returns attention from B without marking either thread read', async () => {
    const f = fixture([message('001', 'B')]);
    const text = await f.read(f.wait);
    expect(text).toContain('(001)');
    expect(text).toContain('thread B');
    expect(f.api.updateAttentionCursor).toHaveBeenCalledWith('C', '001');
    expect(f.api.updateCursor).not.toHaveBeenCalled();
    expect(f.api.updateThreadCursor).not.toHaveBeenCalled();
});

it('a thread wait also catches a new top-level address to the caller', async () => {
    const f = fixture([message('001', null)]);
    const text = await f.read(f.wait);
    expect(text).toContain('(001)');
    expect(text).toContain('top-level');
    expect(f.api.updateCursor).not.toHaveBeenCalled();
});

it('a channel wait catches attention in a reply thread', async () => {
    const f = fixture([message('001', 'B')]);
    const text = await f.read(f.wait, {});
    expect(text).toContain('(001)');
    expect(text).toContain('thread B');
    expect(f.api.updateThreadCursor).not.toHaveBeenCalled();
});

it('until=turn returns an off-thread mention even when the message yields to someone else', async () => {
    const f = fixture([message('001', 'B', '[AGORA/v1 MODE=plan STATE=TURN]\n@claude FYI\n[YIELD to=gemini]')]);
    expect(await f.read(f.wait)).toContain('(001)');
});

it('returns a post matching both native scope and attention only once in that result', async () => {
    const post = message('001', 'A');
    const f = fixture([post], undefined, [post]);
    expect((await f.read(f.wait)).match(/\(001\)/g)).toHaveLength(1);
});

it('acknowledges only the returned attention page so a later page cannot be skipped', async () => {
    const posts = Array.from({ length: 101 }, (_, i) => message(String(i + 1).padStart(3, '0'), 'B'));
    const f = fixture(posts);
    const first = await f.read(f.wait);
    expect(first).toContain('(001)');
    expect(first).toContain('(100)');
    expect(first).not.toContain('(101)');
    expect(f.api.updateAttentionCursor).toHaveBeenLastCalledWith('C', '100');
    const second = await f.read(f.wait);
    expect(second).toContain('(101)');
    expect(second).not.toContain('(001)');
    expect(f.api.updateAttentionCursor).toHaveBeenLastCalledWith('C', '101');
});

it('loads the persisted attention cursor on a new MCP instance', async () => {
    const posts = [message('001', 'B')];
    const f = fixture(posts);
    expect(await f.read(f.wait)).toContain('(001)');
    posts.push(message('002', 'B'));
    const next = await f.read(f.restart());
    expect(next).toContain('(002)');
    expect(next).not.toContain('(001)');
    expect(f.api.getAttentionCursors).toHaveBeenCalledTimes(2);
});

it('first use does not baseline away already-pending attention', async () => {
    const f = fixture([message('001', 'B'), message('002', 'B')]);
    const text = await f.read(f.wait);
    expect(text).toContain('(001)');
    expect(text).toContain('(002)');
});

it('reports unsupported server attention rather than silently waiting only in one thread', async () => {
    const f = fixture([]);
    f.api.getAttention.mockRejectedValue(new AgoraApiError('not found', 404, null, {}));
    await expect(f.read(f.wait)).rejects.toThrow(/attention.*support|upgrad/i);
});

it('still delivers the messages when acknowledgement fails, warning that attention may repeat', async () => {
    const f = fixture([message('001', 'B')]);
    f.api.updateAttentionCursor.mockRejectedValueOnce(new Error('database unavailable'));
    const text = await f.read(f.wait);
    expect(text).toContain('(001)');
    expect(text).toContain('notifications may repeat');
    expect(await f.read(f.wait)).toContain('(001)');
    expect(f.api.updateAttentionCursor).toHaveBeenCalledTimes(2);
});

it('an older acknowledgement response cannot rewind the local attention cursor', async () => {
    let finish!: (value: { channelId: string; lastReadId: string }) => void;
    const api = { updateAttentionCursor: vi.fn(async (_c: string, id: string) => id === '001'
        ? new Promise<{ channelId: string; lastReadId: string }>(resolve => { finish = resolve; })
        : { channelId: 'C', lastReadId: id }) };
    const tracker = new CursorTracker(api as unknown as AgoraApi);
    const older = tracker.ackAttention('C', '001');
    await tracker.ackAttention('C', '002');
    finish({ channelId: 'C', lastReadId: '001' }); await older;
    expect(tracker.getAttentionCursor('C')).toBe('002');
});

it('the API client uses the dedicated feed/cursor endpoints and serializes paging and acknowledgement', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response('[]', { status: 200 }))
        .mockResolvedValueOnce(new Response('[]', { status: 200 }))
        .mockResolvedValueOnce(new Response('{"channelId":"C","lastReadId":"M"}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const api = new AgoraApi('http://agora.test', 'test-token');
    await api.getAttention('C', { after: 'M', limit: 5 });
    await api.getAttentionCursors();
    await api.updateAttentionCursor('C', 'M');
    expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method, init?.body])).toEqual([
        ['http://agora.test/channels/C/attention?after=M&limit=5', 'GET', undefined],
        ['http://agora.test/bots/@me/attention-cursors', 'GET', undefined],
        ['http://agora.test/bots/@me/attention-cursors/C', 'PUT', '{"lastReadId":"M"}'],
    ]);
});
