import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from './MessageList';
import { NoticeText } from './SystemNoticeRun';
import { expandedRunsKey } from './systemNotices';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { api } from '../../lib/api';

const storage = vi.hoisted(() => {
  const data = new Map<string, string>();
  const s = {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  };
  vi.stubGlobal('localStorage', s);
  return s;
});
// Render every row so collapsed members can be inspected
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    scrollToIndex: vi.fn(),
    measureElement: vi.fn(),
    resizeItem: vi.fn(),
    getTotalSize: () => 0,
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({ index, start: 0, key: index })),
  }),
}));

const msg = (id: string, content: string, systemEvent?: string): Message => ({
  id, channelId: 'channel', content, authorId: systemEvent ? 'system' : 'agent', authorUsername: 'Agent',
  createdAt: '2026-10-20T00:00:00Z', systemEvent,
});

function setMessages(list: Message[]) {
  useMessageStore.setState({ byChannel: new Map([['channel', list]]) });
}

beforeEach(() => {
  storage.data.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  useUIStore.setState({ aux: null, navOpen: false, activeOverlay: null });
  useAuthStore.setState({ user: { id: 'me', username: 'me' } });
  vi.spyOn(useMessageStore.getState(), 'loadMessages').mockResolvedValue();
  vi.spyOn(api, 'put').mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('system notice runs in MessageList', () => {
  it('collapses consecutive notices into one drawer row and remembers it per user', () => {
    setMessages([
      msg('m1', 'hello'),
      msg('n1', 'Session standby', 'agent_session'),
      msg('n2', 'Session started', 'agent_session'),
      msg('n3', 'Loop guard tripped', 'loop_guard'),
      msg('m2', 'bye'),
    ]);
    const { unmount } = render(<MessageList channelId="channel" channelName="general" />);
    const toggle = screen.getByRole('button', { name: /3 system notices/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('▸');
    expect(screen.queryByText('Session standby')).toBeNull();
    expect(screen.queryByText('Loop guard tripped')).toBeNull();
    expect(screen.getByText('hello')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('▾');
    expect(screen.getByText('Session standby')).toBeTruthy();
    expect(screen.getByText('Loop guard tripped')).toBeTruthy();
    expect(JSON.parse(storage.data.get(expandedRunsKey('me'))!)).toEqual(['n1']);

    unmount();
    render(<MessageList channelId="channel" channelName="general" />);
    expect(screen.getByRole('button', { name: /3 system notices/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('renders a lone notice without a drawer', () => {
    setMessages([msg('m1', 'hello'), msg('n1', 'Session ended', 'agent_session'), msg('m2', 'bye')]);
    render(<MessageList channelId="channel" channelName="general" />);
    expect(screen.queryByRole('button', { name: /system notices/ })).toBeNull();
    expect(screen.getByText('Session ended')).toBeTruthy();
  });

  it('keeps working when storage throws', () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    setMessages([msg('n1', 'a', 'agent_session'), msg('n2', 'b', 'agent_session')]);
    render(<MessageList channelId="channel" channelName="general" />);
    const toggle = screen.getByRole('button', { name: /2 system notices/ });
    act(() => { fireEvent.click(toggle); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('agent message drawers in MessageList', () => {
  const bot = (id: string, content: string, extra: Partial<Message> = {}): Message => ({
    ...msg(id, content), authorBot: true, authorUsername: 'Claude', ...extra,
  });

  it('expands real messages with protocol badges, persists per user, and leaves human replies visible', () => {
    setMessages([bot('a1', 'First agent update', { protocol: { version: 1, mode: 'fix', state: 'TURN', yieldTo: 'Codex' } }),
      bot('a2', 'Second agent update', { authorId: 'codex', authorUsername: 'Codex' }), bot('a3', 'Third agent update'),
      msg('human', 'Please continue')]);
    const { unmount } = render(<MessageList channelId="channel" channelName="general" />);
    const toggle = screen.getByRole('button', { name: '3 agent messages (Claude, Codex)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('First agent update')).toBeNull();
    expect(screen.queryByText('TURN')).toBeNull();
    expect(screen.getByText('Please continue')).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.getByText('First agent update')).toBeTruthy();
    expect(screen.getByText('TURN')).toBeTruthy();
    expect(JSON.parse(storage.data.get(expandedRunsKey('me'))!)).toEqual(['agents:a1']);
    unmount();
    const second = render(<MessageList channelId="channel" channelName="general" />);
    expect(screen.getByRole('button', { name: /3 agent messages/ }).getAttribute('aria-expanded')).toBe('true');
    second.unmount();
    useAuthStore.setState({ user: { id: 'another', username: 'another' } });
    render(<MessageList channelId="channel" channelName="general" />);
    expect(screen.getByRole('button', { name: /3 agent messages/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('forms a drawer on the third live message and unfolds when a message is deleted', () => {
    const list = [bot('a1', 'First update'), bot('a2', 'Second update')];
    setMessages(list);
    render(<MessageList channelId="channel" channelName="general" />);
    expect(screen.getByText('First update')).toBeTruthy();
    act(() => setMessages([...list, bot('a3', 'Third update')]));
    expect(screen.getByRole('button', { name: /3 agent messages/ })).toBeTruthy();
    expect(screen.queryByText('First update')).toBeNull();
    act(() => setMessages([list[0], { ...list[1], deletedAt: '2026-10-22' }, bot('a3', 'Third update')]));
    expect(screen.queryByRole('button', { name: /agent messages/ })).toBeNull();
    expect(screen.getByText('First update')).toBeTruthy();
    expect(screen.getByText('Third update')).toBeTruthy();
  });

  it('keeps an interactive card outside two folded runs and updates an open run on arrival', () => {
    const list = [bot('a1', 'One'), bot('a2', 'Two'), bot('a3', 'Three'),
      bot('card', 'Read the notes', { artifact: { id: 'notes', version: 1, latestVersion: 1, title: 'Review notes', kind: 'markdown' } }),
      bot('b1', 'Four'), bot('b2', 'Five'), bot('b3', 'Six')];
    setMessages(list);
    render(<MessageList channelId="channel" channelName="general" />);
    const toggles = screen.getAllByRole('button', { name: /3 agent messages/ });
    expect(toggles).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Open Review notes in the canvas' }));
    expect(useUIStore.getState().aux).toBe('canvas');
    expect(useUIStore.getState().canvas).toMatchObject({ channelId: 'channel', artifactId: 'notes' });
    fireEvent.click(toggles[1]);
    act(() => setMessages([...list, bot('b4', 'Seven')]));
    expect(screen.getByRole('button', { name: /4 agent messages/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Seven')).toBeTruthy();
    expect(screen.queryByText('One')).toBeNull();
  });
});

describe('NoticeText', () => {
  it('links to the wake-budget settings while keeping other markup as text', () => {
    render(<NoticeText text="Raise the wake budget in [Agent settings](/settings/agents). [other](https://example.com)" />);
    expect(screen.getByRole('link', { name: 'Agent settings' })).toHaveProperty('pathname', '/settings/agents');
    expect(screen.queryByRole('link', { name: 'other' })).toBeNull();
    expect(screen.getByText(/\[other\]\(https:\/\/example.com\)/)).toBeTruthy();
  });
  it('truncates long notices behind show more / show less', () => {
    const text = ['Kept worktree with changes:', ...Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`)].join('\n');
    const { container } = render(<NoticeText text={text} />);
    expect(container.textContent).not.toContain('src/file29.ts');
    const more = screen.getByRole('button', { name: 'show more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(container.textContent).toContain('src/file29.ts');
    fireEvent.click(screen.getByRole('button', { name: 'show less' }));
    expect(container.textContent).not.toContain('src/file29.ts');
  });

  it('shows short notices whole with no button', () => {
    render(<NoticeText text="Session started" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
