import { useEffect } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ArcUserPanel } from './ArcUserPanel';
import { installShellHistory } from './shellHistory';
import { AuthGuard } from '../auth/AuthGuard';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { api } from '../../lib/api';

// The shell as far as logout is concerned: it writes Back entries for open layers
function Shell() {
  useEffect(installShellHistory, []);
  return <ArcUserPanel compact />;
}

function renderApp() {
  return render(
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<p>login page</p>} />
        <Route path="/app/*" element={<AuthGuard><Shell /></AuthGuard>} />
      </Routes>
    </BrowserRouter>,
  );
}

let go: MockInstance<History['go']>;
beforeEach(() => {
  vi.spyOn(api, 'get').mockResolvedValue({ user: { id: 'u1', username: 'Espresso' } });
  vi.spyOn(api, 'post').mockResolvedValue(undefined);
  window.history.replaceState(null, '', '/app/channel');
  useUIStore.setState({ aux: null, navOpen: false, activeOverlay: null });
  useAuthStore.getState().setAuthenticated({ id: 'u1', username: 'Espresso' });
  go = vi.spyOn(window.history, 'go');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Signing out closes the open layers, and each layer has a Back entry. In Chrome and
// Safari, going back over those entries lands after the move to /login and returns
// the page to /app, where AuthGuard has already used its redirect: a blank page.
// jsdom drops a pending traversal when the router pushes /login, so these tests check
// that no traversal is started at all.
it.each([
  ['the nav drawer', () => useUIStore.getState().openNav()],
  ['an inspector', () => useUIStore.getState().openAux('members')],
])('Log out with %s open goes to the login page without going back in history', async (_layer, open) => {
  renderApp();
  act(open);
  await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
  expect(go).not.toHaveBeenCalled();
  expect(window.location.pathname).toBe('/login');
  expect(screen.getByText('login page')).toBeTruthy();
});

it('a session that ends while the drawer is open goes to the login page without going back', () => {
  renderApp();
  act(() => useUIStore.getState().openNav());
  act(() => useAuthStore.getState().clearSession());
  expect(go).not.toHaveBeenCalled();
  expect(window.location.pathname).toBe('/login');
  expect(screen.getByText('login page')).toBeTruthy();
});
