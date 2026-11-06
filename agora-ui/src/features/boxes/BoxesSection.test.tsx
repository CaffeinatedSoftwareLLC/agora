import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, ApiError } from '../../lib/api';
import type { Channel } from '../../lib/contracts/server';
import { BoxesSection } from './BoxesSection';
import type { Box } from './api';
import { domainProblem, parseRepos, stateChip } from './boxRules';

const CHANNELS: Channel[] = [
  { id: 'C1', name: 'general', channelType: 3, serverId: 'S' },
  { id: 'C2', name: 'builds', channelType: 3, serverId: 'S' },
];

const box = (over: Partial<Box> = {}): Box => ({
  id: 'B'.repeat(26), name: 'builder', adapter: 'claude', auth: 'subscription', state: 'running', desiredState: 'running',
  pendingAction: null, generation: 3, imageVersion: 7, loginState: 'logged_in', homeChannelId: 'C1',
  allowedDomains: ['api.anthropic.com', 'registry.npmjs.org'], repos: ['octo/app'], cpus: 2, memoryMb: 4096, pids: 1024,
  lastError: null, lastSeenAt: null, createdAt: '2026-11-01T00:00:00Z', deletedAt: null, volumePurgeAfter: null,
  policies: [{ channelId: 'C1', autoPush: true, autoPr: false }],
  ...over,
});

