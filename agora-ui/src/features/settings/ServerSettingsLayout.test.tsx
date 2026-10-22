import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { ServerSettingsLayout } from './ServerSettingsLayout';

vi.hoisted(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() }));
let narrow = true;
const listeners = new Set<() => void>();
beforeEach(() => {
  narrow = true; listeners.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: narrow,
    addEventListener: (_event: string, callback: () => void) => listeners.add(callback),
    removeEventListener: (_event: string, callback: () => void) => listeners.delete(callback) }));
  useAuthStore.setState({ user: { id: 'owner', username: 'owner', isInstanceAdmin: true } });
  useServerStore.setState({ instanceServerId: 'server' });
});
afterEach(cleanup);
function mount(path = '/settings') {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/settings/*" element={
    <ServerSettingsLayout><Routes>
      <Route index element={<Navigate to="/settings/roles" replace />} />
      <Route path=":section" element={<h2>Section content</h2>} />
    </Routes></ServerSettingsLayout>
  } /></Routes></MemoryRouter>);
}

it.each(['Roles', 'Role Assignment', 'Channel Overrides', 'Bots', 'Agents', 'AI', 'Instance Settings', 'File Storage'])('phone opens the list, then %s full-width, then returns with one Back control', label => {
  mount();
  expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy();
  expect(screen.queryByRole('main')).toBeNull();
  fireEvent.click(screen.getByRole('link', { name: label }));
  expect(screen.queryByRole('navigation')).toBeNull();
  expect(screen.getByRole('main', { name: 'Settings section' })).toBeTruthy();
  expect(screen.getAllByRole('link', { name: /^Back/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole('link', { name: 'Back to settings' }));
  expect(screen.queryByRole('main')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('link', { name: label }));
});

it('phone list opens with no section focused, so none looks selected', () => {
  mount();
  expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy();
  expect(document.activeElement).toBe(document.body);
});

it('phone Back from a deep-linked section focuses that section link', () => {
  mount('/settings/bots');
  fireEvent.click(screen.getByRole('link', { name: 'Back to settings' }));
  expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Bots' }));
});

it('supports deep links and switches to two columns when rotated wider', () => {
  mount('/settings/agents');
  expect(screen.getByRole('heading', { name: 'Section content' })).toBeTruthy();
  expect(screen.queryByRole('navigation')).toBeNull();
  act(() => { narrow = false; listeners.forEach(callback => callback()); });
  expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy();
  expect(screen.getByRole('main')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Back to settings' })).toBeNull();
  act(() => { narrow = true; listeners.forEach(callback => callback()); });
  expect(screen.queryByRole('navigation')).toBeNull();
  expect(screen.getByRole('link', { name: 'Back to settings' })).toBeTruthy();
});

it('keeps the desktop default section and hides admin-only sections from other viewers', () => {
  narrow = false;
  useAuthStore.setState({ user: { id: 'manager', username: 'manager', isInstanceAdmin: false } });
  mount();
  expect(screen.getByRole('navigation')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Section content' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Instance Settings' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'File Storage' })).toBeNull();
});
