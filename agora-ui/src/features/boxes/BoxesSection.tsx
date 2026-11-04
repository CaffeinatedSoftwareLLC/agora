import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import type { Channel } from '../../lib/contracts/server';
import { Button } from '../../components/ui/Button';
import { boxApi, type Box, type GithubCredential as Credential } from './api';
import { boxError } from './boxRules';
import { BoxCard } from './BoxCard';
import { CreateBoxDialog } from './CreateBoxDialog';
import { GithubCredential } from './GithubCredential';
import { LoginDialog } from './LoginDialog';

/** While a box is changing state the list refreshes itself, so the owner sees boxd's progress. */
const SETTLING_POLL_MS = 5000;

function settling(b: Box): boolean {
  if (b.deletedAt) return false;
  return !!b.pendingAction || b.state === 'creating' || b.loginState === 'pending'
    || (b.state === 'running') !== (b.desiredState === 'running');
}

/**
 * Settings → Agents → Boxes (docs/agent-boxes.md): one persistent container per agent, reached
 * only through the edge. Members see the list; the server owner creates and manages boxes and
 * sets the GitHub token the git broker uses.
 */
export function BoxesSection({ serverId, channels, isOwner }: { serverId: string; channels: Channel[]; isOwner: boolean }) {
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loginFor, setLoginFor] = useState<Box | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => {
    let live = true;
    boxApi.list(serverId).then(
      res => { if (live) { setBoxes(Array.isArray(res?.boxes) ? res.boxes : []); setError(''); } },
      err => {
        if (!live) return;
        // A server without boxes (404) shows nothing rather than an error
        if (err instanceof ApiError && err.status === 404) setUnavailable(true);
        else setError(boxError(err));
      },
    );
    boxApi.getGithub(serverId).then(
      res => { if (live) setCredential(res && typeof res === 'object' && 'set' in res ? res : null); },
      () => { if (live) setCredential(null); },
    );
    return () => { live = false; };
  }, [serverId, reloadKey]);

  const anySettling = !!boxes?.some(settling);
  useEffect(() => {
    if (!anySettling) return;
    const t = setTimeout(reload, SETTLING_POLL_MS);
    return () => clearTimeout(t);
  }, [anySettling, reloadKey, reload]);

  if (unavailable) return null;
  const visible = (boxes ?? []).filter(b => b.desiredState !== 'deleted' || b.volumePurgeAfter);

  return (
    <section className="mb-8" aria-labelledby="boxes-heading">
      <h3 id="boxes-heading" className="mb-1 text-lg font-semibold text-text">Boxes</h3>
      <p className="mb-3 text-xs text-text-muted">
        A box runs one agent in its own container on this server. It reaches the internet only through the domains you
        allow, and GitHub only through the git broker; pushes and pull requests ask you on a card in its home channel.
        Inside its box the agent runs without permission prompts.
      </p>
      {error && <p className="mb-3 text-sm text-danger" role="alert">{error}</p>}

      <GithubCredential serverId={serverId} credential={credential} isOwner={isOwner} onChange={reload} />

      <ul className="mb-3 flex flex-col gap-2">
        {boxes === null && !error && <li className="text-sm text-text-muted">Loading boxes…</li>}
        {boxes !== null && visible.length === 0 && <li className="text-sm text-text-muted">No boxes yet.</li>}
        {visible.map(b => <BoxCard key={b.id} box={b} channels={channels} isOwner={isOwner} onChange={reload} />)}
      </ul>

      {isOwner
        ? <Button onClick={() => setCreating(true)} disabled={channels.length === 0}>Create box</Button>
        : <p className="text-xs text-text-muted">Only the server owner creates and manages boxes.</p>}
      {isOwner && channels.length === 0 && <p className="mt-1 text-xs text-text-muted">Create a channel first: a box needs a home channel.</p>}

      {creating && (
        <CreateBoxDialog serverId={serverId} channels={channels} onClose={() => setCreating(false)}
          onCreated={box => {
            setCreating(false);
            reload();
            // A subscription box can't work until its CLI is logged in: offer that straight away
            if (box?.auth === 'subscription') setLoginFor(box);
          }} />
      )}
      {loginFor && <LoginDialog box={loginFor} onClose={() => { setLoginFor(null); reload(); }} />}
    </section>
  );
}
