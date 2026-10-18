import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SessionBudget } from './SessionBudget';
import { useUIStore } from '../../stores/uiStore';
import { useOverlayFocus } from '../shell/useOverlayFocus';
import {
  ERRORS, STATE_LABEL, actionText, classifyCommandError, compactTokens, deriveChips, runAgentCommand, sessionState,
  type AgentProfile, type AgentSession, type ChipState, type CommandBody,
} from './agentSessions';

/**
 * Agent session sheet (docs/planning/ui-redesign.md 6.2): start, resume, shelve-and-start-new
 * and end an agent's session in this channel without typing a command. A bottom sheet below
 * 768px, a centered dialog above. Traps focus, closes on Escape or Back, and returns focus to whatever
 * opened it. Registered with the shell overlay manager as kind 'session-sheet'.
 */

export type SheetMode = { kind: 'profile'; profile: string } | { kind: 'start' };

interface SessionSheetProps {
  open: boolean;
  onClose: () => void;
  channelId: string;
  mode: SheetMode;
  sessions: AgentSession[];
  /** Server's agent profiles for start mode; null while loading. */
  profiles: AgentProfile[] | null;
  profilesError?: string;
  /** Called after a command succeeds so the caller can refresh sessions. */
  onChanged: () => void;
}

const DOT_CLASS: Record<ChipState | 'none', string> = {
  working: 'bg-online motion-safe:animate-pulse',
  idle: 'bg-online',
  shelved: 'bg-warn',
  ended: 'bg-text-dim',
  none: 'bg-text-dim',
};

