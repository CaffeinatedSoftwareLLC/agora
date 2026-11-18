import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useChannelStore } from '../../stores/channelStore';
import { useMessageStore } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import { ConsoleStrip } from './ConsoleStrip';
import type { AgentSession } from './agentSessions';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }); });
const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => socket }));
const post = vi.fn();
vi.mock('../../lib/api', async orig => {
  const actual = await orig<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, post: (...a: unknown[]) => post(...a), get: vi.fn().mockResolvedValue([]) } };
});

const CH = 'C'.repeat(26);
const SID = 'A'.repeat(26);
const session = (over: Partial<AgentSession> = {}): AgentSession => ({
  id: SID, profile: 'boxed-claude', botUsername: 'boxed-claude', state: 'live', endReason: null, wakesUsed: 1, tokensUsed: 0,
  lastActiveAt: '2026-11-17T10:00:00Z', running: false, serverId: 'SRV', liveMode: true, liveState: 'working', ...over,
});
const sessionUpdate = () => socket.on.mock.calls.find(c => c[0] === 'AgentSessionUpdate')![1];

beforeEach(() => {
  socket.on.mockReset(); socket.off.mockReset(); post.mockReset();
  useChannelStore.setState({ channels: new Map([[CH, { id: CH, name: 'agora', channelType: 0, serverId: 'SRV' }]]) });
  useMessageStore.setState({ byChannel: new Map() });
  useThreadStore.setState({ activeThreads: new Map(), repliesByThread: new Map(), loadActiveThreads: async () => {} });
});

async function openSheet() {
  render(<ConsoleStrip channelId={CH} onOpenThread={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /boxed-claude/ }));
  return screen.findByTestId('open-live-terminal');
}

describe('live terminal link in the session sheet', () => {
  it('is there while working', async () => {
    post.mockResolvedValue({ sessions: [session()] });
    const link = await openSheet();
    expect(link).toHaveAttribute('href', `/live-terminal/SRV/${SID}`);
    expect(link).toHaveTextContent("Open the agent's terminal");
  });

  it('stays, and becomes the way to answer, when the agent starts waiting on the owner', async () => {
    post.mockResolvedValue({ sessions: [session()] });
    await openSheet();
    post.mockResolvedValue({ sessions: [session({ liveState: 'waiting', liveNote: 'notification' })] });
    await act(async () => { sessionUpdate()({ channelId: CH, sessionId: SID, running: false, state: 'live' }); });
    await waitFor(() => expect(screen.getByTestId('open-live-terminal')).toHaveTextContent("Open the agent's terminal to answer it"));
    expect(screen.getByTestId('open-live-terminal')).toHaveAttribute('href', `/live-terminal/SRV/${SID}`);
    expect(screen.getByTestId('live-terminal-panel')).toHaveTextContent('waiting on you');
    expect(screen.getByTestId('live-chip-note')).toHaveTextContent('waiting on you');
  });

  it.each([
    ['a session without serverId', { serverId: undefined }],
    ['a session with serverId null', { serverId: null as unknown as undefined }],
    ['a session update without liveState', { liveState: null }],
    ['an idle live session', { liveState: 'idle' as const }],
    ['a restarting live session', { liveState: 'restarting' as const }],
  ])('survives %s (the channel knows the server)', async (_n, over) => {
    post.mockResolvedValue({ sessions: [session()] });
    await openSheet();
    post.mockResolvedValue({ sessions: [session(over as Partial<AgentSession>)] });
    await act(async () => { sessionUpdate()({ channelId: CH, sessionId: SID, running: true, state: 'live', run: null }); });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('open-live-terminal')).toHaveAttribute('href', `/live-terminal/SRV/${SID}`);
  });
});
