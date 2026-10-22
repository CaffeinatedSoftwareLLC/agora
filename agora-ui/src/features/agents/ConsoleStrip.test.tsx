import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '../../lib/api';
import { useChannelStore } from '../../stores/channelStore';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import { useUIStore } from '../../stores/uiStore';
import { ConsoleStrip } from './ConsoleStrip';
import { resetTime, type AgentSession } from './agentSessions';

vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});

const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => socket }));
const post = vi.fn();
const get = vi.fn();
vi.mock('../../lib/api', async (orig) => {
  const actual = await orig<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) } };
});

const CH = 'C'.repeat(26);
const live = (over: Partial<AgentSession> = {}): AgentSession => ({
  id: 'A'.repeat(26), profile: 'claude', botUsername: 'claude', state: 'live', endReason: null,
  wakesUsed: 3, tokensUsed: 14_200, lastActiveAt: '2026-10-17T10:00:00Z', running: true, ...over,
});

function message(over: Partial<Message>): Message {
  return { id: 'M1', content: 'hi', authorId: 'u', authorUsername: 'u', channelId: CH, createdAt: '', ...over };
}

beforeEach(() => {
  socket.on.mockReset();
  socket.off.mockReset();
  post.mockReset();
  get.mockReset();
  useChannelStore.setState({ channels: new Map([[CH, { id: CH, name: 'general', channelType: 0, serverId: 'SRV' }]]) });
  useMessageStore.setState({ byChannel: new Map() });
  useThreadStore.setState({ activeThreads: new Map(), repliesByThread: new Map(), loadActiveThreads: async () => {} });
});
afterEach(() => { vi.useRealTimers(); });

