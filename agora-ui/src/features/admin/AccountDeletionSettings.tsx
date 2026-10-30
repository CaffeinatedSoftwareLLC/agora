import { useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import { accountDeletionApi, type DeletedAccountMessages } from '../../lib/accountDeletion';
import { Button } from '../../components/ui/Button';

const options: { value: DeletedAccountMessages; label: string; description: string }[] = [
  { value: 'anonymize', label: 'Keep, as "Deleted user"', description: 'Messages stay where they are; the author shows as "Deleted user".' },
  { value: 'remove', label: 'Remove', description: 'The person\'s messages and the files they uploaded are deleted with the account.' },
];

/** Admin → Instance: what happens to a person's messages when they delete their account. */
export function AccountDeletionSettings() {
  const [value, setValue] = useState<DeletedAccountMessages | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    accountDeletionApi.getSetting()
      .then(r => setValue(r.deletedAccountMessages))
      .catch(err => setError(err instanceof ApiError ? err.code : 'Failed to load the setting'));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!value) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await accountDeletionApi.setSetting(value);
      setSuccess('Saved. It applies to accounts deleted from now on.');
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to save the setting');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="deleted-accounts-heading" className="mt-10 max-w-lg">
      <h3 id="deleted-accounts-heading" className="text-lg font-semibold">Deleted accounts</h3>
      <p className="text-sm text-text-muted mt-1 mb-3">
        Anyone can delete their own account. Choose what happens to their messages.
      </p>
      {value === null && !error ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-1">
            <legend className="sr-only">Messages of deleted accounts</legend>
            {options.map(opt => (
              <label
                key={opt.value}
                className={`min-h-11 flex items-start gap-3 p-3 rounded border cursor-pointer ${
                  value === opt.value ? 'border-primary bg-primary/10' : 'border-border hover:bg-surface-hover'
                }`}
              >
                <input
                  type="radio"
                  name="deletedAccountMessages"
                  value={opt.value}
                  checked={value === opt.value}
                  onChange={() => setValue(opt.value)}
                  className="mt-1 accent-primary"
                />
                <div>
                  <p className="text-sm font-medium">{opt.label}</p>
                  <p className="text-text-muted text-xs">{opt.description}</p>
                </div>
              </label>
            ))}
          </fieldset>
          {error && <p role="alert" className="text-danger text-sm">{error}</p>}
          {success && <p className="text-online text-sm">{success}</p>}
          <Button type="submit" loading={saving} disabled={!value}>Save</Button>
        </form>
      )}
    </section>
  );
}
