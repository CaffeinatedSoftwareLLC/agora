import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { registerTools, wakesAgent } from '../src/tools.js';
import { CursorTracker } from '../src/cursor.js';
import type { AgoraApi, Message } from '../src/api.js';

function msg(id: string, content: string, opts: Partial<Message> = {}): Message {
    return {
        id,
        content,
        authorId: 'peer',
        authorUsername: 'sol',
        authorBot: true,
        channelId: 'ch1',
        createdAt: '2026-01-01T00:00:00Z',
        ...opts,
    };
}

const turn = (to: string) => `[AGORA/v1 MODE=plan STATE=TURN]\nmy take\n[YIELD to=${to}]`;

describe('wakesAgent', () => {
    it('sleeps through a TURN that yields to another agent', () => {
        expect(wakesAgent(msg('1', turn('gemini')), 'claude')).toBe(false);
    });

    it('wakes on a YIELD to itself, case-insensitively and with @', () => {
        expect(wakesAgent(msg('1', turn('Claude')), 'claude')).toBe(true);
        expect(wakesAgent(msg('1', turn('@claude')), 'claude')).toBe(true);
    });

    it('wakes on humans, system events, and bot messages without a YIELD', () => {
        expect(wakesAgent(msg('1', turn('gemini'), { authorBot: false }), 'claude')).toBe(true);
        expect(wakesAgent(msg('1', 'Loop guard', { systemEvent: 'loop_guard', authorBot: false }), 'claude')).toBe(true);
        expect(wakesAgent(msg('1', '[AGORA/v1 MODE=plan STATE=DECIDE]\nAGREE'), 'claude')).toBe(true);
        expect(wakesAgent(msg('1', '[AGORA/v1 MODE=plan STATE=ACK]\nready'), 'claude')).toBe(true);
    });

    it('only honors YIELD on the last line', () => {
        expect(wakesAgent(msg('1', '[YIELD to=gemini]\nactually, over to anyone'), 'claude')).toBe(true);
    });
});

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }>;

/** Registers the real tools on a fake server over a mutable thread, returning the chat_wait handler. */
function setup(replies: Message[]) {
    const api = {
        getMe: vi.fn().mockResolvedValue({
            id: 'self', username: 'claude', serverId: 's1', bot: true,
            channels: [{ id: 'ch1', name: 'general', channelType: 'text' }],
        }),
        getReplies: vi.fn().mockImplementation(async (_c: string, _t: string, opts?: { limit?: number; after?: string }) => {
            const filtered = opts?.after ? replies.filter(r => r.id > opts.after!) : replies;
            return filtered.slice(0, opts?.limit ?? 50);
        }),
        getThreadCursors: vi.fn().mockResolvedValue([{ threadId: 't1', channelId: 'ch1', lastReadId: '0', updatedAt: '' }]),
        updateThreadCursor: vi.fn().mockResolvedValue({}),
        getCursors: vi.fn().mockResolvedValue([]),
    } as unknown as AgoraApi;

    const handlers = new Map<string, Handler>();
    const server = { tool: (name: string, ...rest: unknown[]) => handlers.set(name, rest[rest.length - 1] as Handler) };
    registerTools(server as never, api, new CursorTracker(api), { defaultChannel: 'general' });

    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const controller = new AbortController();
    const extra = (progressToken?: string) => ({
        signal: controller.signal,
        sendNotification,
        _meta: progressToken ? { progressToken } : undefined,
    });
    return { wait: handlers.get('chat_wait')!, extra, sendNotification, controller };
}

describe('chat_wait', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('until=turn waits past other agents\' turns and returns them with its own', async () => {
        const replies = [msg('1', turn('gemini'))];
        const { wait, extra } = setup(replies);

        const pending = wait({ thread: 't1', timeout: 600, until: 'turn' }, extra());
        await vi.advanceTimersByTimeAsync(10_000);
        replies.push(msg('2', turn('claude'), { authorUsername: 'gemini' }));
        await vi.advanceTimersByTimeAsync(2_000);

        const text = (await pending).content[0].text;
        expect(text).toContain('2 new message(s)');
        expect(text).toContain('(1) sol');
        expect(text).toContain('(2) gemini');
    });

    it('until=any returns on the first message', async () => {
        const { wait, extra } = setup([msg('1', turn('gemini'))]);
        const text = (await wait({ thread: 't1', until: 'any' }, extra())).content[0].text;
        expect(text).toContain('1 new message(s)');
    });

    it('allows waits past the old 120s cap and returns messages read for others on timeout', async () => {
        const { wait, extra } = setup([msg('1', turn('gemini'))]);

        const pending = wait({ thread: 't1', timeout: 300, until: 'turn' }, extra());
        await vi.advanceTimersByTimeAsync(200_000);
        let settled = false;
        pending.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(101_000);
        const text = (await pending).content[0].text;
        expect(text).toContain('not your turn yet after 300s');
        expect(text).toContain('(1) sol');
    });

    it('sends progress notifications when the client passed a progress token', async () => {
        const { wait, extra, sendNotification, controller } = setup([]);

        const pending = wait({ thread: 't1', timeout: 3600 }, extra('tok'));
        await vi.advanceTimersByTimeAsync(40_000);
        controller.abort();
        await vi.advanceTimersByTimeAsync(5_000);
        await pending;

        expect(sendNotification).toHaveBeenCalled();
        expect(sendNotification.mock.calls[0][0]).toMatchObject({
            method: 'notifications/progress',
            params: { progressToken: 'tok' },
        });
    });

    it('sends no progress without a token', async () => {
        const { wait, extra, sendNotification, controller } = setup([]);
        const pending = wait({ thread: 't1', timeout: 3600 }, extra());
        await vi.advanceTimersByTimeAsync(40_000);
        controller.abort();
        await vi.advanceTimersByTimeAsync(5_000);
        await pending;
        expect(sendNotification).not.toHaveBeenCalled();
    });
});
