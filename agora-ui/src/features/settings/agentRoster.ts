import type { Bot, ModelAgent } from '../../lib/api';
import type { Box } from '../boxes/api';
import { limitStopText, sessionState, stopLabel, type AgentSession } from '../agents/agentSessions';
import type { Host, Profile } from './AgentSessionsSettings';

/**
 * One list of every agent in the server, built from the pieces the server already keeps apart:
 * the account an agent posts as (a bot), its profile on a host or box, the box itself, a model agent.
 * Words used everywhere in settings:
 *  - agent: something that works in your channels, however it runs;
 *  - account: the bot account an agent posts as (its tokens and channel access);
 *  - model: the AI model a provider key serves.
 */
export type AgentKind = 'box' | 'machine' | 'terminal' | 'model' | 'assistant';

export const KIND_LABEL: Record<AgentKind, string> = {
  box: 'In a box',
  machine: 'On this machine',
  terminal: 'Connected from a terminal',
  model: 'Model on an API key',
  assistant: 'Built-in assistant',
};

/** One line saying what the kind means, for the detail view and the Add an agent page. */
export const KIND_HELP: Record<AgentKind, string> = {
  box: "Runs its CLI in its own locked-down container on this server. It reaches only the websites you allow.",
  machine: "Agora wakes a CLI (Claude Code, Codex...) on one of your own machines. It can read and change that machine's files.",
  terminal: "A CLI running in someone's own terminal that connected through agora-mcp. Agora can't start or stop it.",
  model: "Answers @mentions with a model from one of your provider keys. It has no CLI and no files.",
  assistant: 'The built-in @assistant. It uses the model chosen under Models and assistant.',
};

export type StateTone = 'working' | 'idle' | 'attention' | 'stopped';
export interface AgentState {
  tone: StateTone;
  /** "Working", "Idle", "Stopped"... */
  label: string;
  /** Why, in one sentence; null when the label says it all. */
  why: string | null;
}

export interface AgentRow {
  /** The route key: the account's ID, or `box-<id>` for a box with no profile yet. */
  key: string;
  name: string;
  kind: AgentKind;
  botId: string | null;
  bot: Bot | null;
  avatarUrl: string | null;
  profile: Profile | null;
  host: Host | null;
  box: Box | null;
  model: ModelAgent | null;
  /** The agent's own sessions across the server's channels. */
  sessions: AgentSession[];
  state: AgentState;
}

export interface RosterInput {
  /** null: the viewer may not list accounts (no Manage Bots), so rows come from the other sources. */
  bots: Bot[] | null;
  profiles: Profile[];
  hosts: Host[];
  boxes: Box[];
  /** null: the viewer can't list model agents (administrators only). */
  modelAgents: ModelAgent[] | null;
  assistantBotId: string | null;
  sessions: AgentSession[];
  now?: number;
}

const id = (value: string | null | undefined) => (value ?? '').trim();

function loginWhy(box: Box): string {
  if (box.loginState === 'pending') return 'Its CLI is logging in now.';
  if (box.loginState === 'failed') return box.loginError ? `Its login failed: ${box.loginError}` : 'Its last login failed. Log in again from this page.';
  return 'Its CLI is not logged in yet. Log it in from this page.';
}

/** Sessions of one agent: by account when known, else by profile name. */
function sessionsOf(all: AgentSession[], botId: string | null, name: string): AgentSession[] {
  return all.filter(s => (botId && id(s.botId) === botId) || s.profile === name || s.botUsername === name);
}

