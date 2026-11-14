import { useEffect, useId, useState } from 'react';
import { CHECK_RESULT, githubApi, taskError, type GithubRule, type GithubRuleState } from './taskBoard';

/**
 * The Automation section of the linked repository (docs/github-issues.md "Automatic import").
 * Three plain rows, as the limit rows are: each is off by default, says in one line what it does,
 * and the owner decides. Only the owner saves; directors see the rule and can press Check now.
 */

const BTN = 'inline-flex min-h-[44px] items-center justify-center rounded-lg border border-border px-3 text-sm text-text hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent';
const BTN_PRIMARY = 'inline-flex min-h-[44px] items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent';
const INPUT = 'min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-[16px] md:text-sm text-text placeholder:text-text-muted/70 focus:outline-none disabled:opacity-50';
const CHOICE = 'flex min-h-11 cursor-pointer items-center gap-2 text-sm text-text';
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** "ann, Bob" → ['ann', 'Bob'] (empty entries dropped) */
const logins = (text: string) => text.split(/[\s,]+/).filter(Boolean);

function when(iso: string | null): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
}

export function GithubAutomation({ channelId, canCheck }: { channelId: string; canCheck: boolean }) {
  const [state, setState] = useState<GithubRuleState | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    githubApi.rule(channelId).then(s => { if (!cancelled) setState(s); }).catch(() => { /* an older server: show nothing */ });
    return () => { cancelled = true; };
  }, [channelId]);
  if (!state?.rule) return null;
  const { rule } = state;
  const on = rule.import.mode !== 'off';
  const summary = !on ? 'Off' : rule.import.mode === 'label' ? `Issues labelled "${rule.import.label}"` : 'Every new open issue';

  return (
    <div className="space-y-2 border-t border-border pt-2" aria-label="Automation">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-text">Automation: {summary}{on && rule.autostart.profile ? `, starts ${rule.autostart.profile}` : ''}</span>
          <StatusLine rule={rule} />
        </span>
        {on && canCheck && <CheckNow channelId={channelId} onDone={next => setState(s => s && { ...s, rule: next ?? s.rule })} onError={setError} />}
        <button type="button" className={BTN} aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? 'Hide' : state.canConfigure ? 'Automation' : 'Details'}</button>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {open && <RuleForm key={JSON.stringify(rule)} channelId={channelId} state={state} onSaved={next => setState(s => s && { ...s, rule: next })} />}
    </div>
  );
}

function StatusLine({ rule }: { rule: GithubRule }) {
  if (rule.import.mode === 'off') return <span className="block text-xs text-text-muted">Issues become cards only when you import them by hand.</span>;
  const result = rule.status.result;
  const text = result ? CHECK_RESULT[result] ?? `failed (${result})` : 'not checked yet';
  const detail = result === 'ok' || result === 'truncated' ? `${rule.status.found ?? 0} matching, ${rule.status.created ?? 0} new` : text;
  return (
    <span className="block text-xs text-text-muted" aria-live="polite">
      Last checked {when(rule.status.lastCheckedAt)}: {result === 'ok' || result === 'truncated' ? `${detail}${result === 'truncated' ? ` (only the newest ${rule.limits.scanLimit} open issues are looked at)` : ''}` : text}
    </span>
  );
}

