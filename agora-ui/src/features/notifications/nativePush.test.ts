import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from '../../lib/api';
import type { AgoraNative } from '../../lib/contracts/notifications';
import { registerNativePush, unregisterNativePush } from './nativePush';

const reg = { relay: 'https://relay.test', handle: 'H'.repeat(43), platform: 'android' as const, label: 'Pixel 8' };
let native: AgoraNative & { registerPush: ReturnType<typeof vi.fn>; unregisterPush: ReturnType<typeof vi.fn> };
let appPush = true;

beforeEach(() => {
  sessionStorage.clear();
  appPush = true;
  native = { platform: 'android', version: '1.0.0', registerPush: vi.fn().mockResolvedValue(reg), unregisterPush: vi.fn().mockResolvedValue(undefined) };
  window.AgoraNative = native;
  vi.spyOn(api, 'get').mockImplementation(async () => ({ types: {}, appPush }));
  vi.spyOn(api, 'post').mockResolvedValue({ id: 'D'.repeat(26) });
  vi.spyOn(api, 'delete').mockResolvedValue(undefined);
});
afterEach(() => {
  delete window.AgoraNative;
  vi.restoreAllMocks();
});

test('does nothing in a plain browser', async () => {
  delete window.AgoraNative;
  await registerNativePush('U1');
  expect(api.get).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});

test('registers once per login session and posts the result as-is', async () => {
  await Promise.all([registerNativePush('U1'), registerNativePush('U1')]);
  await registerNativePush('U1');
  expect(native.registerPush).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/me/push-devices', reg);
});

test('a different user signing in registers again', async () => {
  await registerNativePush('U1');
  await registerNativePush('U2');
  expect(native.registerPush).toHaveBeenCalledTimes(2);
});

test('skips registration when app notifications are off', async () => {
  appPush = false;
  await registerNativePush('U1');
  expect(native.registerPush).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});

test('a denied permission (null) posts nothing, and a refused relay does not throw', async () => {
  native.registerPush.mockResolvedValueOnce(null);
  await registerNativePush('U1');
  expect(api.post).not.toHaveBeenCalled();
  vi.mocked(api.post).mockRejectedValueOnce(new Error('relay_not_allowed'));
  await expect(registerNativePush('U1')).resolves.toBeUndefined();
});

test('logout removes the device on the instance, then unregisters the handle', async () => {
  await registerNativePush('U1');
  await unregisterNativePush();
  expect(api.delete).toHaveBeenCalledWith(`/me/push-devices/${'D'.repeat(26)}`);
  expect(native.unregisterPush).toHaveBeenCalledWith(reg.handle);
  // Nothing left to undo, and the next sign-in registers again
  await unregisterNativePush();
  expect(native.unregisterPush).toHaveBeenCalledTimes(1);
  await registerNativePush('U1');
  expect(native.registerPush).toHaveBeenCalledTimes(2);
});
