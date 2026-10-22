import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ArcChannelSidebar } from './ArcChannelSidebar';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useMemberStore } from '../../stores/memberStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { api } from '../../lib/api';

vi.mock('./ArcUserPanel', () => ({ ArcUserPanel: () => null }));
const access = vi.hoisted(() => ({ hasModerationAccess: false, hasServerAdminAccess: false, isInstanceAdmin: false, loading: false }));
vi.mock('../../hooks/useServerAccess', () => ({ useServerAccess: () => access }));

beforeEach(() => {
  useServerStore.getState().setServers([{ id: 'server', name: 'Agora', ownerId: 'owner' }]);
  useChannelStore.getState().setChannels([{ id: 'channel', serverId: 'server', channelType: 3, name: 'general' }]);
  useMemberStore.getState().clear();
  usePresenceStore.getState().setOnlineUsers(['owner', 'member']);
  Object.assign(access, { hasModerationAccess: false, hasServerAdminAccess: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('counts online members without the member panel ever opening (#129)', async () => {
  const get = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/servers/server/members') {
      return [
        { id: 'owner', username: 'owner', joinedAt: '', roles: [] },
        { id: 'member', username: 'member', joinedAt: '', roles: [] },
        { id: 'away', username: 'away', joinedAt: '', roles: [] },
      ];
    }
    return [];
  });
  render(<MemoryRouter><ArcChannelSidebar /></MemoryRouter>);
  expect(await screen.findByText('2 online')).toBeTruthy();
  expect(get).toHaveBeenCalledWith('/servers/server/members');
});

it('the header gear opens server settings, for server admins only', async () => {
  vi.spyOn(api, 'get').mockResolvedValue([]);
  const sidebar = () => render(
    <MemoryRouter initialEntries={['/app']}>
      <Routes>
        <Route path="/app" element={<ArcChannelSidebar />} />
        <Route path="/settings" element={<p>server settings page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  const { unmount } = sidebar();
  expect(screen.queryByRole('button', { name: 'Server Settings' })).toBeNull();
  unmount();

  Object.assign(access, { hasModerationAccess: true, hasServerAdminAccess: true });
  sidebar();
  // Invite and Moderation stay in the header next to the gear
  expect(screen.getByRole('button', { name: 'Invite People' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Moderation' })).toBeTruthy();
  const gear = screen.getByRole('button', { name: 'Server Settings' });
  // A gear (cog with a centre circle), not the old three-dot icon
  expect(gear.querySelector('circle[r="3"]')).toBeTruthy();
  expect(gear.querySelectorAll('circle[r="1"]').length).toBe(0);
  await userEvent.click(gear);
  expect(screen.getByText('server settings page')).toBeTruthy();
});
