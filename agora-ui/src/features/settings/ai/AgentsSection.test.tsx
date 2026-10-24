import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { aiApi } from '../../../lib/api';
import type { AIProvider, ModelAgent, ModelAgentBudget } from '../../../lib/api';
import type { Channel } from '../../../lib/contracts/server';
import { AgentsSection } from './AgentsSection';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const provider = (id: string, adapter: string, label: string): AIProvider =>
  ({ id, adapter, label, baseUrl: null, hasApiKey: true, enabled: true, capabilities: [], createdAt: '', updatedAt: '' });
const PROVIDERS = [provider('O', 'openai', 'OpenRouter'), provider('A', 'anthropic', 'Anthropic')];
const CHANNELS = [{ id: 'C1', name: 'general', channelType: 3 }] as Channel[];
const BUDGET: ModelAgentBudget = { mode: 'shared', dailyRequestLimit: null, dailyTokenLimit: null, dailyCostLimitMicros: null, today: { requests: 0, tokens: 0, costMicros: null } };

it('creates an agent with an OpenAI-compatible provider, chosen tools and channels', async () => {
  const create = vi.spyOn(aiApi, 'createAgent').mockResolvedValue({} as never);
  const onChanged = vi.fn();
  render(<AgentsSection serverId="S" adapters={[]} providers={PROVIDERS} agents={[]} budget={BUDGET} channels={CHANNELS} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));

  // Only providers that can run agents are offered
  const select = screen.getByLabelText('Provider') as HTMLSelectElement;
  expect([...select.options].map(o => o.textContent)).toEqual(['OpenRouter']);

  fireEvent.change(screen.getByLabelText('Name (how people @mention it)'), { target: { value: 'Scout' } });
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'openai/gpt-4.1-mini' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /task_list/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /#general/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));

  await waitFor(() => expect(create).toHaveBeenCalledWith('S', expect.objectContaining({
    name: 'Scout', providerId: 'O', model: 'openai/gpt-4.1-mini', maxSteps: 6, channelIds: ['C1'],
    tools: ['read_history', 'file_search', 'file_read', 'task_list'],
  })));
  expect(onChanged).toHaveBeenCalled();
});

it('pauses an agent', async () => {
  const update = vi.spyOn(aiApi, 'updateAgent').mockResolvedValue({} as never);
  const agent = {
    id: 'G', botId: 'B', name: 'Scout', providerId: 'O', providerLabel: 'OpenRouter', adapter: 'openai', model: 'm', systemPrompt: null,
    tools: [], maxSteps: 6, maxOutputTokens: 2048, dailyRequestLimit: null, dailyTokenLimit: null, dailyCostLimitMicros: null,
    inputPriceMicrosPerMtok: null, outputPriceMicrosPerMtok: null, enabled: true, runtimeAccess: 'none', channelCount: 1,
    today: { requests: 0, tokens: 0, costMicros: null }, createdAt: '', updatedAt: '',
  } satisfies ModelAgent;
  render(<AgentsSection serverId="S" adapters={[]} providers={PROVIDERS} agents={[agent]} budget={BUDGET} channels={CHANNELS} onChanged={() => {}} />);
  expect(screen.getByText('@Scout')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith('S', 'G', { enabled: false }));
});

it('switches agents to a separate budget with a pool limit', async () => {
  const update = vi.spyOn(aiApi, 'updateAgentBudget').mockResolvedValue({} as never);
  render(<AgentsSection serverId="S" adapters={[]} providers={PROVIDERS} agents={[]} budget={BUDGET} channels={CHANNELS} onChanged={() => {}} />);
  expect(screen.queryByRole('button', { name: 'Save budget' })).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: /Separate/ }));
  fireEvent.change(screen.getByLabelText("Agents' daily requests (optional)"), { target: { value: '50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith('S', { mode: 'separate', dailyRequestLimit: 50, dailyTokenLimit: null }));
});
