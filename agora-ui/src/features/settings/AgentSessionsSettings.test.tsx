import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, serverApi } from '../../lib/api';
import { useServerStore } from '../../stores/serverStore';
import { AgentSessionsSettings, SubscriptionWakesSection } from './AgentSessionsSettings';

beforeEach(() => {
  useServerStore.setState({ instanceServerId: 'S' });
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => (path.endsWith('/agent-hosts')
    ? [{ id: 'H', name: 'desktop', revokedAt: null }]
    : path.endsWith('/agent-profiles') ? [{ id: 'P', name: 'claude', botId: 'B', hostId: 'H', adapter: 'claude',
      model: null, effort: null, workdirAlias: 'agora', workspaceId: 'primary', wakeBudget: 50, tokenBudget: 2000000, runTimeoutSec: 900 }]
    : []) as never);
  vi.spyOn(serverApi, 'getChannels').mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); useServerStore.setState({ instanceServerId: null }); });

/** The profile list with one profile; `limits` overrides the mock's old program defaults. */
function profiles(limits: object = {}, over: object = {}, host: object = {}) {
  vi.mocked(api.get).mockImplementation(async (path: string) => (path.endsWith('/agent-hosts')
    ? [{ id: 'H', name: 'desktop', revokedAt: null, ...host }]
    : path.endsWith('/agent-profiles') ? [{ id: 'P', name: 'claude', botId: 'B', hostId: 'H', adapter: 'claude',
      model: null, effort: null, workdirAlias: 'agora', workspaceId: 'primary', wakeBudget: null, tokenBudget: null, runTimeoutSec: null, ...limits, ...over }]
    : []) as never);
}
const LIMITS = ['Wakes per session', 'Tokens per session', 'Time per run'] as const;

