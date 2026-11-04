import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { boxApi, type GithubCredential as Credential } from './api';
import { INPUT, TOUCH, boxError } from './boxRules';

/**
 * The server's GitHub token (docs/agent-boxes.md §3.2, §5): the git broker in the edge uses it to
 * fetch, push and open pull requests for every box. Boxes never see it. The server checks it
 * against GitHub and stores it encrypted; it is never shown again.
 */
export function GithubCredential({ serverId, credential, isOwner, onChange }: {
  serverId: string; credential: Credential | null; isOwner: boolean; onChange: () => void;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const save = async () => {
    const t = token.trim();
    if (!t) return;
    setBusy('save');
    setError('');
    setSaved('');
    try {
      const res = await boxApi.setGithub(serverId, t);
      setToken('');
      setSaved(res.accountLogin ? `Saved. GitHub account: ${res.accountLogin}.` : 'Saved.');
      onChange();
    } catch (err) {
      setError(boxError(err));
    } finally {
      setBusy(null);
    }
  };

  // Members can't read it; nothing to show them
  const hidden = !isOwner && !credential;

  const remove = async () => {
    if (!confirm('Remove the GitHub token? Boxes can no longer fetch, push or open pull requests until a new one is set.')) return;
    setBusy('remove');
    setError('');
    setSaved('');
    try {
      await boxApi.removeGithub(serverId);
      onChange();
    } catch (err) {
      setError(boxError(err));
    } finally {
      setBusy(null);
    }
  };

  if (hidden) return null;
  return (
    <div className="mb-4 rounded border border-border bg-surface p-3 text-sm" data-testid="github-credential">
      <h4 className="mb-1 font-semibold text-text">GitHub token</h4>
      <p className="mb-2 text-xs text-text-muted">
        The git broker uses it to clone, push and open pull requests for your boxes; boxes never see it. Use a fine-grained
        token limited to the repositories your boxes work on.
      </p>
      <p className="mb-2 text-text">
        {credential?.set
          ? <>Set{credential.accountLogin ? <> for <span className="font-medium">@{credential.accountLogin}</span></> : null}
              {credential.setAt ? <span className="text-text-muted"> · {new Date(credential.setAt).toLocaleDateString()}</span> : null}</>
          : <span className="text-text-muted">Not set. Boxes can&apos;t reach GitHub until it is.</span>}
      </p>
      {isOwner && (
        <form className="flex flex-col gap-2 md:flex-row" onSubmit={e => { e.preventDefault(); void save(); }}>
          <input className={`${INPUT} font-mono`} type="password" value={token} autoComplete="off" spellCheck={false}
            placeholder={credential?.set ? 'New token to replace it' : 'github_pat_…'} aria-label="GitHub token"
            onChange={e => setToken(e.target.value)} />
          <Button type="submit" disabled={!token.trim() || busy !== null} loading={busy === 'save'} className={TOUCH}>
            {credential?.set ? 'Replace' : 'Save'}
          </Button>
          {credential?.set && (
            <Button type="button" variant="danger" disabled={busy !== null} loading={busy === 'remove'} onClick={() => void remove()} className={TOUCH}>Remove</Button>
          )}
        </form>
      )}
      {saved && <p className="mt-2 text-online" role="status">{saved}</p>}
      {error && <p className="mt-2 text-danger" role="alert">{error}</p>}
    </div>
  );
}
