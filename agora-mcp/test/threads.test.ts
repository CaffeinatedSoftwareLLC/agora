import { describe, it, expect, vi } from 'vitest';
import { fetchUnreadReplies, formatMessages, formatThreads } from '../src/tools.js';
import { CursorTracker } from '../src/cursor.js';
import type { AgoraApi, Message, ThreadCursor } from '../src/api.js';

const channelId = 'ch1';
const threadId = 't1';

function msg(id: string, content = `content-${id}`): Message {
    return {
        id,
        content,
        authorId: 'user1',
        authorUsername: 'alice',
        authorBot: false,
        channelId,
        createdAt: '2025-01-01T00:00:00Z',
    };
}

/** Mock API over an oldest-first reply list, honoring `after` and `limit` like the real endpoint. */
function createReplyApi(replies: Message[] = [], threadCursors: { threadId: string; lastReadId: string }[] = []) {
    return {
        getReplies: vi.fn<(c: string, t: string, opts?: { limit?: number; after?: string }) => Promise<Message[]>>()
            .mockImplementation(async (_c, _t, opts) => {
                const filtered = opts?.after ? replies.filter(r => r.id > opts.after!) : replies;
                return filtered.slice(0, opts?.limit ?? 50);
            }),
        getThreadCursors: vi.fn<() => Promise<ThreadCursor[]>>().mockResolvedValue(
            threadCursors.map(c => ({ ...c, channelId, updatedAt: '2025-01-01' })),
        ),
        updateThreadCursor: vi.fn<(t: string, id: string) => Promise<{ threadId: string; channelId: string; lastReadId: string }>>()
            .mockImplementation(async (t, id) => ({ threadId: t, channelId, lastReadId: id })),
        getCursors: vi.fn().mockResolvedValue([]),
        updateCursor: vi.fn(),
    } as unknown as AgoraApi & {
        getReplies: ReturnType<typeof vi.fn>;
        getThreadCursors: ReturnType<typeof vi.fn>;
        updateThreadCursor: ReturnType<typeof vi.fn>;
        updateCursor: ReturnType<typeof vi.fn>;
    };
}

describe('CursorTracker thread cursors', () => {
    it('loadThreads() fetches once and exposes cursors by thread', async () => {
        const api = createReplyApi([], [{ threadId: 't1', lastReadId: 'r5' }]);
        const tracker = new CursorTracker(api);

        await tracker.loadThreads();
        await tracker.loadThreads();

        expect(api.getThreadCursors).toHaveBeenCalledOnce();
        expect(tracker.getThreadCursor('t1')).toBe('r5');
        expect(tracker.getThreadCursor('t2')).toBeUndefined();
    });

    it('ackThread() advances the cursor and persists it', async () => {
        const api = createReplyApi();
        const tracker = new CursorTracker(api);

        await tracker.ackThread('t1', 'r3');

        expect(api.updateThreadCursor).toHaveBeenCalledWith('t1', 'r3');
        expect(tracker.getThreadCursor('t1')).toBe('r3');
    });

    it('ackThread() never moves backward', async () => {
        const api = createReplyApi([], [{ threadId: 't1', lastReadId: 'r5' }]);
        const tracker = new CursorTracker(api);
        await tracker.loadThreads();

        await tracker.ackThread('t1', 'r3');
        await tracker.ackThread('t1', 'r5');

        expect(api.updateThreadCursor).not.toHaveBeenCalled();
        expect(tracker.getThreadCursor('t1')).toBe('r5');
    });

    it('thread acks do not touch channel cursors', async () => {
        const api = createReplyApi();
        const tracker = new CursorTracker(api);

        await tracker.ackThread('ch1', 'r9');

        expect(tracker.getThreadCursor('ch1')).toBe('r9');
        expect(tracker.getCursor('ch1')).toBeUndefined();
        expect(api.updateCursor).not.toHaveBeenCalled();
    });
});

