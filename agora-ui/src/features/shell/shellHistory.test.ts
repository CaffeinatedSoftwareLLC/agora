import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installShellHistory, shellHistorySettled } from './shellHistory';
import { useUIStore } from '../../stores/uiStore';
import { useThreadStore } from '../../stores/threadStore';
import { api } from '../../lib/api';

vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
});
let width = 390;
let cleanup: () => void;
beforeEach(() => {
  width = 390;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: width <= (q.includes('1279') ? 1279 : 767) }));
  useUIStore.setState({ aux: null, navOpen: false, activeOverlay: null });
  window.history.replaceState({}, '', '/app/channel');
  cleanup = installShellHistory();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function back() { window.dispatchEvent(new PopStateEvent('popstate')); }
it('Back dismisses sheet then aux, keeps the channel URL and never locks a thread', () => {
  const patch = vi.spyOn(api, 'patch');
  vi.spyOn(api, 'get').mockResolvedValue([]);
  const ui = useUIStore.getState();
  ui.openThreadView('channel', 'parent');
  ui.openOverlay({ kind: 'message-actions', id: 'reply', onClose: vi.fn() });
  expect(window.history.state.agoraLayer).toBe('message-actions:reply');
  back();
  expect(useUIStore.getState()).toMatchObject({ aux: 'thread', activeOverlay: null });
  back();
  expect(useUIStore.getState().aux).toBeNull();
  expect(useThreadStore.getState().openThreadId).toBe('parent');
  expect(window.location.pathname).toBe('/app/channel');
  expect(patch).not.toHaveBeenCalled();
});
it('Back dismisses nav and switching aux replaces its history layer', () => {
  const push = vi.spyOn(window.history, 'pushState');
  const ui = useUIStore.getState();
  ui.openNav();
  ui.openAux('files');
  ui.openAux('members');
  expect(push).toHaveBeenCalledTimes(1);
  back();
  expect(useUIStore.getState()).toMatchObject({ aux: null, navOpen: false });
  ui.openNav();
  back();
  expect(useUIStore.getState().navOpen).toBe(false);
});
it('resizes never mutate history or selection, including a selected desktop inspector', () => {
  const ui = useUIStore.getState();
  ui.openAux('files');
  const push = vi.spyOn(window.history, 'pushState');
  const go = vi.spyOn(window.history, 'go');
  for (const next of [768, 1280, 360]) {
    width = next;
    window.dispatchEvent(new Event('resize'));
    expect(useUIStore.getState().aux).toBe('files');
  }
  expect(push).not.toHaveBeenCalled();
  expect(go).not.toHaveBeenCalled();
});
it('explicit Back consumes the shell entry before channel navigation can proceed', async () => {
  const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
  const ui = useUIStore.getState();
  ui.openNav();
  ui.onChannelSelect('other');
  expect(go).toHaveBeenCalledWith(-1);
  back();
  await shellHistorySettled();
  expect(window.history.state.agoraLayer).toBeNull();
  expect(useUIStore.getState().navOpen).toBe(false);
});

it('real browser history Back consumes aux and nav entries without leaving the channel', async () => {
  const ui = useUIStore.getState();
  ui.openAux('files');
  await new Promise<void>(resolve => {
    window.addEventListener('popstate', () => resolve(), { once: true });
    window.history.back();
  });
  expect(useUIStore.getState().aux).toBeNull();
  expect(window.location.pathname).toBe('/app/channel');
  ui.openNav();
  await new Promise<void>(resolve => {
    window.addEventListener('popstate', () => resolve(), { once: true });
    window.history.back();
  });
  expect(useUIStore.getState().navOpen).toBe(false);
  expect(window.location.pathname).toBe('/app/channel');
});

it('remounting on a layer entry adopts it, so Back still closes the open inspector', () => {
  useUIStore.getState().openAux('members');
  expect(window.history.state.agoraLayer).toBe('aux:members');
  cleanup(); // AppShell unmounts (e.g. navigated to /settings) and later remounts here
  cleanup = installShellHistory();
  back();
  expect(useUIStore.getState().aux).toBeNull();
});

it('a docked inspector keeps a Back entry when resized to phone without adding history', () => {
  width = 1440;
  useUIStore.getState().openAux('files');
  const push = vi.spyOn(window.history, 'pushState');
  width = 390;
  window.dispatchEvent(new Event('resize'));
  expect(push).not.toHaveBeenCalled();
  back();
  expect(useUIStore.getState().aux).toBeNull();
});
