import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ArcUserPanel } from './ArcUserPanel';
import { useAuthStore } from '../../stores/authStore';

const logout = vi.fn();
const logoutAll = vi.fn(async () => {});

function renderPanel() {
  return render(
    <MemoryRouter initialEntries={['/app']}>
      <Routes>
        <Route path="/app" element={<ArcUserPanel compact />} />
        <Route path="/login" element={<p>login page</p>} />
        <Route path="/account" element={<p>account page</p>} />
        <Route path="/admin" element={<p>admin page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const trigger = () => screen.getByRole('button', { name: 'Account menu' });
const itemNames = () => screen.getAllByRole('menuitem').map(el => el.textContent);

beforeEach(() => {
  logout.mockReset();
  logoutAll.mockReset().mockResolvedValue(undefined);
  useAuthStore.setState({ user: { id: 'u1', username: 'Espresso' }, logout, logoutAll });
});
afterEach(() => { cleanup(); });

it('shows the name and status with a single menu button and no gears or shield', () => {
  renderPanel();
  expect(screen.getByText('Espresso')).toBeTruthy();
  expect(screen.getByText('Online')).toBeTruthy();
  expect(screen.getAllByRole('button')).toEqual([trigger()]);
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Instance Admin' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Moderation' })).toBeNull();
  expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
});

it('lists the account actions for a member', async () => {
  renderPanel();
  await userEvent.click(trigger());
  expect(screen.getByRole('menu', { name: 'Account' })).toBeTruthy();
  expect(itemNames()).toEqual(['Account & security', 'Log out', 'Log out all sessions']);
  expect(trigger().getAttribute('aria-expanded')).toBe('true');
  expect(trigger().getAttribute('aria-controls')).toBe(screen.getByRole('menu').id);
});

it('adds Instance admin for an instance admin and opens /admin', async () => {
  useAuthStore.setState({ user: { id: 'u1', username: 'Espresso', isInstanceAdmin: true } });
  renderPanel();
  await userEvent.click(trigger());
  expect(itemNames()).toEqual(['Account & security', 'Instance admin', 'Log out', 'Log out all sessions']);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Instance admin' }));
  expect(screen.getByText('admin page')).toBeTruthy();
});

it('Account & security opens /account', async () => {
  renderPanel();
  await userEvent.click(trigger());
  await userEvent.click(screen.getByRole('menuitem', { name: 'Account & security' }));
  expect(screen.getByText('account page')).toBeTruthy();
});

it('Log out logs out and goes to the login page', async () => {
  renderPanel();
  await userEvent.click(trigger());
  await userEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
  expect(logout).toHaveBeenCalledTimes(1);
  expect(screen.getByText('login page')).toBeTruthy();
});

it('Log out all sessions revokes every session, and shows an error when that fails', async () => {
  logoutAll.mockRejectedValueOnce(new Error('down'));
  renderPanel();
  await userEvent.click(trigger());
  await userEvent.click(screen.getByRole('menuitem', { name: 'Log out all sessions' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toMatch(/Could not log out all sessions/);
  // The alert sits beside the menu (a menu holds only menu items) and describes the item
  expect(screen.getByRole('menu').contains(alert)).toBe(false);
  expect(screen.getByRole('menuitem', { name: 'Log out all sessions' }).getAttribute('aria-describedby')).toBe(alert.id);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Log out all sessions' }));
  expect(logoutAll).toHaveBeenCalledTimes(2);
  expect(await screen.findByText('login page')).toBeTruthy();
});

it('opens and closes from the keyboard, with arrow-key focus inside the menu', async () => {
  const user = userEvent.setup();
  renderPanel();
  trigger().focus();
  await user.keyboard('{Enter}');
  const items = screen.getAllByRole('menuitem');
  await waitFor(() => expect(document.activeElement).toBe(items[0]));
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(items[1]);
  await user.keyboard('{End}');
  expect(document.activeElement).toBe(items[items.length - 1]);
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(items[0]);
  await user.keyboard('{ArrowUp}');
  expect(document.activeElement).toBe(items[items.length - 1]);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger());
  expect(trigger().getAttribute('aria-expanded')).toBe('false');

  // ArrowUp on the trigger opens on the last item
  await user.keyboard('{ArrowUp}');
  const reopened = screen.getAllByRole('menuitem');
  await waitFor(() => expect(document.activeElement).toBe(reopened[reopened.length - 1]));
});

it('closes on an outside click', async () => {
  renderPanel();
  await userEvent.click(trigger());
  expect(screen.getByRole('menu')).toBeTruthy();
  await userEvent.click(document.body);
  expect(screen.queryByRole('menu')).toBeNull();
});

it('Log out all sessions keeps keyboard focus while pending and ignores repeat presses', async () => {
  let finish!: () => void;
  logoutAll.mockImplementation(() => new Promise<void>(r => { finish = r; }));
  const user = userEvent.setup();
  renderPanel();
  trigger().focus();
  await user.keyboard('{ArrowUp}');
  const item = screen.getByRole('menuitem', { name: 'Log out all sessions' });
  await waitFor(() => expect(document.activeElement).toBe(item));
  await user.keyboard('{Enter}');
  const pending = await screen.findByRole('menuitem', { name: 'Logging out…' });
  expect(pending.getAttribute('aria-disabled')).toBe('true');
  expect(pending.hasAttribute('disabled')).toBe(false);
  expect(document.activeElement).toBe(pending);
  // Still reachable with the arrow keys while pending
  await user.keyboard('{ArrowUp}{ArrowDown}');
  expect(document.activeElement).toBe(pending);
  await user.keyboard('{Enter}');
  expect(logoutAll).toHaveBeenCalledTimes(1);
  finish();
  expect(await screen.findByText('login page')).toBeTruthy();
});
