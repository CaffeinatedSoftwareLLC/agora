import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import {
  NOTIFICATION_TYPES,
  type NotificationPreferences,
  type NotificationType,
  type PushDevice,
} from '../../lib/contracts/notifications';

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const TOGGLE = 'mt-0.5 h-5 w-5 shrink-0 accent-primary';

/** Settings → Account & security: which notifications to get, and the phones that get pushes. */
export function NotificationSettings() {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<NotificationPreferences>('/me/notification-preferences')
      .then(setPrefs)
      .catch(() => setError("Couldn't load notification settings."));
    api.get<{ devices: PushDevice[] }>('/me/push-devices')
      .then(r => setDevices(r.devices))
      .catch(() => setDevices([]));
  }, []);

  const save = async (change: { types?: Partial<Record<NotificationType, boolean>>; appPush?: boolean }) => {
    setError('');
    const before = prefs;
    // Show the change at once; put it back if the server refuses
    if (prefs) setPrefs({ types: { ...prefs.types, ...change.types }, appPush: change.appPush ?? prefs.appPush });
    try {
      setPrefs(await api.put<NotificationPreferences>('/me/notification-preferences', change));
    } catch (err) {
      setPrefs(before);
      setError(err instanceof ApiError ? `Couldn't save: ${err.code}` : "Couldn't save.");
    }
  };

  const remove = async (device: PushDevice) => {
    if (!window.confirm(`Stop push notifications to "${device.label}"?`)) return;
    setError('');
    setRemoving(device.id);
    try {
      await api.delete(`/me/push-devices/${device.id}`);
      setDevices(list => (list ?? []).filter(d => d.id !== device.id));
    } catch {
      setError("Couldn't remove the device.");
    } finally {
      setRemoving(null);
    }
  };

  return (
    <section aria-labelledby="notifications-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="notifications-heading" className="text-lg font-semibold">Notifications</h2>
        <p className="text-sm text-text-muted mt-1">
          Notifications show under the bell. They say what happened and where, never what anyone wrote.
        </p>
      </div>

      {prefs === null ? (
        <p className="text-sm text-text-muted">{error ? '' : 'Loading…'}</p>
      ) : (
        <>
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium mb-2">Notify me about</legend>
            {NOTIFICATION_TYPES.map(t => (
              <label key={t.type} className="flex items-start gap-3 min-h-11 md:min-h-0 cursor-pointer">
                <input
                  type="checkbox"
                  className={TOGGLE}
                  checked={prefs.types[t.type]}
                  onChange={e => { void save({ types: { [t.type]: e.target.checked } }); }}
                />
                <span>
                  <span className="block text-sm">{t.label}</span>
                  <span className="block text-xs text-text-muted">{t.description}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <label className="flex items-start gap-3 min-h-11 md:min-h-0 cursor-pointer">
            <input
              type="checkbox"
              className={TOGGLE}
              checked={prefs.appPush}
              onChange={e => { void save({ appPush: e.target.checked }); }}
            />
            <span>
              <span className="block text-sm">Push to my phones</span>
              <span className="block text-xs text-text-muted">
                In the Agora app for Android or iOS. Turned off, the app doesn't register for pushes and nothing is sent to your phones.
              </span>
            </span>
          </label>
        </>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Phones</h3>
        {devices === null ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : devices.length === 0 ? (
          <p className="text-sm text-text-muted">No phones. Sign in from the Agora app to add one.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border" aria-label="Your phones">
            {devices.map(d => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{d.label}</p>
                  <p className="text-xs text-text-muted">
                    {d.platform === 'ios' ? 'iOS' : 'Android'} · Added {formatDate(d.createdAt)} · Last push {formatDate(d.lastOkAt)}
                  </p>
                </div>
                <Button variant="danger" onClick={() => remove(d)} loading={removing === d.id} aria-label={`Remove ${d.label}`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </section>
  );
}
