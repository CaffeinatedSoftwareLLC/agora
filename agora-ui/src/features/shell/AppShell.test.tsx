import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AppShell } from './AppShell';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useDraftStore } from '../../stores/draftStore';
import { api } from '../../lib/api';

vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
});
vi.mock('./TabBar', () => ({ TabBar: () => <div>Tabs</div> }));
vi.mock('./ArcChannelSidebar', () => ({ ArcChannelSidebar: () => <button>Channel</button> }));
vi.mock('../agents/ConsoleStrip', () => ({ ConsoleStrip: () => null }));
vi.mock('../live/TypingIndicator', () => ({ TypingIndicator: () => null }));
vi.mock('../messages/MessageList', () => ({ MessageList: () => <div data-testid="feed">Messages</div> }));
vi.mock('../messages/FloatingMessageInput', () => ({ FloatingMessageInput: () => {
  const text = useDraftStore(s => s.drafts['channel:channel'] ?? '');
  return <textarea aria-label="Composer" value={text} onChange={e => useDraftStore.getState().setDraft('channel:channel', e.target.value)} />;
} }));
vi.mock('../messages/ThreadPanel', () => ({ ThreadPanel: () => <div>Thread content</div> }));
vi.mock('../messages/FilesPanel', () => ({ FilesPanel: () => <div>File content</div> }));
vi.mock('../servers/MembersSidebar', () => ({ MembersSidebar: () => <div>Members content</div> }));
let width = 360;
const listeners = new Set<() => void>();
beforeEach(() => {
  width = 360;
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return width <= (query.includes('1279') ? 1279 : 767); },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  useUIStore.setState({ navOpen: false, aux: null, activeOverlay: null, connectionStatus: 'connected' });
  useServerStore.getState().setServers([{ id: 'server', name: 'Agora', ownerId: 'user' }]);
  useChannelStore.getState().setChannels([{ id: 'channel', serverId: 'server', channelType: 3, name: 'general' }]);
  useChannelStore.getState().setActiveChannel('channel');
});
afterEach(() => { cleanup(); listeners.clear(); vi.restoreAllMocks(); });
function mount() {
  return render(<MemoryRouter initialEntries={['/app/channel']}><Routes><Route path="/app/*" element={<AppShell />} /></Routes></MemoryRouter>);
}
it('keeps one feed and composer DOM instance through resizes and phone auxiliary coverage', () => {
  const { container } = mount();
  const feed = screen.getByTestId('feed');
  const composer = screen.getByRole('textbox', { name: 'Composer' });
  fireEvent.change(composer, { target: { value: 'Long instruction' } });
  feed.scrollTop = 123;
  act(() => useUIStore.getState().openAux('files'));
  expect(container.querySelector('.shell-channel')?.hasAttribute('inert')).toBe(true);
  expect(screen.getByText('File content')).toBeTruthy();
  for (const next of [768, 1280, 360]) {
    act(() => { width = next; listeners.forEach(listener => listener()); });
    expect(screen.getByTestId('feed')).toBe(feed);
    expect(container.querySelector('textarea')).toBe(composer);
    expect((composer as HTMLTextAreaElement).value).toBe('Long instruction');
    expect(feed.scrollTop).toBe(123);
    expect(container.querySelector('.shell-channel')?.hasAttribute('inert')).toBe(next < 768);
    expect(screen.getAllByTestId('feed')).toHaveLength(1);
  }
});
it('Escape closes the top sheet before the aux and restores the original invoking button', async () => {
  mount();
  const trigger = screen.getByTitle('Files in this channel');
  trigger.focus();
  fireEvent.click(trigger);
  const close = vi.fn();
  act(() => useUIStore.getState().openOverlay({ kind: 'message-actions', id: 'actions', onClose: close }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(close).toHaveBeenCalledOnce();
  expect(useUIStore.getState().aux).toBe('files');
  fireEvent.keyDown(document, { key: 'Escape' });
  await act(async () => {});
  expect(useUIStore.getState().aux).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it('opening a thread via a shared action renders one inspector and local Back keeps its identity', () => {
  vi.spyOn(api, 'get').mockResolvedValue([]);
  const { container } = mount();
  act(() => useUIStore.getState().openThreadView('channel', 'parent'));
  expect(screen.getByText('Thread content')).toBeTruthy();
  expect(container.querySelectorAll('.shell-aux')).toHaveLength(1);
  fireEvent.click(screen.getByText('\u2190 Back'));
  expect(useUIStore.getState().aux).toBeNull();
  expect(screen.getByTestId('feed')).toBeTruthy();
});
it('phone header toggles the palette and shows connection state', () => {
  useUIStore.setState({ paletteKey: 'aegean', connectionStatus: 'reconnecting' });
  mount();
  expect(screen.getByRole('img', { name: 'reconnecting' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Switch theme from Aegean/ }));
  expect(useUIStore.getState().paletteKey).toBe('terracotta');
  expect(screen.getByRole('button', { name: /Switch theme from Terracotta/ })).toBeTruthy();
});
