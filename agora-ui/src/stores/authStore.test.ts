import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from '../lib/api';
import { useAuthStore } from './authStore';

// Node versions with experimental Web Storage expose a different global object.
vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});

beforeEach(() => {
  useAuthStore.setState({ token: 'current-token', status: 'authenticated' });
  localStorage.setItem('agora_token', 'current-token');
});
afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clearSession();
});

test('logout-all preserves the session when revocation fails so the user can retry', async () => {
  vi.spyOn(api, 'post').mockRejectedValue(new Error('offline'));
  await expect(useAuthStore.getState().logoutAll()).rejects.toThrow('offline');
  expect(useAuthStore.getState().token).toBe('current-token');
  expect(localStorage.getItem('agora_token')).toBe('current-token');
});

test('successful logout-all clears persisted auth without issuing another logout request', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ success: true });
  await useAuthStore.getState().logoutAll();
  expect(post).toHaveBeenCalledExactlyOnceWith('/auth/logout-all');
  expect(useAuthStore.getState().token).toBeNull();
  expect(localStorage.getItem('agora_token')).toBeNull();
});

test('server-initiated session clearing does not submit a logout request', () => {
  const post = vi.spyOn(api, 'post');
  useAuthStore.getState().clearSession();
  expect(post).not.toHaveBeenCalled();
  expect(useAuthStore.getState().status).toBe('idle');
});
