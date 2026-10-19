import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// Node versions with experimental Web Storage expose a different global object.
const values = vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  // A token left by a build that kept the session in localStorage
  values.set('agora_token', 'legacy-token');
  values.set('agora_user', JSON.stringify({ id: 'U1', username: 'eryk' }));
  return values;
});
const fetchMock = vi.hoisted(() => {
  const fn = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fn);
  return fn;
});

import { api, ApiError } from '../lib/api';
import { useAuthStore } from './authStore';

const user = { id: 'U1', username: 'eryk' };
// State right after the store module loaded, before any test touched it
const atLoad = { keys: [...values.keys()], status: useAuthStore.getState().status };

test('a legacy localStorage token is revoked and removed, and the user signs in again', () => {
  expect(atLoad.keys).toEqual([]);
  expect(fetchMock).toHaveBeenCalledWith('/auth/logout', {
    method: 'POST', headers: { Authorization: 'Bearer legacy-token' },
  });
  expect(atLoad.status).toBe('idle');
});

beforeEach(() => {
  useAuthStore.getState().setAuthenticated(user);
});
afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clearSession();
});

test('login keeps only the user, never a token', async () => {
  useAuthStore.getState().clearSession();
  vi.spyOn(api, 'post').mockResolvedValue({ user });
  await useAuthStore.getState().login('eryk', 'pw');
  expect(useAuthStore.getState().status).toBe('authenticated');
  expect(JSON.parse(values.get('agora_user')!)).toEqual(user);
  expect(values.has('agora_token')).toBe(false);
});

test('logout-all preserves the session when revocation fails so the user can retry', async () => {
  vi.spyOn(api, 'post').mockRejectedValue(new Error('offline'));
  await expect(useAuthStore.getState().logoutAll()).rejects.toThrow('offline');
  expect(useAuthStore.getState().status).toBe('authenticated');
  expect(values.has('agora_user')).toBe(true);
});

test('successful logout-all clears persisted auth without issuing another logout request', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ success: true });
  await useAuthStore.getState().logoutAll();
  expect(post).toHaveBeenCalledExactlyOnceWith('/auth/logout-all');
  expect(useAuthStore.getState().user).toBeNull();
  expect(values.has('agora_user')).toBe(false);
});

test('server-initiated session clearing does not submit a logout request', () => {
  const post = vi.spyOn(api, 'post');
  useAuthStore.getState().clearSession();
  expect(post).not.toHaveBeenCalled();
  expect(useAuthStore.getState().status).toBe('idle');
});

test('verifySession signs out when the cookie is no longer accepted', async () => {
  vi.spyOn(api, 'get').mockRejectedValue(new ApiError(401, 'Token revoked'));
  await useAuthStore.getState().verifySession();
  expect(useAuthStore.getState().status).toBe('idle');
});

test('verifySession keeps the session through a network error', async () => {
  vi.spyOn(api, 'get').mockRejectedValue(new TypeError('fetch failed'));
  await useAuthStore.getState().verifySession();
  expect(useAuthStore.getState().status).toBe('authenticated');
});
