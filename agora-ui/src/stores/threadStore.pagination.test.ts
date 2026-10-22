import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useThreadStore } from './threadStore';
import type { MessagePayload } from '../lib/contracts/ws-events';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({ api: { get: vi.fn() } }));
const reply = (n: number): MessagePayload => ({ id: String(n).padStart(26, '0'), content: `Reply ${n}`,
  authorId: 'alice', authorUsername: 'alice', channelId: 'channel', threadId: 'parent', createdAt: '2026-10-22T12:00:00Z' });
const page = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => reply(last - i));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { resolve, promise };
}
beforeEach(() => { useThreadStore.getState().clear(); vi.clearAllMocks(); });
const held = () => useThreadStore.getState().repliesByThread.get('parent')!;

describe('thread reply pagination', () => {
  it('opens at the newest 50, then prepends older pages in chronological order', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(page(16, 65)).mockResolvedValueOnce(page(1, 15));
    const store = useThreadStore.getState();
    await store.loadReplies('channel', 'parent');
    expect(api.get).toHaveBeenLastCalledWith('/channels/channel/messages/parent/replies?limit=50&order=desc');
    expect(held().map(m => m.content)).toEqual(Array.from({ length: 50 }, (_, i) => `Reply ${i + 16}`));
    expect(useThreadStore.getState().hasMore.get('parent')).toBe(true);
    await store.loadOlder('channel', 'parent');
    expect(api.get).toHaveBeenLastCalledWith(`/channels/channel/messages/parent/replies?limit=50&order=desc&before=${reply(16).id}`);
    expect(held()).toHaveLength(65);
    expect(held()[0].content).toBe('Reply 1');
    expect(held().at(-1)?.content).toBe('Reply 65');
    expect(useThreadStore.getState().hasMore.get('parent')).toBe(false);
    await store.loadOlder('channel', 'parent');
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('retains live arrivals, edits, and optimistic sends while the newest snapshot loads', async () => {
    useThreadStore.getState().addReply(reply(20));
    const request = deferred<MessagePayload[]>();
    vi.mocked(api.get).mockReturnValueOnce(request.promise);
    const pending = useThreadStore.getState().loadReplies('channel', 'parent');
    useThreadStore.getState().addReply(reply(66));
    useThreadStore.getState().updateReply({ id: reply(20).id, channelId: 'channel', threadId: 'parent', content: 'Edited during load', editedAt: 'later' });
    useThreadStore.setState(state => ({ repliesByThread: new Map(state.repliesByThread).set('parent', [...held(), { ...reply(67), id: 'pending-1', pending: true }]) }));
    request.resolve(page(16, 65)); await pending;
    expect(held().find(m => m.id === reply(20).id)?.content).toBe('Edited during load');
    expect(held().filter(m => m.id === reply(66).id)).toHaveLength(1);
    expect(held().at(-1)?.id).toBe('pending-1');
  });

  it('deduplicates older requests and overlapping replies without losing live appends', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(page(16, 65));
    await useThreadStore.getState().loadReplies('channel', 'parent');
    const request = deferred<MessagePayload[]>();
    vi.mocked(api.get).mockReturnValueOnce(request.promise);
    const one = useThreadStore.getState().loadOlder('channel', 'parent');
    const two = useThreadStore.getState().loadOlder('channel', 'parent');
    expect(one).toBe(two);
    useThreadStore.getState().addReply(reply(66));
    request.resolve(page(1, 16)); await one;
    expect(held()).toHaveLength(66);
    expect(new Set(held().map(m => m.id)).size).toBe(66);
    expect(held().at(-1)?.content).toBe('Reply 66');
  });

  it('drops stale newest responses after reopen or clear', async () => {
    const first = deferred<MessagePayload[]>();
    const second = deferred<MessagePayload[]>();
    vi.mocked(api.get).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const oldLoad = useThreadStore.getState().loadReplies('channel', 'parent');
    const newLoad = useThreadStore.getState().loadReplies('channel', 'parent');
    second.resolve([reply(65)]); await newLoad;
    first.resolve([reply(1)]); await oldLoad;
    expect(held().map(m => m.content)).toEqual(['Reply 65']);
    const cleared = deferred<MessagePayload[]>();
    vi.mocked(api.get).mockReturnValueOnce(cleared.promise);
    const pending = useThreadStore.getState().loadReplies('channel', 'parent');
    useThreadStore.getState().clear(); cleared.resolve([reply(66)]); await pending;
    expect(useThreadStore.getState().repliesByThread.size).toBe(0);
    expect(useThreadStore.getState().loadingReplies.size).toBe(0);
  });

  it('drops older responses after clear and keeps failed pages retryable', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(page(16, 65));
    await useThreadStore.getState().loadReplies('channel', 'parent');
    vi.mocked(api.get).mockRejectedValueOnce(new Error('offline'));
    await expect(useThreadStore.getState().loadOlder('channel', 'parent')).rejects.toThrow('offline');
    expect(useThreadStore.getState().hasMore.get('parent')).toBe(true);
    const request = deferred<MessagePayload[]>();
    vi.mocked(api.get).mockReturnValueOnce(request.promise);
    const pending = useThreadStore.getState().loadOlder('channel', 'parent');
    useThreadStore.getState().clear(); request.resolve(page(1, 15)); await pending;
    expect(useThreadStore.getState().repliesByThread.size).toBe(0);
  });

  it('reports initial loading failures and clears the error on retry', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
    await expect(useThreadStore.getState().loadReplies('channel', 'parent')).rejects.toThrow('offline');
    expect(useThreadStore.getState().replyLoadErrors.get('parent')).toContain('Could not load replies');
    expect(useThreadStore.getState().loadingReplies.get('parent')).toBe(false);
    await useThreadStore.getState().loadReplies('channel', 'parent');
    expect(useThreadStore.getState().replyLoadErrors.get('parent')).toBe('');
    expect(held()).toEqual([]);
  });
});
