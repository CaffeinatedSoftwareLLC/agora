import { generateUlid } from '../utils/ulid';
import { postSessionNotice, sessionUpdate, threadReplyCounted, type Notice } from './agent-runs';

/**
 * Subtask delegation (docs/task-board.md): an agent in a hosted run hands a scoped brief to a
 * child session that works in its own thread with a clean context, and only the child's
 * summary comes back to the thread the parent delegated from.
 *
 * The child spends its parent's token budget (budgetExhausted in agent-runs.ts) and is
 * shelved as 'done' once it has reported, so its worktree stays reviewable and resumable.
 */

/** Live subtasks one parent may have at a time. */
export const MAX_LIVE_SUBTASKS = 5;
/** The summary is cut to fit a wake's 4000-character message limit, with the header line. */
const SUMMARY_LIMIT = 3500;

/** Insert a message from a bot (an agent's brief or summary, posted by the server for it). */
export async function insertBotMessage(c: any, input: { channelId: string; botId: string; content: string; threadId: string | null; clientKey?: string | null }): Promise<Notice[]> {
    const id = generateUlid();
    await c.query(
        `INSERT INTO messages (id, channel_id, author_id, content, thread_id, author_could_direct, client_key)
         VALUES ($1, $2, $3, $4, $5, false, $6)`,
        [id, input.channelId, input.botId, input.content, input.threadId, input.clientKey ?? null]
    );
    const user = (await c.query('SELECT username, avatar_url FROM users WHERE id = $1', [input.botId])).rows[0];
    const channelId = input.channelId.trim();
    const notices: Notice[] = [{
        channelId,
        event: {
            id, content: input.content, authorId: input.botId.trim(), authorUsername: user?.username ?? null,
            authorBot: true, authorAvatarUrl: user?.avatar_url ?? null, authorAuthority: null,
            channelId, createdAt: new Date().toISOString(), mentions: [], mentionsEveryone: false,
            ...(input.threadId ? { threadId: input.threadId.trim() } : {}),
        },
    }];
    if (input.threadId) notices.push(await threadReplyCounted(c, channelId, input.threadId));
    return notices;
}

/** The first line of a subtask's report in the parent's thread. */
export function reportHeader(title: string, sessionId: string, branch: string | null, headSha: string | null): string {
    const where = branch && headSha ? `, ${branch} @ ${headSha.slice(0, 12)}` : '';
    return `Subtask "${title}" finished (session ${sessionId}${where}).`;
}

/**
 * A subtask's run succeeded: post its summary as the child agent in the thread the parent
 * delegated from (the channel if that thread is gone or closed), wake the parent with it,
 * and shelve the child as done. Runs inside the run's completion, with the child locked.
 * Returns false when the session is not a subtask.
 */
export async function reportSubtask(c: any, sessionId: string, summary: string | null, notices: Notice[]): Promise<boolean> {
    const row = (await c.query(
        `SELECT s.channel_id, s.bot_id, s.parent_session_id, s.report_thread_id, s.thread_id, s.title, s.branch, s.head_sha,
                parent.state AS parent_state
         FROM agent_sessions s LEFT JOIN agent_sessions parent ON parent.id = s.parent_session_id
         WHERE s.id = $1`,
        [sessionId]
    )).rows[0];
    if (!row?.parent_session_id) return false;
    const channelId = row.channel_id.trim();

    let threadId: string | null = row.report_thread_id?.trim() ?? null;
    if (threadId) {
        const open = await c.query(
            `SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2 AND thread_id IS NULL AND deleted_at IS NULL AND thread_closed_at IS NULL`,
            [threadId, channelId]
        );
        if (!open.rows.length) threadId = null;
    }
    const body = summary?.trim() ? summary.trim().slice(0, SUMMARY_LIMIT) : 'It returned no summary.';
    const content = `${reportHeader(row.title ?? 'Subtask', sessionId, row.branch ?? null, row.head_sha ?? null)}\n\n${body}`;
    const posted = await insertBotMessage(c, { channelId, botId: row.bot_id.trim(), content, threadId });
    notices.push(...posted);

    // An ended parent never runs again; a shelved one gets the summary when it is resumed
    if (row.parent_state && row.parent_state !== 'ended') {
        await c.query(
            `INSERT INTO agent_inbox (id, session_id, message_id, thread_id, reason) VALUES ($1, $2, $3, $4, 'delegate')
             ON CONFLICT (session_id, message_id) DO NOTHING`,
            [generateUlid(), row.parent_session_id, posted[0].event.id, threadId]
        );
        notices.push(await sessionUpdate(c, row.parent_session_id.trim(), false));
    }
    await c.query(
        `UPDATE agent_sessions SET state = 'shelved', end_reason = 'done', shelved_at = NOW() WHERE id = $1 AND state = 'live'`,
        [sessionId]
    );
    notices.push(...await postSessionNotice(c, channelId, row.thread_id?.trim() ?? null,
        `Subtask done: its summary went to ${threadId ? `thread ${threadId}` : 'the channel'}. Resume session ${sessionId} to continue it.`));
    return true;
}
