import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { useAuthStore } from '../../stores/authStore';
import { passkeysSupported } from '../../lib/passkeys';
import { accountDeletionApi, deletionErrorMessage, type DeletionPreview } from '../../lib/accountDeletion';

/** Settings → Account & security: delete the signed-in account. */
export function DeleteAccount() {
  const username = useAuthStore(s => s.user?.username) ?? '';
  const clearSession = useAuthStore(s => s.clearSession);
  const navigate = useNavigate();
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [open, setOpen] = useState(false);
  const [usePasskey, setUsePasskey] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    accountDeletionApi.preview()
      .then(setPreview)
      .catch(err => setError(deletionErrorMessage(err) ?? ''));
  }, []);

  const blocked = !!preview && (preview.ownedServers.length > 0 || preview.lastAdmin);
  const canPasskey = !!preview && preview.passkeys > 0 && passkeysSupported();
  const ready = confirm.trim() === username && (usePasskey || password.length > 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setError('');
    setDeleting(true);
    try {
      await accountDeletionApi.deleteAccount(confirm.trim(), usePasskey ? { passkey: true } : { password });
      // The server has ended every session and cleared the cookie; drop local state too
      clearSession();
      navigate('/login', { replace: true });
    } catch (err) {
      const message = deletionErrorMessage(err);
      if (message) setError(message);
      setDeleting(false);
    }
  };

  return (
    <section aria-labelledby="delete-account-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="delete-account-heading" className="text-lg font-semibold">Delete account</h2>
        {preview && (
          <div className="text-sm text-text-muted mt-1 flex flex-col gap-2">
            <p>
              {preview.deletedAccountMessages === 'remove'
                ? 'Your messages and the files you uploaded will be deleted. Other people\'s replies in your threads stay.'
                : 'Your messages stay where they are, shown as "Deleted user". This instance\'s admin chose to keep them.'}
            </p>
            <p>
              Your username, email, password, passkeys and preferences are deleted, and you are signed out everywhere.
              {preview.ownedBots.length > 0 && ` Your ${preview.ownedBots.length === 1 ? 'bot is' : `${preview.ownedBots.length} bots are`} paused and ${preview.ownedBots.length === 1 ? 'its tokens stop' : 'their tokens stop'} working; a server admin can delete ${preview.ownedBots.length === 1 ? 'it' : 'them'}.`}
              {' '}This cannot be undone.
            </p>
          </div>
        )}
      </div>

      {preview && preview.ownedServers.length > 0 && (
        <div role="note" className="text-sm rounded-lg border border-border p-3">
          <p>You own {preview.ownedServers.length === 1 ? 'this server' : 'these servers'}. Transfer or delete {preview.ownedServers.length === 1 ? 'it' : 'them'} first:</p>
          <ul className="list-disc pl-5 mt-1">
            {preview.ownedServers.map(s => <li key={s.id} className="break-words">{s.name}</li>)}
          </ul>
        </div>
      )}
      {preview?.lastAdmin && (
        <p role="note" className="text-sm rounded-lg border border-border p-3">
          You are this instance&apos;s only admin. Make someone else an admin before deleting your account.
        </p>
      )}

      {!open ? (
        <div>
          <Button variant="danger" onClick={() => setOpen(true)} disabled={!preview || blocked}>Delete account…</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          {usePasskey ? (
            <p className="text-sm text-text-muted">Your browser will ask for one of your passkeys when you delete.</p>
          ) : (
            <Input
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              maxLength={1024}
            />
          )}
          {canPasskey && (
            <button
              type="button"
              className="min-h-11 md:min-h-8 self-start text-sm text-accent hover:underline"
              onClick={() => { setUsePasskey(v => !v); setPassword(''); }}
            >
              {usePasskey ? 'Use my password instead' : 'Use a passkey instead'}
            </button>
          )}
          <Input
            label={`Type your username (${username}) to confirm`}
            id="delete-account-confirm"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={64}
          />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" onClick={() => { setOpen(false); setError(''); }} disabled={deleting}>Cancel</Button>
            <Button type="submit" variant="danger" loading={deleting} disabled={!ready}>Delete my account</Button>
          </div>
        </form>
      )}

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </section>
  );
}
