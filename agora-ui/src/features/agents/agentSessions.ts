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
  /**
   * 'terminal' (#112): the user's own CLI connected through agora-mcp with presence. It has
   * no profile, host, runs or budget, and lives while agora-mcp is connected.
   */
  kind?: 'hosted' | 'terminal';
  /** Terminal sessions: tool calls agora-mcp has seen. */
  toolCalls?: number;
  /** Terminal sessions: false when the CLI's token use is unknown (shown as "n/a"). */
  usageKnown?: boolean;
  /** Terminal sessions: Claude Code Channel ('channel') or plain MCP with chat_wait ('mcp'). */
  terminalMode?: 'channel' | 'mcp' | null;
  /** Terminal sessions: false. Agora can't stop a user's own CLI. */
  budgetEnforced?: boolean;
  lurkMode?: 'quiet' | 'balanced' | 'vocal' | null;
  /** How the agent's CLI signs in (docs/provider-terms.md); subscription = owner-triggered only, siwc = plan-owner-triggered only. */
  authMode?: 'subscription' | 'api_key' | 'siwc';
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
  tokenBudget?: number | null;
  run?: AgentRun | null;
  recentRuns?: AgentRun[];
  /** A task card's or subtask's session works only in this thread (docs/task-board.md). */
  threadId?: string | null;
  /** A subtask's parent session. */
  parentSessionId?: string | null;
  title?: string | null;
}

export interface AgentProfile {
  id: string;
  name: string;
  botId: string;
  adapter: string;
}

export type CommandBody =
  | { command: 'start'; profile: string; fresh?: boolean; onLive?: 'shelve' | 'keep' | 'standby' }
  | { command: 'end'; profile: string }
  | { command: 'end'; sessionId: string }
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
  bot_not_in_channel: "That agent isn't in this channel yet. Open Agents in this channel to add it, or ask the server owner or an administrator.",
  no_live_session: 'That agent has no live session here.',
  not_resumable: 'Only a shelved session from this channel can be resumed.',
  session_live: 'That agent already has a live session here.',
  not_sleeping: 'That session is not sleeping.',
  subscription_owner_only: "This agent runs on the owner's personal subscription, so only the owner can start or resume it. Ask the owner, or configure an API key profile.",
  plan_owner_only: "This agent runs on its plan owner's ChatGPT plan, so only they can start or resume it. Ask them, or configure an API key profile.",
  card_session_live: "This card's agent is working. End its session before reassigning the card.",
  card_changed: 'The card changed meanwhile. Try again.',
  card_not_found: 'That card no longer exists.',
  no_assignee: 'Assign an agent to the card first.',
  empty_title: 'Give the card a title.',
  terminal_connected: 'That agent is already connected from a terminal, which answers here. A hosted session would wait on standby until the terminal disconnects.',
  terminal_session: "That is the user's own terminal session. It ends when they close their CLI.",
};