describe('agent limits are shown, off by default, and the owner\'s choice', () => {
  it('a profile with no limits shows each limit as a row with "No limit" selected, one line on what it does, and no number field', async () => {
    profiles();
    render(<AgentSessionsSettings />);
    for (const limit of LIMITS) {
      expect(await screen.findByRole('radio', { name: `No limit: ${limit} for claude` })).toBeChecked();
      expect(screen.getByRole('radio', { name: `Set a limit: ${limit} for claude` })).not.toBeChecked();
      expect(screen.queryByRole('spinbutton', { name: `${limit} for claude` })).toBeNull();
    }
    expect(screen.getByText('Shelves a session after this many wakes. A wake is one run the agent starts to handle new messages.')).toBeTruthy();
    expect(screen.getByText('Shelves a session once it and its subtasks have used this many tokens. Claude counts cached context, so long runs use millions.')).toBeTruthy();
    expect(screen.getByText('Stops a single run after this long. With no limit a run ends when the agent finishes or you end its session.')).toBeTruthy();
    expect(screen.getByText("A change applies to this agent's existing sessions at once. A session a limit already stopped stays shelved until you resume it.")).toBeTruthy();
    expect(screen.getByText(/workdir agora · no limits/)).toBeTruthy();
    // Nothing to save until the owner changes something
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('choosing "Limit to" opens a number field; the limit is saved as typed, however large', async () => {
    profiles();
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
    render(<AgentSessionsSettings />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Set a limit: Wakes per session for claude' }));
    const wakes = screen.getByRole('spinbutton', { name: 'Wakes per session for claude' });
    expect(wakes).not.toHaveAttribute('max');
    // Chosen but still empty: not saveable yet
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(wakes, { target: { value: '100001' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Set a limit: Tokens per session for claude' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tokens per session for claude' }), { target: { value: '9007199254740991' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Set a limit: Time per run for claude' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Time per run for claude' }), { target: { value: '100000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/servers/S/agent-profiles/P',
      expect.objectContaining({ wakeBudget: 100001, tokenBudget: 9007199254740991, runTimeoutSec: 6_000_000 })));
  });

  it('a profile with limits shows them, and "No limit" removes one (saved as null)', async () => {
    profiles({ wakeBudget: 50, tokenBudget: 2000000, runTimeoutSec: 900 });
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
    render(<AgentSessionsSettings />);
    expect(await screen.findByRole('spinbutton', { name: 'Wakes per session for claude' })).toHaveValue(50);
    expect(screen.getByRole('spinbutton', { name: 'Tokens per session for claude' })).toHaveValue(2000000);
    expect(screen.getByRole('spinbutton', { name: 'Time per run for claude' })).toHaveValue(15);
    expect(screen.getByText(/50 wakes per session · 2,000,000 tokens per session · 15 min per run/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'No limit: Wakes per session for claude' }));
    expect(screen.queryByRole('spinbutton', { name: 'Wakes per session for claude' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'No limit: Time per run for claude' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/servers/S/agent-profiles/P',
      expect.objectContaining({ wakeBudget: null, tokenBudget: 2000000, runTimeoutSec: null })));
  });

  it.each(LIMITS.flatMap(limit => ['', '0', '-1', '1.5', '1e9', '9007199254740993'].map(value => [limit, value] as const)))(
    'does not save %s as "%s": a limit is a positive whole number', async (limit, value) => {
      profiles({ wakeBudget: 50, tokenBudget: 2000000, runTimeoutSec: 900 });
      const patch = vi.spyOn(api, 'patch');
      render(<AgentSessionsSettings />);
      fireEvent.change(await screen.findByRole('spinbutton', { name: `${limit} for claude` }), { target: { value } });
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(patch).not.toHaveBeenCalled();
    });

  it('leaves the run time limit out of a save that did not change it', async () => {
    profiles({ wakeBudget: 50, tokenBudget: 2000000, runTimeoutSec: 905 });
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
    render(<AgentSessionsSettings />);
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Wakes per session for claude' }), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][1]).not.toHaveProperty('runTimeoutSec');
  });

  it("sends only the session limits for a box's profile (its model and the rest are the box's)", async () => {
    profiles({ wakeBudget: 50, tokenBudget: null, runTimeoutSec: 900 }, { name: 'cci', adapter: 'codex', boxed: true, model: 'gpt-x', workdirAlias: 'work' }, { name: 'box-cci', kind: 'box' });
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
    render(<AgentSessionsSettings />);
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Time per run for cci' }), { target: { value: '45' } });
    expect(screen.queryByLabelText('Model for cci')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/servers/S/agent-profiles/P', { wakeBudget: 50, tokenBudget: null, runTimeoutSec: 2700 }));
  });
});

it('creates an opencode agent only with an OpenRouter model ID', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ bot: { username: 'qwen' }, token: 'bot_x' });
  render(<AgentSessionsSettings />);
  fireEvent.change(await screen.findByLabelText('CLI'), { target: { value: 'opencode' } });
  fireEvent.change(screen.getByLabelText('Name (what you type after /start)'), { target: { value: 'qwen' } });
  const create = screen.getByRole('button', { name: 'Create agent' });
  expect(create).toHaveProperty('disabled', true);
  fireEvent.change(screen.getByLabelText('OpenRouter model ID (required)'), { target: { value: 'qwen/qwen3-coder' } });
  // Not before the owner confirms it runs unboxed (docs/agent-boxes.md §10)
  expect(create).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByLabelText(/^Run unboxed on this machine/));
  expect(create).toHaveProperty('disabled', false);
  fireEvent.click(create);
  await waitFor(() => expect(post).toHaveBeenCalledWith('/servers/S/agents', expect.objectContaining({ adapter: 'opencode', model: 'qwen/qwen3-coder', name: 'qwen', hostModeAck: true })));
});

it('does not save an opencode agent without a model', async () => {
  vi.mocked(api.get).mockImplementation(async (path: string) => (path.endsWith('/agent-hosts')
    ? [{ id: 'H', name: 'desktop', revokedAt: null }]
    : path.endsWith('/agent-profiles') ? [{ id: 'P', name: 'qwen', botId: 'B', hostId: 'H', adapter: 'opencode',
      model: 'qwen/qwen3-coder', effort: null, workdirAlias: 'agora', workspaceId: 'primary', wakeBudget: 50, tokenBudget: 2000000, runTimeoutSec: 900 }]
    : []) as never);
  const patch = vi.spyOn(api, 'patch');
  render(<AgentSessionsSettings />);
  fireEvent.change(await screen.findByLabelText('Model for qwen'), { target: { value: ' ' } });
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  expect(patch).not.toHaveBeenCalled();
});

describe('who can wake subscription agents (docs/provider-terms.md, "Owner bots")', () => {
  const settingsGet = (value: string) => vi.mocked(api.get).mockImplementation(async (path: string) =>
    (path.endsWith('/agent-settings') ? { subscriptionWakes: value } : []) as never);

  it('shows the default (you and your own agents) and lets the owner make it stricter', async () => {
    settingsGet('owner_bots');
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ subscriptionWakes: 'owner_only' });
    render(<SubscriptionWakesSection serverId="S" isOwner />);
    const ours = await screen.findByRole('radio', { name: /^You and your own agents/ });
    const strict = screen.getByRole('radio', { name: /^Only you/ });
    expect(ours).toHaveProperty('checked', true);
    expect(strict).toHaveProperty('checked', false);
    expect(screen.getByText('Stricter: agents only answer you, not your other agents.')).toBeTruthy();
    fireEvent.click(strict);
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/servers/S/agent-settings', { subscriptionWakes: 'owner_only' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /^Only you/ })).toHaveProperty('checked', true));
  });

  it('shows the setting to everyone else, without letting them change it', async () => {
    settingsGet('owner_only');
    const patch = vi.spyOn(api, 'patch');
    render(<SubscriptionWakesSection serverId="S" isOwner={false} />);
    const strict = await screen.findByRole('radio', { name: /^Only you/ });
    expect(strict).toHaveProperty('checked', true);
    expect(strict).toHaveProperty('disabled', true);
    expect(screen.getByRole('radio', { name: /^You and your own agents/ })).toHaveProperty('disabled', true);
    expect(screen.getByText('Only the server owner can change this.')).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();
  });

  it('is part of the Agents page, and stays hidden on a server without the setting', async () => {
    settingsGet('owner_bots');
    render(<AgentSessionsSettings />);
    expect(await screen.findByRole('radiogroup', { name: 'Who can wake subscription agents' })).toBeTruthy();
    cleanup();
    vi.mocked(api.get).mockRejectedValue(new Error('404'));
    const { container } = render(<SubscriptionWakesSection serverId="S" isOwner />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/servers/S/agent-settings'));
    expect(container.textContent).toBe('');
  });
});
