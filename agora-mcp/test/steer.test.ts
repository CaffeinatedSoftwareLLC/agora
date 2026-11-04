import { describe, expect, it, vi } from 'vitest';
import { registerTools } from '../src/tools.js';
import { CursorTracker } from '../src/cursor.js';
import type { AgoraApi, Message } from '../src/api.js';

/** The reply guard is bookkeeping: it must never turn a post or a read into an error, or skip retrying. */

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const ME = { id: 'B1', username: 'Codex', serverId: 'S', bot: true, channels: [{ id: 'C1', name: 'general', type: 3 }] };
const START: Message = { id: '01M6M3000000000000000000T1', content: '[AGORA/v1 MODE=review STATE=START]\nDesign review\nparticipants: [Claude, Codex]\n[YIELD to=Codex]',
    authorId: 'B2', authorUsername: 'Claude', authorBot: true, channelId: 'C1', createdAt: '2026-11-04T20:00:00Z' };

function harness(api: Partial<AgoraApi>) {
    const handlers = new Map<string, Handler>();
    const server = { tool: (name: string, ...rest: unknown[]) => handlers.set(name, rest[rest.length - 1] as Handler) };
    registerTools(server as never, api as AgoraApi, new CursorTracker(api as AgoraApi), { defaultChannel: 'general' });
    return (name: string, args: Record<string, unknown> = {}) => handlers.get(name)!(args, {});
}

describe('identity first, tracking best effort', () => {
    it('chat_send and thread_start fail before posting when the bot\'s identity can\'t be read', async () => {
        const sendMessage = vi.fn(async () => ({ ...START, id: 'M1', authorId: 'B1' }));
        const call = harness({ getMe: vi.fn(async () => { throw new Error('Agora API 503 GET /bots/@me'); }), sendMessage });
        await expect(call('chat_send', { message: 'hello' })).rejects.toThrow(/503/);
        await expect(call('thread_start', { message: 'topic' })).rejects.toThrow(/503/);
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('a failing parent lookup neither fails the read nor stops the next read from trying again', async () => {
        const getMessages = vi.fn()
            .mockRejectedValueOnce(new Error('Agora API 503 GET messages'))
            .mockResolvedValue([START]);
        const sendMessage = vi.fn(async () => ({ ...START, id: 'M9', authorId: 'B1', content: 'x' }));
        const call = harness({
            getMe: vi.fn(async () => ME as never),
            getMessages,
            getReplies: vi.fn(async () => [] as Message[]),
            getThreadNow: vi.fn(async () => ({ open: true, replies: [] })),
            sendMessage,
        });
        const first = await call('chat_history', { thread: START.id });
        expect(first.isError).toBeFalsy();
        // Not armed yet: the parent was never seen
        expect((await call('chat_send', { message: 'one' })).isError).toBeFalsy();
        await call('chat_history', { thread: START.id });
        const refused = await call('chat_send', { message: 'two' });
        expect(refused.isError).toBe(true);
        expect(refused.content[0].text).toContain(`pending turn in thread ${START.id}`);
        expect(getMessages).toHaveBeenCalledTimes(2);
        expect(sendMessage).toHaveBeenCalledTimes(1);
    });
});
