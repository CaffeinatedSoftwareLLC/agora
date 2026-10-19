import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, ApiError } from '../../lib/api';
import { CreateAgentInviteModal, inviteCommand } from './CreateAgentInviteModal';
import { BotManagement } from './BotManagement';
import { botApi, serverApi } from '../../lib/api';
import { useServerStore } from '../../stores/serverStore';
import { MemoryRouter } from 'react-router-dom';

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const code = 'a'.repeat(64);

test('new-bot invitation shows a copyable command and switches clients without minting another invite', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ code, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const created = vi.fn();
  render(<CreateAgentInviteModal serverId="server" onClose={() => {}} onCreated={created} />);
  fireEvent.change(screen.getByLabelText('New bot username'), { target: { value: 'new-agent' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Invite' }));
  await screen.findByLabelText('Setup command');
  expect(post).toHaveBeenCalledWith('/servers/server/agent-invites', { username: 'new-agent' });
  expect(created).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('Setup command').textContent).toContain(`--invite ${code}`);
  expect(screen.getByLabelText('Setup command').textContent).not.toContain('--token');
  fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'codex' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy Setup Command' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('codex mcp add agora -- agora-mcp')));
  expect(post).toHaveBeenCalledOnce();
});

test('invites an existing bot and displays authorization failures', async () => {
  const post = vi.spyOn(api, 'post').mockRejectedValue(new ApiError(403, 'forbidden'));
  render(<CreateAgentInviteModal serverId="server" botId="bot" onClose={() => {}} onCreated={() => {}} />);
  expect(screen.queryByLabelText('New bot username')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Create Invite' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('forbidden');
  expect(post).toHaveBeenCalledWith('/servers/server/agent-invites', { botId: 'bot' });
});

test.each(['http://remote.example', 'https://$(id).example', 'https://`id`.example'])(
  'rejects unsafe URL %s before creation and formats Gemini setup with an argument separator', async instance => {
  const post = vi.spyOn(api, 'post');
  render(<CreateAgentInviteModal serverId="server" botId="bot" onClose={() => {}} onCreated={() => {}} />);
  fireEvent.change(screen.getByLabelText('Instance URL reachable by the agent'), { target: { value: instance } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Invite' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('HTTPS');
  expect(post).not.toHaveBeenCalled();
  expect(inviteCommand('gemini', 'https://agora.example', code)).toBe(`gemini mcp add --scope user agora agora-mcp -- --instance "https://agora.example" --channel general --invite ${code}`);
});

test('bot-list refresh after invitation keeps the one-time setup command visible', async () => {
  useServerStore.setState({ instanceServerId: 'server' });
  const list = vi.spyOn(botApi, 'list').mockResolvedValue([]);
  vi.spyOn(serverApi, 'getChannels').mockResolvedValue([]);
  vi.spyOn(api, 'post').mockResolvedValue({ code, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  render(<MemoryRouter><BotManagement /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Invite Agent' }));
  fireEvent.change(screen.getByLabelText('New bot username'), { target: { value: 'new-agent' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Invite' }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('Setup command').textContent).toContain(code);
});
