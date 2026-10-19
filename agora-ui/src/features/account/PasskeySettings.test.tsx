import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, ApiError } from '../../lib/api';
import { PasskeySettings } from './PasskeySettings';

const startRegistration = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: (...a: unknown[]) => startRegistration(...a),
  startAuthentication: vi.fn(),
}));

const laptop = { id: 'A'.repeat(26), name: 'Laptop', rpId: 'localhost', deviceType: 'multiDevice', backedUp: true, createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null };
const key = { id: 'B'.repeat(26), name: 'YubiKey', rpId: 'localhost', deviceType: 'singleDevice', backedUp: false, createdAt: '2026-10-02T00:00:00Z', lastUsedAt: '2026-10-18T00:00:00Z' };

beforeEach(() => { vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); startRegistration.mockReset(); });

test('lists passkeys with name, hostname, created and last used', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ passkeys: [laptop, key] });
  render(<PasskeySettings />);
  const list = await screen.findByRole('list', { name: 'Your passkeys' });
  const items = within(list).getAllByRole('listitem');
  expect(items).toHaveLength(2);
  expect(items[0]).toHaveTextContent('Laptop');
  expect(items[0]).toHaveTextContent('Last used Never');
  expect(items[0]).toHaveTextContent('Synced');
  expect(items[1]).toHaveTextContent('YubiKey');
  expect(items[1]).toHaveTextContent('localhost');
  expect(items[1]).not.toHaveTextContent('Synced');
});

test('shows an empty state', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ passkeys: [] });
  render(<PasskeySettings />);
  expect(await screen.findByText('No passkeys yet.')).toBeInTheDocument();
});

test('adds a passkey through the browser ceremony', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ passkeys: [] });
  const post = vi.spyOn(api, 'post').mockImplementation(async (path: string) => {
    if (path === '/auth/passkeys/register/options') return { flowId: 'flow', options: { challenge: 'c' } };
    return { passkey: key };
  });
  startRegistration.mockResolvedValue({ id: 'cred' });
  render(<PasskeySettings />);
  await screen.findByText('No passkeys yet.');
  fireEvent.change(screen.getByLabelText('Passkey name'), { target: { value: 'YubiKey' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add a passkey' }));
  expect(await screen.findByText('YubiKey')).toBeInTheDocument();
  expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c' } });
  expect(post).toHaveBeenLastCalledWith('/auth/passkeys/register/verify', { flowId: 'flow', name: 'YubiKey', response: { id: 'cred' } });
});

test('a cancelled ceremony shows no error; a server error does', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ passkeys: [] });
  vi.spyOn(api, 'post').mockResolvedValue({ flowId: 'flow', options: {} });
  startRegistration.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
  render(<PasskeySettings />);
  await screen.findByText('No passkeys yet.');
  fireEvent.click(screen.getByRole('button', { name: 'Add a passkey' }));
  await waitFor(() => expect(startRegistration).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add a passkey' })).not.toBeDisabled());
  expect(screen.queryByRole('alert')).toBeNull();

  startRegistration.mockRejectedValueOnce(new ApiError(409, 'passkey_exists'));
  fireEvent.click(screen.getByRole('button', { name: 'Add a passkey' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('already registered');
});

test('removes a passkey after confirmation', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ passkeys: [laptop, key] });
  const del = vi.spyOn(api, 'delete').mockResolvedValue(undefined);
  render(<PasskeySettings />);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove Laptop' }));
  await waitFor(() => expect(screen.queryByText('Laptop')).toBeNull());
  expect(del).toHaveBeenCalledWith(`/auth/passkeys/${laptop.id}`);
  expect(screen.getByText('YubiKey')).toBeInTheDocument();
});
