import { api } from '../../lib/api';
import type { NativePushRegistration, NotificationPreferences } from '../../lib/contracts/notifications';

/**
 * The native bridge (docs/planning/mobile-apps.md section 8). Inside the Android or iOS app
 * the page has `window.AgoraNative`. After sign-in, unless the user turned app
 * notifications off, the UI calls registerPush() once per login session and gives the
 * result to the instance; on sign-out it removes the device and calls unregisterPush().
 *
 * What was registered is kept in sessionStorage, so a reload in the same session doesn't
 * register again. Nothing here runs in a plain browser.
 */

const KEY = 'agora_native_push';

interface Registered { userId: string; deviceId: string; handle: string }

function read(): Registered | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) as Registered : null;
  } catch { return null; }
}

function write(value: Registered | null) {
  try {
    if (value) sessionStorage.setItem(KEY, JSON.stringify(value));
    else sessionStorage.removeItem(KEY);
  } catch { /* storage unavailable: the next load registers again, which is harmless */ }
}

/** Calls in flight, so two mounts in one session don't both register. */
let inFlight: Promise<void> | null = null;
let inFlightFor: string | null = null;

/** Register this phone for app push, once per login session. Never throws. */
export function registerNativePush(userId: string): Promise<void> {
  const native = typeof window !== 'undefined' ? window.AgoraNative : undefined;
  if (!native) return Promise.resolve();
  if (read()?.userId === userId) return Promise.resolve();
  if (inFlight && inFlightFor === userId) return inFlight;
  inFlightFor = userId;
  inFlight = (async () => {
    try {
      const prefs = await api.get<NotificationPreferences>('/me/notification-preferences');
      if (!prefs.appPush) return;
      const reg: NativePushRegistration | null = await native.registerPush();
      if (!reg) return; // Permission denied on the phone
      const res = await api.post<{ id: string }>('/me/push-devices', reg);
      write({ userId, deviceId: res.id, handle: reg.handle });
    } catch {
      // Push is optional: a refused relay or a network error leaves the app working
    } finally {
      inFlight = null;
      inFlightFor = null;
    }
  })();
  return inFlight;
}

/**
 * On sign-out, while the session is still valid: remove the device on the instance, then
 * let the app forget the handle. Never throws.
 */
export async function unregisterNativePush(): Promise<void> {
  const registered = read();
  write(null);
  if (!registered) return;
  await api.delete(`/me/push-devices/${registered.deviceId}`).catch(() => {});
  await window.AgoraNative?.unregisterPush(registered.handle).catch(() => {});
}