/** Tooltip for hosted-only actions on a terminal session (#112). */
export const HOSTED_ONLY = 'Hosted sessions only. A terminal session is the user\'s own CLI in their own checkout: no worktree, diff review, checkpoints, verify or subtasks.';
export const TERMINAL_BUDGET = 'No budget: this is the user\'s own CLI, and Agora can\'t stop it.';

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
export function classifyCommandError(err: unknown, command: CommandBody['command']): { kind: 'live' } | { kind: 'terminal' } | { kind: 'error'; text: string } {
  const code = err instanceof ApiError ? err.code : 'unknown_error';
  if (code === 'session_live' && (command === 'start' || command === 'resume')) return { kind: 'live' };
  if (code === 'terminal_connected' && command === 'start') return { kind: 'terminal' };
  if (code === 'subscription_owner_only' || code === 'plan_owner_only') return { kind: 'error', text: ERRORS[code] };
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

/** 'standby': live, but the agent is connected from a terminal, which answers instead (#112). */
export type ChipState = 'working' | 'idle' | 'sleeping' | 'standby' | 'shelved' | 'ended';

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
  standby: 'On standby (connected from a terminal)',
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

/** When a rate limit resets, as a clock time in the viewer's locale ("2:05 PM", "14:05"). */
export function resetTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const RANK: Record<ChipState, number> = { working: 0, idle: 1, sleeping: 2, standby: 3, shelved: 4, ended: 5 };

function byRecent(a: AgentSession, b: AgentSession): number {
  return (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '');
}

/** Bots with a live terminal session in this list. */
export function terminalBots(sessions: AgentSession[]): Set<string> {
  return new Set(sessions.filter(s => s.kind === 'terminal' && s.state === 'live' && s.botId).map(s => s.botId!.trim()));
}

/**
 * One chip per profile with sessions in the channel: live first, then shelved, then ended.
 * Task card and subtask sessions work in their own threads and show on the task board.
 * Terminal sessions show as the agent's own-session chip (ownSessionChips); a live hosted
 * session of an agent connected from a terminal is on standby.
 */
export function deriveChips(sessions: AgentSession[]): AgentChip[] {
  const terminal = terminalBots(sessions);
  const groups = new Map<string, AgentSession[]>();
  for (const s of sessions) {
    if (s.threadId || s.kind === 'terminal') continue;
    const list = groups.get(s.profile);
    if (list) list.push(s); else groups.set(s.profile, [s]);
  }
  const chips: AgentChip[] = [];
  for (const [profile, list] of groups) {
    list.sort(byRecent);
    const session = list.find(s => s.state === 'live') ?? list[0];
    const standby = session.state === 'live' && !session.running && !!session.botId && terminal.has(session.botId.trim());
    chips.push({ profile, state: standby ? 'standby' : sessionState(session), session, sessions: list });
  }
  return chips.sort((a, b) => RANK[a.state] - RANK[b.state] || byRecent(a.session, b.session) || a.profile.localeCompare(b.profile));
}

/** "subscription (owner only)" or "API key", plus "approval per run". */
export function authLabel(mode: AgentSession['authMode'], runApproval?: boolean): string {
  const base = mode === 'api_key' ? 'API key' : mode === 'siwc' ? 'ChatGPT plan (plan owner only)' : 'subscription (owner only)';
  return runApproval ? `${base}, approval per run` : base;
}

/** "tokens n/a" for a CLI that doesn't report them. */
export function terminalUsage(s: AgentSession): string {
  const calls = s.toolCalls ?? 0;
  return `${calls} tool ${calls === 1 ? 'call' : 'calls'} · ${s.usageKnown ? `${compactTokens(s.tokensUsed)} tokens` : 'tokens n/a'}`;
}

export function describeSession(s: AgentSession): string {
  if (s.kind === 'terminal') {
    return `${s.profile} · terminal · ${s.state}${s.state === 'live' ? (s.running ? ' (working)' : ' (idle)') : ''} · ${terminalUsage(s)} · no budget (own CLI)`;
  }
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
  kept_terminal: 'Kept the terminal session; no hosted session started.',
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
  /** Its live terminal session (#112), when the server has one. */
  session?: AgentSession;
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
  const terminal = new Map(sessions.filter(s => s.kind === 'terminal' && s.state === 'live' && s.botId).map(s => [s.botId!.trim(), s]));
  const hosted = new Set(sessions.filter(s => s.kind !== 'terminal' && s.state === 'live' && s.botId && !s.threadId).map(s => s.botId!.trim()));
  const chips: OwnSessionChip[] = [...present]
    // A hosted chip already stands for an agent without a terminal session
    .filter(p => terminal.has(p.userId.trim()) || !hosted.has(p.userId.trim()))
    .map(p => ({ userId: p.userId, username: p.username, status: p.status, mode: p.mode, session: terminal.get(p.userId.trim()) }));
  // A terminal session in its reconnect grace period, or before presence arrived
  for (const [botId, session] of terminal) {
    if (!chips.some(c => c.userId.trim() === botId)) {
      chips.push({ userId: botId, username: session.botUsername, status: 'connected', mode: session.terminalMode ?? null, session });
    }
  }
  return chips
    .sort((a, b) => OWN_RANK[a.status] - OWN_RANK[b.status] || a.username.localeCompare(b.username));
}

/** "Claude Code Channel" or "chat_wait", for the chip's tooltip. */
export function ownSessionDetail(chip: OwnSessionChip): string {
  if (chip.status === 'offline') return 'Its agora-mcp has disconnected.';
  if (chip.session?.running) return `Working in its terminal: ${terminalUsage(chip.session)}.`;
  if (chip.mode === 'channel') return 'Claude Code Channel: instructions are pushed into the session.';
  return chip.status === 'listening' ? 'Waiting in chat_wait for new messages.' : 'agora-mcp is running; the agent is not waiting for messages right now.';
}