let boxes: Box[];
let credential: unknown;
beforeEach(() => {
  boxes = [box()];
  credential = { set: true, accountLogin: 'octocat', setAt: '2026-11-02T00:00:00Z' };
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/servers/S/boxes') return { boxes } as never;
    if (path === '/servers/S/github-credential') return credential as never;
    if (path.endsWith('/login')) return { login: null } as never;
    throw new Error(`unexpected GET ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderSection = (isOwner = true) => render(<BoxesSection serverId="S" channels={CHANNELS} isOwner={isOwner} />);

describe('box list', () => {
  it('shows name, CLI, state, image version, login state and home channel', async () => {
    renderSection();
    const row = await screen.findByTestId('box-builder');
    expect(within(row).getByText('Claude Code')).toBeInTheDocument();
    expect(within(row).getByTestId('box-state')).toHaveTextContent('running');
    expect(within(row).getByText('image v7')).toBeInTheDocument();
    expect(row).toHaveTextContent('logged in');
    expect(row).toHaveTextContent('#general');
    expect(screen.getByTestId('github-credential')).toHaveTextContent('@octocat');
  });

  it('says a running box cannot log in, and which domain to allow, instead of "running"', async () => {
    boxes = [
      box({ id: 'A'.repeat(26), name: 'blocked', loginState: 'failed', loginError: 'needs_domain', loginBlockedHosts: ['platform.claude.com'] }),
      box({ id: 'C'.repeat(26), name: 'badcode', loginState: 'failed', loginError: 'login_failed' }),
      box({ id: 'D'.repeat(26), name: 'fresh', loginState: 'none' }),
      box({ id: 'E'.repeat(26), name: 'waiting', loginState: 'pending', loginBlockedHosts: ['auth.openai.com'] }),
    ];
    renderSection();
    const blocked = await screen.findByTestId('box-blocked');
    expect(within(blocked).getByTestId('box-state')).toHaveTextContent('login failed');
    expect(within(blocked).getByTestId('box-state')).not.toHaveTextContent('running');
    expect(within(blocked).getByTestId('box-login-hint')).toHaveTextContent("Login failed: allow platform.claude.com on the box's card, then log in again.");
    expect(within(screen.getByTestId('box-badcode')).getByTestId('box-login-hint')).toHaveTextContent('Login failed (login_failed): log in again.');
    expect(within(screen.getByTestId('box-fresh')).getByTestId('box-state')).toHaveTextContent('not logged in');
    expect(within(screen.getByTestId('box-fresh')).queryByTestId('box-login-hint')).toBeNull();
    expect(within(screen.getByTestId('box-waiting')).getByTestId('box-login-hint')).toHaveTextContent('The login is waiting: allow auth.openai.com');
  });

  it('shows a failed box with its last error, and pending actions', async () => {
    boxes = [
      box({ id: 'F'.repeat(26), name: 'broken', state: 'failed', lastError: 'five failed starts in ten minutes', loginState: 'none' }),
      box({ id: 'P'.repeat(26), name: 'busy', pendingAction: 'rebuild' }),
      box({ id: 'K'.repeat(26), name: 'keyed', auth: 'api_key', adapter: 'codex', imageVersion: null, state: 'creating' }),
    ];
    renderSection();
    const broken = await screen.findByTestId('box-broken');
    expect(within(broken).getByTestId('box-state')).toHaveTextContent('failed');
    expect(within(broken).getByTestId('box-error')).toHaveTextContent('five failed starts in ten minutes');
    expect(broken).toHaveTextContent('not logged in');
    const busy = screen.getByTestId('box-busy');
    expect(within(busy).getByTestId('box-state')).toHaveTextContent('rebuild pending');
    expect(within(busy).getByRole('button', { name: 'Rebuild' })).toBeDisabled();
    const keyed = screen.getByTestId('box-keyed');
    expect(keyed).toHaveTextContent('Codex');
    expect(keyed).toHaveTextContent('no image yet');
    expect(keyed).toHaveTextContent('API key');
    // An API key box has nothing to log in
    expect(within(keyed).queryByRole('button', { name: /Log in/ })).toBeNull();
  });

  it('shows a deleted box with the 7-day note, Restore and Delete now', async () => {
    const purgeAfter = new Date(Date.now() + 5.5 * 86_400_000).toISOString();
    boxes = [box({ desiredState: 'deleted', state: 'deleted', deletedAt: '2026-11-03T00:00:00Z', volumePurgeAfter: purgeAfter })];
    const post = vi.spyOn(api, 'post').mockResolvedValue({});
    renderSection();
    const row = await screen.findByTestId('box-builder');
    expect(row).toHaveTextContent('Its home folder is kept for 6 more days');
    expect(within(row).queryByRole('button', { name: 'Stop' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/boxes/${'B'.repeat(26)}/restore`));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(row).getByRole('button', { name: 'Delete now' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/boxes/${'B'.repeat(26)}/purge`));
  });

  it('hides owner actions from members and shows settings read-only', async () => {
    renderSection(false);
    const row = await screen.findByTestId('box-builder');
    for (const name of ['Log in again', 'Stop', 'Restart', 'Rebuild', 'Reset', 'Delete']) {
      expect(within(row).queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: 'Create box' })).toBeNull();
    expect(screen.queryByLabelText('GitHub token')).toBeNull();
    expect(within(row).getByLabelText('Auto-allow pushes from #general')).toBeDisabled();
    expect(within(row).queryByLabelText('Add an allowed domain for builder')).toBeNull();
  });

  it('sends lifecycle actions', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({});
    renderSection();
    const row = await screen.findByTestId('box-builder');
    fireEvent.click(within(row).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/boxes/${'B'.repeat(26)}/actions`, { action: 'stop' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Rebuild' }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith(`/boxes/${'B'.repeat(26)}/actions`, { action: 'rebuild' }));
  });

  it('deletes only after the 7-day confirmation', async () => {
    const del = vi.spyOn(api, 'delete').mockResolvedValue({});
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderSection();
    fireEvent.click(within(await screen.findByTestId('box-builder')).getByRole('button', { name: 'Delete' }));
    expect(confirm.mock.calls[0][0]).toContain('kept for 7 days');
    expect(del).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(within(screen.getByTestId('box-builder')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(`/boxes/${'B'.repeat(26)}`));
  });
});

describe('reset', () => {
  it('needs the box name typed and says logins and repos are wiped', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({});
    renderSection();
    fireEvent.click(within(await screen.findByTestId('box-builder')).getByRole('button', { name: 'Reset' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reset builder?' });
    expect(dialog).toHaveTextContent(/login and every cloned repository are gone/);
    const confirmButton = within(dialog).getByRole('button', { name: 'Reset box' });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Box name to confirm reset'), { target: { value: 'build' } });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Box name to confirm reset'), { target: { value: 'builder' } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/boxes/${'B'.repeat(26)}/actions`, { action: 'reset', confirm: 'builder' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('create box', () => {
  const open = async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Create box' }));
    return screen.findByRole('dialog', { name: 'Create box' });
  };

  it('validates name, API key and repos before sending', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ box: box({ name: 'reviewer', auth: 'api_key' }) });
    const dialog = await open();
    const submit = within(dialog).getByRole('button', { name: 'Create box' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'bad name!' } });
    expect(dialog).toHaveTextContent('Letters, digits');
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Reviewer' } });
    expect(submit).toBeEnabled();

    fireEvent.click(within(dialog).getByLabelText(/^API key/));
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/^Anthropic API key/), { target: { value: 'sk-ant-test' } });
    expect(submit).toBeEnabled();
    // Another CLI starts from its own default sign-in and never carries the key over
    fireEvent.change(within(dialog).getByLabelText('CLI'), { target: { value: 'codex' } });
    expect(within(dialog).getByLabelText(/^Subscription/)).toBeChecked();
    fireEvent.click(within(dialog).getByLabelText(/^API key/));
    expect(within(dialog).getByLabelText(/^OpenAI API key/)).toHaveValue('');
    fireEvent.change(within(dialog).getByLabelText(/^OpenAI API key/), { target: { value: 'sk-openai-test' } });

    fireEvent.change(within(dialog).getByLabelText(/GitHub repositories/), { target: { value: 'octo/app\nnot a repo' } });
    expect(dialog).toHaveTextContent('Not owner/repo');
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/GitHub repositories/), { target: { value: 'octo/app\nhttps://github.com/octo/lib.git' } });
    fireEvent.change(within(dialog).getByLabelText(/^Home channel/), { target: { value: 'C2' } });
    expect(within(dialog).getByLabelText('OpenAI API key')).toBeInTheDocument();
    fireEvent.click(submit);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/servers/S/boxes', {
      name: 'reviewer', adapter: 'codex', auth: 'api_key', apiKey: 'sk-openai-test', homeChannelId: 'C2', repos: ['octo/app', 'octo/lib'],
    }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('creates an opencode box with an OpenRouter key and its model, never a subscription', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ box: box({ name: 'qwen', adapter: 'opencode', auth: 'api_key' }) });
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'qwen' } });
    fireEvent.change(within(dialog).getByLabelText('CLI'), { target: { value: 'opencode' } });
    // An API key is its only sign-in: the subscription choice is gone and API key is picked
    expect(within(dialog).queryByLabelText(/^Subscription/)).toBeNull();
    expect(within(dialog).getByLabelText(/^API key/)).toBeChecked();
    const submit = within(dialog).getByRole('button', { name: 'Create box' });
    fireEvent.change(within(dialog).getByLabelText(/^OpenRouter API key/), { target: { value: 'sk-or-test' } });
    expect(dialog).toHaveTextContent('Enter the model ID.');
    expect(submit).toBeDisabled();
    // What agora-host can't claim with, and an :online model (web search around the edge), are refused
    fireEvent.change(within(dialog).getByLabelText(/^OpenRouter model ID/), { target: { value: 'qwen qwen3' } });
    expect(dialog).toHaveTextContent('Letters, digits and');
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/^OpenRouter model ID/), { target: { value: 'qwen/qwen3-coder:online' } });
    expect(dialog).toHaveTextContent("can't use an :online model");
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/^OpenRouter model ID/), { target: { value: ' qwen/qwen3-coder ' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/servers/S/boxes', {
      name: 'qwen', adapter: 'opencode', auth: 'api_key', apiKey: 'sk-or-test', homeChannelId: 'C1', model: 'qwen/qwen3-coder',
    }));
  });

  it('offers Log in straight after creating a subscription box', async () => {
    vi.spyOn(api, 'post').mockImplementation(async (path: string) => (path === '/servers/S/boxes'
      ? { box: box({ id: 'N'.repeat(26), name: 'fresh', loginState: 'none' }) }
      : { login: { id: 'L', status: 'requested', verificationUrl: null, userCode: null, error: null, expiresAt: null } }) as never);
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'fresh' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create box' }));
    expect(await screen.findByRole('dialog', { name: 'Log in Claude Code in fresh' })).toBeInTheDocument();
  });

  it('shows why the server refused', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(409, 'name_taken'));
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'builder' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create box' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('An agent with that name already exists.');
  });
});

describe('network and resources', () => {
  it('adds and removes allowed domains, refusing IPs and wildcards', async () => {
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
    renderSection();
    const row = await screen.findByTestId('box-builder');
    const input = within(row).getByLabelText('Add an allowed domain for builder');
    const add = () => within(row).getAllByRole('button', { name: 'Add' })[0];
    fireEvent.change(input, { target: { value: '10.0.0.1' } });
    expect(row).toHaveTextContent('IP addresses are not allowed');
    expect(add()).toBeDisabled();
    fireEvent.change(input, { target: { value: '*' } });
    expect(add()).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Docs.Example.com' } });
    fireEvent.click(add());
    await waitFor(() => expect(patch).toHaveBeenCalledWith(`/boxes/${'B'.repeat(26)}`,
      { allowedDomains: ['api.anthropic.com', 'registry.npmjs.org', 'docs.example.com'] }));
    fireEvent.click(within(row).getByRole('button', { name: 'Remove registry.npmjs.org' }));
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith(`/boxes/${'B'.repeat(26)}`, { allowedDomains: ['api.anthropic.com'] }));
  });

  it('toggles auto-allow per channel', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({});
    renderSection();
    const row = await screen.findByTestId('box-builder');
    expect(within(row).getByLabelText('Auto-allow pushes from #general')).toBeChecked();
    fireEvent.click(within(row).getByLabelText('Auto-allow pull requests from #builds'));
    await waitFor(() => expect(put).toHaveBeenCalledWith(`/boxes/${'B'.repeat(26)}/policies/C2`, { autoPush: false, autoPr: true }));
  });

  it('saves resources only within the limits', async () => {
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
    renderSection();
    const row = await screen.findByTestId('box-builder');
    fireEvent.change(within(row).getByLabelText('Memory (MB) for builder'), { target: { value: '100' } });
    expect(within(row).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(row).getByLabelText('Memory (MB) for builder'), { target: { value: '8192' } });
    fireEvent.change(within(row).getByLabelText('CPUs for builder'), { target: { value: '4' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(`/boxes/${'B'.repeat(26)}`, { cpus: 4, memoryMb: 8192, pids: 1024 }));
  });
});

describe('GitHub token', () => {
  it('sets a token and shows the account', async () => {
    credential = { set: false, accountLogin: null, setAt: null };
    const put = vi.spyOn(api, 'put').mockResolvedValue({ accountLogin: 'octocat' });
    renderSection();
    const panel = await screen.findByTestId('github-credential');
    expect(panel).toHaveTextContent('Not set');
    fireEvent.change(within(panel).getByLabelText('GitHub token'), { target: { value: 'github_pat_x' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/servers/S/github-credential', { token: 'github_pat_x' }));
    expect(await within(panel).findByRole('status')).toHaveTextContent('GitHub account: octocat');
    expect(within(panel).getByLabelText('GitHub token')).toHaveValue('');
  });

  it('replaces and removes a token', async () => {
    const del = vi.spyOn(api, 'delete').mockResolvedValue({});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSection();
    const panel = await screen.findByTestId('github-credential');
    await within(panel).findByText('@octocat');
    expect(within(panel).getByRole('button', { name: 'Replace' })).toBeDisabled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/servers/S/github-credential'));
  });
});

it('shows nothing on a server without boxes', async () => {
  vi.mocked(api.get).mockRejectedValue(new ApiError(404, 'not_found'));
  const { container } = renderSection();
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});

describe('rules', () => {
  it('mirrors DOMAIN_ENTRY', () => {
    expect(domainProblem('example.com', [])).toBeNull();
    expect(domainProblem('*.example.com', [])).toBeNull();
    expect(domainProblem('*', [])).not.toBeNull();
    expect(domainProblem('localhost', [])).not.toBeNull();
    expect(domainProblem('[::1]', [])).not.toBeNull();
    expect(domainProblem('example.com', ['example.com'])).toBe('Already on the list.');
  });
  it('parses repos', () => {
    expect(parseRepos('a/b, c/d\n a/b')).toEqual({ repos: ['a/b', 'c/d'], bad: [] });
    expect(parseRepos('a/..').bad).toEqual(['a/..']);
  });
  it('labels transitions', () => {
    expect(stateChip(box({ desiredState: 'stopped' })).label).toBe('stopping');
    expect(stateChip(box({ state: 'stopped', desiredState: 'running' })).label).toBe('starting');
  });
});
