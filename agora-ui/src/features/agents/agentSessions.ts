import { api, ApiError, inBackground } from '../../lib/api';

/**
 * Agent session data and the /channels/:id/agent-commands call, shared by the message-box
 * commands (AgentCommands) and the Console Strip / Session Sheet. Server:
 * src/routes/agent-commands.ts.
 */

export interface AgentRun {
  id: string;
  status: 'claimed' | 'succeeded' | 'failed' | 'expired';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  changedPaths: string[];
}

export interface AgentSession {
  lurkMode?: 'quiet' | 'balanced' | 'vocal' | null;
  /** How the agent's CLI signs in (docs/provider-terms.md); subscription = owner-triggered only. */
  authMode?: 'subscription' | 'api_key';
  /** Every run waits for the owner's approval on a card. */
  runApproval?: boolean;
  branch?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  id: string;
  profile: string;
  botId?: string;
  botUsername: string;
  state: 'live' | 'shelved' | 'ended';
  endReason: string | null;
  wakesUsed: number;
  tokensUsed: number;
  createdAt?: string;
  lastActiveAt: string;
  /** A host has claimed a run for this session and is working now. */
  running?: boolean;
  /** The agent hit its rate limit and sleeps until then; its messages are held (#87). */
  sleepingUntil?: string | null;
  tokenBudget?: number;
  run?: AgentRun | null;
  recentRuns?: AgentRun[];
}

export interface AgentProfile {
  id: string;
  name: string;
  botId: string;
  adapter: string;
}

export type CommandBody =
  | { command: 'start'; profile: string; fresh?: boolean; onLive?: 'shelve' | 'keep' }
  | { command: 'end'; profile: string }
  | { command: 'lurk'; profile: string; lurkMode: 'quiet' | 'balanced' | 'vocal' | null }
  | { command: 'sessions' }
  | { command: 'resume'; sessionId: string; onLive?: 'shelve' | 'keep'; tokenBudget?: number }
  | { command: 'budget'; sessionId: string; tokenBudget: number }
  | { command: 'wake'; sessionId: string };

export interface CommandResponse {
  action?: string;
  session?: AgentSession;
  sessions?: AgentSession[];
}

export const ERRORS: Record<string, string> = {
  budget_exhausted: 'This session has used its budget. The owner can raise its token budget, or start a fresh session.',
  unknown_profile: 'No agent profile with that name on this server.',
  bot_not_in_channel: "That agent's bot hasn't been added to this channel.",
  no_live_session: 'That agent has no live session here.',
  not_resumable: 'Only a shelved session from this channel can be resumed.',
  session_live: 'That agent already has a live session here.',
  not_sleeping: 'That session is not sleeping.',
  subscription_owner_only: "This agent runs on the owner's personal subscription, so only the owner can start or resume it. Ask the owner, or configure an API key profile.",
};

export const NO_AUTHORITY = 'Only the owner and directors can start, end, resume or change lurk mode for agent sessions.';

export function runAgentCommand(channelId: string, body: CommandBody): Promise<CommandResponse> {
  return api.post<CommandResponse>(`/channels/${channelId}/agent-commands`, body);
}

/** Polled and refreshed on notices, so it never counts as user activity (see inBackground). */
export async function listSessions(channelId: string): Promise<AgentSession[]> {
  return (await inBackground(() => runAgentCommand(channelId, { command: 'sessions' }))).sessions ?? [];
}

export function listProfiles(serverId: string): Promise<AgentProfile[]> {
  return api.get<AgentProfile[]>(`/servers/${serverId}/agent-profiles`);
}

/**
 * What a failed command means for the UI: a live-session conflict on start/resume asks the
 * user to shelve or keep; anything else is a plain sentence.
 */
export function classifyCommandError(err: unknown, command: CommandBody['command']): { kind: 'live' } | { kind: 'error'; text: string } {
  const code = err instanceof ApiError ? err.code : 'unknown_error';
  if (code === 'session_live' && (command === 'start' || command === 'resume')) return { kind: 'live' };
  if (code === 'subscription_owner_only') return { kind: 'error', text: ERRORS[code] };
  if (err instanceof ApiError && err.status === 403) return { kind: 'error', text: NO_AUTHORITY };
  return { kind: 'error', text: ERRORS[code] ?? `Command failed (${code}).` };
}