function CheckNow({ channelId, onDone, onError }: { channelId: string; onDone: (rule?: GithubRule) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const check = async () => {
    setBusy(true); onError('');
    try {
      await githubApi.checkNow(channelId);
      setAsked(true);
      // The host answers within a few seconds; read the result once
      setTimeout(() => { githubApi.rule(channelId).then(s => onDone(s.rule ?? undefined)).catch(() => {}); setAsked(false); }, 6000);
    } catch (err) { onError(taskError(err)); } finally { setBusy(false); }
  };
  return <button type="button" className={BTN} disabled={busy || asked} onClick={() => void check()}>{asked ? 'Checking…' : 'Check now'}</button>;
}

function RuleForm({ channelId, state, onSaved }: { channelId: string; state: GithubRuleState; onSaved: (rule: GithubRule) => void }) {
  const rule = state.rule!;
  const id = useId();
  const editable = state.canConfigure;
  const [mode, setMode] = useState(rule.import.mode);
  const [label, setLabel] = useState(rule.import.label ?? 'agora');
  const [onlyThese, setOnlyThese] = useState(rule.authors.length > 0);
  const [authors, setAuthors] = useState(rule.authors.join(', '));
  const [start, setStart] = useState<string | null>(rule.autostart.profile);
  const [poll, setPoll] = useState(String(rule.pollMinutes));
  const [pickup, setPickup] = useState(rule.commentOnPickup);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const names = onlyThese ? logins(authors) : [];
  const badLogin = names.find(n => !LOGIN.test(n));
  const pollNumber = Number(poll);
  const pollOk = Number.isInteger(pollNumber) && pollNumber >= rule.limits.minPollMinutes && pollNumber <= rule.limits.maxPollMinutes;
  const option = state.autostartOptions.find(o => o.name === start);
  // Plan-owned agents need the author filter; the server checks it too
  const startBlocked = !!start && !!option && option.planOwned && names.length === 0;
  const open = mode === 'all' && !!start && names.length === 0;
  const invalid = (mode === 'label' && !label.trim()) || !!badLogin || (onlyThese && names.length === 0) || !pollOk || startBlocked || (open && !confirmed);

  const save = async () => {
    setBusy(true); setError(''); setSaved(false);
    try {
      const res = await githubApi.saveRule(channelId, {
        import: mode === 'label' ? { mode, label: label.trim() } : { mode },
        authors: names, autostart: { profile: mode === 'off' ? null : start, ...(open ? { confirmOpen: true } : {}) },
        pollMinutes: pollNumber, commentOnPickup: pickup,
      });
      setSaved(true); onSaved(res.rule);
    } catch (err) { setError(taskError(err)); } finally { setBusy(false); }
  };

  return (
    <form className="space-y-1" onSubmit={e => { e.preventDefault(); if (!invalid && editable) void save(); }}>
      <fieldset disabled={!editable || busy} className="min-w-0 border-t border-border py-2 first:border-t-0">
        <legend className="text-sm font-medium text-text">Import issues as cards</legend>
        <label className={CHOICE}><input type="radio" name={`${id}-import`} className="accent-primary" checked={mode === 'off'} onChange={() => setMode('off')} />Off</label>
        <label className={CHOICE}><input type="radio" name={`${id}-import`} className="accent-primary" checked={mode === 'label'} onChange={() => setMode('label')} />Issues with the label</label>
        {mode === 'label' && (
          <input className={INPUT} aria-label="Label" maxLength={50} placeholder="agora" value={label} onChange={e => setLabel(e.target.value)} />
        )}
        <label className={CHOICE}><input type="radio" name={`${id}-import`} className="accent-primary" checked={mode === 'all'} onChange={() => setMode('all')} />Every new open issue</label>
        <p className="text-xs text-text-muted">Off is the default: nothing is imported unless you import it. A label is the safest rule, because only people who can label the issue pick what is imported. Every new open issue takes only issues opened after you turn it on.</p>
      </fieldset>

      {mode !== 'off' && (<>
        <fieldset disabled={!editable || busy} className="min-w-0 border-t border-border py-2">
          <legend className="text-sm font-medium text-text">Only issues opened by these GitHub users</legend>
          <label className={CHOICE}><input type="radio" name={`${id}-who`} className="accent-primary" checked={!onlyThese} onChange={() => setOnlyThese(false)} />Anyone</label>
          <label className={CHOICE}><input type="radio" name={`${id}-who`} className="accent-primary" checked={onlyThese} onChange={() => setOnlyThese(true)} />Only these</label>
          {onlyThese && (
            <input className={INPUT} aria-label="GitHub logins" placeholder="octocat, hubot" aria-invalid={!!badLogin || names.length === 0} value={authors} onChange={e => setAuthors(e.target.value)} />
          )}
          {badLogin && <p role="alert" className="text-xs text-danger">"{badLogin}" is not a GitHub login.</p>}
          <p className="text-xs text-text-muted">Anyone is the default. Logins are compared without capital letters.</p>
        </fieldset>

        <fieldset disabled={!editable || busy} className="min-w-0 border-t border-border py-2">
          <legend className="text-sm font-medium text-text">Start an agent on each new card</legend>
          <label className={CHOICE}><input type="radio" name={`${id}-start`} className="accent-primary" checked={start === null} onChange={() => setStart(null)} />Off</label>
          <label className={CHOICE}>
            <input type="radio" name={`${id}-start`} className="accent-primary" checked={start !== null} disabled={state.autostartOptions.length === 0}
              onChange={() => setStart(state.autostartOptions.find(o => o.allowed || o.planOwned)?.name ?? state.autostartOptions[0]?.name ?? null)} />
            Start
          </label>
          {start !== null && (
            <select className={INPUT} aria-label="Agent to start" value={start} onChange={e => setStart(e.target.value)}>
              {state.autostartOptions.map(o => <option key={o.name} value={o.name}>{o.name}{o.planOwned ? ' (personal login)' : ''}</option>)}
            </select>
          )}
          {startBlocked && <p role="alert" className="text-xs text-danger">{option!.reason ?? 'Set the author filter first.'}</p>}
          {open && (
            <div role="alert" className="mt-1 space-y-2 rounded-lg border border-danger p-2 text-sm">
              <p><strong>Warning.</strong> This starts an agent on every new issue, whoever opens it. If the repository is public, strangers' text will reach the agent without anyone reading it first. Restrict the authors, or use a label, to keep control.</p>
              <label className={CHOICE}><input type="checkbox" className="accent-primary" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I understand, start it on every issue</label>
            </div>
          )}
          <p className="text-xs text-text-muted">Off is the default: cards wait on the board until a person starts them. The agent works in its own box and opens a pull request; it never merges. Cards start one after another as its host has room.</p>
        </fieldset>

        <div className="min-w-0 space-y-1 border-t border-border py-2">
          <label className="block text-sm font-medium text-text" htmlFor={`${id}-poll`}>Check every (minutes)</label>
          <input id={`${id}-poll`} type="number" inputMode="numeric" min={rule.limits.minPollMinutes} max={rule.limits.maxPollMinutes} step={1} disabled={!editable || busy}
            className={`${INPUT} w-40`} value={poll} aria-invalid={!pollOk} onChange={e => setPoll(e.target.value)} />
          <p className="text-xs text-text-muted">Default {rule.limits.defaultPollMinutes}, at least {rule.limits.minPollMinutes}: the floor protects GitHub's rate limit and the host. Agora polls; it uses no webhook.</p>
          <label className={CHOICE}><input type="checkbox" className="accent-primary" disabled={!editable || busy} checked={pickup} onChange={e => setPickup(e.target.checked)} />Comment "Picked up in Agora" on the issue</label>
          <p className="text-xs text-text-muted">Off is the default. The comment is fixed text; nothing an agent or person wrote goes to GitHub.</p>
        </div>
      </>)}

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {saved && !error && <p role="status" className="text-sm text-text-muted">Saved.</p>}
      {editable
        ? <button type="submit" className={BTN_PRIMARY} disabled={busy || invalid}>{busy ? 'Saving…' : 'Save automation'}</button>
        : <p className="text-xs text-text-muted">Only the server owner changes the automation: it uses the owner's GitHub login.</p>}
    </form>
  );
}
