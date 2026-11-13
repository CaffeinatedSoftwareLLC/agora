import { useState, type ReactNode } from 'react';
import type { Channel } from '../../lib/contracts/server';
import { Button } from '../../components/ui/Button';
import { boxApi, type Box, type BoxAction, type BoxPatch } from './api';
import {
  ADAPTER_LABEL, INPUT, LIMITS, LOGIN_LABEL, TOUCH, boxError, daysLeft, domainProblem, loginHint, normalizeDomain, parseRepos,
  resourceProblem, stateChip,
} from './boxRules';
import { LoginDialog } from './LoginDialog';
import { ResetBoxDialog } from './ResetBoxDialog';
import { TerminalControls } from './terminal/TerminalControls';

/**
 * One box in Settings → Agents (docs/agent-boxes.md §9): its state, the owner's lifecycle
 * actions, and what it may reach (allowed domains, repos, auto-allowed pushes and PRs per
 * channel, resources). Members see it read-only; the server enforces the owner rule.
 */
export function BoxCard({ box, channels, isOwner, onChange }: {
  box: Box; channels: Channel[]; isOwner: boolean; onChange: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'login' | 'reset' | null>(null);
  const chip = stateChip(box);
  const hint = loginHint(box);
  const deleted = !!box.deletedAt || box.desiredState === 'deleted';
  const home = channels.find(c => c.id === box.homeChannelId);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(boxError(err));
    } finally {
      setBusy(null);
    }
  };
  const act = (action: BoxAction) => run(action, () => boxApi.action(box.id, action));
  const patch = (key: string, body: BoxPatch) => run(key, () => boxApi.update(box.id, body));

  const remove = () => {
    if (!confirm(`Delete box "${box.name}"? Its tokens stop working at once and its container is removed. Its home folder (logins and repos) is kept for 7 days, so you can restore it until then.`)) return;
    void run('delete', () => boxApi.remove(box.id));
  };
  const purge = () => {
    if (!confirm(`Delete "${box.name}" now? Its home folder, with its logins and repos, is removed for good.`)) return;
    void run('purge', () => boxApi.purge(box.id));
  };

  const left = daysLeft(box.volumePurgeAfter);
  const disabled = busy !== null;

  return (
    <li className="rounded border border-border bg-surface px-3 py-2 text-sm" data-testid={`box-${box.name}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-text">{box.name}</span>
        <span className="text-xs text-text-muted">{ADAPTER_LABEL[box.adapter] ?? box.adapter}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none ${chip.tone}`} data-testid="box-state">{chip.label}</span>
        <span className="text-xs text-text-muted">{box.imageVersion != null ? `image v${box.imageVersion}` : 'no image yet'}</span>
        {/* The chip already says the login state when that is what's wrong */}
        {!chip.login && (
          <span className="text-xs text-text-muted">
            · {box.auth === 'api_key' ? 'API key' : LOGIN_LABEL[box.loginState] ?? box.loginState}
          </span>
        )}
        {home && <span className="text-xs text-text-muted">· #{home.name}</span>}
      </div>
      {hint && !deleted && (
        <p className={`mt-1 break-words text-xs ${box.loginState === 'failed' ? 'text-danger' : 'text-warn'}`} data-testid="box-login-hint">{hint}</p>
      )}
      {box.lastError && !deleted && (
        <p className="mt-1 break-words text-xs text-danger" data-testid="box-error">Last error: {box.lastError}</p>
      )}

      {deleted ? (
        <div className="mt-2">
          <p className="text-xs text-text-muted">
            Deleted. Its home folder is kept{left !== null ? ` for ${left} more ${left === 1 ? 'day' : 'days'}` : ' for 7 days'}, then removed.
          </p>
          {isOwner && (
            <div className="mt-2 flex flex-col gap-2 md:flex-row">
              <Button variant="secondary" onClick={() => void run('restore', () => boxApi.restore(box.id))} loading={busy === 'restore'} disabled={disabled} className={TOUCH}>Restore</Button>
              <Button variant="danger" onClick={purge} loading={busy === 'purge'} disabled={disabled} className={TOUCH}>Delete now</Button>
            </div>
          )}
        </div>
      ) : (
        <>
          {isOwner && (
            <div className="mt-2 grid grid-cols-2 gap-2 md:flex md:flex-wrap">
              {box.auth === 'subscription' && (
                <Button onClick={() => setDialog('login')} disabled={disabled}>{box.loginState === 'logged_in' ? 'Log in again' : 'Log in'}</Button>
              )}
              {box.desiredState === 'stopped'
                ? <Button variant="secondary" onClick={() => void act('start')} loading={busy === 'start'} disabled={disabled}>Start</Button>
                : <Button variant="secondary" onClick={() => void act('stop')} loading={busy === 'stop'} disabled={disabled}>Stop</Button>}
              <Button variant="secondary" onClick={() => void act('restart')} loading={busy === 'restart'} disabled={disabled || !!box.pendingAction}>Restart</Button>
              <Button variant="secondary" onClick={() => void act('rebuild')} loading={busy === 'rebuild'} disabled={disabled || !!box.pendingAction}
                title="Recreate the container from the current image; keeps the home folder, rotates its tokens">Rebuild</Button>
              <Button variant="danger" onClick={() => setDialog('reset')} disabled={disabled || !!box.pendingAction}>Reset</Button>
              <Button variant="danger" onClick={remove} loading={busy === 'delete'} disabled={disabled}>Delete</Button>
            </div>
          )}
          {isOwner && <TerminalControls box={box} onChange={onChange} />}
          <details className="mt-2">
            <summary className="flex min-h-11 md:min-h-8 cursor-pointer select-none items-center text-xs font-semibold text-text-muted">
              Network, repositories and resources
            </summary>
            <div className="mt-1 flex flex-col gap-3 border-t border-border pt-2">
              <HomeChannel box={box} channels={channels} isOwner={isOwner} busy={disabled} onSave={id => void patch('home', { homeChannelId: id })} />
              <DomainList box={box} isOwner={isOwner} busy={disabled} onSave={allowedDomains => void patch('domains', { allowedDomains })} />
              <RepoList box={box} isOwner={isOwner} busy={disabled} onSave={repos => void patch('repos', { repos })} />
              <Policies box={box} channels={channels} isOwner={isOwner} busy={disabled}
                onSave={(channelId, p) => void run(`policy:${channelId}`, () => boxApi.setPolicy(box.id, channelId, p))} />
              <Resources key={`${box.cpus}:${box.memoryMb}:${box.pids}`} box={box} isOwner={isOwner} busy={disabled}
                onSave={r => void patch('resources', r)} />
            </div>
          </details>
        </>
      )}
      {error && <p className="mt-2 text-danger" role="alert">{error}</p>}

      {dialog === 'login' && <LoginDialog box={box} onClose={changed => { setDialog(null); if (changed) onChange(); }} />}
      {dialog === 'reset' && <ResetBoxDialog box={box} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onChange(); }} />}
    </li>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-xs font-semibold text-text-muted">{children}</div>;
}

