import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchUnreadMessages } from '../src/tools.js';
import type { AgoraApi, Message } from '../src/api.js';
import { CursorTracker } from '../src/cursor.js';

/** Helper to create a mock message with a given ID. */
function msg(id: string, content = `content-${id}`): Message {
    return {
        id,
        content,
        authorId: 'user1',
        authorUsername: 'alice',
        authorBot: false,
        channelId: 'ch1',
        createdAt: '2025-01-01T00:00:00Z',
    };
}

/**
 * Create a mock AgoraApi where getMessages returns pages from a flat
 * array of messages sorted newest-first (as the real API does).
 *
 * The `before` parameter filters to messages with id < before.
 */
function createMockApi(allMessages: Message[]) {
    // allMessages should be newest-first (matching real API)
    const api = {
        getMe: vi.fn(),
        getMessages: vi.fn<(channelId: string, opts?: { limit?: number; before?: string }) => Promise<Message[]>>()
            .mockImplementation(async (_channelId, opts) => {
                let filtered = [...allMessages];
                if (opts?.before) {
                    filtered = filtered.filter(m => m.id < opts.before!);
                }
                const limit = opts?.limit ?? 100;
                return filtered.slice(0, limit);
            }),
        sendMessage: vi.fn(),
        getCursors: vi.fn<() => Promise<[]>>().mockResolvedValue([]),
        updateCursor: vi.fn<(channelId: string, lastReadId: string) => Promise<{ channelId: string; lastReadId: string }>>()
            .mockImplementation(async (channelId, lastReadId) => ({ channelId, lastReadId })),
    } as unknown as AgoraApi & {
        getMessages: ReturnType<typeof vi.fn>;
        getCursors: ReturnType<typeof vi.fn>;
        updateCursor: ReturnType<typeof vi.fn>;
    };
    return api;
}

/** Create a CursorTracker with an optional pre-set cursor. */
function createTracker(api: AgoraApi, cursors: { channelId: string; lastReadId: string }[] = []) {
    (api as any).getCursors = vi.fn().mockResolvedValue(
        cursors.map(c => ({ ...c, updatedAt: '2025-01-01' })),
    );
    return new CursorTracker(api);
}

