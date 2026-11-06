import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageList } from './MessageList';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { api } from '../../lib/api';

const resize = vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  // Rendered height of a row: rows inside an open run are tall (START protocol posts run to
  // hundreds of pixels), far above the 28-112px estimates. A closed run's head is its toggle.
  const sizeOf = (node: Element) => node.hasAttribute('data-agent-hidden') ? 0 : node.querySelector('[data-agent-run]') ? 240
    : node.querySelector('button[aria-expanded]') ? 48 : 64;
  // A browser ResizeObserver: targets start at 0x0, so a callback comes when observation starts
  // (unless the box is 0px) and then only when the box actually changes size. jsdom has none.
  const observers = new Set<{ callback: ResizeObserverCallback; sizes: Map<Element, number> }>();
  class FakeResizeObserver {
    private state = { callback: null as unknown as ResizeObserverCallback, sizes: new Map<Element, number>() };
    constructor(callback: ResizeObserverCallback) { this.state.callback = callback; observers.add(this.state); }
    observe(target: Element) { this.state.sizes.set(target, 0); }
    unobserve(target: Element) { this.state.sizes.delete(target); }
    disconnect() { this.state.sizes.clear(); observers.delete(this.state); }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  // jsdom lays nothing out; rows report the rendered height a browser would give them.
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true,
    get(this: HTMLElement) { return this.hasAttribute('data-index') ? sizeOf(this) : offsetHeight.get!.call(this); } });
  const restore = () => Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
  const flush = () => observers.forEach(state => {
    const entries = [...state.sizes].filter(([target, last]) => target.isConnected && sizeOf(target) !== last).map(([target]) => {
      state.sizes.set(target, sizeOf(target));
      return { target, borderBoxSize: [{ blockSize: sizeOf(target), inlineSize: 800 }] } as unknown as ResizeObserverEntry;
    });
    if (entries.length) state.callback(entries, null as unknown as ResizeObserver);
  });
  // The scroll container: its height, and the scroll offset the test moves it to.
  const viewport: { height: number; scrollTo: (offset: number) => void } = { height: 2000, scrollTo: () => {} };
  return { flush, restore, viewport };
});
// Real hook, Virtualizer and row measurement; only browser geometry and scrolling are supplied.
vi.mock('@tanstack/react-virtual', async importOriginal => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();
  return { ...actual, useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) => actual.useVirtualizer({
    ...options, initialRect: { width: 800, height: resize.viewport.height },
    observeElementRect: (_instance, callback) => { callback({ width: 800, height: resize.viewport.height }); return () => {}; },
    observeElementOffset: (_instance, callback) => { resize.viewport.scrollTo = offset => callback(offset, false); callback(0, false); return () => {}; },
    scrollToFn: () => {},
  }) };
});

const message = (id: string, extra: Partial<Message> = {}): Message => ({ id, content: id, channelId: 'channel',
  authorId: 'agent', authorUsername: 'Agent', authorBot: true, createdAt: '2026-10-22T12:00:00Z', ...extra });
const setMessages = (messages: Message[]) => useMessageStore.setState({ byChannel: new Map([['channel', messages]]) });
const startAt = (index: number) => {
  const row = document.querySelector<HTMLElement>(`[data-index="${index}"]`)!;
  return Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1]);
};
const startOf = (id: string) => {
  const row = screen.getByText(id).closest('[data-index]') as HTMLElement;
  return Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1]);
};

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  useUIStore.setState({ aux: null, navOpen: false, activeOverlay: null });
  useAuthStore.setState({ user: { id: 'owner', username: 'Owner' } });
  vi.spyOn(useMessageStore.getState(), 'loadMessages').mockResolvedValue();
  vi.spyOn(api, 'put').mockResolvedValue({});
  vi.spyOn(api, 'get').mockResolvedValue({ directors: [{ userId: 'owner', authority: 'owner' }] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); resize.viewport.height = 2000; });
afterAll(() => resize.restore());

