// Plain system notices (session standby/started/ended, kept-worktree lists, loop guard...)
// collapse into one expandable row when several arrive in a row (#118).

type NoticeLike = { id: string; systemEvent?: string | null; deletedAt?: string };

/** System events that render as their own interactive card; never folded into a run. */
const CARD_EVENTS = new Set([
  'agent_tool_approval',
  'agent_run_approval',
  'agent_handoff',
  'agent_permission_relay',
  'task_card',
  'subtask',
  'provider_terms',
]);

/** True for messages MessageItem renders as a plain one-line notice. */
export function isPlainNotice(msg: NoticeLike): boolean {
  const ev = msg.systemEvent;
  if (!ev) return false;
  if (ev.startsWith('runtime_')) return false;
  return !CARD_EVENTS.has(ev);
}

export interface NoticeRun {
  /** Id of the run's first message; the key its expanded state is stored under. */
  key: string;
  /** Number of notices in the run (always >= 2). */
  size: number;
  /** Position of this message within the run (0 = first). */
  position: number;
}

/**
 * For each message, its place in a run of 2+ consecutive plain notices, or null.
 * A lone notice gets null and renders normally.
 */
export function computeNoticeRuns(messages: readonly NoticeLike[]): (NoticeRun | null)[] {
  const out: (NoticeRun | null)[] = new Array(messages.length).fill(null);
  let i = 0;
  while (i < messages.length) {
    if (!isPlainNotice(messages[i])) { i++; continue; }
    let j = i;
    while (j < messages.length && isPlainNotice(messages[j])) j++;
    const size = j - i;
    if (size >= 2) {
      const key = messages[i].id;
      for (let k = i; k < j; k++) out[k] = { key, size, position: k - i };
    }
    i = j;
  }
  return out;
}

/** True when a run member is hidden (collapsed run, not its first row). */
export function isHiddenInRun(run: NoticeRun | null, expanded: boolean): boolean {
  return !!run && !expanded && run.position > 0;
}

export const NOTICE_MAX_LINES = 6;
export const NOTICE_MAX_CHARS = 600;

/** Text shown for a notice while collapsed, or null when it is short enough to show in full. */
export function truncateNotice(
  text: string | null | undefined,
  maxLines = NOTICE_MAX_LINES,
  maxChars = NOTICE_MAX_CHARS,
): string | null {
  if (!text) return null;
  const lines = text.split('\n');
  let shown = text;
  if (lines.length > maxLines) shown = lines.slice(0, maxLines).join('\n');
  if (shown.length > maxChars) shown = shown.slice(0, maxChars);
  if (shown === text) return null;
  return shown.replace(/\s+$/, '') + '…';
}

export const EXPANDED_RUNS_CAP = 200;

export function expandedRunsKey(userId: string): string {
  return `agora:expanded-notice-runs:${userId}`;
}

/** Expanded run keys for a user; empty when storage is missing, throws, or holds junk. */
export function loadExpandedRuns(userId: string | undefined): string[] {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(expandedRunsKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').slice(-EXPANDED_RUNS_CAP);
  } catch {
    return [];
  }
}

/** Stores the newest `EXPANDED_RUNS_CAP` keys; failures are ignored. */
export function saveExpandedRuns(userId: string | undefined, keys: readonly string[]): void {
  if (!userId) return;
  try {
    localStorage.setItem(expandedRunsKey(userId), JSON.stringify(keys.slice(-EXPANDED_RUNS_CAP)));
  } catch {
    // storage unavailable: state lives in memory for this session
  }
}

/** Returns the new key list with `key` toggled; a newly expanded key goes last. */
export function toggleRunKey(keys: readonly string[], key: string): string[] {
  if (keys.includes(key)) return keys.filter(k => k !== key);
  return [...keys, key].slice(-EXPANDED_RUNS_CAP);
}

/** The part of the virtualizer resizeRunRows needs (@tanstack/virtual-core's Virtualizer). */
export interface ResizableList { resizeItem(index: number, size: number): void }

/**
 * A run was expanded or collapsed: replace the virtualizer's cached heights for its rows with
 * the new estimates. Offscreen rows are never re-measured, so without this a collapsed run
 * keeps its expanded height as blank scroll space. Visible rows get measured again anyway.
 */
export function resizeRunRows(list: ResizableList, runs: readonly (NoticeRun | null)[], keys: ReadonlySet<string>, estimate: (index: number) => number): void {
  runs.forEach((run, index) => { if (run && keys.has(run.key)) list.resizeItem(index, estimate(index)); });
}
