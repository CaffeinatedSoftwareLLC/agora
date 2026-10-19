import type { Notice } from './agent-runs';

/**
 * Task cards (docs/task-board.md): one board per channel. A card names an assignee agent;
 * starting it opens a thread and a worktree session scoped to that thread, and the card
 * follows that session's branch and the pull request opened from its review sheet.
 *
 * Cards are read and written only by the server as the table owner, after the route's own
 * channel access and authority checks (src/routes/task-board.ts).
 */

export const CARD_STATUSES = ['todo', 'in_progress', 'review', 'done'] as const;
export type CardStatus = typeof CARD_STATUSES[number];

export const CARD_SELECT = `SELECT t.*, p.name AS profile_name, sp.name AS session_profile,
        s.state AS session_state, s.end_reason AS session_end_reason, s.branch, s.base_sha, s.head_sha,
        s.tokens_used, COALESCE(s.token_budget, sp.token_budget) AS token_budget, s.last_active_at, s.sleeping_until,
        EXISTS (SELECT 1 FROM agent_runs r WHERE r.session_id = s.id AND r.status = 'claimed') AS running,
        (SELECT r.changed_paths FROM agent_runs r WHERE r.session_id = s.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS changed_paths
    FROM task_cards t
    LEFT JOIN agent_profiles p ON p.id = t.profile_id
    LEFT JOIN agent_sessions s ON s.id = t.session_id
    LEFT JOIN agent_profiles sp ON sp.id = s.profile_id`;

export function cardJson(r: any) {
    return {
        id: r.id.trim(), channelId: r.channel_id.trim(), title: r.title, description: r.description, status: r.status as CardStatus,
        profile: r.profile_id ? { id: r.profile_id.trim(), name: r.profile_name } : null,
        threadId: r.thread_id?.trim() ?? null,
        session: r.session_id ? {
            id: r.session_id.trim(), profile: r.session_profile, state: r.session_state, endReason: r.session_end_reason ?? null,
            running: !!r.running, sleepingUntil: r.sleeping_until ?? null,
            branch: r.branch ?? null, baseSha: r.base_sha ?? null, headSha: r.head_sha ?? null,
            tokensUsed: Number(r.tokens_used), tokenBudget: Number(r.token_budget), lastActiveAt: r.last_active_at,
            changedPaths: r.changed_paths ?? [],
        } : null,
        prUrl: r.pr_url ?? null, prState: r.pr_state ?? null, prCheckedAt: r.pr_checked_at ?? null, mergedSha: r.merged_sha ?? null,
        createdBy: r.created_by?.trim() ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
    };
}
export type TaskCard = ReturnType<typeof cardJson>;

/** The card as the board shows it, as a socket event to emit after commit. */
export async function cardUpdate(c: any, cardId: string): Promise<Notice | null> {
    const row = (await c.query(`${CARD_SELECT} WHERE t.id = $1`, [cardId])).rows[0];
    if (!row) return null;
    const card = cardJson(row);
    return { channelId: card.channelId, eventName: 'TaskCardUpdate', event: { channelId: card.channelId, card } };
}

/** The kickoff the agent reads first: the card itself, in the card's thread. */
export function kickoffText(who: string, profile: string, sessionId: string, title: string, description: string): string {
    return `${who} started ${profile} on task "${title}" (session ${sessionId}).\n\n`
        + `Task: ${title}\n${description.trim() ? `${description.trim()}\n` : ''}\n`
        + 'Work in this thread. Your session has its own worktree branch; the diff is reviewed and the pull request opened from the task board.';
}

/**
 * A workspace command on a card's session finished (src/routes/workspace-review.ts): an
 * opened pull request moves the card to review, a squash merge or a merged pull request to
 * done. Runs with the session locked (profile → session → card, as everywhere).
 */
export async function trackWorkspaceResult(c: any, sessionId: string, action: string, result: any): Promise<Notice[]> {
    // The board renders the link: keep only an https URL, whatever the host sent
    const url = typeof result.url === 'string' && /^https:\/\/\S+$/.test(result.url) ? result.url : null;
    let card;
    if (action === 'pr' && url) {
        card = await c.query(
            `UPDATE task_cards SET pr_url = $2, pr_state = 'open', pr_checked_at = NOW(), updated_at = NOW(),
                    status = CASE WHEN status IN ('todo', 'in_progress') THEN 'review' ELSE status END
             WHERE session_id = $1 RETURNING id`,
            [sessionId, url]
        );
    } else if (action === 'merge' && result.headSha) {
        card = await c.query(
            `UPDATE task_cards SET merged_sha = $2, status = 'done', updated_at = NOW() WHERE session_id = $1 RETURNING id`,
            [sessionId, result.headSha]
        );
    } else if (action === 'pr_status' && result.prState) {
        card = await c.query(
            `UPDATE task_cards SET pr_state = $2::text, pr_url = COALESCE($3, pr_url), pr_checked_at = NOW(), updated_at = NOW(),
                    status = CASE WHEN $2::text = 'merged' THEN 'done' WHEN $2::text IN ('open', 'draft') AND status IN ('todo', 'in_progress') THEN 'review' ELSE status END
             WHERE session_id = $1 RETURNING id`,
            [sessionId, result.prState, url]
        );
    }
    const notices: Notice[] = [];
    for (const row of card?.rows ?? []) {
        const update = await cardUpdate(c, row.id);
        if (update) notices.push(update);
    }
    return notices;
}
