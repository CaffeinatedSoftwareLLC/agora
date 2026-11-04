import { generateUlid } from '../utils/ulid';

/**
 * GitHub issues bridge (docs/github-issues.md). A channel links to one repository; a director
 * picks one of its open issues, which becomes a task card; when the card's pull request opens,
 * merges or closes, a fixed status line is commented on the issue.
 *
 * Agora holds no GitHub token. Every GitHub call is a `github_commands` row that an agent host
 * claims and runs with `gh --repo owner/name`, under the owner's own `gh` login on that machine.
 */

/** owner/name. The owner is a GitHub login; '.' and '..' are not repository names. */
export const REPO_PATTERN = '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$';
export const validRepo = (repo: string) => new RegExp(REPO_PATTERN).test(repo) && !/\/\.{1,2}$/.test(repo);

/** Issues the host lists for the picker, and how much of each body it sends. */
export const ISSUE_LIST_LIMIT = 30;
export const ISSUE_BODY_MAX = 2000;
/** A list older than this can't be imported from: list again. */
export const LIST_FRESH_MINUTES = 60;

export type IssueState = 'open' | 'merged' | 'closed';

export interface ListedIssue { number: number; title: string; url: string; author: string; updatedAt: string; body: string }

/** The card's issue: https only and pointing at that issue, whatever the host sent. */
export function issueUrlOk(url: unknown, number: number): url is string {
    return typeof url === 'string' && /^https:\/\/\S+$/.test(url) && url.length <= 2048 && url.endsWith(`/issues/${number}`);
}

/** The status line on the issue. Fixed text: nothing a person or agent wrote goes to GitHub. */
export function commentText(state: IssueState, prUrl: string): string {
    if (state === 'open') return `Agora: an agent opened a pull request for this issue: ${prUrl}`;
    if (state === 'merged') return `Agora: the pull request for this issue was merged: ${prUrl}`;
    return `Agora: the pull request for this issue was closed without merging: ${prUrl}`;
}

/** The card's description: the issue text, cut to fit the card. */
export function issueDescription(issue: ListedIssue): string {
    const body = issue.body.trim();
    return body.length > 2900 ? `${body.slice(0, 2900)}…` : body;
}

/** The pull request state an issue hears about: a draft counts as opened. */
export function reportedState(prState: string | null | undefined): IssueState | null {
    if (prState === 'open' || prState === 'draft') return 'open';
    if (prState === 'merged' || prState === 'closed') return prState;
    return null;
}

/**
 * A card's pull request changed (src/lib/task-cards.ts trackWorkspaceResult). If the card came
 * from an issue and the issue hasn't heard about this state yet, queue the comment on the
 * host of the card's session: the same `gh` login that opened or read the pull request.
 */
export async function reportToIssue(c: any, cardId: string): Promise<void> {
    const card = (await c.query(
        `SELECT t.id, t.server_id, t.channel_id, t.thread_id, t.issue_repo, t.issue_number, t.issue_reported, t.pr_url, t.pr_state, p.host_id
         FROM task_cards t JOIN agent_sessions s ON s.id = t.session_id JOIN agent_profiles p ON p.id = s.profile_id
         WHERE t.id = $1 AND t.issue_number IS NOT NULL`, [cardId])).rows[0];
    if (!card || !card.pr_url) return;
    const state = reportedState(card.pr_state);
    if (!state || state === card.issue_reported) return;
    await c.query('UPDATE task_cards SET issue_reported = $2 WHERE id = $1', [cardId, state]);
    await c.query(
        `INSERT INTO github_commands (id, server_id, channel_id, host_id, requested_by, action, repo, payload)
         VALUES ($1, $2, $3, $4, NULL, 'issue_comment', $5, $6)`,
        [generateUlid(), card.server_id, card.channel_id, card.host_id, card.issue_repo,
         { number: card.issue_number, body: commentText(state, card.pr_url), cardId: card.id.trim() }]
    );
}
