import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError, botApi, serverApi, type BotDetail } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { ChannelAgentsControl } from './ChannelAgents';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() }); });

const bot = (id: string, present: boolean): BotDetail => ({
  id, username: id, ownerId: 'owner', createdAt: '', canManageTokens: false,
  channels: present ? [{ id: 'channel', name: 'general', channelType: 3 }] : [],
});

beforeEach(() => {
  useAuthStore.setState({ user: { id: 'owner', username: 'owner' } });
  useServerStore.getState().setServers([{ id: 'server', name: 'Agora', ownerId: 'owner' }]);
  useUIStore.setState({ activeOverlay: null });
  vi.spyOn(serverApi, 'getAccess').mockResolvedValue({ permissions: '0', isInstanceAdmin: false, hasModerationAccess: false, hasServerAdminAccess: false });
  vi.spyOn(botApi, 'list').mockResolvedValue([bot('claude', false), bot('codex', true)]);
  vi.spyOn(botApi, 'get').mockImplementation(async (_server, id) => bot(id, id === 'codex'));
  vi.spyOn(botApi, 'grantChannel').mockResolvedValue({ botId: 'claude', channelId: 'channel' });
  vi.spyOn(botApi, 'revokeChannel').mockResolvedValue({ removed: true });
});
afterEach(() => { vi.restoreAllMocks(); });

async function open() {
  render(<ChannelAgentsControl channelId="channel" serverId="server" />);
  const trigger = await screen.findByRole('button', { name: 'Add agent to channel' });
  trigger.focus();
  fireEvent.click(trigger);
  await screen.findByRole('button', { name: 'Add claude' });
}

describe('channel agent access', () => {
  it('lets the server owner add and remove agents through the existing endpoints', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add claude' }));
    await screen.findByRole('button', { name: 'Remove claude' });
    expect(botApi.grantChannel).toHaveBeenCalledExactlyOnceWith('channel', 'claude');
    expect(screen.getByRole('status').textContent).toContain('claude added');
    fireEvent.click(screen.getByRole('button', { name: 'Remove codex' }));
    await screen.findByRole('button', { name: 'Add codex' });
    expect(botApi.revokeChannel).toHaveBeenCalledExactlyOnceWith('channel', 'codex');
    expect(screen.getByRole('status').textContent).toContain('codex removed');
  });

  it.each(['1', String(1n << 27n)])('shows the control for permission mask %s', async permissions => {
    useAuthStore.setState({ user: { id: 'admin', username: 'admin' } });
    vi.mocked(serverApi.getAccess).mockResolvedValue({ permissions, isInstanceAdmin: false, hasModerationAccess: false, hasServerAdminAccess: true });
    await open();
    expect(botApi.list).toHaveBeenCalledWith('server');
  });

  it.each(['0', String(1n << 29n)])('hides the control without bot-management permissions (%s)', async permissions => {
    useAuthStore.setState({ user: { id: 'member', username: 'member' } });
    vi.mocked(serverApi.getAccess).mockResolvedValue({ permissions, isInstanceAdmin: false, hasModerationAccess: false, hasServerAdminAccess: false });
    render(<ChannelAgentsControl channelId="channel" serverId="server" />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Add agent to channel' })).toBeNull();
    expect(botApi.list).not.toHaveBeenCalled();
  });

  it('fails closed if access lookup fails and never offers the control in a DM', async () => {
    useAuthStore.setState({ user: { id: 'member', username: 'member' } });
    vi.mocked(serverApi.getAccess).mockRejectedValue(new ApiError(503, 'service_unavailable'));
    const view = render(<ChannelAgentsControl channelId="channel" serverId="server" />);
    await act(async () => {});
    expect(screen.queryByRole('button')).toBeNull();
    view.rerender(<ChannelAgentsControl channelId="dm" serverId={null} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps membership unchanged on a rejected write and offers a retry', async () => {
    vi.mocked(botApi.grantChannel).mockRejectedValue(new ApiError(403, 'Missing ManageBots permission'));
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add claude' }));
    await screen.findByText('You no longer have permission to manage channel agents.');
    expect((screen.getByRole('button', { name: 'Add claude' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Remove claude' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));
    await screen.findByRole('button', { name: 'Add claude' });
    expect(botApi.list).toHaveBeenCalledTimes(3);
  });

  it('disables membership changes until the pending write completes', async () => {
    let finish!: (value: { botId: string; channelId: string }) => void;
    vi.mocked(botApi.grantChannel).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add claude' }));
    expect((screen.getByRole('button', { name: 'Add claude' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Remove codex' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish({ botId: 'claude', channelId: 'channel' }); });
    expect((screen.getByRole('button', { name: 'Remove claude' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('reports a failed list load and can load an empty list on retry', async () => {
    vi.mocked(botApi.list).mockRejectedValue(new Error('network'));
    render(<ChannelAgentsControl channelId="channel" serverId="server" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add agent to channel' }));
    await screen.findByText('Could not load channel agents. Try again.');
    vi.mocked(botApi.list).mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));
    await screen.findByText(/No agents on this server yet/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('makes adding explicit and shows the empty hint until the first bot is added', async () => {
    vi.mocked(botApi.get).mockImplementation(async (_server, id) => bot(id, false));
    render(<ChannelAgentsControl channelId="channel" serverId="server" />);
    await screen.findByText('No agents in this channel ·');
    expect(screen.getByRole('button', { name: 'Add agent to channel' }).textContent).toContain('＋ Add agent');
    fireEvent.click(screen.getByRole('button', { name: 'Add agent to channel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add claude' }));
    await screen.findByRole('button', { name: 'Remove claude' });
    expect(screen.queryByText('No agents in this channel ·')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove claude' }));
    await screen.findByText('No agents in this channel ·');
  });

  it('does not call a channel empty merely because it has no hosted sessions', async () => {
    render(<ChannelAgentsControl channelId="channel" serverId="server" />);
    await act(async () => {});
    expect(screen.queryByText('No agents in this channel ·')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not claim the channel is empty when membership lookup fails', async () => {
    vi.mocked(botApi.list).mockRejectedValue(new Error('offline'));
    render(<ChannelAgentsControl channelId="channel" serverId="server" />);
    await act(async () => {});
    expect(screen.queryByText('No agents in this channel ·')).toBeNull();
  });

  it('closes the dialog on Escape and restores focus to Agents', async () => {
    await open();
    const trigger = screen.getByRole('button', { name: 'Add agent to channel' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
