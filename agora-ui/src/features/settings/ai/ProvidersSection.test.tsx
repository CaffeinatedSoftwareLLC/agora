import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { aiApi, ApiError } from '../../../lib/api';
import type { AICapability } from '../../../lib/api';
import { ProvidersSection } from './ProvidersSection';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function view(capabilities: AICapability[], model?: string, supportsBaseUrl = true) {
  return <ProvidersSection serverId="S" adapters={[{ id: 'openai', label: 'OpenAI-compatible',
    capabilities: ['chat', 'tts', 'stt'], requiresApiKey: false, supportsBaseUrl, defaultBaseUrl: 'https://api.openai.com/v1', defaultModels: {} }]}
    providers={[{ id: 'P', label: 'Speech server', adapter: 'openai', baseUrl: 'https://speech.example/v1', hasApiKey: false,
      enabled: true, capabilities, createdAt: '', updatedAt: '' }]} testModels={model ? { P: model } : {}}
    isInstanceAdmin={false} allowPrivateBaseUrls={false} onChanged={() => {}} onAllowPrivateChanged={() => {}} />;
}
const show = (capabilities: AICapability[], model?: string) => render(view(capabilities, model));

it.each(['tts', 'stt'] as const)('defaults a speech-only provider Test to %s', async capability => {
  const test = vi.spyOn(aiApi, 'testProvider').mockResolvedValue({ ok: true });
  show([capability], 'speech-model');
  expect((screen.getByLabelText('Test capability for Speech server') as HTMLSelectElement).value).toBe(capability);
  fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  await screen.findByText('Connection OK');
  expect(test).toHaveBeenCalledWith('S', 'P', 'speech-model', capability);
});

it('lets an unrouted speech server be tested without inventing a chat model', async () => {
  const test = vi.spyOn(aiApi, 'testProvider').mockResolvedValue({ ok: true });
  show([]);
  expect(screen.getByRole('button', { name: 'Test' })).toHaveProperty('disabled', true);
  fireEvent.change(screen.getByLabelText('Test capability for Speech server'), { target: { value: 'stt' } });
  expect(screen.getByRole('button', { name: 'Test' })).toHaveProperty('disabled', false);
  fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  await screen.findByText('Connection OK');
  expect(test).toHaveBeenCalledWith('S', 'P', undefined, 'stt');
});

it('offers explicit chat testing and displays a provider failure', async () => {
  const test = vi.spyOn(aiApi, 'testProvider').mockResolvedValue({ ok: false, error: 'Chat is not available' });
  show(['tts'], 'chat-model');
  fireEvent.change(screen.getByLabelText('Test capability for Speech server'), { target: { value: 'chat' } });
  fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  await screen.findByText('Chat is not available');
  expect(test).toHaveBeenCalledWith('S', 'P', 'chat-model', 'chat');
});

it('updates the default after a route is saved, while preserving an explicit user choice', () => {
  const ui = show([]);
  const select = () => screen.getByLabelText('Test capability for Speech server') as HTMLSelectElement;
  expect(select().value).toBe('chat');
  ui.rerender(view(['tts'])); expect(select().value).toBe('tts');
  fireEvent.change(select(), { target: { value: 'stt' } });
  ui.rerender(view(['chat', 'tts'])); expect(select().value).toBe('stt');
});

it('edits an existing base URL without replacing the provider, key or capability routes', async () => {
  const update = vi.spyOn(aiApi, 'updateProvider').mockResolvedValue({} as never);
  show(['tts']);
  fireEvent.click(screen.getByRole('button', { name: 'Edit base URL' }));
  expect(screen.getByLabelText('Base URL')).toHaveProperty('value', 'https://speech.example/v1');
  expect(screen.getByRole('button', { name: 'Test' })).toHaveProperty('disabled', true);
  fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: '  https://new.example/v1  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save base URL' }));
  await waitFor(() => expect(screen.queryByLabelText('Base URL')).toBeNull());
  expect(update).toHaveBeenCalledExactlyOnceWith('S', 'P', { baseUrl: 'https://new.example/v1' });
  expect(screen.getByRole('button', { name: 'Test' })).toHaveProperty('disabled', false);
});

it('clears a custom URL to the adapter default', async () => {
  const update = vi.spyOn(aiApi, 'updateProvider').mockResolvedValue({} as never);
  show(['tts']);
  fireEvent.click(screen.getByRole('button', { name: 'Edit base URL' }));
  fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: '   ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save base URL' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith('S', 'P', { baseUrl: null }));
});

it('cancels a draft without saving and restores the saved URL when reopened', () => {
  const update = vi.spyOn(aiApi, 'updateProvider');
  show(['tts']);
  fireEvent.click(screen.getByRole('button', { name: 'Edit base URL' }));
  fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://discard.example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit base URL' }));
  expect(screen.getByLabelText('Base URL')).toHaveProperty('value', 'https://speech.example/v1');
  expect(update).not.toHaveBeenCalled();
});

it('keeps a rejected URL draft visible with the API validation error', async () => {
  vi.spyOn(aiApi, 'updateProvider').mockRejectedValue(new ApiError(400, 'Private network base URLs are disabled'));
  show(['tts']);
  fireEvent.click(screen.getByRole('button', { name: 'Edit base URL' }));
  fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'http://localhost:8880/v1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save base URL' }));
  await screen.findByText('Private network base URLs are disabled');
  expect(screen.getByLabelText('Base URL')).toHaveProperty('value', 'http://localhost:8880/v1');
  expect(screen.getByRole('button', { name: 'Save base URL' })).toHaveProperty('disabled', false);
});

it('does not offer URL editing for an adapter without base URL support', () => {
  render(view(['tts'], undefined, false));
  expect(screen.queryByRole('button', { name: 'Edit base URL' })).toBeNull();
});