describe('fetchUnreadMessages', () => {
    const channelId = 'ch1';

    describe('first read (no cursor)', () => {
        it('returns newest messages and acks last', async () => {
            // 5 messages, newest first: m5 m4 m3 m2 m1
            const allMsgs = [msg('m5'), msg('m4'), msg('m3'), msg('m2'), msg('m1')];
            const api = createMockApi(allMsgs);
            const tracker = createTracker(api);

            const result = await fetchUnreadMessages(api, tracker, channelId, 3, 100);

            // Should return newest 3 in chronological order: m3 m4 m5
            expect(result.messages.map(m => m.id)).toEqual(['m3', 'm4', 'm5']);
            expect(result.skipped).toBe(0);
            // Should ack the last (newest) message
            expect(api.updateCursor).toHaveBeenCalledWith(channelId, 'm5');
        });

        it('returns all available when fewer than maxMessages', async () => {
            const allMsgs = [msg('m2'), msg('m1')];
            const api = createMockApi(allMsgs);
            const tracker = createTracker(api);

            const result = await fetchUnreadMessages(api, tracker, channelId, 10, 100);

            expect(result.messages.map(m => m.id)).toEqual(['m1', 'm2']);
            expect(result.skipped).toBe(0);
        });

        it('paginates multiple pages correctly', async () => {
            // 6 messages, fetch with pageSize=2, maxMessages=4
            const allMsgs = [msg('m6'), msg('m5'), msg('m4'), msg('m3'), msg('m2'), msg('m1')];
            const api = createMockApi(allMsgs);
            const tracker = createTracker(api);

            const result = await fetchUnreadMessages(api, tracker, channelId, 4, 2);

            // Should get newest 4 in chronological order: m3 m4 m5 m6
            expect(result.messages.map(m => m.id)).toEqual(['m3', 'm4', 'm5', 'm6']);
            expect(result.skipped).toBe(0);
        });

        it('returns empty result for empty channel', async () => {
            const api = createMockApi([]);
            const tracker = createTracker(api);

            const result = await fetchUnreadMessages(api, tracker, channelId, 10, 100);

            expect(result.messages).toEqual([]);
            expect(result.skipped).toBe(0);
            expect(api.updateCursor).not.toHaveBeenCalled();
        });
    });

    describe('with cursor', () => {
        it('returns only messages newer than cursor', async () => {
            // Messages newest-first: m5 m4 m3 m2 m1. Cursor at m2.
            const allMsgs = [msg('m5'), msg('m4'), msg('m3'), msg('m2'), msg('m1')];
            const api = createMockApi(allMsgs);
            const tracker = createTracker(api, [{ channelId, lastReadId: 'm2' }]);

            const result = await fetchUnreadMessages(api, tracker, channelId, 10, 100);

            // Should return m3 m4 m5 (everything after cursor, chronological)
            expect(result.messages.map(m => m.id)).toEqual(['m3', 'm4', 'm5']);
            expect(result.skipped).toBe(0);
        });

        it('respects maxMessages limit (returns oldest from unread)', async () => {
            // Messages: m5 m4 m3 m2 m1. Cursor at m1. maxMessages = 2
            const allMsgs = [msg('m5'), msg('m4'), msg('m3'), msg('m2'), msg('m1')];
            const api = createMockApi(allMsgs);
            const tracker = createTracker(api, [{ channelId, lastReadId: 'm1' }]);

            const result = await fetchUnreadMessages(api, tracker, channelId, 2, 100);

            // Returns oldest 2 from unread: m2 m3
            expect(result.messages.map(m => m.id)).toEqual(['m2', 'm3']);
            expect(result.skipped).toBe(0);
        });

        it('stops scanning at cursor boundary', async () => {
            const allMsgs = [msg('m5'), msg('m4'), msg('m3'), msg('m2'), msg('m1')];
            const api = createMockApi(allMsgs);
            const tracker = createTracker(api, [{ channelId, lastReadId: 'm3' }]);

            const result = await fetchUnreadMessages(api, tracker, channelId, 10, 100);

            // Only m4 and m5 are newer than cursor m3
            expect(result.messages.map(m => m.id)).toEqual(['m4', 'm5']);
            expect(result.skipped).toBe(0);
        });

        it('sets skipped = -1 when scan cap hit without reaching cursor', async () => {
            // 5 messages. Cursor at m1. maxScan=2 means we only scan m5, m4.
            const allMsgs = [msg('m5'), msg('m4'), msg('m3'), msg('m2'), msg('m1')];
            const api = createMockApi(allMsgs);
            const tracker = createTracker(api, [{ channelId, lastReadId: 'm1' }]);

            const result = await fetchUnreadMessages(api, tracker, channelId, 10, 2, 2);

            // Scans only 2 messages (m5, m4), doesn't reach cursor m1
            // Returns in chronological: m4 m5
            expect(result.messages.map(m => m.id)).toEqual(['m4', 'm5']);
            expect(result.skipped).toBe(-1);
        });

        it('returns empty when no new messages since cursor', async () => {
            // All messages at or below cursor
            const allMsgs = [msg('m3'), msg('m2'), msg('m1')];
            const api = createMockApi(allMsgs);
            const tracker = createTracker(api, [{ channelId, lastReadId: 'm3' }]);

            const result = await fetchUnreadMessages(api, tracker, channelId, 10, 100);

            expect(result.messages).toEqual([]);
            expect(result.skipped).toBe(0);
        });

        it('acks the last returned message', async () => {
            const allMsgs = [msg('m5'), msg('m4'), msg('m3'), msg('m2'), msg('m1')];
            const api = createMockApi(allMsgs);
            const tracker = createTracker(api, [{ channelId, lastReadId: 'm2' }]);

            const result = await fetchUnreadMessages(api, tracker, channelId, 2, 100);

            // Oldest 2 from unread: m3 m4
            expect(result.messages.map(m => m.id)).toEqual(['m3', 'm4']);
            // Acks last returned message
            expect(api.updateCursor).toHaveBeenCalledWith(channelId, 'm4');
        });
    });
});
