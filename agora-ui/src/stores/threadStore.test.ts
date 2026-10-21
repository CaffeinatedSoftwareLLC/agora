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

it('sends attachment-only replies and retains HTTP attachment metadata before the socket echo (#207)', async () => {
  const attachment = { id: 'file', name: 'note.txt', mime: 'text/plain', size: 3, width: null, height: null, url: '/files/file' };
  mockApi.post.mockResolvedValueOnce({ id: 'reply', attachments: [attachment] });
  expect(await useThreadStore.getState().sendReply('channel', 'parent', '', 'me', 'me', ['file'])).toBe(true);
  expect(mockApi.post).toHaveBeenCalledWith('/channels/channel/messages/parent/replies', { attachments: ['file'] });
  expect(useThreadStore.getState().repliesByThread.get('parent')![0].attachments).toEqual([attachment]);
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
    mockApi.get.mockResolvedValue(fresh);
    useThreadStore.getState().updateParentMetadata({ channelId: 'ch-1', messageId: 'parent-2', replyCount: 1, lastReplyAt: '2026-10-20T12:03:00.000Z' });
    // A second event while the fetch is in flight does not start a parallel request;
    // it queues one trailing fetch for after the first resolves
    useThreadStore.getState().updateParentMetadata({ channelId: 'ch-1', messageId: 'parent-2', replyCount: 2, lastReplyAt: '2026-10-20T12:04:00.000Z' });
    expect(mockApi.get).toHaveBeenCalledTimes(1);
    expect(mockApi.get).toHaveBeenCalledWith('/channels/ch-1/threads?limit=5');
    await vi.waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(useThreadStore.getState().activeThreads.get('ch-1')).toEqual(fresh));
    await Promise.resolve();
    expect(mockApi.get).toHaveBeenCalledTimes(2);
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('threadStore active-thread list races (#128)', () => {
  it('a thread whose event arrives while a refresh is pending is fetched by a trailing refresh', async () => {
    useThreadStore.setState({ activeThreads: new Map([['ch-1', []]]) });
    const first = deferred<ThreadSummary[]>();
    const second = deferred<ThreadSummary[]>();
    mockApi.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = summary({ id: 'thread-A' });
    const b = summary({ id: 'thread-B', lastReplyAt: '2026-10-20T12:02:00.000Z' });

    useThreadStore.getState().updateParentMetadata({ channelId: 'ch-1', messageId: 'thread-A', replyCount: 1, lastReplyAt: a.lastReplyAt });
    useThreadStore.getState().updateParentMetadata({ channelId: 'ch-1', messageId: 'thread-B', replyCount: 1, lastReplyAt: b.lastReplyAt });
    expect(mockApi.get).toHaveBeenCalledTimes(1);

    // The first snapshot was taken before B's reply
    first.resolve([a]);
    await vi.waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(2));
    second.resolve([b, a]);
    await vi.waitFor(() => expect(useThreadStore.getState().activeThreads.get('ch-1')!.map((t) => t.id)).toContain('thread-B'));
    expect(useThreadStore.getState().activeThreads.get('ch-1')!.map((t) => t.id)).toEqual(['thread-B', 'thread-A']);
  });

  it('a snapshot requested before an event does not overwrite the newer reply count or closure', async () => {
    useThreadStore.setState({ activeThreads: new Map([['ch-1', [summary({ id: 'thread-A' })]]]) });
    const first = deferred<ThreadSummary[]>();
    const second = deferred<ThreadSummary[]>();
    mockApi.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const load = useThreadStore.getState().loadActiveThreads('ch-1');
    useThreadStore.getState().updateParentMetadata({
      channelId: 'ch-1', messageId: 'thread-A', replyCount: 3,
      lastReplyAt: '2026-10-20T12:09:00.000Z', threadClosedAt: '2026-10-20T12:10:00.000Z',
    });

    first.resolve([summary({ id: 'thread-A' })]);
    await vi.waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(2));
    // Between the stale snapshot and the trailing refresh, the event's data stands
    const between = useThreadStore.getState().activeThreads.get('ch-1')![0];
    expect(between).toMatchObject({ replyCount: 3, lastReplyAt: '2026-10-20T12:09:00.000Z', threadClosedAt: '2026-10-20T12:10:00.000Z' });

    // The trailing refresh was requested after the event, so the server's answer wins
    second.resolve([summary({ id: 'thread-A', replyCount: 4, lastReplyAt: '2026-10-20T12:11:00.000Z', threadClosedAt: '2026-10-20T12:10:00.000Z' })]);
    await load;
    expect(useThreadStore.getState().activeThreads.get('ch-1')![0]).toMatchObject({ replyCount: 4, lastReplyAt: '2026-10-20T12:11:00.000Z' });
    expect(mockApi.get).toHaveBeenCalledTimes(2);
  });

  it('concurrent loads share one request and one trailing refresh', async () => {
    const first = deferred<ThreadSummary[]>();
    mockApi.get.mockReturnValueOnce(first.promise).mockResolvedValueOnce([summary({ id: 'thread-A', replyCount: 2 })]);
    const p1 = useThreadStore.getState().loadActiveThreads('ch-1');
    const p2 = useThreadStore.getState().loadActiveThreads('ch-1');
    const p3 = useThreadStore.getState().loadActiveThreads('ch-1');
    expect(mockApi.get).toHaveBeenCalledTimes(1);
    first.resolve([summary({ id: 'thread-A' })]);
    await Promise.all([p1, p2, p3]);
    expect(mockApi.get).toHaveBeenCalledTimes(2);
    expect(useThreadStore.getState().activeThreads.get('ch-1')![0].replyCount).toBe(2);
  });

  it('a request from before clear() does not write into the cleared store', async () => {
    const stale = deferred<ThreadSummary[]>();
    mockApi.get.mockReturnValueOnce(stale.promise).mockResolvedValueOnce([summary({ id: 'thread-new' })]);
    void useThreadStore.getState().loadActiveThreads('ch-1');
    useThreadStore.getState().clear();
    await useThreadStore.getState().loadActiveThreads('ch-1');
    stale.resolve([summary({ id: 'thread-old' })]);
    await Promise.resolve();
    await Promise.resolve();
    expect(useThreadStore.getState().activeThreads.get('ch-1')!.map((t) => t.id)).toEqual(['thread-new']);
  });
});

