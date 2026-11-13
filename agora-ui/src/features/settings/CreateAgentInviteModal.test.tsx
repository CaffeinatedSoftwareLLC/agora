import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, ApiError } from '../../lib/api';
import { CreateAgentInviteModal } from './CreateAgentInviteModal';
import { AGORA_MCP_INSTALL_COMMAND, inviteCommand } from './inviteCommand';
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

// By default the server does not know the addresses route (an older server): today's behaviour.
beforeEach(() => { vi.spyOn(api, 'get').mockRejectedValue(new ApiError(404, 'not_found')); });
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

test('Claude Code connects one project by default; the dialog offers all projects, and only for Claude Code', async () => {
  vi.spyOn(api, 'post').mockResolvedValue({ code, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  render(<CreateAgentInviteModal serverId="server" botId="bot" onClose={() => {}} onCreated={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create Invite' }));
  const command = await screen.findByLabelText('Setup command');
  expect(command.textContent).toContain('claude mcp add --transport stdio --scope local agora -- agora-mcp');
  fireEvent.change(screen.getByLabelText('Connect in'), { target: { value: 'user' } });
  expect(command.textContent).toContain('--scope user agora -- agora-mcp');
  fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'codex' } });
  expect(screen.queryByLabelText('Connect in')).toBeNull();
  expect(command.textContent).toBe(inviteCommand('codex', 'http://localhost:3000', code));
  expect(inviteCommand('claude', 'https://agora.example', code)).toBe(`claude mcp add --transport stdio --scope local agora -- agora-mcp --instance "https://agora.example" --channel general --invite ${code}`);
  expect(inviteCommand('gemini', 'https://agora.example', code, 'project')).toContain('--scope user');
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

// --- The address the dialog suggests (the server reports where it can be reached) ---

test('with an HTTPS address known, the dialog asks where the agent runs and defaults to another computer', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({ local: 'http://localhost:3100', remote: ['https://name.tailnet.ts.net'] });
  vi.spyOn(api, 'post').mockResolvedValue({ code, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  render(<CreateAgentInviteModal serverId="server" botId="bot" onClose={() => {}} onCreated={() => {}} />);
  const where = await screen.findByLabelText('Where will this agent run?') as HTMLSelectElement;
  expect(get).toHaveBeenCalledWith('/servers/server/agent-invites/addresses');
  const field = screen.getByLabelText('Instance URL reachable by the agent') as HTMLInputElement;
  expect(where.value).toBe('https://name.tailnet.ts.net');
  expect(field.value).toBe('https://name.tailnet.ts.net');
  expect(screen.queryByText(/localhost address only works/)).toBeNull();
  expect(Array.from(where.options).map(o => o.textContent)).toEqual([
    'On another computer (https://name.tailnet.ts.net)', 'On the same computer as Agora (http://localhost:3100)']);

  // Same computer: the localhost address with the real API port, and the warning
  fireEvent.change(where, { target: { value: 'http://localhost:3100' } });
  expect(field.value).toBe('http://localhost:3100');
  expect(screen.getByText(/localhost address only works for an agent on the same computer/)).toBeInTheDocument();

  // Free text still works and shows as its own choice
  fireEvent.change(field, { target: { value: 'https://other.example' } });
  expect(where.value).toBe('');
  expect(where.selectedOptions[0].textContent).toBe('Another address (typed below)');

  fireEvent.change(where, { target: { value: 'https://name.tailnet.ts.net' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Invite' }));
  expect((await screen.findByLabelText('Setup command')).textContent).toContain('--instance "https://name.tailnet.ts.net"');
});

test('with only localhost known, the dialog fills in the real API port and says who it works for', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ local: 'http://localhost:3100', remote: [] });
  render(<CreateAgentInviteModal serverId="server" botId="bot" onClose={() => {}} onCreated={() => {}} />);
  const field = screen.getByLabelText('Instance URL reachable by the agent') as HTMLInputElement;
  await waitFor(() => expect(field.value).toBe('http://localhost:3100'));
  expect(screen.queryByLabelText('Where will this agent run?')).toBeNull();
  expect(screen.getByText(/localhost address only works for an agent on the same computer as Agora\. For an agent on another computer, type the HTTPS address/)).toBeInTheDocument();
});

test('an address typed before the server answers is kept, and a server without the route keeps the old default', async () => {
  let answer!: (v: unknown) => void;
  vi.spyOn(api, 'get').mockReturnValue(new Promise(resolve => { answer = resolve; }) as never);
  const first = render(<CreateAgentInviteModal serverId="server" botId="bot" onClose={() => {}} onCreated={() => {}} />);
  const field = screen.getByLabelText('Instance URL reachable by the agent') as HTMLInputElement;
  fireEvent.change(field, { target: { value: 'https://typed.example' } });
  answer({ local: 'http://localhost:3100', remote: ['https://name.tailnet.ts.net'] });
  await screen.findByLabelText('Where will this agent run?');
  expect(field.value).toBe('https://typed.example');
  first.unmount();

  vi.spyOn(api, 'get').mockRejectedValue(new ApiError(404, 'not_found'));
  render(<CreateAgentInviteModal serverId="server" botId="bot" onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect((screen.getByLabelText('Instance URL reachable by the agent') as HTMLInputElement).value).toBe('http://localhost:3000');
  expect(screen.queryByLabelText('Where will this agent run?')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

// --- Two numbered steps: the connect command fails with ENOENT when agora-mcp is not installed ---

test('the install command is its own numbered step with its own copy button, and ENOENT is explained', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ local: 'http://localhost:3000', remote: [] });
  vi.spyOn(api, 'post').mockResolvedValue({ code, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<CreateAgentInviteModal serverId="server" botId="bot" onClose={() => {}} onCreated={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create Invite' }));
  const install = await screen.findByLabelText('Install command');
  expect(install.textContent).toBe(AGORA_MCP_INSTALL_COMMAND);
  expect(AGORA_MCP_INSTALL_COMMAND).toBe('npm install -g https://github.com/CaffeinatedSoftwareLLC/agora/releases/download/agora-mcp-latest/agora-mcp.tgz');
  expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['1. Install agora-mcp (once per computer)', '2. Connect']);
  // The install step comes before the connect command
  expect(install.compareDocumentPosition(screen.getByLabelText('Setup command')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText(/agora-mcp is not installed on that computer/).textContent).toContain('ENOENT');

  fireEvent.click(screen.getByRole('button', { name: 'Copy Install Command' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(AGORA_MCP_INSTALL_COMMAND));
  expect(screen.getByRole('button', { name: 'Copy Setup Command' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Copy Setup Command' }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('claude mcp add')));
  // Only one of the two shows "Copied!"
  expect(screen.getByRole('button', { name: 'Copy Install Command' })).toBeInTheDocument();
});
