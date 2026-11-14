import { api, ApiError, inBackground } from '../../lib/api';
import { ERRORS, NO_AUTHORITY, limitStopText, type LimitStop } from '../agents/agentSessions';

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
  /** Started, but waiting for a free slot on its host (a host runs only so many agents at once). */
  queued?: boolean;
  sleepingUntil: string | null;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  tokensUsed: number;
  /** Limits: null is none. limitStop: what stopped a session shelved as 'budget'. */
  tokenBudget: number | null;
  wakesUsed?: number;
  wakeBudget?: number | null;
  limitStop?: LimitStop | null;
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
  /** The GitHub issue this card was imported from (docs/github-issues.md). */
  issue: { repo: string; number: number; url: string | null } | null;
  /** Made by the channel's automation rule (docs/github-issues.md). */
  fromRule?: boolean;
  /** Why the rule did not start this card's agent; the owner can start it from here. */
  ruleNote?: string | null;
  /** Set when the card's issue was closed on GitHub while the card is open. */
  issueClosedAt?: string | null;
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

// ─── GitHub issues bridge (src/routes/github-issues.ts) ───

export interface GithubLink { repo: string; hostId: string; hostName: string; hostRevoked: boolean; updatedAt: string }
export interface GithubState {
  link: GithubLink | null;
  /** May link and unlink a repository (the server owner). */
  canLink: boolean;
  /** May list and import issues (owner, directors). */
  canImport: boolean;
}
export interface GithubIssue { number: number; title: string; url: string; author: string; updatedAt: string; body: string; cardId: string | null }
/** The automation rule on the linked repository (src/lib/github-rules.ts). Everything in it is off until the owner turns it on. */
export interface GithubRule {
  import: { mode: 'off' | 'label' | 'all'; label: string | null };
  authors: string[];
  autostart: { profile: string | null; confirmedOpen: boolean; maxPerCheck?: number | null };
  /** The GitHub login the linked host's gh is signed in as (null until the host has said). */
  hostLogin?: string | null;
  hostLoginError?: string | null;
  pollMinutes: number;
  commentOnPickup: boolean;
  status: { lastPolledAt: string | null; lastCheckedAt: string | null; result: string | null; found: number | null; created: number | null };
  limits: { defaultPollMinutes: number; minPollMinutes: number; maxPollMinutes: number; scanLimit: number };
}
export interface AutostartOption { name: string; planOwned: boolean; allowed: boolean; never?: boolean; reason: string | null }
export interface GithubRuleState { rule: GithubRule | null; canConfigure: boolean; autostartOptions: AutostartOption[] }
export interface GithubRuleInput {
  import: { mode: 'off' | 'label' | 'all'; label?: string };
  authors: string[];
  autostart: { profile: string | null; confirmOpen?: boolean; maxPerCheck?: number | null };
  pollMinutes: number;
  commentOnPickup: boolean;
}

/** What the rule's last check says, in a sentence. */
export const CHECK_RESULT: Record<string, string> = {
  ok: 'checked, nothing wrong', truncated: 'checked, but only the newest open issues were looked at',
  host_offline: 'the host is offline, so nothing was checked', host_old: 'the host runs an older agora-host that cannot check yet: update it',
  host_revoked: 'the host was revoked: link the repository again with another host', host_timeout: 'the host took the check and never answered',
  gh_not_installed: 'gh is not installed on the host', gh_not_signed_in: 'gh is not signed in on the host (gh auth login)',
  repo_not_found: "the host's gh can't find the repository", binding_changed: 'the link changed before the host ran it',
  rule_changed: 'the rule was changed before the host answered',
};

export interface AgentHost { id: string; name: string; revokedAt: string | null }

interface GithubCommand { id: string; status: string; result?: { error?: string; issues?: GithubIssue[] } | null }

export const githubApi = {
  get: (channelId: string) => inBackground(() => api.get<GithubState>(`/channels/${channelId}/github`)),
  /** Hosts the owner can pick for the link; revoked ones are left out. */
  hosts: async (serverId: string) => (await api.get<AgentHost[]>(`/servers/${serverId}/agent-hosts`)).filter(h => !h.revokedAt),
  link: (channelId: string, repo: string, hostId: string) =>
    api.put<{ link: GithubLink }>(`/channels/${channelId}/github`, { repo, hostId }),
  unlink: (channelId: string) => api.delete<void>(`/channels/${channelId}/github`),
  rule: (channelId: string) => inBackground(() => api.get<GithubRuleState>(`/channels/${channelId}/github/automation`)),
  saveRule: (channelId: string, body: GithubRuleInput) => api.put<{ rule: GithubRule }>(`/channels/${channelId}/github/automation`, body),
  /** Ask the host to check now; resolves once it is queued. */
  checkNow: (channelId: string) => api.post<{ id: string; status: string }>(`/channels/${channelId}/github/automation/check`),
  /** Ask the linked host for the repository's open issues; resolves with them once it answers (null if aborted). */
  async listIssues(channelId: string, signal?: AbortSignal): Promise<{ commandId: string; issues: GithubIssue[] } | null> {
    let command = await api.post<GithubCommand>(`/channels/${channelId}/github/issues`);
    const deadline = Date.now() + 120_000;
    while (command.status === 'queued' || command.status === 'claimed') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (signal?.aborted) return null;
      if (Date.now() >= deadline) throw new Error('The host has not answered yet (is agora-host running and up to date?).');
      command = await inBackground(() => api.get<GithubCommand>(`/channels/${channelId}/github/commands/${command.id}`));
    }
    if (command.status !== 'succeeded') {
      const code = command.result?.error ?? '';
      throw new Error(GITHUB_ERRORS[code] ?? (code ? `The host could not list the issues (${code}).` : 'The host could not list the issues.'));
    }
    return { commandId: command.id, issues: command.result?.issues ?? [] };
  },
  importIssue: (channelId: string, body: { commandId: string; number: number; profile?: string | null; start?: boolean }) =>
    api.post<{ action: string; card: TaskCard }>(`/channels/${channelId}/github/issues/import`, body),
};

