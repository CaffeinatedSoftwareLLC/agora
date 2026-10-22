import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { aiApi } from '../../../lib/api';
import type { AIAdapter, AIProvider } from '../../../lib/api';
import { RoutesSection } from './RoutesSection';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const decider = (id: string, label: string, model: string, extra: Partial<AIAdapter> = {}): AIAdapter => ({
  id, label, capabilities: ['decide'], requiresApiKey: true, supportsBaseUrl: false, defaultBaseUrl: '', defaultModels: { decide: model }, ...extra,
});
const ADAPTERS = [
  decider('typesafe', 'TypeSafe Jev (decisions)', 'jev-latest'),
  decider('greenpt', 'GreenPT Metis (decisions)', 'metis'),
  decider('cloudflare', 'Cloudflare Clef (decisions)', '@cf/cloudflare/clef-flash', {
    requiresAccountId: true, modelChoices: { decide: ['@cf/cloudflare/clef-flash', '@cf/cloudflare/clef'] },
  }),
];
const provider = (id: string, adapter: string, label: string): AIProvider =>
  ({ id, adapter, label, baseUrl: null, hasApiKey: true, enabled: true, capabilities: [], createdAt: '', updatedAt: '' });
const PROVIDERS = [provider('J', 'typesafe', 'Jev'), provider('M', 'greenpt', 'Metis'), provider('C', 'cloudflare', 'Clef')];

it('offers every decision provider for Decide; only Clef narrows the model to its two IDs', async () => {
  const put = vi.spyOn(aiApi, 'putRoute').mockResolvedValue({} as never);
  render(<RoutesSection serverId="S" adapters={ADAPTERS} providers={PROVIDERS} routes={[]} onChanged={() => {}} />);
  const providerSelect = screen.getByLabelText('Decide provider') as HTMLSelectElement;
  expect([...providerSelect.options].map(o => o.textContent)).toEqual(['Jev', 'Metis', 'Clef']);
  expect(screen.getByLabelText('Decide model')).toHaveProperty('value', 'jev-latest');

  fireEvent.change(providerSelect, { target: { value: 'C' } });
  const clefModel = screen.getByLabelText('Decide model') as HTMLSelectElement;
  expect([...clefModel.options].map(o => o.value)).toEqual(['@cf/cloudflare/clef-flash', '@cf/cloudflare/clef']);

  fireEvent.change(providerSelect, { target: { value: 'M' } });
  expect(screen.getByLabelText('Decide model')).toHaveProperty('value', 'metis');
  fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
  await waitFor(() => expect(put).toHaveBeenCalledWith('S', 'decide', expect.objectContaining({ providerId: 'M', model: 'metis' })));
});