// Deliver resize observations after the commit, then let the virtualizer's frames run.
const settle = async () => {
  await act(async () => resize.flush());
  await act(async () => new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
  await act(async () => resize.flush());
};

it('keeps measured heights of open run rows when a live notice joins the run', async () => {
  let messages = [message('human', { authorBot: false, authorId: 'owner' }),
    message('start-1'), message('start-2'), message('start-3')];
  setMessages(messages);
  render(<MessageList channelId="channel" channelName="general" />);
  await settle();
  expect(startOf('start-2') - startOf('start-1')).toBe(240);

  // A notice joining after bot posts adds an alias to the run; the rows above it render the same.
  messages = [...messages, message('notice', { systemEvent: 'agent_session', content: 'cci is working' })];
  await act(async () => setMessages(messages));
  await settle();

  expect(startOf('start-2') - startOf('start-1')).toBe(240);
  expect(startOf('start-3') - startOf('start-2')).toBe(240);
});

it('keeps measured heights of an explicitly opened run when a human posts after it', async () => {
  let messages = [message('human', { authorBot: false, authorId: 'owner' }),
    message('start-1'), message('start-2'), message('start-3'), message('start-4')];
  setMessages(messages);
  render(<MessageList channelId="channel" channelName="general" />);
  await act(async () => {});
  // Close then reopen: the run is now held open by the user, not by the default.
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^4 agent updates/ })));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^4 agent updates/ })));
  await settle();
  expect(startOf('start-3') - startOf('start-2')).toBe(240);

  messages = [...messages, message('reply', { authorBot: false, authorId: 'owner' })];
  await act(async () => setMessages(messages));
  await settle();

  expect(screen.getByRole('button', { name: /^4 agent updates/ }).getAttribute('aria-expanded')).toBe('true');
  expect(startOf('start-2') - startOf('start-1')).toBe(240);
  expect(startOf('start-3') - startOf('start-2')).toBe(240);
});

it('keeps measured heights of open run rows scrolled out of view when a notice joins', async () => {
  resize.viewport.height = 600;
  let messages = [message('human', { authorBot: false, authorId: 'owner' }),
    ...Array.from({ length: 30 }, (_, i) => message(`start-${i + 1}`))];
  setMessages(messages);
  render(<MessageList channelId="channel" channelName="general" />);
  await settle();
  // Scroll to the bottom: the measured rows at the top of the run unmount.
  await act(async () => resize.viewport.scrollTo(64 + 30 * 240 - 600));
  await settle();
  expect(document.querySelector('[data-index="1"]')).toBeNull();
  const lastStart = startAt(30);
  expect(lastStart).toBe(64 + 29 * 240);

  messages = [...messages, message('notice', { systemEvent: 'agent_session', content: 'cci is working' })];
  await act(async () => setMessages(messages));
  await settle();
  expect(startAt(30)).toBe(lastStart);

  // Scrolling back up shows the top of the run at its measured heights.
  await act(async () => resize.viewport.scrollTo(0));
  await settle();
  expect(startAt(2) - startAt(1)).toBe(240);
  expect(startAt(3) - startAt(2)).toBe(240);
});

it('reads a default-open run as its toggle row when a human posts after it', async () => {
  let messages = [message('human', { authorBot: false, authorId: 'owner' }),
    message('start-1'), message('start-2'), message('start-3'), message('start-4')];
  setMessages(messages);
  render(<MessageList channelId="channel" channelName="general" />);
  await settle();
  expect(startAt(2) - startAt(1)).toBe(240);

  messages = [...messages, message('reply', { authorBot: false, authorId: 'owner' })];
  await act(async () => setMessages(messages));
  await settle();

  expect(screen.getByRole('button', { name: /^4 agent updates/ }).getAttribute('aria-expanded')).toBe('false');
  const head = startAt(1);
  expect(head).toBe(64);
  for (const index of [2, 3, 4, 5]) expect(startAt(index)).toBe(head + 48);
  expect(startOf('reply')).toBe(head + 48);
});
