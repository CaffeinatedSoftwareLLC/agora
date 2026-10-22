import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useThreadStore } from '../../stores/threadStore';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import type { MessagePayload } from '../../lib/contracts/ws-events';
import { ThreadPanel } from './ThreadPanel';

vi.hoisted(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() }));
vi.mock('../agents/handoffs', () => ({ useThreadOwner: () => null }));
vi.mock('../voice/MicButton', () => ({ MicButton: () => null }));
// Each reply's action buttons, rendered 66 times and walked by every role query, pushed the first test to
// 3–6 s, past vitest's 5 s timeout. Scrolling never uses them; MessageItem's real .prose-msg anchor stays.
vi.mock('./MessageActions', () => ({ MessageActions: () => null }));
const reply = (n: number): MessagePayload => ({ id: String(n).padStart(26, '0'), content: `Reply ${n}`,
  channelId: 'channel', threadId: 'parent', authorId: 'other', authorUsername: 'other', createdAt: '2026-10-22T12:00:00Z' });
const page = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => reply(last - i));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { resolve, promise };
}
beforeEach(() => {
  vi.restoreAllMocks();
  useThreadStore.getState().clear();
  useMessageStore.setState({ byChannel: new Map() });
  useAuthStore.setState({ user: { id: 'me', username: 'me' } });
  useUIStore.setState({ activeOverlay: null, aux: 'thread' });
});
afterEach(cleanup);

it('opens on the newest reply, prepends older replies at the top without jumping, and preserves live arrivals', async () => {
  const newest = deferred<MessagePayload[]>();
  const older = deferred<MessagePayload[]>();
  const get = vi.spyOn(api, 'get').mockReturnValueOnce(newest.promise).mockReturnValueOnce(older.promise);
  useThreadStore.getState().openThread('channel', 'parent');
  render(<ThreadPanel />);
  expect(screen.getByRole('status').textContent).toBe('Loading replies…');
  expect(screen.queryByText('No replies yet')).toBeNull();
  const list = screen.getByRole('log', { name: 'Thread replies' });
  let height = 1000;
  Object.defineProperty(list, 'scrollHeight', { get: () => height });
  Object.defineProperty(list, 'clientHeight', { get: () => 300 });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    if (this === list) return new DOMRect(0, 0, 300, 300);
    if (this.classList.contains('prose-msg') && this.textContent === 'Reply 16') {
      const prepended = useThreadStore.getState().repliesByThread.get('parent')?.[0].content === 'Reply 1';
      // Header grouping/button removal make this delta differ from total scrollHeight.
      return new DOMRect(0, (prepended ? 470 : 80) - list.scrollTop, 200, 20);
    }
    return new DOMRect();
  });
  await act(async () => { newest.resolve(page(16, 65)); await newest.promise; });
  expect(screen.getByText('Reply 65')).toBeTruthy();
  expect(screen.queryByText('Reply 1')).toBeNull();
  expect(list.scrollTop).toBe(1000);
  list.scrollTop = 0;
  fireEvent.scroll(list);
  expect(get).toHaveBeenLastCalledWith(`/channels/channel/messages/parent/replies?limit=50&order=desc&before=${reply(16).id}`);
  expect(screen.getByRole('button', { name: 'Loading older replies…' })).toHaveProperty('disabled', true);
  fireEvent.scroll(list);
  expect(get).toHaveBeenCalledTimes(2);
  act(() => { height = 1040; useThreadStore.getState().addReply(reply(66)); });
  expect(list.scrollTop).toBe(0);
  await act(async () => { height = 1440; older.resolve(page(1, 15)); await older.promise; });
  expect(screen.getByText('Reply 1')).toBeTruthy();
  expect(screen.getByText('Reply 66')).toBeTruthy();
  expect(list.scrollTop).toBe(390);
  expect(screen.getByText('Reply 16').closest('.prose-msg')!.getBoundingClientRect().top).toBe(80);
  expect(screen.queryByRole('button', { name: 'Load older replies' })).toBeNull();
  list.scrollTop = 1140; fireEvent.scroll(list);
  act(() => { height = 1480; useThreadStore.getState().addReply(reply(67)); });
  expect(list.scrollTop).toBe(1480);
});

it('retries a failed older page from the visible control', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValueOnce(page(16, 65)).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page(1, 15));
  useThreadStore.getState().openThread('channel', 'parent');
  render(<ThreadPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'Load older replies' }));
  await screen.findByText('Could not load older replies. Try again.');
  fireEvent.click(screen.getByRole('button', { name: 'Load older replies' }));
  await screen.findByText('Reply 1');
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(get).toHaveBeenCalledTimes(3);
});

it('offers a retry when opening the newest page fails', async () => {
  vi.spyOn(api, 'get').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([reply(65)]);
  useThreadStore.getState().openThread('channel', 'parent');
  render(<ThreadPanel />);
  await screen.findByRole('alert');
  expect(screen.queryByText('No replies yet')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('Reply 65');
  expect(screen.queryByRole('alert')).toBeNull();
});
