import { Profiler } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageList } from './MessageList';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { api } from '../../lib/api';

vi.hoisted(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() }));
// Keep the actual React hook, Virtualizer and row measurement. Only browser geometry
// and scrolling are supplied here, since jsdom has no layout/ResizeObserver delivery.
vi.mock('@tanstack/react-virtual', async importOriginal => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();
  return { ...actual, useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) => actual.useVirtualizer({
    ...options, initialRect: { width: 800, height: 600 },
    observeElementRect: (_instance, callback) => { callback({ width: 800, height: 600 }); return () => {}; },
    observeElementOffset: (_instance, callback) => { callback(0, false); return () => {}; },
    scrollToFn: () => {},
    measureElement: node => node.hasAttribute('data-agent-hidden') ? 0 : node.querySelector('[data-agent-run]') ? 96 : 64,
  }) };
});

const message = (id: string, extra: Partial<Message> = {}): Message => ({ id, content: id, channelId: 'channel',
  authorId: 'agent', authorUsername: 'Agent', authorBot: true, createdAt: '2026-10-22T12:00:00Z', ...extra });
const setMessages = (messages: Message[]) => useMessageStore.setState({ byChannel: new Map([['channel', messages]]) });
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  useUIStore.setState({ aux: null, navOpen: false, activeOverlay: null });
  useAuthStore.setState({ user: { id: 'owner', username: 'Owner' } });
  vi.spyOn(useMessageStore.getState(), 'loadMessages').mockResolvedValue();
  vi.spyOn(api, 'put').mockResolvedValue({});
  vi.spyOn(api, 'get').mockResolvedValue({ directors: [{ userId: 'owner', authority: 'owner' }] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('settles after a live approval resolves and activity joins the expanded trailing run', async () => {
  let messages = [message('human', { authorBot: false, authorId: 'owner' }), message('hello'),
    message('card', { systemEvent: 'agent_tool_approval', systemData: { requestId: 'request', profile: 'agent', status: 'pending' } })];
  setMessages(messages);
  let commits = 0;
  render(<Profiler id="feed" onRender={() => { if (++commits > 100) throw new Error('Unbounded feed renders'); }}>
    <MessageList channelId="channel" channelName="general" />
  </Profiler>);
  await act(async () => {});
  const before = commits;
  messages = [messages[0], messages[1], { ...messages[2], systemData: { ...messages[2].systemData, status: 'once' } },
    message('notice', { systemEvent: 'agent_session', content: 'Approval granted.' }), message('reply', { content: 'Running with the grant.' })];
  await act(async () => setMessages(messages));
  expect(screen.getByText('APPROVED ONCE')).toBeTruthy();
  expect(screen.getByText('Running with the grant.')).toBeTruthy();
  expect(screen.getByRole('button', { name: /^4 agent updates/ }).getAttribute('aria-expanded')).toBe('true');
  expect(commits - before).toBeLessThanOrEqual(12);
  const settled = commits;
  await act(async () => {});
  expect(commits).toBe(settled);

  // New message objects with the same roles must not start a measurement/render cycle.
  const beforeEdits = commits;
  for (let i = 0; i < 10; i++) {
    messages = messages.map(row => row.id === 'reply' ? { ...row, content: `Reply revision ${i}` } : row);
    await act(async () => setMessages(messages));
  }
  expect(screen.getByText('Reply revision 9')).toBeTruthy();
  expect(commits - beforeEdits).toBeLessThanOrEqual(20);
  await act(async () => setMessages([...messages, message('next-human', { authorBot: false, authorId: 'owner' })]));
  expect(screen.getByRole('button', { name: /^4 agent updates/ }).getAttribute('aria-expanded')).toBe('false');
  // Finish the real virtualizer's two-frame scroll verification while still mounted.
  await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
});
