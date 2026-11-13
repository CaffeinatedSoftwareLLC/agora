import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionBudget } from './SessionBudget';
import { describeSession, stopLabel, type AgentSession } from './agentSessions';
import { useAuthStore } from '../../stores/authStore';
import { useChannelStore } from '../../stores/channelStore';
import { useServerStore } from '../../stores/serverStore';

const post = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async orig => ({ ...await orig<typeof import('../../lib/api')>(), api: { post: (...args: unknown[]) => post(...args) } }));

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
  id: 'S1', profile: 'cci', botUsername: 'cci', state: 'live', endReason: null, wakesUsed: 2, tokensUsed: 10,
  tokenBudget: null, wakeBudget: null, limitStop: null, lastActiveAt: '', ...over });
const show = (s: AgentSession, onChanged = vi.fn()) => render(<MemoryRouter><SessionBudget session={s} channelId="channel" onChanged={onChanged} /></MemoryRouter>);

beforeEach(() => {
  post.mockReset();
  useAuthStore.setState({ user: { id: 'owner' } as never });
  useChannelStore.setState({ channels: new Map([['channel', { id: 'channel', name: 'general', channelType: 0, serverId: 'server' }]]) });
  useServerStore.setState({ servers: new Map([['server', { id: 'server', name: 'server', ownerId: 'owner' }]]) });
});

describe('what stopped a session', () => {
  /**
   * The report: cci "hasn't hit its token budget but the UI claims it did". A session the wake
   * limit stopped showed "1,200,000 / 50,000,000 tokens used", "Paused: session budget used up."
   * and one control, the token budget.
   */
  it('a wake stop says wakes, with the numbers and where to lift it, and does not blame tokens', () => {
    show(session({ state: 'shelved', endReason: 'budget', wakesUsed: 50, wakeBudget: 50, tokensUsed: 1_200_000, tokenBudget: 50_000_000,
      limitStop: { kind: 'wake', used: 50, limit: 50, sessionId: 'S1' } }));
    const stop = screen.getByRole('alert');
    expect(stop).toHaveTextContent('Stopped by the wake limit: 50 of 50 wakes.');
    expect(stop).toHaveTextContent('Raise or remove "Wakes per session" for cci in Settings → Agents, then resume.');
    expect(within(stop).getByRole('link', { name: 'Settings → Agents' })).toHaveAttribute('href', '/settings/agents');
    expect(stop).not.toHaveTextContent(/token/i);
    expect(screen.queryByText(/budget used up/i)).toBeNull();
    expect(screen.getByText('50 / 50 wakes')).toBeInTheDocument();
    expect(screen.getByText('1,200,000 / 50,000,000 tokens')).toBeInTheDocument();
  });

  it('a token stop says tokens; a parent\'s limit is named as the parent\'s', () => {
    const { unmount } = show(session({ state: 'shelved', endReason: 'budget', tokensUsed: 150, tokenBudget: 100, limitStop: { kind: 'token', used: 150, limit: 100, sessionId: 'S1' } }));
    expect(screen.getByRole('alert')).toHaveTextContent('Stopped by the token limit: 150 of 100 tokens. Raise or remove "Tokens per session" for cci in Settings → Agents, then resume.');
    unmount();
    show(session({ state: 'shelved', endReason: 'budget', parentSessionId: 'P9', limitStop: { kind: 'token', used: 11000, limit: 10000, sessionId: 'P9' } }));
    expect(screen.getByRole('alert')).toHaveTextContent('Stopped by the token limit of its parent session P9: 11,000 of 10,000 tokens.');
  });

  it("a token limit set on the session itself points at the session's controls, not at Settings", () => {
    show(session({ state: 'shelved', endReason: 'budget', tokensUsed: 6, tokenBudget: 5, limitStop: { kind: 'token', used: 6, limit: 5, sessionId: 'S1', source: 'session' } }));
    const stop = screen.getByRole('alert');
    expect(stop).toHaveTextContent("Stopped by the token limit: 6 of 5 tokens. That is this session's own token limit: raise or clear it in its session controls, then resume.");
    expect(within(stop).queryByRole('link')).toBeNull();
  });

  it("an API key out of credit is not described as one of Agora's limits", () => {
    show(session({ state: 'shelved', endReason: 'budget', limitStop: { kind: 'credit' } }));
    expect(screen.getByRole('alert')).toHaveTextContent("Stopped because the agent's API key is out of credit. This is the provider's limit, not one set in Agora: add credit or raise the key's limit, then resume.");
  });

  it('a session shelved before the upgrade, with no record of which limit, says so and that resume works', () => {
    show(session({ state: 'shelved', endReason: 'budget' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Stopped by a session limit before this server recorded which one. Resume it: limits are off unless you set one in Settings → Agents.');
  });

  it('labels in lists name the limit too', () => {
    expect(stopLabel(session({ endReason: 'budget', limitStop: { kind: 'wake', used: 50, limit: 50, sessionId: 'S1' } }))).toBe('wake limit 50/50');
    expect(stopLabel(session({ endReason: 'budget', limitStop: { kind: 'token', used: 1_500_000, limit: 1_000_000, sessionId: 'S1' } }))).toBe('token limit 1.5M/1M');
    expect(stopLabel(session({ endReason: 'budget', limitStop: { kind: 'credit' } }))).toBe('API key out of credit');
    expect(stopLabel(session({ endReason: 'replaced' }))).toBe('replaced');
    expect(describeSession(session({ state: 'shelved', endReason: 'budget', wakesUsed: 50, limitStop: { kind: 'wake', used: 50, limit: 50, sessionId: 'S1' } })))
      .toContain('shelved (wake limit 50/50)');
  });
});

describe('limits are shown, not pushed', () => {
  it('a session with no limits says so and still shows usage', () => {
    show(session({ wakesUsed: 5000, tokensUsed: 900_000_000 }));
    expect(screen.getByText('5,000 wakes · no limit')).toBeInTheDocument();
    expect(screen.getByText('900,000,000 tokens · no limit')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("the owner sets this session's own token limit to any size, or clears it", async () => {
    post.mockResolvedValue({ action: 'budget_updated' });
    const onChanged = vi.fn();
    show(session(), onChanged);
    const field = screen.getByLabelText("This session's own token limit");
    expect(field).toHaveValue(null);
    expect(field).not.toHaveAttribute('max');
    fireEvent.change(field, { target: { value: '9007199254740991' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(post).toHaveBeenLastCalledWith('/channels/channel/agent-commands', { command: 'budget', sessionId: 'S1', tokenBudget: 9007199254740991 });
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/channels/channel/agent-commands', { command: 'budget', sessionId: 'S1', tokenBudget: null }));
    fireEvent.change(field, { target: { value: '0' } });
    expect(screen.getByRole('button', { name: 'Save limit' })).toBeDisabled();
  });

  it('nothing is shown for a terminal session: Agora cannot limit a CLI the user runs', () => {
    const { container } = show(session({ kind: 'terminal' }));
    expect(container).toBeEmptyDOMElement();
  });
});
