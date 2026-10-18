import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageList } from './MessageList';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { useUIStore } from '../../stores/uiStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { api } from '../../lib/api';

vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
});
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: () => ({
  scrollToIndex: vi.fn(), getVirtualItems: () => [], getTotalSize: () => 0,
}) }));
function message(id: string): Message {
  return { id, channelId: 'channel', content: 'Instruction', authorId: 'agent', authorUsername: 'Agent', createdAt: '2026-10-17T00:00:00Z' };
}
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  useUIStore.setState({ aux: 'thread', navOpen: false, activeOverlay: null });
  useMessageStore.setState({ byChannel: new Map([['channel', [message('one')]]]) });
  vi.spyOn(useMessageStore.getState(), 'loadMessages').mockResolvedValue();
  vi.spyOn(api, 'put').mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('never marks hidden channel messages read; returning acknowledges the latest confirmed message', () => {
  const read = vi.spyOn(useUnreadStore.getState(), 'markRead');
  render(<MessageList channelId="channel" channelName="general" />);
  act(() => useMessageStore.setState({ byChannel: new Map([['channel', [message('one'), message('two')]]]) }));
  expect(read).not.toHaveBeenCalled();
  expect(api.put).not.toHaveBeenCalled();
  act(() => useUIStore.getState().closeAux());
  expect(read).toHaveBeenCalledWith('channel', 'two');
  expect(api.put).toHaveBeenCalledWith('/channels/channel/ack', { messageId: 'two' });
  act(() => useMessageStore.setState({ byChannel: new Map([['channel', [message('one'), message('two'), { ...message('pending'), pending: true }]]]) }));
  expect(api.put).toHaveBeenCalledTimes(1);
});
it('also suppresses reads behind navigation drawers and registered overlays', () => {
  useUIStore.setState({ aux: null, navOpen: true });
  render(<MessageList channelId="channel" channelName="general" />);
  expect(api.put).not.toHaveBeenCalled();
  act(() => {
    useUIStore.getState().openOverlay({ kind: 'session-sheet', id: 'agent', onClose: vi.fn() });
    useUIStore.getState().closeNav();
  });
  expect(api.put).not.toHaveBeenCalled();
  act(() => useUIStore.getState().closeOverlay());
  expect(api.put).toHaveBeenCalledOnce();
});
