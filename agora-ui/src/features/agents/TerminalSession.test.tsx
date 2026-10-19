import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '../../lib/api';
import { useAgentPresenceStore } from '../../stores/agentPresenceStore';
import { useChannelStore } from '../../stores/channelStore';
import { useMessageStore } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import { ConsoleStrip } from './ConsoleStrip';
import { RunActivity } from './RunActivity';
import { SessionSheet } from './SessionSheet';
import { useAgentCommands } from '../messages/AgentCommands';
import {
  HOSTED_ONLY, classifyCommandError, deriveChips, describeSession, ownSessionChips, terminalUsage, type AgentSession,
} from './agentSessions';

/** Terminal sessions (#112): the user's own CLI as a lightweight session. */

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }); });
const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => socket }));
const post = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (orig) => {
  const actual = await orig<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, post: (...a: unknown[]) => post(...a), get: vi.fn().mockResolvedValue({ checkpoints: [], next: null }) } };
});

const CH = 'C'.repeat(26);
const CLAUDE = 'B'.repeat(26);
const hosted = (over: Partial<AgentSession> = {}): AgentSession => ({
  id: 'H'.repeat(26), kind: 'hosted', profile: 'claude', botId: CLAUDE, botUsername: 'claude', state: 'live', endReason: null,
  wakesUsed: 1, tokensUsed: 500, tokenBudget: 1000, lastActiveAt: '2026-10-19T10:00:00Z', ...over,
});
const terminal = (over: Partial<AgentSession> = {}): AgentSession => ({
  id: 'T'.repeat(26), kind: 'terminal', profile: 'claude', botId: CLAUDE, botUsername: 'claude', state: 'live', endReason: null,
  wakesUsed: 0, tokensUsed: 0, tokenBudget: null, toolCalls: 3, usageKnown: false, terminalMode: 'mcp', budgetEnforced: false,
  lastActiveAt: '2026-10-19T10:05:00Z', running: true, ...over,
});

beforeEach(() => {
  post.mockReset();
  useAgentPresenceStore.getState().clear();
  useChannelStore.setState({ channels: new Map([[CH, { id: CH, name: 'general', channelType: 0, serverId: 'SRV' }]]) });
  useMessageStore.setState({ byChannel: new Map() });
  useThreadStore.setState({ activeThreads: new Map(), repliesByThread: new Map(), loadActiveThreads: async () => {} });
});

describe('terminal session data', () => {
  it('a hosted session of an agent connected from a terminal is on standby; the terminal is its own chip', () => {
    const chips = deriveChips([hosted(), terminal()]);
    expect(chips.map(c => `${c.profile}:${c.state}`)).toEqual(['claude:standby']);
    const own = ownSessionChips([{ userId: CLAUDE, username: 'claude', status: 'listening', mode: 'mcp' }], [hosted(), terminal()]);
    expect(own).toHaveLength(1);
    expect(own[0].session?.id).toBe('T'.repeat(26));
    // In its reconnect grace period presence is gone, but the session still shows
    expect(ownSessionChips([], [terminal()])[0]).toMatchObject({ username: 'claude', status: 'connected' });
  });

  it('usage it cannot know is n/a, and no budget applies', () => {
    expect(terminalUsage(terminal())).toBe('3 tool calls · tokens n/a');
    expect(describeSession(terminal())).toBe('claude · terminal · live (working) · 3 tool calls · tokens n/a · no budget (own CLI)');
  });

  it('a /start conflict with a terminal is its own choice', () => {
    expect(classifyCommandError(new ApiError(409, 'terminal_connected'), 'start')).toEqual({ kind: 'terminal' });
  });
});

describe('terminal session UI', () => {
  it('the strip opens a terminal sheet with hosted-only actions greyed out and the budget explained', async () => {
    post.mockResolvedValue({ sessions: [hosted(), terminal()] });
    useAgentPresenceStore.getState().setAll([{ userId: CLAUDE, username: 'claude', channelId: CH, status: 'listening', mode: 'mcp' }]);
    render(<ConsoleStrip channelId={CH} onOpenThread={() => {}} />);
    expect(await screen.findByRole('button', { name: /^claude: on standby/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'claude: terminal session, working. Open session details' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Terminal, working');
    expect(dialog.textContent).toContain('3 tool calls · tokens n/a');
    expect(screen.getByTestId('terminal-budget').textContent).toContain("Agora can't stop it");
    for (const label of ['Review changes', 'Checkpoints', 'Verify', 'Subtasks', 'End session']) {
      const button = screen.getByRole('button', { name: label }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.parentElement?.getAttribute('title')).toBe(HOSTED_ONLY);
    }
    expect(dialog.textContent).toContain('is on standby');
  });

  it('the hosted sheet asks keep-or-standby when /start meets a terminal session', async () => {
    post.mockRejectedValueOnce(new ApiError(409, 'terminal_connected')).mockResolvedValueOnce({ action: 'kept_terminal' });
    render(<SessionSheet open onClose={() => {}} channelId={CH} mode={{ kind: 'profile', profile: 'claude' }}
      sessions={[terminal()]} profiles={[]} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('group', { name: 'Agent connected from a terminal' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep the terminal' }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith(`/channels/${CH}/agent-commands`, { command: 'start', profile: 'claude', onLive: 'keep' }));
    expect(await screen.findByText('Kept the terminal session; no hosted session started.')).toBeTruthy();
  });

  it('/start in the message box warns "already connected from a terminal"', async () => {
    post.mockRejectedValueOnce(new ApiError(409, 'terminal_connected')).mockResolvedValueOnce({ action: 'started', session: hosted() });
    function Box() {
      const { tryHandle, panel } = useAgentCommands(CH);
      return <div><button onClick={() => tryHandle('/start claude')}>go</button>{panel}</div>;
    }
    render(<Box />);
    fireEvent.click(screen.getByText('go'));
    expect(await screen.findByText(/already connected from a terminal/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start hosted on standby' }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith(`/channels/${CH}/agent-commands`, { command: 'start', profile: 'claude', fresh: false, onLive: 'standby' }));
  });

  it('the working indicator shows a working terminal agent with n/a usage', async () => {
    post.mockResolvedValue({ sessions: [terminal()] });
    render(<RunActivity channelId={CH} />);
    expect(await screen.findByText('claude is working in its terminal…')).toBeTruthy();
    expect(screen.getByLabelText('claude terminal usage').textContent).toBe('3 tool calls · tokens n/a · no budget (own CLI)');
  });
});
