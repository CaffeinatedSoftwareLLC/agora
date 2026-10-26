import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChannelOverrides } from './ChannelOverrides';
import { roleApi, serverApi } from '../../lib/api';

vi.mock('../../lib/api', () => ({
  serverApi: { getChannels: vi.fn() },
  roleApi: { list: vi.fn(), getOverrides: vi.fn() },
}));
vi.mock('../../stores/serverStore', () => ({
  useServerStore: (selector: (state: { instanceServerId: string }) => unknown) =>
    selector({ instanceServerId: 'server-1' }),
}));

describe('ChannelOverrides channel selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(serverApi.getChannels).mockResolvedValue([{ id: 'channel-1', name: 'general' }] as Awaited<ReturnType<typeof serverApi.getChannels>>);
    vi.mocked(roleApi.list).mockResolvedValue([]);
  });

  it('clears loaded overrides without requesting an empty channel', async () => {
    vi.mocked(roleApi.getOverrides).mockResolvedValue({
      roles: [{ roleId: 'role-1', roleName: 'Moderator', allow: '1', deny: '0' }],
      members: [],
    });
    render(<ChannelOverrides />);
    await screen.findByText('#general');
    const select = screen.getAllByRole('combobox')[0];
    fireEvent.change(select, { target: { value: 'channel-1' } });
    await screen.findByText('Moderator');
    fireEvent.change(select, { target: { value: '' } });
    expect(screen.queryByText('Moderator')).toBeNull();
    expect((select as HTMLSelectElement).value).toBe('');
    expect(roleApi.getOverrides).toHaveBeenCalledExactlyOnceWith('channel-1');
  });

  it('clears an earlier error when returning to the placeholder', async () => {
    vi.mocked(roleApi.getOverrides).mockRejectedValue(new Error('Cannot load overrides'));
    render(<ChannelOverrides />);
    await screen.findByText('#general');
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'channel-1' } });
    await screen.findByText('Cannot load overrides');
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(screen.queryByText('Cannot load overrides')).toBeNull());
    expect(roleApi.getOverrides).toHaveBeenCalledExactlyOnceWith('channel-1');
  });
});
