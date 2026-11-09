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

it('lets the owner raise the wake budget from the notice destination', async () => {
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
  render(<AgentSessionsSettings />);
  const input = await screen.findByLabelText('Wake budget for claude');
  expect(input).toHaveProperty('value', '50');
  fireEvent.change(input, { target: { value: '125' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/servers/S/agent-profiles/P', expect.objectContaining({ wakeBudget: 125 })));
});

it.each(['', '0', '-1', '1.5', '100001'])('does not save an invalid wake budget: %s', async value => {
  const patch = vi.spyOn(api, 'patch');
  render(<AgentSessionsSettings />);
  fireEvent.change(await screen.findByLabelText('Wake budget for claude'), { target: { value } });
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  expect(patch).not.toHaveBeenCalled();
});

it('lets the owner set the token budget per session next to the wake budget', async () => {
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
  render(<AgentSessionsSettings />);
  const input = await screen.findByLabelText('Token budget for claude');
  expect(input).toHaveProperty('value', '2000000');
  expect(screen.getByText('Sessions without their own budget use this. Claude counts cached context, so long runs use millions.')).toBeTruthy();
  fireEvent.change(input, { target: { value: '50000000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/servers/S/agent-profiles/P', expect.objectContaining({ tokenBudget: 50_000_000, wakeBudget: 50 })));
});

it.each(['', '0', '-5', '2.5', '1e9', '9007199254740993'])('does not save an invalid token budget: %s', async value => {
  const patch = vi.spyOn(api, 'patch');
  render(<AgentSessionsSettings />);
  fireEvent.change(await screen.findByLabelText('Token budget for claude'), { target: { value } });
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  expect(patch).not.toHaveBeenCalled();
});

it('lets the owner set the run time limit in minutes next to the budgets, saved in seconds', async () => {
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
  render(<AgentSessionsSettings />);
  const input = await screen.findByLabelText('Run time limit for claude');
  expect(input).toHaveProperty('value', '15');
  expect(screen.getByText('A run longer than this is stopped. Long jobs should run detached and be checked on later.')).toBeTruthy();
  expect(screen.getByText(/15 min per run/)).toBeTruthy();
  fireEvent.change(input, { target: { value: '60' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/servers/S/agent-profiles/P', expect.objectContaining({ runTimeoutSec: 3600, wakeBudget: 50 })));
});

it('leaves the run time limit out of a save that did not change it', async () => {
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
  render(<AgentSessionsSettings />);
  fireEvent.change(await screen.findByLabelText('Wake budget for claude'), { target: { value: '60' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(patch).toHaveBeenCalled());
  expect(patch.mock.calls[0][1]).not.toHaveProperty('runTimeoutSec');
});

it("sends only the session limits for a box's profile (its model and the rest are the box's)", async () => {
  vi.mocked(api.get).mockImplementation(async (path: string) => (path.endsWith('/agent-hosts')
    ? [{ id: 'H', name: 'box-cci', revokedAt: null, kind: 'box' }]
    : path.endsWith('/agent-profiles') ? [{ id: 'P', name: 'cci', botId: 'B', hostId: 'H', adapter: 'codex', boxed: true,
      model: 'gpt-x', effort: null, workdirAlias: 'work', workspaceId: 'primary', wakeBudget: 50, tokenBudget: 2000000, runTimeoutSec: 900 }]
    : []) as never);
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
  render(<AgentSessionsSettings />);
  fireEvent.change(await screen.findByLabelText('Run time limit for cci'), { target: { value: '45' } });
  expect(screen.queryByLabelText('Model for cci')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/servers/S/agent-profiles/P', { wakeBudget: 50, tokenBudget: 2000000, runTimeoutSec: 2700 }));
});

it.each(['', '0', '1.5', '121', '-5'])('does not save an invalid run time limit: %s', async value => {
  const patch = vi.spyOn(api, 'patch');
  render(<AgentSessionsSettings />);
  fireEvent.change(await screen.findByLabelText('Run time limit for claude'), { target: { value } });
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  expect(patch).not.toHaveBeenCalled();
});

it('creates an opencode agent only with an OpenRouter model ID', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ bot: { username: 'qwen' }, token: 'bot_x' });
  render(<AgentSessionsSettings />);
  fireEvent.change(await screen.findByLabelText('CLI'), { target: { value: 'opencode' } });
  fireEvent.change(screen.getByLabelText('Name (bot and /start name)'), { target: { value: 'qwen' } });
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