describe('fetchUnreadReplies', () => {
    it('first read returns newest replies when the thread fits the scan window', async () => {
        const api = createReplyApi([msg('r1'), msg('r2'), msg('r3'), msg('r4')]);
        const tracker = new CursorTracker(api);

        const result = await fetchUnreadReplies(api, tracker, channelId, threadId, 2, 100);

        expect(result.map(m => m.id)).toEqual(['r3', 'r4']);
        expect(api.updateThreadCursor).toHaveBeenCalledWith(threadId, 'r4');
    });

    it('first read pages forward across multiple pages', async () => {
        const api = createReplyApi([msg('r1'), msg('r2'), msg('r3'), msg('r4'), msg('r5')]);
        const tracker = new CursorTracker(api);

        const result = await fetchUnreadReplies(api, tracker, channelId, threadId, 10, 2);

        expect(result.map(m => m.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
        expect(api.getReplies).toHaveBeenCalledTimes(3);
    });

    it('first read beyond the scan cap returns oldest and the next call continues', async () => {
        const api = createReplyApi([msg('r1'), msg('r2'), msg('r3'), msg('r4'), msg('r5')]);
        const tracker = new CursorTracker(api);

        const first = await fetchUnreadReplies(api, tracker, channelId, threadId, 2, 2, 4);
        expect(first.map(m => m.id)).toEqual(['r1', 'r2']);

        const second = await fetchUnreadReplies(api, tracker, channelId, threadId, 10, 2, 4);
        expect(second.map(m => m.id)).toEqual(['r3', 'r4', 'r5']);
    });

    it('with cursor returns only newer replies, oldest-first, capped at maxMessages', async () => {
        const api = createReplyApi(
            [msg('r1'), msg('r2'), msg('r3'), msg('r4'), msg('r5')],
            [{ threadId, lastReadId: 'r2' }],
        );
        const tracker = new CursorTracker(api);

        const result = await fetchUnreadReplies(api, tracker, channelId, threadId, 2, 100);

        expect(result.map(m => m.id)).toEqual(['r3', 'r4']);
        expect(api.getReplies).toHaveBeenCalledWith(channelId, threadId, { limit: 2, after: 'r2' });
        expect(api.updateThreadCursor).toHaveBeenCalledWith(threadId, 'r4');
    });

    it('with cursor and nothing new returns empty without acking', async () => {
        const api = createReplyApi([msg('r1'), msg('r2')], [{ threadId, lastReadId: 'r2' }]);
        const tracker = new CursorTracker(api);

        const result = await fetchUnreadReplies(api, tracker, channelId, threadId, 10, 100);

        expect(result).toEqual([]);
        expect(api.updateThreadCursor).not.toHaveBeenCalled();
    });

    it('empty thread returns empty without acking', async () => {
        const api = createReplyApi([]);
        const tracker = new CursorTracker(api);

        const result = await fetchUnreadReplies(api, tracker, channelId, threadId, 10, 100);

        expect(result).toEqual([]);
        expect(api.updateThreadCursor).not.toHaveBeenCalled();
    });
});

describe('formatMessages', () => {
    it('includes message IDs so agents can address threads', () => {
        expect(formatMessages([msg('m1', 'hello')])).toBe('[2025-01-01T00:00:00Z] (m1) alice: hello');
    });

    it('annotates thread parents with reply count and closed state', () => {
        const open = { ...msg('m1', 'topic'), replyCount: 3 };
        const closed = { ...msg('m2', 'old'), replyCount: 1, threadClosedAt: '2025-01-02T00:00:00Z' };

        const lines = formatMessages([open, closed]).split('\n');

        expect(lines[0]).toBe('[2025-01-01T00:00:00Z] (m1) alice: topic [thread: 3 replies]');
        expect(lines[1]).toBe('[2025-01-01T00:00:00Z] (m2) alice: old [thread closed: 1 replies]');
    });

    it('marks bot authors', () => {
        const bot = { ...msg('m1', 'hi'), authorBot: true, authorUsername: 'codex' };
        expect(formatMessages([bot])).toBe('[2025-01-01T00:00:00Z] (m1) codex [BOT]: hi');
    });
});

describe('formatThreads', () => {
    it('lists thread IDs with a single-line preview', () => {
        const out = formatThreads([{
            id: 't1',
            content: 'Plan the\nrefactor',
            authorId: 'u1',
            authorUsername: 'claude',
            authorBot: true,
            channelId,
            createdAt: '2025-01-01T00:00:00Z',
            replyCount: 4,
            lastReplyAt: '2025-01-01T01:00:00Z',
        }]);

        expect(out).toBe('(t1) claude [BOT]: Plan the refactor — 4 replies, last 2025-01-01T01:00:00Z');
    });

    it('reports no open threads', () => {
        expect(formatThreads([])).toBe('No open threads.');
    });
});