/** What an agent is doing now, or why it is not, from what is known about where it runs. */
export function agentState(row: Pick<AgentRow, 'kind' | 'bot' | 'profile' | 'host' | 'box' | 'model' | 'sessions'>, now = Date.now()): AgentState {
  const { kind, bot, host, box, model, sessions } = row;
  if (bot?.pausedAt) {
    return { tone: 'stopped', label: 'Paused', why: bot.pausedReason ? `Paused by an admin: ${bot.pausedReason}` : 'Paused by an admin. It is read-only until resumed.' };
  }
  if (kind === 'box' && box) {
    if (box.state === 'failed') return { tone: 'stopped', label: 'Stopped', why: box.lastError ? `The box failed: ${box.lastError}` : 'The box failed to start.' };
    if (box.state === 'stopped' || box.desiredState === 'stopped') return { tone: 'stopped', label: 'Stopped', why: 'The box is stopped.' };
    if (box.state === 'creating') return { tone: 'attention', label: 'Starting', why: 'The box is being created.' };
    if (box.auth === 'subscription' && box.loginState !== 'logged_in') return { tone: 'attention', label: 'Needs login', why: loginWhy(box) };
  }
  if (kind === 'machine') {
    if (!host || host.revokedAt) return { tone: 'stopped', label: 'Stopped', why: 'Its host was revoked, so nothing wakes it.' };
    if (!host.lastSeenAt) return { tone: 'attention', label: 'Waiting for its host', why: `The host "${host.name}" has never connected.` };
  }
  if (kind === 'model') {
    if (model && !model.enabled) return { tone: 'stopped', label: 'Stopped', why: 'It is switched off in its settings.' };
    return { tone: 'idle', label: 'Ready', why: 'It answers when someone @mentions it.' };
  }
  if (kind === 'assistant') return { tone: 'idle', label: 'Ready', why: 'It answers when someone @mentions it.' };

  const states = sessions.map(s => ({ s, state: sessionState(s, now) }));
  if (states.some(x => x.state === 'working')) return { tone: 'working', label: 'Working', why: null };
  if (states.some(x => x.state === 'sleeping')) return { tone: 'attention', label: 'Sleeping', why: 'It hit its rate limit and wakes when that resets.' };
  if (states.some(x => x.state === 'idle' || x.state === 'standby')) return { tone: 'idle', label: 'Idle', why: kind === 'terminal' ? 'Connected and waiting for a message.' : 'It has a live session and is waiting for a message.' };
  const shelved = states.filter(x => x.state === 'shelved').map(x => x.s)
    .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))[0];
  if (shelved) {
    return { tone: 'stopped', label: 'Stopped', why: shelved.endReason === 'budget' ? limitStopText(shelved) : `Its session was shelved (${stopLabel(shelved) || 'by someone'}).` };
  }
  if (kind === 'terminal') return { tone: 'idle', label: 'Not connected', why: 'No terminal is connected as this agent right now.' };
  return { tone: 'idle', label: 'Idle', why: 'No session yet. Type /start in a channel to begin one.' };
}

/** Every agent as one row, sorted by name. */
export function buildRoster(input: RosterInput): AgentRow[] {
  const { bots, profiles, hosts, boxes, modelAgents, assistantBotId, sessions, now } = input;
  const rows: AgentRow[] = [];
  const botById = new Map((bots ?? []).map(b => [id(b.id), b]));
  const used = new Set<string>();
  const liveBoxes = boxes.filter(b => !b.deletedAt && b.desiredState !== 'deleted');
  const boxesUsed = new Set<string>();

  const add = (partial: Omit<AgentRow, 'key' | 'bot' | 'avatarUrl' | 'sessions' | 'state'> & { key?: string }) => {
    const botId = partial.botId ? id(partial.botId) : null;
    const bot = botId ? botById.get(botId) ?? null : null;
    const own = sessionsOf(sessions, botId, partial.name);
    const row: AgentRow = { ...partial, botId, bot, key: partial.key ?? botId ?? partial.name, avatarUrl: bot?.avatarUrl ?? null, sessions: own, state: { tone: 'idle', label: '', why: null } };
    row.state = agentState(row, now);
    if (botId) used.add(botId);
    rows.push(row);
  };

  for (const p of profiles) {
    const host = hosts.find(h => id(h.id) === id(p.hostId)) ?? null;
    const boxed = !!p.boxed || host?.kind === 'box';
    const box = boxed ? liveBoxes.find(b => b.name === p.name) ?? null : null;
    if (box) boxesUsed.add(box.id);
    add({ name: p.name, kind: boxed ? 'box' : 'machine', botId: p.botId, profile: p, host, box, model: null });
  }
  for (const box of liveBoxes) {
    if (boxesUsed.has(box.id)) continue;
    add({ key: `box-${box.id}`, name: box.name, kind: 'box', botId: null, profile: null, host: null, box, model: null });
  }
  for (const m of modelAgents ?? []) {
    add({ name: m.name, kind: 'model', botId: m.botId, profile: null, host: null, box: null, model: m });
  }
  if (assistantBotId && !used.has(id(assistantBotId))) {
    add({ name: botById.get(id(assistantBotId))?.username ?? 'assistant', kind: 'assistant', botId: assistantBotId, profile: null, host: null, box: null, model: null });
  }
  // An account no profile, box or model uses is an agent connected from someone's terminal
  for (const b of bots ?? []) {
    if (!used.has(id(b.id))) add({ name: b.username, kind: 'terminal', botId: b.id, profile: null, host: null, box: null, model: null });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** The row a route key names: the account's ID, or a box's `box-<id>`. */
export function findRow(rows: AgentRow[], key: string): AgentRow | undefined {
  return rows.find(r => r.key === key || (r.box && `box-${r.box.id}` === key));
}

export const TONE_DOT: Record<StateTone, string> = {
  working: 'bg-online animate-pulse',
  idle: 'bg-text-muted',
  attention: 'bg-warn',
  stopped: 'bg-danger',
};

/** The agent's detail page, or the Models page for the built-in assistant. */
export function agentPath(row: AgentRow): string {
  return row.kind === 'assistant' ? '/settings/models' : `/settings/agents/${row.key}`;
}

