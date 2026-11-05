import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import { useUIStore } from '../../stores/uiStore';
import { ThreadPanel } from './ThreadPanel';
import { closingNotice } from './closingNotice';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() }); });
vi.mock('../agents/handoffs', () => ({ useThreadOwner: () => null }));
vi.mock('../voice/MicButton', () => ({ MicButton: () => null }));

const CLOSED_AT = '2026-11-05T12:00:00.000Z';
const parent: Message = {
  id: 'parent', channelId: 'channel', content: 'Old plan', authorId: 'claude', authorUsername: 'claude',
  createdAt: '2026-11-05T10:00:00Z', replyCount: 3, lastReplyAt: CLOSED_AT, threadClosedAt: CLOSED_AT,
};
const notice = (over: Partial<Message> & { systemData: Record<string, unknown> }): Message => ({
  id: 'notice', channelId: 'channel', content: 'Closed by codex as superseded.', authorId: '', authorUsername: '',
  createdAt: CLOSED_AT, systemEvent: 'thread_closed', ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'get').mockResolvedValue([]);
  useAuthStore.setState({ user: { id: 'me', username: 'me' } });
  useMessageStore.setState({ byChannel: new Map([['channel', [parent, { ...parent, id: 'newer', content: 'New plan', threadClosedAt: undefined }]]]) });
  useThreadStore.getState().clear();
  useUIStore.setState({ activeOverlay: null });
});

it('says how a closed thread ended and opens the thread its work moved to (#132)', () => {
  const openThread = vi.fn();
  useThreadStore.setState({
    openThreadId: 'parent', openThreadChannelId: 'channel', openThread,
    repliesByThread: new Map([['parent', [notice({ systemData: { reason: 'superseded', successorId: 'newer', successorChannelId: 'channel' } })]]]),
  });
  render(<ThreadPanel />);
  expect(screen.getByText(/Thread closed as superseded/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open the thread it moved to' }));
  expect(openThread).toHaveBeenCalledWith('channel', 'newer');
});

it('names a successor in another channel instead of linking it', () => {
  useThreadStore.setState({
    openThreadId: 'parent', openThreadChannelId: 'channel',
    repliesByThread: new Map([['parent', [notice({ systemData: { reason: 'superseded', successorId: 'elsewhere', successorChannelId: 'other' } })]]]),
  });
  render(<ThreadPanel />);
  expect(screen.getByText(/continues in thread elsewhere/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open the thread it moved to' })).toBeNull();
});

it('ignores the notice of an earlier closure that was reopened since', () => {
  const earlier = notice({ createdAt: '2026-11-05T11:00:00.000Z', systemData: { reason: 'done', successorId: null } });
  expect(closingNotice([earlier], CLOSED_AT)).toBeNull();
  expect(closingNotice([earlier], '2026-11-05T11:00:00.000Z')).toEqual({ reason: 'done', successorId: null, successorChannelId: null });
  useThreadStore.setState({ openThreadId: 'parent', openThreadChannelId: 'channel', repliesByThread: new Map([['parent', [earlier]]]) });
  render(<ThreadPanel />);
  expect(screen.getByText('Thread closed')).toBeTruthy();
  expect(screen.queryByText(/as done/)).toBeNull();
});