describe('ConsoleStrip', () => {
  function scrollableStrip() {
    post.mockResolvedValue({ sessions: [] });
    const view = render(<ConsoleStrip channelId={CH} onOpenThread={vi.fn()} />);
    const strip = screen.getByRole('toolbar', { name: 'Agents and active threads' });
    Object.defineProperties(strip, {
      scrollWidth: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 200 },
    });
    return { strip, ...view };
  }

  function wheel(strip: HTMLElement, init: WheelEventInit) {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    fireEvent(strip, event);
    return event;
  }

  it('maps vertical wheels in both directions and releases the page at strip edges', async () => {
    const { strip } = scrollableStrip();
    await act(async () => {});
    expect(wheel(strip, { deltaY: 80 }).defaultPrevented).toBe(true);
    expect(strip.scrollLeft).toBe(80);
    expect(wheel(strip, { deltaY: -30 }).defaultPrevented).toBe(true);
    expect(strip.scrollLeft).toBe(50);
    wheel(strip, { deltaY: 999 });
    expect(strip.scrollLeft).toBe(400);
    expect(wheel(strip, { deltaY: 40 }).defaultPrevented).toBe(false);
    wheel(strip, { deltaY: -999 });
    expect(strip.scrollLeft).toBe(0);
    expect(wheel(strip, { deltaY: -40 }).defaultPrevented).toBe(false);
  });

  it('leaves horizontal gestures, zoom, Shift+wheel and non-overflowing strips native', async () => {
    const { strip } = scrollableStrip();
    await act(async () => {});
    for (const init of [
      { deltaX: 50, deltaY: 10 }, { deltaY: 50, ctrlKey: true }, { deltaY: 50, shiftKey: true },
    ]) expect(wheel(strip, init).defaultPrevented).toBe(false);
    expect(strip.scrollLeft).toBe(0);
    Object.defineProperty(strip, 'scrollWidth', { value: 200 });
    expect(wheel(strip, { deltaY: 50 }).defaultPrevented).toBe(false);
    expect(strip.scrollLeft).toBe(0);
  });

  it('normalizes line and page wheel deltas', async () => {
    const { strip } = scrollableStrip();
    await act(async () => {});
    wheel(strip, { deltaY: 3, deltaMode: 1 });
    expect(strip.scrollLeft).toBe(48);
    wheel(strip, { deltaY: 1, deltaMode: 2 });
    expect(strip.scrollLeft).toBe(248);
  });

  it('removes the non-passive wheel listener on unmount', () => {
    const { strip, unmount } = scrollableStrip();
    unmount();
    expect(wheel(strip, { deltaY: 80 }).defaultPrevented).toBe(false);
    expect(strip.scrollLeft).toBe(0);
  });

  it('shows live agents first with state and compact tokens, then thread chips', async () => {
    post.mockResolvedValue({ sessions: [
      live({ id: 'B'.repeat(26), profile: 'codex', state: 'shelved', running: false, tokensUsed: 900 }),
      live(),
    ] });
    useMessageStore.setState({ byChannel: new Map([[CH, [message({ id: 'T1', content: 'Plan the redesign', protocol: { version: 1, mode: 'plan', state: 'TURN', yieldTo: 'codex' } })]]]) });
    useThreadStore.setState({ activeThreads: new Map([[CH, [{
      id: 'T1', content: 'Plan the redesign', authorId: null, authorUsername: null, channelId: CH, createdAt: '',
      replyCount: 4, lastReplyAt: '', previewReplies: [],
    }]]]) });
    const onOpenThread = vi.fn();
    render(<ConsoleStrip channelId={CH} onOpenThread={onOpenThread} />);

    const claude = await screen.findByRole('button', { name: /^claude: live and working, 14k tokens/ });
    const codex = screen.getByRole('button', { name: /^codex: shelved, 900 tokens/ });
    expect(claude.compareDocumentPosition(codex) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(post).toHaveBeenCalledWith(`/channels/${CH}/agent-commands`, { command: 'sessions' });

    const thread = screen.getByRole('button', { name: /Open thread \(TURN, next: codex\): Plan the redesign, 4 replies/ });
    expect(within(thread).getByText('→ codex')).toBeTruthy();
    fireEvent.click(thread);
    expect(onOpenThread).toHaveBeenCalledWith('T1');
  });

  it('shows Sleeping and the reset time on a rate-limited agent chip (#147)', async () => {
    const until = new Date(Date.now() + 3 * 3600_000).toISOString();
    post.mockResolvedValue({ sessions: [
      live({ running: false, sleepingUntil: until }),
      live({ id: 'B'.repeat(26), profile: 'codex', running: false, tokensUsed: 900 }),
    ] });
    render(<ConsoleStrip channelId={CH} onOpenThread={vi.fn()} />);

    const claude = await screen.findByRole('button', { name: `claude: sleeping (rate limited), resets ${resetTime(until)}, 14k tokens. Open session controls` });
    expect(claude.textContent).toBe(`claudeSleeping · resets ${resetTime(until)}14k`);
    expect(claude.textContent).toMatch(/\d{1,2}:\d\d/);
    // An agent that isn't sleeping shows no such text
    expect(screen.getByRole('button', { name: /^codex: live and idle, 900 tokens/ }).textContent).not.toContain('Sleeping');
  });

  it('shows the latest server protocol before opening and tracks live replies', async () => {
    post.mockResolvedValue({ sessions: [] });
    useMessageStore.setState({ byChannel: new Map([[CH, [message({ id: 'T1', protocol: { version: 1, mode: 'fix', state: 'START' } })]]]) });
    useThreadStore.setState({ activeThreads: new Map([[CH, [{
      id: 'T1', content: 'Fix UI', authorId: null, authorUsername: null, channelId: CH, createdAt: '',
      replyCount: 4, lastReplyAt: '', previewReplies: [],
      latestProtocol: { version: 1, mode: 'fix', state: 'TURN', yieldTo: 'codex', messageId: 'T3', authorUsername: 'claude' },
    }]]]), repliesByThread: new Map([['T1', [message({ id: 'T2', protocol: { version: 1, mode: 'fix', state: 'ACK' } })]]]) });
    render(<ConsoleStrip channelId={CH} onOpenThread={() => {}} />);
    expect(screen.getByRole('button', { name: /Open thread \(TURN, next: codex\)/ })).toBeTruthy();
    act(() => useThreadStore.getState().addReply({ ...message({ id: 'T4', protocol: { version: 1, mode: 'fix', state: 'DONE' } }), content: 'Done', threadId: 'T1' }));
    expect(screen.getByRole('button', { name: /Open thread \(DONE\)/ })).toBeTruthy();
  });

  it('refreshes immediately on channel run updates and removes its socket listener', async () => {
    post.mockResolvedValue({ sessions: [live({ running: false })] });
    const { unmount } = render(<ConsoleStrip channelId={CH} onOpenThread={() => {}} />);
    await screen.findByRole('button', { name: /^claude: live and idle/ });
    const handler = socket.on.mock.calls.find(c => c[0] === 'AgentSessionUpdate')![1];
    act(() => handler({ channelId: 'other', sessionId: 'A'.repeat(26), running: true }));
    expect(post).toHaveBeenCalledTimes(1);
    post.mockResolvedValue({ sessions: [live()] });
    act(() => handler({ channelId: CH, sessionId: 'A'.repeat(26), running: true }));
    await screen.findByRole('button', { name: /^claude: live and working/ });
    unmount();
    expect(socket.off).toHaveBeenCalledWith('AgentSessionUpdate', handler);
  });

  it('refreshes when an agent_session notice arrives, and polls every 20s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    post.mockResolvedValue({ sessions: [] });
    render(<ConsoleStrip channelId={CH} onOpenThread={() => {}} />);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    act(() => { useMessageStore.setState({ byChannel: new Map([[CH, [message({ id: 'N0', systemEvent: 'agent_session' })]]]) }); });
    act(() => { useMessageStore.setState({ byChannel: new Map([[CH, [message({ id: 'N0', systemEvent: 'agent_session' }), message({ id: 'N1', systemEvent: 'agent_session' })]]]) }); });
    await waitFor(() => expect(post.mock.calls.length).toBeGreaterThanOrEqual(2));
    const before = post.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(post.mock.calls.length).toBe(before + 1);
  });

  it('opens the session sheet, handles session_live, and returns focus on Escape', async () => {
    post.mockImplementation(async (_path: string, body: { command: string; onLive?: string }) => {
      if (body.command === 'sessions') return { sessions: [live()] };
      if (body.command === 'start' && !body.onLive) throw new ApiError(409, 'session_live');
      return { action: 'kept', session: live() };
    });
    get.mockResolvedValue([]);
    render(<ConsoleStrip channelId={CH} onOpenThread={() => {}} />);
    const chip = await screen.findByRole('button', { name: /^claude:/ });
    chip.focus();
    fireEvent.click(chip);

    const dialog = screen.getByRole('dialog', { name: 'Agent: claude' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByRole('button', { name: 'End session' })).toBeTruthy();
    expect(useUIStore.getState().activeOverlay?.kind).toBe('session-sheet');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useUIStore.getState().activeOverlay).toBeNull();
    expect(document.activeElement).toBe(chip);

    fireEvent.click(screen.getByRole('button', { name: 'Start an agent' }));
    expect(get).toHaveBeenCalledWith('/servers/SRV/agent-profiles');
    expect(await screen.findByText(/no agents yet/)).toBeTruthy();
  });

  it('shows the three choices when /start meets a live session', async () => {
    post.mockImplementation(async (_path: string, body: { command: string; onLive?: string }) => {
      if (body.command === 'sessions') return { sessions: [live({ state: 'ended', running: false })] };
      if (body.command === 'start' && !body.onLive) throw new ApiError(409, 'session_live');
      return { action: 'kept', session: live() };
    });
    render(<ConsoleStrip channelId={CH} onOpenThread={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /^claude: ended/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('That agent already has a live session here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Shelve it and start new' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(await screen.findByText('Kept the live session.')).toBeTruthy();
    expect(post).toHaveBeenCalledWith(`/channels/${CH}/agent-commands`, { command: 'start', profile: 'claude', onLive: 'keep' });
  });
});


it('keeps changed-file details from recent runs in the session sheet', async () => {
  post.mockResolvedValue({ sessions: [live({ running: false, recentRuns: [
    { id: 'old-run', status: 'succeeded', startedAt: '2026-10-17T10:00:00Z', finishedAt: '2026-10-17T10:01:00Z', error: null, changedPaths: ['src/older.ts'] },
  ] })] });
  render(<ConsoleStrip channelId={CH} onOpenThread={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /claude: live and idle/ }));
  fireEvent.click(screen.getByText('Recent runs'));
  fireEvent.click(screen.getByText('1 changed file'));
  expect(screen.getByText('src/older.ts')).toBeInTheDocument();
});
