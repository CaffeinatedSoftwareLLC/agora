import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CursorTracker } from '../src/cursor.js';
import type { AgoraApi, Cursor } from '../src/api.js';

function createMockApi(cursors: Cursor[] = []) {
    return {
        getCursors: vi.fn<() => Promise<Cursor[]>>().mockResolvedValue(cursors),
        updateCursor: vi.fn<(channelId: string, lastReadId: string) => Promise<{ channelId: string; lastReadId: string }>>()
            .mockImplementation(async (channelId, lastReadId) => ({ channelId, lastReadId })),
        // Stubs for other AgoraApi methods (not used by CursorTracker)
        getMe: vi.fn(),
        getMessages: vi.fn(),
        sendMessage: vi.fn(),
    } as unknown as AgoraApi & {
        getCursors: ReturnType<typeof vi.fn>;
        updateCursor: ReturnType<typeof vi.fn>;
    };
}

describe('CursorTracker', () => {
    let api: ReturnType<typeof createMockApi>;
    let tracker: CursorTracker;

    beforeEach(() => {
        api = createMockApi([
            { channelId: 'ch1', lastReadId: 'msg100', updatedAt: '2025-01-01' },
            { channelId: 'ch2', lastReadId: 'msg200', updatedAt: '2025-01-01' },
        ]);
        tracker = new CursorTracker(api as unknown as AgoraApi);
    });

    it('load() fetches cursors from API and sets them', async () => {
        await tracker.load();

        expect(api.getCursors).toHaveBeenCalledOnce();
        expect(tracker.getCursor('ch1')).toBe('msg100');
        expect(tracker.getCursor('ch2')).toBe('msg200');
    });

    it('load() is idempotent — second call does not hit API', async () => {
        await tracker.load();
        await tracker.load();

        expect(api.getCursors).toHaveBeenCalledOnce();
    });

    it('getCursor() returns undefined for unknown channel', async () => {
        await tracker.load();
        expect(tracker.getCursor('unknown')).toBeUndefined();
    });

    it('ack() updates cursor via API and locally', async () => {
        await tracker.load();
        await tracker.ack('ch1', 'msg150');

        expect(api.updateCursor).toHaveBeenCalledWith('ch1', 'msg150');
        expect(tracker.getCursor('ch1')).toBe('msg150');
    });

    it('ack() with older messageId is a no-op (forward-only)', async () => {
        await tracker.load();
        await tracker.ack('ch1', 'msg050'); // 'msg050' < 'msg100' lexicographically

        expect(api.updateCursor).not.toHaveBeenCalled();
        expect(tracker.getCursor('ch1')).toBe('msg100');
    });

    it('ack() with equal messageId is a no-op', async () => {
        await tracker.load();
        await tracker.ack('ch1', 'msg100');

        expect(api.updateCursor).not.toHaveBeenCalled();
        expect(tracker.getCursor('ch1')).toBe('msg100');
    });

    it('ack() with newer messageId calls API and updates local', async () => {
        await tracker.load();
        await tracker.ack('ch1', 'msg999');

        expect(api.updateCursor).toHaveBeenCalledWith('ch1', 'msg999');
        expect(tracker.getCursor('ch1')).toBe('msg999');
    });

    it('ack() on unloaded channel (no prior cursor) calls API', async () => {
        await tracker.load();
        await tracker.ack('ch-new', 'msg001');

        expect(api.updateCursor).toHaveBeenCalledWith('ch-new', 'msg001');
        expect(tracker.getCursor('ch-new')).toBe('msg001');
    });
});
