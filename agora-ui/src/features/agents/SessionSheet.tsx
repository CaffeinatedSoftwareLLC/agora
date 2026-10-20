import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SessionBudget } from './SessionBudget';
import { SessionWorkspace } from './SessionWorkspace';
import { useUIStore } from '../../stores/uiStore';
import { useOverlayFocus } from '../shell/useOverlayFocus';
import {
  ERRORS, HOSTED_ONLY, STATE_LABEL, TERMINAL_BUDGET, actionText, classifyCommandError, compactTokens, deriveChips, runAgentCommand, sessionState,
  terminalUsage, type AgentProfile, type AgentSession, type ChipState, type CommandBody,
} from './agentSessions';

/**
 * Agent session sheet (docs/planning/ui-redesign.md 6.2): start, resume, shelve-and-start-new
 * and end an agent's session in this channel without typing a command. A bottom sheet below
 * 768px, a centered dialog above. Traps focus, closes on Escape or Back, and returns focus to whatever
 * opened it. Registered with the shell overlay manager as kind 'session-sheet'.
 */

/** 'terminal': an agent's terminal session (#112), the user's own CLI connected through agora-mcp. */
export type SheetMode = { kind: 'profile'; profile: string } | { kind: 'start' } | { kind: 'terminal'; botId: string };

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
  sleeping: 'bg-accent',
  standby: 'bg-text-muted',
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
  // /start for an agent connected from a terminal (409 terminal_connected)
  const [terminalConflict, setTerminalConflict] = useState<CommandBody | null>(null);
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
    if (conflict || terminalConflict) panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [conflict, terminalConflict]);

  if (!open) return null;

  const chips = deriveChips(sessions);
  const chip = selected ? chips.find(c => c.profile === selected) : undefined;

  const run = async (body: CommandBody) => {
    setBusy(true);
    setNotice(null);
    setConflict(null);
    setTerminalConflict(null);
    try {
      const res = await runAgentCommand(channelId, body);
      setNotice({ text: actionText(res.action) });
      onChanged();
    } catch (err) {
      const outcome = classifyCommandError(err, body.command);
      if (outcome.kind === 'live') setConflict(body);
      else if (outcome.kind === 'terminal') setTerminalConflict(body);
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

  const retryTerminal = (onLive: 'keep' | 'standby') => {
    if (terminalConflict?.command === 'start') void run({ ...terminalConflict, onLive });
  };

  let title: string;
  let body: ReactNode;
  const terminal = mode.kind === 'terminal'
    ? sessions.find(s => s.kind === 'terminal' && s.state === 'live' && s.botId?.trim() === mode.botId.trim())
    : undefined;

  if (mode.kind === 'terminal') {
    title = `Terminal: ${terminal?.botUsername ?? 'agent'}`;
    const standby = terminal ? sessions.find(s => s.kind !== 'terminal' && s.state === 'live' && !s.threadId && s.botId?.trim() === mode.botId.trim()) : undefined;
    body = terminal ? (
      <div className="space-y-4 text-sm">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-text">
          <StateDot state={terminal.running ? 'working' : 'idle'} />
          <span className="font-medium">{terminal.running ? 'Terminal, working' : 'Terminal, idle'}</span>
          <span className="font-mono text-xs text-text-muted">{terminalUsage(terminal)}</span>
        </p>
        <p className="text-text-muted">
          The user's own CLI, connected through agora-mcp{terminal.terminalMode === 'channel' ? ' as a Claude Code Channel' : terminal.terminalMode === 'mcp' ? ' (chat_wait)' : ''}.
          It answers here while it is connected and ends when agora-mcp disconnects. Only owner and director messages are instructions to it.
        </p>
        <p data-testid="terminal-budget" className="rounded-lg border border-border bg-bg/60 p-3 text-text-muted">{TERMINAL_BUDGET}</p>
        {standby && <p className="text-text-muted">Its hosted session ({shortId(standby.id)}) is on standby: messages don't wake it while the terminal is connected.</p>}
        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap" role="group" aria-label="Hosted-only actions">
          {['Review changes', 'Checkpoints', 'Verify', 'Subtasks', 'End session'].map(label => (
            <span key={label} title={HOSTED_ONLY} className="md:flex-1">
              <button type="button" className={BTN_SECONDARY} disabled aria-disabled="true" aria-describedby={`${titleId}-hosted-only`}>{label}</button>
            </span>
          ))}
        </div>
        <p id={`${titleId}-hosted-only`} className="text-xs text-text-muted">{HOSTED_ONLY}</p>
        <button type="button" className={BTN_SMALL} onClick={() => copy(terminal.id)} aria-label={`Copy session ID ${terminal.id}`}>
          {copiedId === terminal.id ? 'Copied' : 'Copy ID'}
        </button>
      </div>
    ) : <p className="text-sm text-text-muted">This agent has no terminal session here right now.</p>;
  } else if (!selected) {
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
    const live = state === 'working' || state === 'idle' || state === 'sleeping' || state === 'standby';
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

        {live && current && (
          <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
            <label className="flex min-h-[44px] items-center gap-2">
              <input type="checkbox" aria-label="Lurk mode" checked={!!current.lurkMode} disabled={busy}
                onChange={e => void run({ command: 'lurk', profile: selected, lurkMode: e.target.checked ? 'balanced' : null })} />
              Lurk mode
            </label>
            <p className="text-text-muted">Read channel activity and reply only when there is something important to add. Uses this session's budget.</p>
            {current.lurkMode && <label className="flex items-center gap-2">Speak up
              <select aria-label="Lurk dial" value={current.lurkMode} disabled={busy}
                onChange={e => void run({ command: 'lurk', profile: selected, lurkMode: e.target.value as 'quiet' | 'balanced' | 'vocal' })}
                className="min-h-[44px] rounded border border-border bg-bg px-2">
                <option value="quiet">Quiet</option><option value="balanced">Balanced</option><option value="vocal">Vocal</option>
              </select>
            </label>}
          </div>
        )}

        {state === 'sleeping' && current?.sleepingUntil && (
          <div className="space-y-2 rounded-lg border border-border bg-bg/60 p-3 text-sm text-text-muted">
            <p>
              Hit its rate limit. Sleeping until {new Date(current.sleepingUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })};
              messages for it are held and delivered together when it wakes.
            </p>
            <button type="button" className={BTN_SECONDARY} disabled={busy} onClick={() => void run({ command: 'wake', sessionId: current.id })}>
              Wake now
            </button>
          </div>
        )}
        {state === 'standby' && (
          <p className="rounded-lg border border-border bg-bg/60 p-3 text-sm text-text-muted">
            This agent is connected from a terminal, which answers here. This hosted session waits and is not woken until the terminal disconnects.
          </p>
        )}
        {current && <SessionBudget key={current.id} session={current} channelId={channelId} onChanged={onChanged} />}
        {current && <SessionWorkspace key={`workspace-${current.id}`} sessionId={current.id} channelId={channelId} running={current.running} onChanged={onChanged} />}
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
        {terminalConflict ? (
          <div className="space-y-2" role="group" aria-label="Agent connected from a terminal">
            <p className="text-sm text-text">{ERRORS.terminal_connected}</p>
            <button type="button" data-autofocus className={BTN_PRIMARY} disabled={busy} onClick={() => retryTerminal('keep')}>Keep the terminal</button>
            <button type="button" className={BTN_SECONDARY} disabled={busy} onClick={() => retryTerminal('standby')}>Start hosted on standby</button>
            <button type="button" className={BTN_SECONDARY} disabled={busy} onClick={() => setTerminalConflict(null)}>Cancel</button>
          </div>
        ) : conflict ? (
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
                  {s.id !== current?.id && <div className="w-full"><SessionWorkspace sessionId={s.id} channelId={channelId} running={s.running} onChanged={onChanged} /></div>}
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
