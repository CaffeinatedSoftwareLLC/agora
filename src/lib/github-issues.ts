import { generateUlid } from '../utils/ulid';
import { postNotice, type Notice } from './agent-runs';

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
 * A failed comment where gh certainly wrote nothing: the next Check PR may try again. Anything
 * else (gh failed midway, the host never answered) may have posted, so it isn't retried.
 */
const NOTHING_POSTED = new Set(['gh_not_installed', 'gh_not_signed_in', 'repo_not_found', 'invalid_comment', 'invalid_repo', 'binding_changed']);

/**
 * Comments for this card that can no longer finish: a claim past its lease (the host may have
 * posted, so it counts as reported and isn't retried), or a queued one on a host that is revoked
 * or no longer the linked one (nothing posted, so the next Check PR retries). Each is said in the
 * card's thread. Runs with the card locked.
 */
async function settleStaleComments(c: any, cardId: string, linkedHost: string | null): Promise<Notice[]> {
    const notices: Notice[] = [];
    const expired = (await c.query(
        `UPDATE github_commands SET status = 'failed', result = '{"error":"host_timeout"}', finished_at = NOW()
         WHERE action = 'issue_comment' AND payload->>'cardId' = $1 AND status = 'claimed' AND lease_until < NOW() RETURNING *`, [cardId])).rows;
    for (const cmd of expired) notices.push(await commentFailed(c, cmd, 'host_timeout'));
    const orphaned = (await c.query(
        `UPDATE github_commands g SET status = 'failed', result = '{"error":"binding_changed"}', finished_at = NOW()
         FROM agent_hosts h WHERE h.id = g.host_id AND g.action = 'issue_comment' AND g.payload->>'cardId' = $1 AND g.status = 'queued'
           AND (h.revoked_at IS NOT NULL OR $2::text IS NULL OR btrim(g.host_id) <> $2::text) RETURNING g.*`, [cardId, linkedHost])).rows;
    for (const cmd of orphaned) notices.push(await commentFailed(c, cmd, 'binding_changed'));
    return notices;
}

/**
 * A card's pull request changed (src/lib/task-cards.ts trackWorkspaceResult). If the card came
 * from an issue and the issue hasn't heard about this state yet, queue the comment on the host
 * the owner linked to the channel's repository: the owner chose that machine's `gh` login for
 * GitHub, and the assignee's host is never used for it. No usable link to the card's repository:
 * no comment, and a notice says so.
 */
export async function reportToIssue(c: any, cardId: string): Promise<Notice[]> {
    // The card row lock serialises this with a host confirming a comment (commentPosted)
    const locked = (await c.query(
        `SELECT t.id, g.host_id FROM task_cards t LEFT JOIN channel_github_repos g ON g.channel_id = t.channel_id
         WHERE t.id = $1 AND t.issue_number IS NOT NULL FOR UPDATE OF t`, [cardId])).rows[0];
    if (!locked) return [];
    const notices = await settleStaleComments(c, cardId, locked.host_id?.trim() ?? null);
    const card = (await c.query(
        `SELECT t.id, t.server_id, t.channel_id, t.thread_id, t.issue_repo, t.issue_number, t.issue_reported, t.pr_url, t.pr_state,
                g.host_id, g.repo AS linked_repo, h.revoked_at
         FROM task_cards t LEFT JOIN channel_github_repos g ON g.channel_id = t.channel_id LEFT JOIN agent_hosts h ON h.id = g.host_id
         WHERE t.id = $1`, [cardId])).rows[0];
    if (!card.pr_url) return notices;
    const state = reportedState(card.pr_state);
    if (!state || state === card.issue_reported) return notices;
    const ref = `${card.issue_repo}#${card.issue_number}`;
    const say = (text: string) => postNotice(c, card.channel_id.trim(), text, card.thread_id?.trim() ?? null);
    if (!card.host_id || card.linked_repo.toLowerCase() !== card.issue_repo.toLowerCase())
        return [...notices, await say(`Not commenting on GitHub issue ${ref}: this channel is no longer linked to ${card.issue_repo}.`)];
    if (card.revoked_at)
        return [...notices, await say(`Not commenting on GitHub issue ${ref}: the host linked for ${card.issue_repo} was revoked. Link the repository again with another host.`)];
    // One comment per state in flight; issue_reported is set when the host confirms it
    const pending = (await c.query(
        `SELECT 1 FROM github_commands WHERE action = 'issue_comment' AND status IN ('queued', 'claimed')
         AND payload->>'cardId' = $1 AND payload->>'state' = $2`, [card.id.trim(), state])).rows.length;
    if (pending) return notices;
    await c.query(
        `INSERT INTO github_commands (id, server_id, channel_id, host_id, requested_by, action, repo, payload)
         VALUES ($1, $2, $3, $4, NULL, 'issue_comment', $5, $6)`,
        [generateUlid(), card.server_id, card.channel_id, card.host_id, card.issue_repo,
         { number: card.issue_number, body: commentText(state, card.pr_url), cardId: card.id.trim(), state }]
    );
    return notices;
}

/**
 * The host confirmed a comment (or it may have posted): the issue has heard about that state.
 * Only the card's current state is recorded, so a late answer for an older state never moves
 * it backwards and makes the newer state post twice.
 */
export async function commentPosted(c: any, command: any): Promise<void> {
    await c.query(
        `UPDATE task_cards SET issue_reported = $2
         WHERE id = $1 AND $2::text = CASE WHEN pr_state = 'draft' THEN 'open' ELSE pr_state END`,
        [command.payload?.cardId ?? '', command.payload?.state]);
}

/**
 * A comment failed (host error, claim expired, or the link changed before the host ran it).
 * Said in the card's thread. If gh may have posted, the state counts as reported so it is
 * never posted twice; if it certainly didn't, the next Check PR tries again.
 */
export async function commentFailed(c: any, command: any, error: string): Promise<Notice> {
    const card = (await c.query('SELECT thread_id FROM task_cards WHERE id = $1', [command.payload?.cardId ?? ''])).rows[0];
    const retry = NOTHING_POSTED.has(error);
    if (!retry) await commentPosted(c, command);
    const ref = `${command.repo}#${command.payload?.number}`;
    return postNotice(c, command.channel_id.trim(), retry
        ? `Couldn't comment on GitHub issue ${ref}: ${error}. Check PR again once the host's gh is signed in and the repository is linked.`
        : `Commenting on GitHub issue ${ref} may have failed (${error}). Not retried, so it never posts twice: check the issue.`,
        card?.thread_id?.trim() ?? null);
}
