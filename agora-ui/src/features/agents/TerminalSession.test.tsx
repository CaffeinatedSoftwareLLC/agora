import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  HOSTED_ONLY, classifyCommandError, deriveChips, describeSession, ownChipLabel, ownSessionChips, ownerTokenNote, terminalLabel, terminalUsage, type AgentSession,
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

/** #230: a terminal agent whose CLI stopped kept showing "terminal · connected". */
describe('terminal chip states', () => {
  const NOW = Date.parse('2026-11-05T12:00:00Z');
  const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
  const chip = (status: 'listening' | 'connected' | 'offline', over: Partial<AgentSession> = {}) =>
    ownSessionChips(status === 'offline' ? [] : [{ userId: CLAUDE, username: 'claude', status, mode: 'mcp' }], [terminal(over)])[0];

  it('says working, listening, idle 12m, and not listening 2h in amber after 20 minutes', () => {
    expect(ownChipLabel(chip('connected'), NOW)).toEqual({ text: 'working', activity: 'working', warn: false });
    expect(ownChipLabel(chip('listening', { running: false }), NOW)).toMatchObject({ text: 'listening', warn: false });
    // The session's own listening flag counts too (presence from another API process)
    expect(ownChipLabel(chip('connected', { running: false, listening: true }), NOW).text).toBe('listening');
    expect(ownChipLabel(chip('connected', { running: false, idleSince: ago(12) }), NOW)).toEqual({ text: 'idle 12m', activity: 'idle', warn: false });
    expect(ownChipLabel(chip('connected', { running: false, idleSince: ago(19) }), NOW).warn).toBe(false);
    expect(ownChipLabel(chip('connected', { running: false, idleSince: ago(20) }), NOW)).toEqual({ text: 'not listening 20m', activity: 'not_listening', warn: true });
    expect(ownChipLabel(chip('connected', { running: false, idleSince: ago(130) }), NOW)).toMatchObject({ text: 'not listening 2h', warn: true });
    expect(ownChipLabel(chip('connected', { running: false, idleSince: ago(0) }), NOW).text).toBe('idle');
    // Without idleSince (an older server) the last activity stands in
    expect(ownChipLabel(chip('connected', { running: false, lastActiveAt: ago(45) }), NOW).text).toBe('not listening 45m');
  });

  it('appends the context the agent reported', () => {
    expect(ownChipLabel(chip('connected', { contextPercent: 87 }), NOW).text).toBe('working · context 87%');
    expect(ownChipLabel(chip('connected', { running: false, idleSince: ago(130), contextPercent: 87 }), NOW).text).toBe('not listening 2h · context 87%');
    expect(ownChipLabel(chip('listening', { running: false, contextPercent: 0 }), NOW).text).toBe('listening · context 0%');
  });

  it('keeps the presence label without a terminal session, and offline wins', () => {
    const presenceOnly = ownSessionChips([{ userId: CLAUDE, username: 'claude', status: 'connected', mode: 'mcp' }], [])[0];
    expect(ownChipLabel(presenceOnly, NOW).text).toBe('connected');
    expect(ownChipLabel({ ...chip('connected'), status: 'offline' }, NOW).text).toBe('offline');
  });

  it('terminalLabel works from the session alone, for the sheet', () => {
    expect(terminalLabel(terminal({ running: false, listening: false, idleSince: ago(5) }), NOW).text).toBe('idle 5m');
  });

  describe('on the strip', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(NOW); });
    afterEach(() => { vi.useRealTimers(); });

    it('shows an idle agent in amber once it passes 20 minutes, with the label kept in its accessible name', async () => {
      post.mockResolvedValue({ sessions: [terminal({ running: false, idleSince: ago(15), contextPercent: 87 })] });
      useAgentPresenceStore.getState().setAll([{ userId: CLAUDE, username: 'claude', channelId: CH, status: 'connected', mode: 'mcp' }]);
      render(<ConsoleStrip channelId={CH} onOpenThread={() => {}} />);
      const button = await screen.findByRole('button', { name: 'claude: terminal session, idle 15m · context 87%. Open session details' });
      expect(button.textContent).toContain('terminal · idle 15m · context 87%');
      expect(button.querySelector('.text-warn')).toBeNull();

      // Five minutes later, without a refresh: the minute ticker moves the chip on
      await act(async () => { vi.advanceTimersByTime(5 * 60_000); });
      const amber = screen.getByRole('button', { name: 'claude: terminal session, not listening 20m · context 87%. Open session details' });
      expect(amber.querySelector('.text-warn')?.textContent).toBe('terminal · not listening 20m · context 87%');
    });

    it('the sheet shows last activity, last tool, context, usage and the note', async () => {
      render(<SessionSheet open onClose={() => {}} channelId={CH} mode={{ kind: 'terminal', botId: CLAUDE }}
        sessions={[terminal({
          running: false, idleSince: ago(130), lastActiveAt: ago(130), lastTool: 'chat_send', contextPercent: 91,
          usagePercent: 82, usageLabel: '5h window', statusNote: 'handing off next', statusAt: ago(131),
        })]} profiles={[]} onChanged={() => {}} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog.textContent).toContain('Terminal, not listening 2h');
      const details = screen.getByTestId('terminal-details').textContent ?? '';
      for (const text of ['Last activity', 'Last toolchat_send', 'Context91% used', 'Usage82% of 5h window', 'Notehanding off next', 'Reported']) {
        expect(details).toContain(text);
      }
      expect(dialog.textContent).toContain('start a fresh CLI session');
    });
  });
});

