import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../../lib/api';

/**
 * Agent session commands typed in the message box: /start, /end, /sessions, /resume
 * (docs/planning/agent-sessions-wbs.md, "Commands"). The server posts a notice for every
 * change, so the channel sees it; this panel shows the sender the result, and asks what
 * to do when the agent already has a live session here.
 */

interface AgentSession {
  id: string;
  profile: string;
  botUsername: string;
  state: 'live' | 'shelved' | 'ended';
  endReason: string | null;
  wakesUsed: number;
  tokensUsed: number;
  lastActiveAt: string;
}

type Command =
  | { command: 'start'; profile: string; fresh: boolean }
  | { command: 'end'; profile: string }
  | { command: 'sessions' }
  | { command: 'resume'; sessionId: string };

const USAGE = '/start <profile> [--new] · /end <profile> · /sessions · /resume <session id>';

/** Parse a message-box line. Returns null when it isn't one of these commands. */
export function parseAgentCommand(text: string): Command | 'usage' | null {
  const parts = text.trim().split(/\s+/);
  const name = parts[0]?.toLowerCase();
  const args = parts.slice(1);
  switch (name) {
    case '/start': {
      const fresh = args.includes('--new');
      const profile = args.find(a => !a.startsWith('--'));
      return profile ? { command: 'start', profile: profile.toLowerCase(), fresh } : 'usage';
    }
    case '/end':
      return args[0] ? { command: 'end', profile: args[0].toLowerCase() } : 'usage';
    case '/sessions':
      return { command: 'sessions' };
    case '/resume':
      return args[0] && /^[0-9A-Za-z]{26}$/.test(args[0]) ? { command: 'resume', sessionId: args[0].toUpperCase() } : 'usage';
    default:
      return null;
  }
}

const ERRORS: Record<string, string> = {
  unknown_profile: 'No agent profile with that name on this server.',
  bot_not_in_channel: "That agent's bot hasn't been added to this channel.",
  no_live_session: 'That agent has no live session here.',
  not_resumable: 'Only a shelved session from this channel can be resumed.',
  session_live: 'That agent already has a live session here.',
};

function describe(s: AgentSession): string {
  const reason = s.endReason ? ` (${s.endReason})` : '';
  return `${s.profile} · ${s.state}${reason} · ${s.wakesUsed} wakes · ${s.tokensUsed.toLocaleString()} tokens`;
}

type Panel =
  | { kind: 'none' }
  | { kind: 'busy' }
  | { kind: 'message'; text: string; error?: boolean }
  | { kind: 'sessions'; sessions: AgentSession[] }
  | { kind: 'live'; retry: (onLive: 'shelve' | 'keep') => void };

export function useAgentCommands(channelId: string): { tryHandle: (text: string) => boolean; panel: ReactNode } {
  const [state, setState] = useState<Panel>({ kind: 'none' });

  const run = async (cmd: Command, onLive?: 'shelve' | 'keep') => {
    setState({ kind: 'busy' });
    const body = cmd.command === 'start'
      ? { command: 'start', profile: cmd.profile, fresh: cmd.fresh, ...(onLive ? { onLive } : {}) }
      : cmd.command === 'resume'
        ? { command: 'resume', sessionId: cmd.sessionId, ...(onLive ? { onLive } : {}) }
        : cmd;
    try {
      const res = await api.post<{ action?: string; session?: AgentSession; sessions?: AgentSession[] }>(
        `/channels/${channelId}/agent-commands`, body,
      );
      if (cmd.command === 'sessions') {
        setState({ kind: 'sessions', sessions: res.sessions ?? [] });
      } else {
        setState({ kind: 'message', text: `Session ${res.action}: ${res.session ? describe(res.session) : ''}` });
      }
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown_error';
      if (code === 'session_live' && (cmd.command === 'start' || cmd.command === 'resume')) {
        setState({ kind: 'live', retry: (choice) => { void run(cmd, choice); } });
      } else if (err instanceof ApiError && err.status === 403) {
        setState({ kind: 'message', text: 'Only the owner and directors can start, end or resume agent sessions.', error: true });
      } else {
        setState({ kind: 'message', text: ERRORS[code] ?? `Command failed (${code}).`, error: true });
      }
    }
  };

  const tryHandle = (text: string): boolean => {
    const cmd = parseAgentCommand(text);
    if (cmd === null) return false;
    if (cmd === 'usage') setState({ kind: 'message', text: USAGE, error: true });
    else void run(cmd);
    return true;
  };

  const close = () => setState({ kind: 'none' });
  const panel = state.kind === 'none' ? null : (
    <div className="mb-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {state.kind === 'busy' && <span className="text-text-muted">Working…</span>}
          {state.kind === 'message' && (
            <span className={state.error ? 'text-danger' : undefined}>{state.text}</span>
          )}
          {state.kind === 'sessions' && (state.sessions.length === 0
            ? <span className="text-text-muted">No agent sessions in this channel.</span>
            : (
              <ul className="space-y-1">
                {state.sessions.map(s => (
                  <li key={s.id} className="truncate">
                    <span className="font-medium">{describe(s)}</span>
                    <span className="ml-2 font-mono text-xs text-text-muted select-all">{s.id}</span>
                  </li>
                ))}
              </ul>
            ))}
          {state.kind === 'live' && (
            <div className="flex flex-wrap items-center gap-2">
              <span>{ERRORS.session_live}</span>
              <button className="rounded bg-primary px-2 py-1 text-xs font-medium text-white" onClick={() => state.retry('shelve')}>
                Shelve it and start new
              </button>
              <button className="rounded border border-border px-2 py-1 text-xs" onClick={() => state.retry('keep')}>
                Keep it
              </button>
              <button className="rounded px-2 py-1 text-xs text-text-muted" onClick={close}>Cancel</button>
            </div>
          )}
        </div>
        {state.kind !== 'busy' && state.kind !== 'live' && (
          <button className="text-text-muted hover:text-text" onClick={close} aria-label="Close">×</button>
        )}
      </div>
    </div>
  );

  return { tryHandle, panel };
}
