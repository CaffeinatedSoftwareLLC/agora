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

it.each(['Roles', 'Role Assignment', 'Channel Overrides', 'Agents', 'Models and assistant', 'Instance Settings', 'File Storage'])('phone opens the list, then %s full-width, then returns with one Back control', label => {
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
  mount('/settings/agents');
  fireEvent.click(screen.getByRole('link', { name: 'Back to settings' }));
  expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Agents' }));
});

it('phone Back from one agent focuses the Agents link', () => {
  mount('/settings/agents/01ABC');
  fireEvent.click(screen.getByRole('link', { name: 'Back to settings' }));
  expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Agents' }));
});

it('groups the sections by what the person wants to do, with no Bots or AI section', () => {
  narrow = false;
  mount();
  const nav = screen.getByRole('navigation', { name: 'Settings sections' });
  const text = nav.textContent ?? '';
  for (const heading of ['Who can do what', 'Agents and models', 'This server']) expect(text).toContain(heading);
  expect(screen.queryByRole('link', { name: 'Bots' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'AI' })).toBeNull();
  expect(text.indexOf('Agents and models')).toBeLessThan(text.indexOf('This server'));
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
  expect(screen.queryByText('This server')).toBeNull();
});