describe('terminal chip: does it count as the owner (docs/provider-terms.md)', () => {
  it('says why a terminal does or does not count', () => {
    expect(ownerTokenNote(hosted())).toBeNull();
    expect(ownerTokenNote(terminal())).toBeNull(); // a server that doesn't say
    expect(ownerTokenNote(terminal({ ownerToken: true, ownerTokenReason: null, ownedByYou: true })))
      .toEqual({ counts: true, yours: true, text: 'Its messages and hand-offs wake subscription agents you started.' });
    expect(ownerTokenNote(terminal({ ownerToken: true, ownerTokenReason: null, ownedByYou: false }))?.text)
      .toBe('Counts as its owner: its messages and hand-offs wake subscription agents the owner started.');
    expect(ownerTokenNote(terminal({ ownerToken: false, ownerTokenReason: 'other_maker', ownedByYou: true }))?.text)
      .toBe("This terminal won't wake subscription agents: its token was made by someone other than the bot's owner.");
    expect(ownerTokenNote(terminal({ ownerToken: false, ownerTokenReason: 'started_by_other', ownedByYou: true }))?.text)
      .toBe("This terminal won't wake subscription agents: someone other than the bot's owner started this session.");
    expect(ownerTokenNote(terminal({ ownerToken: false, ownerTokenReason: 'other_bot_owner', ownedByYou: false }))?.text)
      .toBe("This terminal won't wake subscription agents: the bot has no owner.");
    expect(ownerTokenNote(terminal({ ownerToken: false, ownerTokenReason: 'mixed' }))?.text)
      .toBe("This terminal won't wake subscription agents: two different tokens share this terminal session.");
    // With Only you set, the strict #361 rule: only hand-offs count, and only on a personal or invite token its owner made
    expect(ownerTokenNote(terminal({ ownerToken: true, ownerTokenReason: null, ownedByYou: true, subscriptionWakes: 'owner_only' }))?.text)
      .toBe('Its hand-offs wake subscription agents you started.');
    expect(ownerTokenNote(terminal({ ownerToken: true, ownerTokenReason: null, ownedByYou: false, subscriptionWakes: 'owner_only' }))?.text)
      .toBe('Counts as its owner: its hand-offs wake subscription agents the owner started.');
    expect(ownerTokenNote(terminal({ ownerToken: false, ownerTokenReason: 'owner_only_token', ownedByYou: true, subscriptionWakes: 'owner_only' }))?.text)
      .toBe("This terminal won't wake subscription agents: Settings → Agents is set to Only you, and its token isn't a personal or agent invite token its owner made.");
    expect(ownerTokenNote(terminal({ ownerToken: false, ownerTokenReason: 'agent_token', ownedByYou: true }))?.text)
      .toBe("This terminal won't wake subscription agents: it uses an agent host's, box's or model agent's token; give your terminal a personal token.");
    expect(ownerTokenNote(terminal({ ownerToken: false, ownerTokenReason: 'no_token', ownedByYou: true }))?.text)
      .toBe("This terminal won't wake subscription agents: no live token is on record for it (revoked, or reconnect its agora-mcp).");
    // A reason an older server sent that no longer exists reads as no owner, never as counting
    expect(ownerTokenNote(terminal({ ownerToken: false, ownerTokenReason: 'unknown_maker' as never }))?.counts).toBe(false);
  });

  it('the chip and its sheet show "counts as you" to the bot owner, with the reason in the tooltip', async () => {
    post.mockResolvedValue({ sessions: [terminal({ ownerToken: true, ownerTokenReason: null, ownedByYou: true })] });
    useAgentPresenceStore.getState().setAll([{ userId: CLAUDE, username: 'claude', channelId: CH, status: 'listening', mode: 'mcp' }]);
    render(<ConsoleStrip channelId={CH} onOpenThread={() => {}} />);
    const chip = await screen.findByRole('button', { name: 'claude: terminal session, working, counts as you. Open session details' });
    expect(chip.getAttribute('title')).toContain('Its messages and hand-offs wake subscription agents you started.');
    expect(screen.getByTestId('owner-token').textContent).toContain('counts as you');
    fireEvent.click(chip);
    await screen.findByRole('dialog');
    expect(screen.getByTestId('terminal-owner-token').textContent).toBe('Counts as you. Its messages and hand-offs wake subscription agents you started.');
  });

  it("a terminal on someone else's token says it doesn't count, and why", async () => {
    post.mockResolvedValue({ sessions: [terminal({ ownerToken: false, ownerTokenReason: 'other_maker', ownedByYou: true })] });
    useAgentPresenceStore.getState().setAll([{ userId: CLAUDE, username: 'claude', channelId: CH, status: 'listening', mode: 'mcp' }]);
    render(<ConsoleStrip channelId={CH} onOpenThread={() => {}} />);
    const chip = await screen.findByRole('button', { name: "claude: terminal session, working, doesn't count as you. Open session details" });
    expect(chip.getAttribute('title')).toContain("This terminal won't wake subscription agents: its token was made by someone other than the bot's owner.");
    expect(screen.getByTestId('owner-token').textContent).toContain("doesn't count as you");
  });

  it("someone else's terminal shows no tag on the chip, only the tooltip", async () => {
    post.mockResolvedValue({ sessions: [terminal({ ownerToken: true, ownerTokenReason: null, ownedByYou: false })] });
    useAgentPresenceStore.getState().setAll([{ userId: CLAUDE, username: 'claude', channelId: CH, status: 'listening', mode: 'mcp' }]);
    render(<ConsoleStrip channelId={CH} onOpenThread={() => {}} />);
    const chip = await screen.findByRole('button', { name: 'claude: terminal session, working. Open session details' });
    expect(chip.getAttribute('title')).toContain('Counts as its owner: its messages and hand-offs wake subscription agents the owner started.');
    expect(screen.queryByTestId('owner-token')).toBeNull();
  });
});
