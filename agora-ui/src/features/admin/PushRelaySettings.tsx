import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';

/**
 * Instance settings → App push: the push relays phones may register with
 * (docs/notifications.md). One https origin per line; empty turns app push off.
 */
export function PushRelaySettings() {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    api.get<{ allowedRelays: string[] }>('/admin/settings/push')
      .then(r => setText(r.allowedRelays.join('\n')))
      .catch(err => setError(err instanceof ApiError ? err.code : 'Failed to load push settings'))
      .finally(() => setLoaded(true));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    const allowedRelays = text.split(/\s+/).map(s => s.trim()).filter(Boolean);
    try {
      const res = await api.patch<{ allowedRelays: string[] }>('/admin/settings/push', { allowedRelays });
      setText(res.allowedRelays.join('\n'));
      setSuccess(res.allowedRelays.length ? 'Push relays saved.' : 'App push is off.');
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'invalid_relay'
        ? 'Each relay must be an https origin, such as https://push.example.com'
        : err instanceof ApiError ? err.code : 'Failed to save push settings');
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;
  return (
    <form onSubmit={save} className="max-w-lg flex flex-col gap-3 mt-8" aria-labelledby="push-relays-heading">
      <h3 id="push-relays-heading" className="text-lg font-semibold">App push</h3>
      <p className="text-sm text-text-muted">
        Push relays the Agora phone apps may register with, one https origin per line. A relay
        forwards pushes to Apple and Google; it receives a short label and a link, never message
        text. Leave empty to keep app push off.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-text-muted">Allowed relays</span>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder="https://push.example.com"
          className="min-h-11 bg-surface border border-border rounded-lg px-3 py-2 text-[16px] md:text-[15px] font-mono text-text placeholder:text-text-muted/70 focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </label>
      {error && <p className="text-danger text-sm" role="alert">{error}</p>}
      {success && <p className="text-online text-sm">{success}</p>}
      <Button type="submit" loading={saving}>Save push relays</Button>
    </form>
  );
}
