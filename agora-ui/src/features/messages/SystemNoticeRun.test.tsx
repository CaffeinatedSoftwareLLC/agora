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

describe('NoticeText', () => {
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