const GITHUB_ERRORS: Record<string, string> = {
  gh_not_installed: 'The GitHub CLI (gh) is not installed on the host.',
  gh_not_signed_in: 'gh is not signed in on the host. Run gh auth login there.',
  repo_not_found: "The host's gh can't find that repository. Check the name and that its login can see it.",
  gh_failed: 'gh failed on the host. Check the host log.',
  host_timeout: 'The host took the request but never answered. Try again.',
  binding_or_authority_changed: 'The link or your permissions changed before the host ran the list. Try again.',
  binding_changed: 'The channel was linked to another repository or host before the host ran this. Try again.',
  no_repo_linked: 'No repository is linked to this channel, or its host was revoked.',
  issue_already_imported: 'That issue is already a card in this channel.',
  issue_list_stale: 'The issue list is out of date. List the issues again.',
  issue_list_not_found: 'That issue list is gone. List the issues again.',
  issue_not_in_list: 'That issue is not in the list. List the issues again.',
  no_assignee: 'Pick an assignee to start the agent now.',
  invalid_repo: 'Use the owner/name form, for example octocat/hello-world.',
  host_not_found: 'That host is gone or revoked. Pick another.',
  owner_only: 'Only the server owner can link, unlink or change the automation.',
  invalid_label: 'Use a label name of letters, numbers, spaces and . _ : / - (up to 50 characters).',
  autostart_not_allowed: 'That agent cannot be started by the rule.',
  confirmation_required: 'Confirm the warning to save.',
  too_soon: 'Checked a moment ago. Wait a few seconds.',
  check_limit: 'Check now is limited to 12 times an hour per channel and 30 per person. The rule keeps checking on its own schedule.',
  rule_off: 'Turn on an import first.',
  host_offline: 'The host is offline, so nothing can be checked.',
  host_old: 'The host runs an older agora-host that cannot check yet: update it.',
  host_revoked: 'The host was revoked: link the repository again with another host.',
};

/** A failed board call as a sentence. */
export function taskError(err: unknown): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : 'Request failed';
  if (ERRORS[err.code]) return ERRORS[err.code];
  if (PR_ERRORS[err.code]) return PR_ERRORS[err.code];
  if (GITHUB_ERRORS[err.code]) return GITHUB_ERRORS[err.code];
  if (err.status === 403) return err.code === 'subscription_owner_only' ? ERRORS.subscription_owner_only : NO_AUTHORITY;
  return `Request failed (${err.code}).`;
}

/**
 * A failed Start/Resume as a sentence. budget_exhausted (409) carries the limit that refused it
 * (wakes or tokens, this session's or a parent's): say that one, never a guess from the card's numbers.
 */
export function startError(err: unknown, card: TaskCard): string {
  const s = card.session;
  if (err instanceof ApiError && err.code === 'budget_exhausted' && s) {
    const limit = (err.body as { limit?: LimitStop } | undefined)?.limit;
    if (limit) return `This card's session can't start. ${limitStopText({ id: s.id, profile: s.profile, limitStop: limit })}`;
  }
  return taskError(err);
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

export type CardSessionState = 'working' | 'queued' | 'idle' | 'shelved' | 'ended' | 'none';

export function cardSessionState(card: TaskCard): CardSessionState {
  const s = card.session;
  if (!s) return 'none';
  if (s.state === 'live') return s.running ? 'working' : s.queued ? 'queued' : 'idle';
  return s.state;
}

export const SESSION_LABEL: Record<CardSessionState, string> = {
  working: 'Agent working', queued: 'Queued: waits for a free slot on its host', idle: 'Agent idle', shelved: 'Session shelved', ended: 'Session ended', none: 'Not started',
};

/** Pull request links come from the host's `gh`: show https links only. */
export function safeUrl(url: string | null): string | null {
  return url && /^https:\/\/\S+$/.test(url) ? url : null;
}
