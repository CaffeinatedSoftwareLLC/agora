import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useThreadStore, type ThreadSummary } from './threadStore';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { api } from '../lib/api';

const mockApi = vi.mocked(api);

function summary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: 'parent-1',
    content: 'parent',
    authorId: 'u1',
    authorUsername: 'alice',
    channelId: 'ch-1',
    createdAt: '2026-10-20T12:00:00.000Z',
    replyCount: 1,
    lastReplyAt: '2026-10-20T12:01:00.000Z',
    previewReplies: [],
    ...overrides,
  };
}

beforeEach(() => {
  useThreadStore.getState().clear();
  vi.clearAllMocks();
});

describe('threadStore.updateParentMetadata', () => {
  it('updates a thread the channel list already holds', () => {
    useThreadStore.setState({ activeThreads: new Map([['ch-1', [summary()]]]) });
    useThreadStore.getState().updateParentMetadata({ channelId: 'ch-1', messageId: 'parent-1', replyCount: 2, lastReplyAt: '2026-10-20T12:02:00.000Z' });
    const t = useThreadStore.getState().activeThreads.get('ch-1')![0];
    expect(t.replyCount).toBe(2);
    expect(t.lastReplyAt).toBe('2026-10-20T12:02:00.000Z');
    expect(mockApi.get).not.toHaveBeenCalled();
  });

  it('fetches the list again when a first reply starts a thread it does not hold (#128)', async () => {
    useThreadStore.setState({ activeThreads: new Map([['ch-1', [summary()]]]) });
    const fresh = [summary({ id: 'parent-2' }), summary()];
    mockApi.get.mockResolvedValueOnce(fresh);
    useThreadStore.getState().updateParentMetadata({ channelId: 'ch-1', messageId: 'parent-2', replyCount: 1, lastReplyAt: '2026-10-20T12:03:00.000Z' });
    // A second event for the same new thread while the fetch is in flight does not fetch twice
    useThreadStore.getState().updateParentMetadata({ channelId: 'ch-1', messageId: 'parent-2', replyCount: 2, lastReplyAt: '2026-10-20T12:04:00.000Z' });
    expect(mockApi.get).toHaveBeenCalledTimes(1);
    expect(mockApi.get).toHaveBeenCalledWith('/channels/ch-1/threads?limit=5');
    await vi.waitFor(() => expect(useThreadStore.getState().activeThreads.get('ch-1')).toEqual(fresh));
  });

  it('starts the list from an empty one too', async () => {
    useThreadStore.setState({ activeThreads: new Map([['ch-1', []]]) });
    mockApi.get.mockResolvedValueOnce([summary()]);
    useThreadStore.getState().updateParentMetadata({ channelId: 'ch-1', messageId: 'parent-1', replyCount: 1, lastReplyAt: '2026-10-20T12:01:00.000Z' });
    await vi.waitFor(() => expect(useThreadStore.getState().activeThreads.get('ch-1')).toHaveLength(1));
  });

  it('does not fetch for a channel whose list was never loaded, or for a closed or emptied thread', () => {
    useThreadStore.getState().updateParentMetadata({ channelId: 'ch-9', messageId: 'parent-1', replyCount: 1, lastReplyAt: null });
    useThreadStore.setState({ activeThreads: new Map([['ch-1', []]]) });
    useThreadStore.getState().updateParentMetadata({ channelId: 'ch-1', messageId: 'parent-1', replyCount: 0, lastReplyAt: null });
    useThreadStore.getState().updateParentMetadata({ channelId: 'ch-1', messageId: 'parent-1', replyCount: 3, lastReplyAt: null, threadClosedAt: '2026-10-20T12:05:00.000Z' });
    expect(mockApi.get).not.toHaveBeenCalled();
  });
});
