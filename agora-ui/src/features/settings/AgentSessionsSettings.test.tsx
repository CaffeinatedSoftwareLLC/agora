import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, serverApi } from '../../lib/api';
import { useServerStore } from '../../stores/serverStore';
import { AgentSessionsSettings } from './AgentSessionsSettings';

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

it('creates an opencode agent only with an OpenRouter model ID', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ bot: { username: 'qwen' }, token: 'bot_x' });
  render(<AgentSessionsSettings />);
  fireEvent.change(await screen.findByLabelText('CLI'), { target: { value: 'opencode' } });
  fireEvent.change(screen.getByLabelText('Name (bot and /start name)'), { target: { value: 'qwen' } });
  const create = screen.getByRole('button', { name: 'Create agent' });
  expect(create).toHaveProperty('disabled', true);
  fireEvent.change(screen.getByLabelText('OpenRouter model ID (required)'), { target: { value: 'qwen/qwen3-coder' } });
  expect(create).toHaveProperty('disabled', false);
  fireEvent.click(create);
  await waitFor(() => expect(post).toHaveBeenCalledWith('/servers/S/agents', expect.objectContaining({ adapter: 'opencode', model: 'qwen/qwen3-coder', name: 'qwen' })));
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
