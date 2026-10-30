import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { DeleteAccount } from './DeleteAccount';

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));

const preview = { deletedAccountMessages: 'anonymize', passkeys: 0, ownedServers: [], lastAdmin: false, ownedBots: [] };

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/account']}>
      <Routes>
        <Route path="/account" element={<DeleteAccount />} />
        <Route path="/login" element={<p>Login page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: 'U'.repeat(26), username: 'alice', isInstanceAdmin: false } as never, status: 'authenticated' as never });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('explains each policy', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(preview);
  renderPage();
  expect(await screen.findByText(/shown as "Deleted user"/)).toBeInTheDocument();
  cleanup();
  vi.spyOn(api, 'get').mockResolvedValue({ ...preview, deletedAccountMessages: 'remove' });
  renderPage();
  expect(await screen.findByText(/Your messages and the files you uploaded will be deleted/)).toBeInTheDocument();
});

test('a server owner sees the servers to transfer and cannot start', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ ...preview, ownedServers: [{ id: 'S'.repeat(26), name: 'Lab' }] });
  renderPage();
  expect(await screen.findByText('Lab')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Delete account…' })).toBeDisabled();
});

test('needs the password and the typed username, then signs out to the login page', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(preview);
  const del = vi.spyOn(api, 'delete').mockResolvedValue({ deleted: true });
  const clearSession = vi.fn();
  useAuthStore.setState({ clearSession });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Delete account…' }));
  const submit = screen.getByRole('button', { name: 'Delete my account' });
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'pw' } });
  fireEvent.change(screen.getByLabelText('Type your username (alice) to confirm'), { target: { value: 'alic' } });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Type your username (alice) to confirm'), { target: { value: 'alice' } });
  fireEvent.click(submit);
  expect(await screen.findByText('Login page')).toBeInTheDocument();
  expect(del).toHaveBeenCalledWith('/users/@me', { confirm: 'alice', password: 'pw' });
  expect(clearSession).toHaveBeenCalled();
});

test('a wrong password is reported and nothing is cleared', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(preview);
  vi.spyOn(api, 'delete').mockRejectedValue(new ApiError(403, 'reauth_failed'));
  const clearSession = vi.fn();
  useAuthStore.setState({ clearSession });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Delete account…' }));
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'nope' } });
  fireEvent.change(screen.getByLabelText('Type your username (alice) to confirm'), { target: { value: 'alice' } });
  fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That password or passkey is not right.'));
  expect(clearSession).not.toHaveBeenCalled();
});