describe('threadStore.sendReply vs its socket echo (#149)', () => {
  const echo = (id: string, content: string) => ({
    id, content, authorId: 'u1', authorUsername: 'alice', channelId: 'ch-1',
    createdAt: '2026-10-20T12:05:00.000Z', threadId: 'parent-1',
  });
  const copies = (text: string) =>
    useThreadStore.getState().repliesByThread.get('parent-1')!.filter((m) => m.content === text);

  it('keeps one copy when the echo arrives before the POST response', async () => {
    const post = deferred<{ id: string }>();
    mockApi.post.mockReturnValueOnce(post.promise);
    const sending = useThreadStore.getState().sendReply('ch-1', 'parent-1', 'Reply check', 'u1', 'alice');
    expect(copies('Reply check')).toHaveLength(1);

    useThreadStore.getState().addReply(echo('reply-1', 'Reply check'));
    // The echo replaces the optimistic row at once: no moment with two copies
    expect(copies('Reply check')).toHaveLength(1);
    expect(copies('Reply check')[0].id).toBe('reply-1');
    expect(copies('Reply check')[0].pending).toBeUndefined();

    post.resolve({ id: 'reply-1' });
    await sending;
    expect(copies('Reply check')).toHaveLength(1);
    expect(copies('Reply check')[0].id).toBe('reply-1');
  });

  it('keeps one copy when the POST response arrives before the echo', async () => {
    const post = deferred<{ id: string }>();
    mockApi.post.mockReturnValueOnce(post.promise);
    const sending = useThreadStore.getState().sendReply('ch-1', 'parent-1', 'Reply check', 'u1', 'alice');

    post.resolve({ id: 'reply-1' });
    await sending;
    expect(copies('Reply check')).toHaveLength(1);
    expect(copies('Reply check')[0]).toMatchObject({ id: 'reply-1', pending: true });

    useThreadStore.getState().addReply(echo('reply-1', 'Reply check'));
    expect(copies('Reply check')).toHaveLength(1);
    expect(copies('Reply check')[0].pending).toBeUndefined();
  });
});