/** 950 → "950", 1234 → "1.2k", 14321 → "14k", 1_250_000 → "1.3M". */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.round(n || 0)));
  if (n < 10_000) return `${trim1(n / 1000)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

function trim1(x: number): string {
  return (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

export type ChipState = 'working' | 'idle' | 'sleeping' | 'shelved' | 'ended';

export interface AgentChip {
  profile: string;
  state: ChipState;
  /** The session the chip stands for: the live one, else the most recently active. */
  session: AgentSession;
  /** This profile's sessions in the channel, most recently active first. */
  sessions: AgentSession[];
}

export const STATE_LABEL: Record<ChipState, string> = {
  working: 'Live and working',
  idle: 'Live and idle',
  sleeping: 'Sleeping (rate limited)',
  shelved: 'Shelved',
  ended: 'Ended',
};

export function sessionState(s: AgentSession, now = Date.now()): ChipState {
  if (s.state === 'live') return s.running ? 'working' : isSleeping(s, now) ? 'sleeping' : 'idle';
  return s.state;
}

/** Live and sleeping through a rate limit that hasn't reset yet. */
export function isSleeping(s: AgentSession, now = Date.now()): boolean {
  return s.state === 'live' && !!s.sleepingUntil && Date.parse(s.sleepingUntil) > now;
}

const RANK: Record<ChipState, number> = { working: 0, idle: 1, sleeping: 2, shelved: 3, ended: 4 };

function byRecent(a: AgentSession, b: AgentSession): number {
  return (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '');
}

/** One chip per profile with sessions in the channel: live first, then shelved, then ended. */
export function deriveChips(sessions: AgentSession[]): AgentChip[] {
  const groups = new Map<string, AgentSession[]>();
  for (const s of sessions) {
    const list = groups.get(s.profile);
    if (list) list.push(s); else groups.set(s.profile, [s]);
  }
  const chips: AgentChip[] = [];
  for (const [profile, list] of groups) {
    list.sort(byRecent);
    const session = list.find(s => s.state === 'live') ?? list[0];
    chips.push({ profile, state: sessionState(session), session, sessions: list });
  }
  return chips.sort((a, b) => RANK[a.state] - RANK[b.state] || byRecent(a.session, b.session) || a.profile.localeCompare(b.profile));
}

/** "subscription (owner only)" or "API key", plus "approval per run". */
export function authLabel(mode: AgentSession['authMode'], runApproval?: boolean): string {
  const base = mode === 'api_key' ? 'API key' : 'subscription (owner only)';
  return runApproval ? `${base}, approval per run` : base;
}

export function describeSession(s: AgentSession): string {
  const reason = s.endReason ? ` (${s.endReason})` : '';
  return `${s.profile} · ${s.state}${reason} · ${s.wakesUsed} wakes · ${s.tokensUsed.toLocaleString()} tokens`
    + (s.authMode ? ` · ${authLabel(s.authMode, s.runApproval)}` : '')
    + (s.branch && s.headSha ? ` · ${s.branch} @ ${s.headSha.slice(0, 12)}` : '');
}

const ACTION_TEXT: Record<string, string> = {
  lurk_updated: 'Lurk mode updated.',
  budget_updated: 'Token budget updated. Resume the session when ready.',
  started: 'Session started.',
  resumed: 'Session resumed.',
  kept: 'Kept the live session.',
  ended: 'Session ended.',
  woken: 'Woken. Held messages go out on its next run.',
};

export function actionText(action: string | undefined): string {
  return (action && ACTION_TEXT[action]) || 'Done.';
}

export function elapsedTime(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000)) || 0;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const DECISION_ERRORS: Record<string, string> = {
  already_decided: 'Someone already answered this.',
  expired: 'This request expired. Wake the agent again to retry.',
  cannot_direct: 'Only the owner and directors can approve agent tools.',
  owner_only: 'Only the server owner can answer this.',
};

/** A failed tool-approval decision (ToolApprovalCard) as a sentence. */
export function decisionError(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Request failed';
  if (DECISION_ERRORS[err.code]) return DECISION_ERRORS[err.code];
  if (err.status === 403) return err.code.startsWith('Only') ? err.code : 'You cannot approve agent tools here.';
  return err.code;
}

/**
 * Bring-your-own-session agents (docs/claude-channel.md): the user's own CLI session
 * connected through agora-mcp, shown apart from host-managed sessions. An agent with a live
 * hosted session in the channel is left out: its hosted chip already stands for it, and a
 * hosted run's own MCP server does not report presence.
 */
export type OwnSessionStatus = 'listening' | 'connected' | 'offline';

export interface OwnSessionChip {
  userId: string;
  username: string;
  status: OwnSessionStatus;
  mode: 'channel' | 'mcp' | null;
}

export const OWN_SESSION_LABEL: Record<OwnSessionStatus, string> = {
  listening: 'Own session, listening',
  connected: 'Own session, connected but not waiting for messages',
  offline: 'Own session, offline',
};

const OWN_RANK: Record<OwnSessionStatus, number> = { listening: 0, connected: 1, offline: 2 };

export function ownSessionChips(
  present: Iterable<{ userId: string; username: string; status: OwnSessionStatus; mode: 'channel' | 'mcp' | null }>,
  sessions: AgentSession[],
): OwnSessionChip[] {
  const hosted = new Set(sessions.filter(s => s.state === 'live' && s.botId).map(s => s.botId!.trim()));
  return [...present]
    .filter(p => !hosted.has(p.userId.trim()))
    .map(p => ({ userId: p.userId, username: p.username, status: p.status, mode: p.mode }))
    .sort((a, b) => OWN_RANK[a.status] - OWN_RANK[b.status] || a.username.localeCompare(b.username));
}

/** "Claude Code Channel" or "chat_wait", for the chip's tooltip. */
export function ownSessionDetail(chip: OwnSessionChip): string {
  if (chip.status === 'offline') return 'Its agora-mcp has disconnected.';
  if (chip.mode === 'channel') return 'Claude Code Channel: instructions are pushed into the session.';
  return chip.status === 'listening' ? 'Waiting in chat_wait for new messages.' : 'agora-mcp is running; the agent is not waiting for messages right now.';
}
