import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ArcChannelSidebar } from './ArcChannelSidebar';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useMemberStore } from '../../stores/memberStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { api } from '../../lib/api';

vi.mock('./ArcUserPanel', () => ({ ArcUserPanel: () => null }));
vi.mock('../../hooks/useServerAccess', () => ({
  useServerAccess: () => ({ hasModerationAccess: false, hasServerAdminAccess: false, isInstanceAdmin: false, loading: false }),
}));

beforeEach(() => {
  useServerStore.getState().setServers([{ id: 'server', name: 'Agora', ownerId: 'owner' }]);
  useChannelStore.getState().setChannels([{ id: 'channel', serverId: 'server', channelType: 3, name: 'general' }]);
  useMemberStore.getState().clear();
  usePresenceStore.getState().setOnlineUsers(['owner', 'member']);
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
