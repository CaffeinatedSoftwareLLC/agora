import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { api } from '../../lib/api';
import { useNotificationStore } from '../../stores/notificationStore';
import type { AppNotification } from '../../lib/contracts/notifications';
import { NotificationBell } from './NotificationBell';

const CH = 'C'.repeat(26);
const TH = 'T'.repeat(26);
const approval: AppNotification = {
  id: '01J00000000000000000000002', type: 'approval', label: 'Approval waiting in #general', url: `/app/${CH}?thread=${TH}`,
  serverId: null, channelId: CH, threadId: TH, readAt: null, createdAt: new Date().toISOString(),
};
const mention: AppNotification = {
  id: '01J00000000000000000000001', type: 'mention', label: 'You were mentioned in #general', url: `/app/${CH}`,
  serverId: null, channelId: CH, threadId: null, readAt: '2026-10-20T00:00:00Z', createdAt: '2026-10-20T00:00:00Z',
};

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}

function renderBell() {
  return render(
    <MemoryRouter initialEntries={['/app']}>
      <NotificationBell />
      <Routes><Route path="*" element={<Where />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useNotificationStore.getState().clear();
  vi.spyOn(api, 'get').mockResolvedValue({ notifications: [approval, mention], unread: 1, hasMore: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('shows the unread count on the bell, and no badge at zero', async () => {
  useNotificationStore.setState({ unread: 3 });
  renderBell();
  expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })).toHaveTextContent('3');
  useNotificationStore.setState({ unread: 0 });
  expect(await screen.findByRole('button', { name: 'Notifications' })).not.toHaveTextContent(/\d/);
});

test('opens the list, newest first, with unread ones marked', async () => {
  renderBell();
  fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
  const list = await screen.findByRole('list', { name: 'Notification list' });
  const items = within(list).getAllByRole('listitem');
  expect(items).toHaveLength(2);
  expect(items[0]).toHaveTextContent('Approval waiting in #general');
  expect(within(items[0]).getByRole('img', { name: 'Unread' })).toBeInTheDocument();
  expect(within(items[1]).queryByRole('img', { name: 'Unread' })).toBeNull();
  expect(api.get).toHaveBeenCalledWith('/me/notifications?limit=30');
});

test('tapping a notification marks it read and opens its url', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ unread: 0 });
  renderBell();
  fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
  fireEvent.click(await screen.findByText('Approval waiting in #general'));
  expect(post).toHaveBeenCalledWith(`/me/notifications/${approval.id}/read`);
  expect(screen.getByTestId('where')).toHaveTextContent(`/app/${CH}?thread=${TH}`);
  expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull();
  await waitFor(() => expect(useNotificationStore.getState().unread).toBe(0));
});

test('mark all read clears the badge', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ updated: 1, unread: 0 });
  renderBell();
  fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
  await screen.findByRole('list', { name: 'Notification list' });
  fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
  expect(post).toHaveBeenCalledWith('/me/notifications/read-all');
  expect(useNotificationStore.getState().unread).toBe(0);
  expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
});

test('a socket notification adds to the list and the badge; Escape closes the list', async () => {
  renderBell();
  fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
  await screen.findByRole('list', { name: 'Notification list' });
  const fresh = { ...approval, id: '01J00000000000000000000003', label: 'Task ready for review in #general' };
  useNotificationStore.getState().add(fresh);
  useNotificationStore.getState().add(fresh);
  expect(await screen.findByText('Task ready for review in #general')).toBeInTheDocument();
  expect(useNotificationStore.getState().unread).toBe(2);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull();
});

test('never follows a url that is not a path in this UI', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    notifications: [{ ...approval, url: '//evil.example/x' }], unread: 1, hasMore: false,
  });
  vi.spyOn(api, 'post').mockResolvedValue({ unread: 0 });
  renderBell();
  fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
  fireEvent.click(await screen.findByText('Approval waiting in #general'));
  expect(screen.getByTestId('where')).toHaveTextContent('/app');
  expect(screen.getByTestId('where')).not.toHaveTextContent('evil');
});
