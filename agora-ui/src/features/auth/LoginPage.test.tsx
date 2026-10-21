import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => { values.set(k, v); },
    removeItem: (k: string) => { values.delete(k); },
  });
});

const supported = vi.hoisted(() => ({ value: true }));
const startAuthentication = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => supported.value,
  startAuthentication: (...a: unknown[]) => startAuthentication(...a),
  startRegistration: vi.fn(),
}));
vi.mock('../../hooks/useInstance', () => ({ useInstance: () => ({ data: { instanceName: 'Agora', registrationPolicy: 'open' } }) }));

import { api, ApiError } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { LoginPage } from './LoginPage';

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/app" element={<p>Signed in</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  startAuthentication.mockReset();
  supported.value = true;
  useAuthStore.setState({ user: null, status: 'idle' });
});

test('signs in with a passkey (username-less) and lands in the app', async () => {
  useAuthStore.setState({ user: null, status: 'idle' });
  const post = vi.spyOn(api, 'post').mockImplementation(async (path: string) => {
    if (path === '/auth/passkeys/login/options') return { flowId: 'flow', options: { challenge: 'c' } };
    return { user: { id: 'U'.repeat(26), username: 'alice' } };
  });
  startAuthentication.mockResolvedValue({ id: 'cred' });
  renderLogin();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
  expect(await screen.findByText('Signed in')).toBeInTheDocument();
  expect(post).toHaveBeenCalledWith('/auth/passkeys/login/options', {});
  expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c' } });
  expect(post).toHaveBeenCalledWith('/auth/passkeys/login/verify', { flowId: 'flow', response: { id: 'cred' } });
  expect(useAuthStore.getState().user?.username).toBe('alice');
});

test('a typed username narrows the passkey prompt; a rejected passkey shows why', async () => {
  useAuthStore.setState({ user: null, status: 'idle' });
  const post = vi.spyOn(api, 'post').mockImplementation(async (path: string) => {
    if (path === '/auth/passkeys/login/options') return { flowId: 'flow', options: {} };
    throw new ApiError(401, 'invalid_credentials');
  });
  startAuthentication.mockResolvedValue({ id: 'cred' });
  renderLogin();
  fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: ' alice ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
  await waitFor(() => expect(screen.getByText(/not registered here/)).toBeInTheDocument());
  expect(post).toHaveBeenCalledWith('/auth/passkeys/login/options', { login: 'alice' });
  expect(useAuthStore.getState().status).toBe('idle');
});

// beta-test-plan §6.1 Branding: plain-text names with the not-affiliated line, no provider sign-in
test('shows the not-affiliated line and no provider sign-in on the login page', () => {
  renderLogin();
  expect(screen.getByText('Agora is not affiliated with Anthropic, OpenAI or Google. Claude Code, Codex and Gemini are trademarks of their owners.')).toBeInTheDocument();
  expect(screen.queryByText(/(sign in|log in|continue) with (claude|google|anthropic|openai|chatgpt)/i)).toBeNull();
  expect(document.querySelectorAll('img')).toHaveLength(0);
});

test('no passkey button when the browser has no WebAuthn', () => {
  supported.value = false;
  useAuthStore.setState({ user: null, status: 'idle' });
  renderLogin();
  expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
});

// #159: the lockout showed the raw code "too_many_attempts"
test.each([
  [429, 'too_many_attempts', 'Too many attempts. Wait a few minutes and try again.'],
  [503, 'login_unavailable', 'Sign-in is unavailable right now. Try again shortly.'],
  [401, 'invalid_credentials', 'Wrong username, email or password.'],
  [403, 'account_suspended', 'Your account has been suspended. Contact an administrator.'],
])('a %i %s from the password form is shown in words', async (status, code, message) => {
  useAuthStore.setState({ user: null, status: 'idle' });
  vi.spyOn(api, 'post').mockRejectedValue(new ApiError(status, code));
  renderLogin();
  fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(screen.queryByText(code)).toBeNull();
});

test('a locked-out passkey sign-in gets the same words as the password form', async () => {
  useAuthStore.setState({ user: null, status: 'idle' });
  vi.spyOn(api, 'post').mockRejectedValue(new ApiError(429, 'too_many_attempts'));
  renderLogin();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
  expect(await screen.findByText('Too many attempts. Wait a few minutes and try again.')).toBeInTheDocument();
});