export function StateDot({ state }: { state: ChipState | 'none' }) {
  return <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT_CLASS[state]}`} />;
}

const BTN = 'inline-flex min-h-[44px] w-full items-center justify-center rounded-lg px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
const BTN_PRIMARY = `${BTN} bg-primary text-on-primary hover:bg-primary-hover`;
const BTN_SECONDARY = `${BTN} border border-border bg-surface-hover text-text hover:bg-bg`;
const BTN_DANGER = `${BTN} border border-danger/40 bg-danger/15 text-danger hover:bg-danger/25`;
const BTN_SMALL = 'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg px-3 text-sm text-text hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50';

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

export function SessionSheet({ open, onClose, channelId, mode, sessions, profiles, profilesError, onChanged }: SessionSheetProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  const [selected, setSelected] = useState<string | null>(mode.kind === 'profile' ? mode.profile : null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [conflict, setConflict] = useState<CommandBody | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // One overlay at a time (Phase 1 overlay manager): registering closes any other sheet, makes
  // Back and Escape dismiss this one, and inerts the shell behind it.
  const overlayId = useId();
  useEffect(() => {
    if (!open) return;
    useUIStore.getState().openOverlay({ kind: 'session-sheet', id: overlayId, onClose: () => onCloseRef.current() });
    return () => useUIStore.getState().releaseOverlay(overlayId);
  }, [open, overlayId]);
  useOverlayFocus(panelRef, open);
  // Escape also works where the shell's OverlayManager is not mounted (tests, standalone use).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      if (useUIStore.getState().activeOverlay?.id === overlayId) useUIStore.getState().closeOverlay();
      else onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, overlayId]);
  // When the live-session choice appears, put focus on its first button.
  useEffect(() => {
    if (conflict) panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [conflict]);

  if (!open) return null;

  const chips = deriveChips(sessions);
  const chip = selected ? chips.find(c => c.profile === selected) : undefined;

  const run = async (body: CommandBody) => {
    setBusy(true);
    setNotice(null);
    setConflict(null);
    try {
      const res = await runAgentCommand(channelId, body);
      setNotice({ text: actionText(res.action) });
      onChanged();
    } catch (err) {
      const outcome = classifyCommandError(err, body.command);
      if (outcome.kind === 'live') setConflict(body);
      else setNotice({ text: outcome.text, error: true });
    } finally {
      setBusy(false);
    }
  };

  const retry = (onLive: 'shelve' | 'keep') => {
    if (!conflict) return;
    if (conflict.command === 'start' || conflict.command === 'resume') void run({ ...conflict, onLive });
  };

  const copy = (id: string) => {
    void navigator.clipboard?.writeText(id).then(() => setCopiedId(id), () => {});
  };

  let title: string;
  let body: ReactNode;

  if (!selected) {
    title = 'Start an agent';
    body = (
      <div className="space-y-2">
        {profilesError && <p className="text-sm text-danger">{profilesError}</p>}
        {!profilesError && profiles === null && <p className="text-sm text-text-muted">Loading agents…</p>}
        {profiles && profiles.length === 0 && (
          <p className="text-sm text-text-muted">This server has no agents yet. The owner can add them in settings.</p>
        )}
        {profiles && profiles.length > 0 && (
          <ul className="space-y-1">
            {profiles.map(p => {
              const c = chips.find(x => x.profile === p.name);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    className="flex min-h-[44px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-text hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-accent"
                    onClick={() => { setSelected(p.name); setNotice(null); setConflict(null); }}
                  >
                    <StateDot state={c ? c.state : 'none'} />
                    <span className="flex-1 truncate font-medium">{p.name}</span>
                    <span className="text-xs text-text-muted">{c ? STATE_LABEL[c.state] : p.adapter}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  } else {
    title = `Agent: ${selected}`;
    const state = chip?.state;
    const current = chip?.session;
    const live = state === 'working' || state === 'idle';
    const history = (chip?.sessions ?? []).filter(s => !(live && s.id === current?.id)).slice(0, 5);
    const latestShelved = chip?.sessions.find(s => s.state === 'shelved');

    body = (
      <div className="space-y-4">
        {mode.kind === 'start' && (
          <button type="button" className={BTN_SMALL} onClick={() => { setSelected(null); setNotice(null); setConflict(null); }}>
            ← All agents
          </button>
        )}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text">
          <StateDot state={state ?? 'none'} />
          <span className="font-medium">{state ? STATE_LABEL[state] : 'No session in this channel'}</span>
          {current && current.state !== 'ended' && (
            <span className="font-mono text-xs text-text-muted">
              {current.wakesUsed} {current.wakesUsed === 1 ? 'wake' : 'wakes'} · {compactTokens(current.tokensUsed)} tokens
            </span>
          )}
        </p>

        {current && <SessionBudget key={current.id} session={current} channelId={channelId} onChanged={onChanged} />}
        {current?.recentRuns && current.recentRuns.length > 0 && <details className="text-sm">
          <summary className="cursor-pointer">Recent runs</summary>
          <ul className="space-y-2 py-2">
            {current.recentRuns.map(run => <li key={run.id}>
              <p>{new Date(run.startedAt).toLocaleString()} ? {run.status}{run.error ? ` (${run.error})` : ''}</p>
              {run.changedPaths.length > 0 && <details><summary className="cursor-pointer">{run.changedPaths.length} changed {run.changedPaths.length === 1 ? 'file' : 'files'}</summary>
                <ul className="max-h-40 overflow-y-auto font-mono text-xs">{run.changedPaths.map(path => <li key={path} className="break-all">{path}</li>)}</ul>
              </details>}
            </li>)}
          </ul>
        </details>}
        {conflict ? (
          <div className="space-y-2" role="group" aria-label="Agent already live">
            <p className="text-sm text-text">{ERRORS.session_live}</p>
            <button type="button" data-autofocus className={BTN_PRIMARY} disabled={busy} onClick={() => retry('shelve')}>Shelve it and start new</button>
            <button type="button" className={BTN_SECONDARY} disabled={busy} onClick={() => retry('keep')}>Keep it</button>
            <button type="button" className={BTN_SECONDARY} disabled={busy} onClick={() => setConflict(null)}>Cancel</button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 md:flex-row md:flex-wrap">
            {live && (
              <>
                <button type="button" className={`${BTN_PRIMARY} md:flex-1`} disabled={busy}
                  onClick={() => void run({ command: 'start', profile: selected, onLive: 'shelve' })}>
                  Shelve and start new
                </button>
                <button type="button" className={`${BTN_DANGER} md:flex-1`} disabled={busy}
                  onClick={() => void run({ command: 'end', profile: selected })}>
                  End session
                </button>
              </>
            )}
            {!live && latestShelved && (
              <>
                <button type="button" className={`${BTN_PRIMARY} md:flex-1`} disabled={busy}
                  onClick={() => void run({ command: 'resume', sessionId: latestShelved.id })}>
                  Resume
                </button>
                <button type="button" className={`${BTN_SECONDARY} md:flex-1`} disabled={busy}
                  onClick={() => void run({ command: 'start', profile: selected, fresh: true })}>
                  Start fresh
                </button>
              </>
            )}
            {!live && !latestShelved && (
              <button type="button" className={`${BTN_PRIMARY} md:flex-1`} disabled={busy}
                onClick={() => void run({ command: 'start', profile: selected })}>
                Start
              </button>
            )}
          </div>
        )}

        <p aria-live="polite" className={`min-h-[1.25rem] text-sm ${notice?.error ? 'text-danger' : 'text-text-muted'}`}>
          {busy ? 'Working…' : notice?.text ?? ''}
        </p>

        {history.length > 0 && (
          <section>
            <h3 className="mb-1 text-sm font-semibold text-text">Recent sessions here</h3>
            <ul className="divide-y divide-border">
              {history.map(s => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-2 py-1">
                  <span className="min-w-0 flex-1 truncate text-sm text-text-muted">
                    <span className="font-mono text-text" title={s.id}>{shortId(s.id)}</span>
                    {' · '}{STATE_LABEL[sessionState(s)].toLowerCase()}
                    {s.endReason ? ` (${s.endReason})` : ''}
                    {' · '}<span className="font-mono">{s.wakesUsed}w · {compactTokens(s.tokensUsed)}</span>
                  </span>
                  {s.state === 'shelved' && (
                    <button type="button" className={BTN_SMALL} disabled={busy}
                      onClick={() => void run({ command: 'resume', sessionId: s.id })}
                      aria-label={`Resume session ${s.id}`}>
                      Resume
                    </button>
                  )}
                  <button type="button" className={BTN_SMALL} onClick={() => copy(s.id)} aria-label={`Copy session ID ${s.id}`}>
                    {copiedId === s.id ? 'Copied' : 'Copy ID'}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-4">
      <div className="absolute inset-0 bg-bg/70" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl border border-border bg-surface px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] text-text shadow-xl outline-none md:w-[420px] md:max-w-full md:rounded-2xl md:pb-4"
      >
        <div className="mb-2 flex items-center gap-2">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-[17px] font-semibold text-text">{title}</h2>
          <button type="button" className={BTN_SMALL} onClick={onClose} aria-label="Close">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {body}
      </div>
    </div>,
    document.body,
  );
}