function HomeChannel({ box, channels, isOwner, busy, onSave }: {
  box: Box; channels: Channel[]; isOwner: boolean; busy: boolean; onSave: (id: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold text-text-muted">Home channel (approval cards and notices)
      <select className={INPUT} value={box.homeChannelId ?? ''} disabled={!isOwner || busy} onChange={e => { if (e.target.value) onSave(e.target.value); }}>
        {!box.homeChannelId && <option value="">None</option>}
        {channels.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
      </select>
    </label>
  );
}

/** The edge's allowlist for this box (§4.2): exact names or *.suffix, never an IP or a bare *. */
function DomainList({ box, isOwner, busy, onSave }: { box: Box; isOwner: boolean; busy: boolean; onSave: (d: string[]) => void }) {
  const [entry, setEntry] = useState('');
  const problem = entry.trim() ? domainProblem(entry, box.allowedDomains) : null;
  const add = () => {
    if (!entry.trim() || problem) return;
    onSave([...box.allowedDomains, normalizeDomain(entry)]);
    setEntry('');
  };
  return (
    <div>
      <SubHeading>Allowed domains</SubHeading>
      <ul className="flex flex-wrap gap-1" aria-label={`Allowed domains for ${box.name}`}>
        {box.allowedDomains.length === 0 && <li className="text-xs text-text-muted">None: the box can reach only Agora.</li>}
        {box.allowedDomains.map(d => (
          <li key={d} className="flex items-center gap-1 rounded border border-border bg-bg px-2 font-mono text-xs text-text">
            <span className="break-all">{d}</span>
            {isOwner && (
              <button type="button" className="min-h-11 min-w-11 md:min-h-7 md:min-w-7 text-danger disabled:opacity-50" disabled={busy}
                aria-label={`Remove ${d}`} onClick={() => onSave(box.allowedDomains.filter(x => x !== d))}>×</button>
            )}
          </li>
        ))}
      </ul>
      {isOwner && (
        <form className="mt-2 flex items-start gap-2" onSubmit={e => { e.preventDefault(); add(); }}>
          <div className="flex-1">
            <input className={`${INPUT} font-mono`} value={entry} placeholder="example.com or *.example.com" maxLength={255}
              autoCapitalize="none" spellCheck={false} aria-label={`Add an allowed domain for ${box.name}`} aria-invalid={!!problem}
              onChange={e => setEntry(e.target.value)} />
            {problem && <p className="mt-1 text-xs text-danger">{problem}</p>}
          </div>
          <Button type="submit" variant="secondary" disabled={!entry.trim() || !!problem || busy}>Add</Button>
        </form>
      )}
      <p className="mt-1 text-xs text-text-muted">github.com is reached only through the git broker, so it isn&apos;t listed here.</p>
    </div>
  );
}

function RepoList({ box, isOwner, busy, onSave }: { box: Box; isOwner: boolean; busy: boolean; onSave: (r: string[]) => void }) {
  const [entry, setEntry] = useState('');
  const { repos, bad } = parseRepos(entry);
  const fresh = repos.filter(r => !box.repos.includes(r));
  const problem = bad.length ? `Not owner/repo: ${bad.join(', ')}` : null;
  return (
    <div>
      <SubHeading>Repositories</SubHeading>
      <ul className="flex flex-col gap-1" aria-label={`Repositories for ${box.name}`}>
        {box.repos.length === 0 && <li className="text-xs text-text-muted">None: the agent works in an empty scratch folder.</li>}
        {box.repos.map((r, i) => (
          <li key={r} className="flex items-center justify-between gap-2 font-mono text-xs text-text">
            <span className="break-all">{r}{i === 0 && <span className="ml-2 font-sans text-text-muted">working folder</span>}</span>
            {isOwner && (
              <button type="button" className="min-h-11 min-w-11 md:min-h-7 md:min-w-7 text-danger disabled:opacity-50" disabled={busy}
                aria-label={`Remove ${r}`} onClick={() => onSave(box.repos.filter(x => x !== r))}>×</button>
            )}
          </li>
        ))}
      </ul>
      {isOwner && (
        <form className="mt-2 flex items-start gap-2" onSubmit={e => { e.preventDefault(); if (!problem && fresh.length) { onSave([...box.repos, ...fresh]); setEntry(''); } }}>
          <div className="flex-1">
            <input className={`${INPUT} font-mono`} value={entry} placeholder="owner/repo" maxLength={200} autoCapitalize="none" spellCheck={false}
              aria-label={`Add a repository for ${box.name}`} aria-invalid={!!problem} onChange={e => setEntry(e.target.value)} />
            {problem && <p className="mt-1 text-xs text-danger">{problem}</p>}
          </div>
          <Button type="submit" variant="secondary" disabled={!!problem || fresh.length === 0 || busy}>Add</Button>
        </form>
      )}
    </div>
  );
}

/** Auto-allow pushes / PRs per channel (§5.2): without it, each push and PR asks on a card. */
function Policies({ box, channels, isOwner, busy, onSave }: {
  box: Box; channels: Channel[]; isOwner: boolean; busy: boolean; onSave: (channelId: string, p: { autoPush: boolean; autoPr: boolean }) => void;
}) {
  // The home channel first: that is where the box's agent works
  const ordered = [...channels].sort((a, b) => (a.id === box.homeChannelId ? -1 : b.id === box.homeChannelId ? 1 : 0));
  return (
    <div>
      <SubHeading>Auto-allow without a card</SubHeading>
      {ordered.length === 0 && <p className="text-xs text-text-muted">No channels.</p>}
      <ul className="flex flex-col" aria-label={`Auto-allow for ${box.name}`}>
        {ordered.map(c => {
          const p = box.policies.find(x => x.channelId === c.id) ?? { channelId: c.id, autoPush: false, autoPr: false };
          return (
            <li key={c.id} className="flex flex-wrap items-center gap-x-4 border-b border-border/50 py-1 last:border-0">
              <span className="min-w-[8rem] flex-1 truncate text-text">#{c.name}</span>
              <label className="flex min-h-11 md:min-h-8 items-center gap-2 text-text">
                <input type="checkbox" checked={p.autoPush} disabled={!isOwner || busy} aria-label={`Auto-allow pushes from #${c.name}`}
                  onChange={e => onSave(c.id, { autoPush: e.target.checked, autoPr: p.autoPr })} />
                Pushes
              </label>
              <label className="flex min-h-11 md:min-h-8 items-center gap-2 text-text">
                <input type="checkbox" checked={p.autoPr} disabled={!isOwner || busy} aria-label={`Auto-allow pull requests from #${c.name}`}
                  onChange={e => onSave(c.id, { autoPush: p.autoPush, autoPr: e.target.checked })} />
                Pull requests
              </label>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-xs text-text-muted">Pushes to the default branch, tag pushes and branch deletes always ask.</p>
    </div>
  );
}

function Resources({ box, isOwner, busy, onSave }: {
  box: Box; isOwner: boolean; busy: boolean; onSave: (r: { cpus: number; memoryMb: number; pids: number }) => void;
}) {
  const [values, setValues] = useState({ cpus: String(box.cpus), memoryMb: String(box.memoryMb), pids: String(box.pids) });
  const problems = {
    cpus: resourceProblem('cpus', values.cpus),
    memoryMb: resourceProblem('memoryMb', values.memoryMb),
    pids: resourceProblem('pids', values.pids),
  };
  const dirty = values.cpus !== String(box.cpus) || values.memoryMb !== String(box.memoryMb) || values.pids !== String(box.pids);
  const valid = !problems.cpus && !problems.memoryMb && !problems.pids;
  const field = (key: keyof typeof values, label: string) => (
    <label className="flex flex-col gap-1 text-xs text-text-muted">{label}
      <input className={INPUT} type="number" inputMode="decimal" min={LIMITS[key].min} max={LIMITS[key].max} step={LIMITS[key].step}
        value={values[key]} disabled={!isOwner || busy} aria-label={`${label} for ${box.name}`} aria-invalid={!!problems[key]}
        onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))} />
      {problems[key] && <span className="text-danger">{problems[key]}</span>}
    </label>
  );
  return (
    <div>
      <SubHeading>Resources</SubHeading>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {field('cpus', 'CPUs')}
        {field('memoryMb', 'Memory (MB)')}
        {field('pids', 'Processes')}
      </div>
      {isOwner && dirty && (
        <div className="mt-2">
          <Button variant="secondary" disabled={!valid || busy}
            onClick={() => onSave({ cpus: Number(values.cpus), memoryMb: Number(values.memoryMb), pids: Number(values.pids) })}>Save</Button>
        </div>
      )}
    </div>
  );
}
