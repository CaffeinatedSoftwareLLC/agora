import { api, ApiError, inBackground } from '../../lib/api';
import { ERRORS, NO_AUTHORITY } from '../agents/agentSessions';

/**
 * Task board data and calls (docs/task-board.md). Server: src/routes/task-board.ts. A card's
 * session is an ordinary agent session scoped to the card's thread, so ending it and
 * reviewing its diff use the session endpoints.
 */

export type CardStatus = 'todo' | 'in_progress' | 'review' | 'done';
export type PrState = 'open' | 'draft' | 'merged' | 'closed';

export interface TaskCardSession {
  id: string;
  profile: string;
  state: 'live' | 'shelved' | 'ended';
  endReason: string | null;
  running: boolean;
  sleepingUntil: string | null;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  tokensUsed: number;
  tokenBudget: number;
  lastActiveAt: string;
  /** The latest run's changed files. */
  changedPaths: string[];
}

export interface TaskCard {
  id: string;
  channelId: string;
  title: string;
  description: string;
  status: CardStatus;
  profile: { id: string; name: string } | null;
  threadId: string | null;
  session: TaskCardSession | null;
  prUrl: string | null;
  prState: PrState | null;
  prCheckedAt: string | null;
  mergedSha: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Board {
  cards: TaskCard[];
  /** May create, edit, move, start and delete cards (owner, directors). */
  canManage: boolean;
  isOwner: boolean;
}

export const STATUSES: CardStatus[] = ['todo', 'in_progress', 'review', 'done'];
export const STATUS_LABEL: Record<CardStatus, string> = { todo: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done' };

export interface CardFields { title?: string; description?: string; status?: CardStatus; profile?: string | null }

interface Command { id: string; status: string; result?: { error?: string; message?: string; prState?: PrState; url?: string } }

export const taskApi = {
  /** Polled and refreshed on events, so it never counts as user activity. */
  list: (channelId: string) => inBackground(() => api.get<Board>(`/channels/${channelId}/tasks`)),
  create: (channelId: string, body: CardFields & { title: string; start?: boolean }) =>
    api.post<{ action: string; card: TaskCard }>(`/channels/${channelId}/tasks`, body),
  update: (channelId: string, taskId: string, body: CardFields) =>
    api.patch<{ card: TaskCard }>(`/channels/${channelId}/tasks/${taskId}`, body),
  remove: (channelId: string, taskId: string) => api.delete<void>(`/channels/${channelId}/tasks/${taskId}`),
  start: (channelId: string, taskId: string) =>
    api.post<{ action: string; card: TaskCard }>(`/channels/${channelId}/tasks/${taskId}/start`),
  endSession: (channelId: string, sessionId: string) =>
    api.post(`/channels/${channelId}/agent-commands`, { command: 'end', sessionId }),
  /** Ask the host for the session branch's pull request state; the card updates when it answers. */
  async refreshPr(channelId: string, sessionId: string, signal?: AbortSignal): Promise<string> {
    const root = `/channels/${channelId}/sessions/${sessionId}/workspace-commands`;
    let command = await api.post<Command>(root, { action: 'pr_status' });
    const deadline = Date.now() + 210_000;
    while (command.status === 'queued' || command.status === 'claimed') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (signal?.aborted) return '';
      if (Date.now() >= deadline) throw new Error('The host has not answered yet.');
      command = await inBackground(() => api.get<Command>(`${root}/${command.id}`));
    }
    if (command.status !== 'succeeded') throw new Error(PR_ERRORS[command.result?.error ?? ''] ?? command.result?.error ?? 'Could not read the pull request.');
    return command.result?.message ?? 'Pull request state updated.';
  },
};

const PR_ERRORS: Record<string, string> = {
  no_pull_request: 'No pull request for this branch yet. Open one from Review changes.',
  pr_status_failed: "The host couldn't read the pull request (is gh signed in there?).",
  workspace_not_created_yet: 'This session has no worktree yet.',
  session_busy: 'Wait for the current run or workspace command to finish.',
};

/** A failed board call as a sentence. */
export function taskError(err: unknown): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : 'Request failed';
  if (ERRORS[err.code]) return ERRORS[err.code];
  if (PR_ERRORS[err.code]) return PR_ERRORS[err.code];
  if (err.status === 403) return err.code === 'subscription_owner_only' ? ERRORS.subscription_owner_only : NO_AUTHORITY;
  return `Request failed (${err.code}).`;
}

/** Cards in board order: by status column, then oldest first. */
export function groupCards(cards: TaskCard[]): Record<CardStatus, TaskCard[]> {
  const groups: Record<CardStatus, TaskCard[]> = { todo: [], in_progress: [], review: [], done: [] };
  for (const c of [...cards].sort((a, b) => a.id.localeCompare(b.id))) (groups[c.status] ?? groups.todo).push(c);
  return groups;
}

export function upsertCard(cards: TaskCard[], card: TaskCard): TaskCard[] {
  const i = cards.findIndex(c => c.id === card.id);
  if (i < 0) return [...cards, card];
  const next = cards.slice();
  next[i] = card;
  return next;
}

export type CardSessionState = 'working' | 'idle' | 'shelved' | 'ended' | 'none';

export function cardSessionState(card: TaskCard): CardSessionState {
  const s = card.session;
  if (!s) return 'none';
  if (s.state === 'live') return s.running ? 'working' : 'idle';
  return s.state;
}

export const SESSION_LABEL: Record<CardSessionState, string> = {
  working: 'Agent working', idle: 'Agent idle', shelved: 'Session shelved', ended: 'Session ended', none: 'Not started',
};

/** Pull request links come from the host's `gh`: show https links only. */
export function safeUrl(url: string | null): string | null {
  return url && /^https:\/\/\S+$/.test(url) ? url : null;
}
