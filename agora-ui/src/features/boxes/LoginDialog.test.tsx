import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, ApiError } from '../../lib/api';
import { LoginDialog } from './LoginDialog';
import type { Box, BoxLogin } from './api';

const ID = 'B'.repeat(26);
const box = (adapter: Box['adapter']): Box => ({
  id: ID, name: 'builder', adapter, auth: 'subscription', state: 'running', desiredState: 'running', pendingAction: null,
  generation: 1, imageVersion: 1, loginState: 'none', homeChannelId: 'C1', allowedDomains: [], repos: [], cpus: 2,
  memoryMb: 4096, pids: 1024, lastError: null, lastSeenAt: null, createdAt: '', deletedAt: null, volumePurgeAfter: null, policies: [],
});
const login = (over: Partial<BoxLogin>): BoxLogin => ({ id: 'L', status: 'requested', verificationUrl: null, userCode: null, error: null, expiresAt: null, ...over });

let polls: BoxLogin[];
let post: ReturnType<typeof vi.spyOn>;
let del: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  polls = [];
  post = vi.spyOn(api, 'post').mockImplementation(async (path: string) => (path === `/boxes/${ID}/login` ? { login: login({}) } : {}) as never);
  // Each poll returns the next state; the last one repeats
  vi.spyOn(api, 'get').mockImplementation(async () => ({ login: polls.length > 1 ? polls.shift()! : polls[0] ?? null }) as never);
  del = vi.spyOn(api, 'delete').mockResolvedValue({});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('Codex: shows the verification link and the one-time code with a copy button, then success', async () => {
  polls = [
    login({ status: 'claimed' }),
    login({ status: 'awaiting_user', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }),
  ];
  const onClose = vi.fn();
  render(<LoginDialog box={box('codex')} onClose={onClose} pollMs={5} />);
  expect(post).toHaveBeenCalledWith(`/boxes/${ID}/login`);
  const link = await screen.findByRole('link', { name: 'https://auth.openai.com/codex/device' });
  expect(link).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByLabelText('One-time code')).toHaveTextContent('ABCD-1234');
  // Codex needs no pasted code
  expect(screen.queryByLabelText('Code from Anthropic')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ABCD-1234'));
  polls = [login({ status: 'succeeded' })];
  await waitFor(() => expect(screen.getByTestId('login-status')).toHaveTextContent('Logged in'));
  expect(screen.queryByRole('link')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledWith(true);
  expect(del).not.toHaveBeenCalled();
});

it('Claude: shows the sign-in link and sends the pasted code', async () => {
  polls = [login({ status: 'awaiting_code', verificationUrl: 'https://claude.ai/oauth/authorize?x=1' })];
  render(<LoginDialog box={box('claude')} onClose={vi.fn()} pollMs={5} />);
  expect(await screen.findByRole('link')).toHaveAttribute('href', 'https://claude.ai/oauth/authorize?x=1');
  const send = screen.getByRole('button', { name: 'Send code' });
  expect(send).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Code from Anthropic'), { target: { value: '  pasted#code  ' } });
  fireEvent.click(send);
  await waitFor(() => expect(post).toHaveBeenCalledWith(`/boxes/${ID}/login/code`, { code: 'pasted#code' }));
  await waitFor(() => expect(screen.queryByLabelText('Code from Anthropic')).toBeNull());
  polls = [login({ status: 'failed', error: 'invalid code' })];
  await waitFor(() => expect(screen.getByTestId('login-status')).toHaveTextContent('Login failed: invalid code'));
});

it('says which domain blocked the login, while it runs and when it fails', async () => {
  polls = [login({ status: 'code_sent', blockedHosts: ['platform.claude.com'] })];
  render(<LoginDialog box={box('claude')} onClose={vi.fn()} pollMs={5} />);
  await waitFor(() => expect(screen.getByTestId('login-status')).toHaveTextContent('Blocked: the login needs platform.claude.com'));
  polls = [login({ status: 'failed', error: 'needs_domain', blockedHosts: ['platform.claude.com'] })];
  await waitFor(() => expect(screen.getByTestId('login-status')).toHaveTextContent('the box was blocked from platform.claude.com'));
});

it('shows an expired login', async () => {
  polls = [login({ status: 'expired' })];
  render(<LoginDialog box={box('claude')} onClose={vi.fn()} pollMs={5} />);
  await waitFor(() => expect(screen.getByTestId('login-status')).toHaveTextContent('expired'));
  expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
});

it('Cancel deletes the running login', async () => {
  polls = [login({ status: 'awaiting_user', verificationUrl: 'https://auth.openai.com/x', userCode: 'Q' })];
  const onClose = vi.fn();
  render(<LoginDialog box={box('codex')} onClose={onClose} pollMs={5} />);
  await screen.findByRole('link');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(del).toHaveBeenCalledWith(`/boxes/${ID}/login`));
  expect(onClose).toHaveBeenCalled();
});

it('never renders a non-http link', async () => {
  polls = [login({ status: 'awaiting_user', verificationUrl: 'javascript:alert(1)', userCode: 'Q' })];
  render(<LoginDialog box={box('codex')} onClose={vi.fn()} pollMs={5} />);
  await screen.findByText('javascript:alert(1)');
  expect(screen.queryByRole('link')).toBeNull();
});

it('never links a sign-in page off the provider’s own hosts', async () => {
  polls = [login({ status: 'awaiting_user', verificationUrl: 'https://auth.openai.com.evil.example/codex/device', userCode: 'Q' })];
  render(<LoginDialog box={box('codex')} onClose={vi.fn()} pollMs={5} />);
  await screen.findByText('https://auth.openai.com.evil.example/codex/device');
  expect(screen.queryByRole('link')).toBeNull();
});

it('follows a login that is already running', async () => {
  post.mockRejectedValue(new ApiError(409, 'login_active'));
  polls = [login({ status: 'awaiting_user', verificationUrl: 'https://auth.openai.com/x', userCode: 'ZZ' })];
  render(<LoginDialog box={box('codex')} onClose={vi.fn()} pollMs={5} />);
  expect(await screen.findByLabelText('One-time code')).toHaveTextContent('ZZ');
});
