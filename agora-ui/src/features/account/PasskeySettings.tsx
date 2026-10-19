import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { passkeyApi, passkeyErrorMessage, passkeysSupported, type Passkey } from '../../lib/passkeys';

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Settings → Account & security: the signed-in user's passkeys. */
export function PasskeySettings() {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const supported = passkeysSupported();
  const host = typeof window !== 'undefined' ? window.location.hostname : '';

  const load = useCallback(() => {
    passkeyApi.list()
      .then(setPasskeys)
      .catch(err => { setPasskeys([]); setError(passkeyErrorMessage(err) ?? ''); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setAdding(true);
    try {
      const created = await passkeyApi.add(name.trim() || 'Passkey');
      setPasskeys(list => [...(list ?? []), created]);
      setName('');
    } catch (err) {
      const message = passkeyErrorMessage(err);
      if (message) setError(message);
    } finally {
      setAdding(false);
    }
  };

  const remove = async (passkey: Passkey) => {
    if (!window.confirm(`Remove the passkey "${passkey.name}"? You can still sign in with your password.`)) return;
    setError('');
    setRemoving(passkey.id);
    try {
      await passkeyApi.remove(passkey.id);
      setPasskeys(list => (list ?? []).filter(p => p.id !== passkey.id));
    } catch (err) {
      setError(passkeyErrorMessage(err) ?? '');
    } finally {
      setRemoving(null);
    }
  };

  return (
    <section aria-labelledby="passkeys-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="passkeys-heading" className="text-lg font-semibold">Passkeys</h2>
        <p className="text-sm text-text-muted mt-1">
          Sign in with Face ID, a fingerprint, a PIN or a security key instead of your password.
          Your password keeps working. A passkey only works on the address it was added on
          {host ? <> (this one is <span className="font-mono">{host}</span>)</> : null}.
        </p>
      </div>

      {passkeys === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : passkeys.length === 0 ? (
        <p className="text-sm text-text-muted">No passkeys yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border" aria-label="Your passkeys">
          {passkeys.map(p => (
            <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{p.name}</p>
                <p className="text-xs text-text-muted">
                  {p.rpId} · Added {formatDate(p.createdAt)} · Last used {formatDate(p.lastUsedAt)}
                  {p.backedUp ? ' · Synced' : ''}
                </p>
              </div>
              <Button variant="danger" onClick={() => remove(p)} loading={removing === p.id} aria-label={`Remove ${p.name}`}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {supported ? (
        <form onSubmit={add} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input label="Passkey name" value={name} onChange={e => setName(e.target.value)} maxLength={64} placeholder="e.g. Phone, YubiKey" />
          </div>
          <Button type="submit" loading={adding}>Add a passkey</Button>
        </form>
      ) : (
        <p className="text-sm text-text-muted">This browser does not support passkeys.</p>
      )}

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </section>
  );
}
