import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '../../lib/api';
import { useAgentPresenceStore } from '../../stores/agentPresenceStore';
import { useChannelStore } from '../../stores/channelStore';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import { ConsoleStrip } from './ConsoleStrip';
import { PermissionRelayCard } from './PermissionRelayCard';
import { ownSessionChips, type AgentSession } from './agentSessions';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }); });
const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => socket }));
const post = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (orig) => {
  const actual = await orig<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, post: (...a: unknown[]) => post(...a), get: vi.fn() } };
});

const CH = 'C'.repeat(26);
const CLAUDE = 'B'.repeat(26);
const CODEX = 'X'.repeat(26);
const hosted = (over: Partial<AgentSession> = {}): AgentSession => ({
  id: 'S'.repeat(26), profile: 'codex', botId: CODEX, botUsername: 'codex', state: 'live', endReason: null,
  wakesUsed: 0, tokensUsed: 0, lastActiveAt: '2026-10-19T10:00:00Z', ...over,
});

beforeEach(() => {
  post.mockReset();
  useAgentPresenceStore.getState().clear();
  useChannelStore.setState({ channels: new Map([[CH, { id: CH, name: 'general', channelType: 0, serverId: 'SRV' }]]) });
  useMessageStore.setState({ byChannel: new Map() });
  useThreadStore.setState({ activeThreads: new Map(), repliesByThread: new Map(), loadActiveThreads: async () => {} });
});

describe('own-session chips', () => {
  it('leaves out agents that have a live hosted session, and sorts listening first', () => {
    const chips = ownSessionChips([
      { userId: 'Z'.repeat(26), username: 'zed', status: 'offline', mode: null },
      { userId: CODEX, username: 'codex', status: 'connected', mode: 'mcp' },
      { userId: CLAUDE, username: 'claude', status: 'listening', mode: 'channel' },
    ], [hosted()]);
    expect(chips.map(c => `${c.username}:${c.status}`)).toEqual(['claude:listening', 'zed:offline']);
    expect(ownSessionChips([{ userId: CODEX, username: 'codex', status: 'connected', mode: 'mcp' }], [hosted({ state: 'ended' })])).toHaveLength(1);
  });

  it('shows a connected agent in the strip apart from hosted chips, and follows presence events', async () => {
    post.mockResolvedValue({ sessions: [hosted()] });
    useAgentPresenceStore.getState().setAll([{ userId: CLAUDE, username: 'claude', channelId: CH, status: 'listening', mode: 'channel' }]);
    render(<ConsoleStrip channelId={CH} onOpenThread={() => {}} />);
    await screen.findByRole('button', { name: /^codex: live and idle/ });
    const chip = screen.getByRole('img', { name: 'claude: own session, listening' });
    expect(chip.getAttribute('title')).toContain('Claude Code Channel');
    expect(screen.queryByRole('button', { name: /^claude:/ })).toBeNull();

    act(() => { useAgentPresenceStore.getState().update({ userId: CLAUDE, username: 'claude', channelId: CH, status: 'offline', mode: null }); });
    expect(screen.getByRole('img', { name: 'claude: own session, offline' })).toBeTruthy();

    act(() => { useAgentPresenceStore.getState().update({ userId: 'G'.repeat(26), username: 'gemini', channelId: 'O'.repeat(26), status: 'connected', mode: 'mcp' }); });
    expect(screen.queryByRole('img', { name: /^gemini/ })).toBeNull();
  });
});

const card = (status: string): Message => ({
  id: 'M'.repeat(26), channelId: CH, content: 'claude asks to use `Bash`.', authorId: null, authorUsername: null,
  createdAt: '2026-10-19T10:00:00Z', systemEvent: 'agent_permission_relay',
  systemData: { kind: 'agent_permission_relay', requestId: 'R'.repeat(26), bot: 'claude', tool: 'Bash', description: 'Run tests', inputPreview: '{"command":"<b>npm test</b>"}', status },
} as unknown as Message);

describe('permission relay card', () => {
  it('shows the prompt as plain text and sends the owner\'s answer', async () => {
    post.mockResolvedValue({ id: 'R'.repeat(26), status: 'allow' });
    render(<PermissionRelayCard message={card('pending')} />);
    expect(screen.getByText('Bash').tagName).toBe('CODE');
    expect(screen.getByText('{"command":"<b>npm test</b>"}').tagName).toBe('PRE');
    fireEvent.click(screen.getByText('Allow'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/channels/${CH}/permission-relays/${'R'.repeat(26)}`, { decision: 'allow' }));
  });

  it('explains a refusal and has no buttons once answered', async () => {
    post.mockRejectedValue(new ApiError(403, 'owner_only'));
    const { unmount } = render(<PermissionRelayCard message={card('pending')} />);
    fireEvent.click(screen.getByText('Deny'));
    expect((await screen.findByRole('alert')).textContent).toBe('Only the server owner can answer this.');
    unmount();
    render(<PermissionRelayCard message={card('deny')} />);
    expect(screen.getByText('DENIED')).toBeTruthy();
    expect(screen.queryByText('Allow')).toBeNull();
  });
});
