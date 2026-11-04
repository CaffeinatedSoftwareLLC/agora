import type { Pool, PoolClient } from 'pg';
import { queueReminder, reminderSessions } from '../lib/agent-sessions';
import { readAuthorities } from '../lib/direct-agents';
import { notify } from '../lib/notifications';
import { threadWaiting, type ProtocolInfo } from '../lib/protocol';
import { generateUlid, ulidFloor } from '../utils/ulid';

/**
 * Handoff nudges (#327). A thread waits on the agent its latest protocol message names: the
 * one a TURN YIELDs to, or the one a `STATE=WAIT` says owes the next step. When that agent has
 * posted nothing in the thread for `threads.nudge_minutes` (default 15, 0 turns nudges off),
 * Agora posts one reminder in the thread that @mentions it, so its `chat_wait` wakes, and queues
 * it for the agent's live api_key hosted session. When the agent can't be reached that way (no
 * agora-mcp socket, no live terminal session, no hosted session Agora may wake), the bot's
 * owner gets a notification.
 *
 * A reminder is Agora's own post, so the wait behind it must be one Agora trusts:
 * - Written by the agent waited on itself, by another unpaused bot with access to the channel,
 *   or by someone who could direct agents when they posted and still can. An ordinary member's
 *   WAIT or YIELD never produces one.
 * - Aimed at an unpaused bot with access to the channel that has already posted in the thread.
 *   People are never nudged.
 * - At most one reminder per waiting message, one per bot per nudge time, and one owner
 *   notification per bot an hour.
 * - Only waits younger than 4× the nudge time (at least an hour), so old unfinished threads are
 *   left alone when nudges are deployed or turned back on.
 * Every rule is checked again, with the thread locked, in the transaction that writes.
 */

export const NUDGE_SETTING = 'threads.nudge_minutes';
export const DEFAULT_NUDGE_MINUTES = 15;
/** An owner hears about the same quiet bot at most this often. */
const OWNER_NOTICE_MINUTES = 60;
const BATCH = 50;

export interface NudgeEvent { room: string; event: string; data: unknown }

export interface HandoffNudgeDeps {
    db: Pool;
    /** Broadcast after commit (the API process passes Socket.IO). */
    emit?: (e: NudgeEvent) => void;
    /** True while the bot has an agora-mcp presence socket in this process. */
    isConnected?: (botId: string) => boolean;
    log?: { warn(obj: unknown, msg: string): void };
}

export async function nudgeMinutes(db: { query: PoolClient['query'] }): Promise<number> {
    const r = await db.query('SELECT value FROM instance_settings WHERE key = $1', [NUDGE_SETTING]);
    const value = Number(r.rows[0]?.value ?? DEFAULT_NUDGE_MINUTES);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_NUDGE_MINUTES;
}

interface Candidate {
    thread_id: string; id: string; channel_id: string; protocol: ProtocolInfo; began: Date;
    author_id: string | null; author_username: string | null; author_bot: boolean | null; author_could_direct: boolean;
    bot_id: string; bot_username: string; bot_owner_id: string | null;
}

/**
 * Waits due for a reminder, eligibility included, so ineligible waits never fill the batch.
 * $1 lookback floor (ULID), $2 due before (ms), $3 lookback (ms), $4 now (ms), $5 per-bot gap
 * (ms), $6 one thread only (the recheck) or null. Reminder times are kept in the reminder's
 * system_data (`at`, ms) so the limits use the same clock as the pass.
 */
const DUE_WAITS = `WITH latest AS (
        SELECT DISTINCT ON (COALESCE(m.thread_id, m.id)) COALESCE(m.thread_id, m.id) AS thread_id,
               m.id, m.channel_id, m.protocol, m.author_id, m.author_could_direct,
               COALESCE(m.edited_at, m.created_at) AS began
        FROM messages m
        WHERE m.protocol IS NOT NULL AND m.id >= $1 AND m.deleted_at IS NULL
          AND ($6::char(26) IS NULL OR m.thread_id = $6 OR m.id = $6)
        ORDER BY COALESCE(m.thread_id, m.id), m.id DESC
    ), waits AS (
        SELECT l.*, au.username AS author_username, au.bot AS author_bot,
               CASE WHEN l.protocol->>'state' = 'WAIT' THEN COALESCE(l.protocol->>'waitingOn', au.username)
                    WHEN l.protocol->>'state' IN ('DONE', 'BLOCK', 'CANCEL') THEN NULL
                    WHEN l.protocol->>'state' = 'DECIDE' AND l.protocol->>'decision' = 'BLOCK' THEN NULL
                    ELSE l.protocol->>'yieldTo' END AS target
        FROM latest l LEFT JOIN users au ON au.id = l.author_id
        WHERE l.began <= to_timestamp($2::double precision / 1000)
          AND l.began >= to_timestamp(($4::double precision - $3) / 1000)
    )
    SELECT w.thread_id, w.id, w.channel_id, w.protocol, w.began, w.author_id, w.author_username, w.author_bot,
           w.author_could_direct, b.id AS bot_id, b.username AS bot_username, b.bot_owner_id
    FROM waits w
    JOIN messages p ON p.id = w.thread_id AND p.thread_id IS NULL AND p.deleted_at IS NULL AND p.thread_closed_at IS NULL
    JOIN users b ON lower(b.username) = lower(w.target) AND b.bot = true AND b.bot_paused_at IS NULL
    JOIN bot_channel_access a ON a.bot_id = b.id AND a.channel_id = w.channel_id
    WHERE (w.author_id = b.id OR w.author_could_direct
           OR (w.author_bot AND EXISTS (SELECT 1 FROM bot_channel_access aa JOIN users ua ON ua.id = aa.bot_id
               WHERE aa.bot_id = w.author_id AND aa.channel_id = w.channel_id AND ua.bot_paused_at IS NULL)))
      AND EXISTS (SELECT 1 FROM messages x WHERE (x.thread_id = w.thread_id OR x.id = w.thread_id)
                  AND x.author_id = b.id AND x.id <= w.id AND x.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM messages x WHERE (x.thread_id = w.thread_id OR x.id = w.thread_id)
                  AND x.author_id = b.id AND x.id > w.id AND x.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM messages n WHERE n.thread_id = w.thread_id
                  AND n.system_event = 'handoff_nudge' AND n.system_data->>'protocolMessageId' = w.id::text)
      AND NOT EXISTS (SELECT 1 FROM messages n WHERE n.system_event = 'handoff_nudge' AND n.id >= $1
                  AND n.system_data->>'waitingOnId' = b.id::text AND (n.system_data->>'at')::double precision > $4 - $5)
    ORDER BY w.id
    LIMIT ${BATCH}`;

/** One pass. `now` is injectable for tests. Returns the reminders posted. */
export async function runHandoffNudges(deps: HandoffNudgeDeps, now = Date.now()): Promise<{ nudged: number; ownersNotified: number }> {
    const c = await deps.db.connect();
    let locked = false, nudged = 0, ownersNotified = 0;
    const events: NudgeEvent[] = [];
    try {
        // One pass at a time across API processes
        locked = (await c.query("SELECT pg_try_advisory_lock(hashtext('handoff_nudge')) AS locked")).rows[0].locked;
        if (!locked) return { nudged, ownersNotified };
        const minutes = await nudgeMinutes(c);
        if (minutes === 0) return { nudged, ownersNotified };
        const lookbackMs = Math.max(4 * minutes, 60) * 60_000;
        const params = (threadId: string | null) => [ulidFloor(now - lookbackMs), now - minutes * 60_000, lookbackMs, now, minutes * 60_000, threadId];

        const due = await c.query<Candidate>(DUE_WAITS, params(null));
        for (const first of due.rows) {
            const threadId = first.thread_id.trim();
            await c.query('BEGIN');
            try {
                // Lock the thread (a reply or a close updates this row too), then check it all again
                const parent = await c.query('SELECT thread_closed_at FROM messages WHERE id = $1 FOR UPDATE', [threadId]);
                const row = parent.rows[0] && !parent.rows[0].thread_closed_at
                    ? (await c.query<Candidate>(DUE_WAITS, params(threadId))).rows[0] : undefined;
                const result = row && await remind(c, deps, row, minutes, now);
                await c.query('COMMIT');
                if (result) {
                    nudged++; ownersNotified += result.told;
                    events.push(...result.events);
                }
            } catch (err) {
                await c.query('ROLLBACK').catch(() => {});
                deps.log?.warn({ err, threadId }, 'Handoff nudge failed');
            }
        }
    } finally {
        if (locked) await c.query("SELECT pg_advisory_unlock(hashtext('handoff_nudge'))").catch(() => {});
        c.release();
    }
    for (const e of events) deps.emit?.(e);
    return { nudged, ownersNotified };
}

/** Write one reminder for a wait that passed the checks, inside the caller's transaction. */
async function remind(c: PoolClient, deps: HandoffNudgeDeps, row: Candidate, minutes: number, now: number): Promise<{ told: number; events: NudgeEvent[] } | null> {
    const waiting = threadWaiting(row.protocol, row.author_username);
    if (!waiting) return null;
    const threadId = row.thread_id.trim(), protocolId = row.id.trim(), channelId = row.channel_id.trim();
    const botId = row.bot_id.trim(), name = row.bot_username;

    // A person's wait counts only while they can still direct agents here
    if (row.author_id && row.author_id.trim() !== botId && !row.author_bot) {
        const authority = await readAuthorities(c, channelId, [{ id: protocolId, author_id: row.author_id.trim(), author_bot: false, author_could_direct: row.author_could_direct }]);
        if (!authority.get(protocolId)) return null;
    }

    const listening = deps.isConnected?.(botId) || (await c.query(
        `SELECT 1 FROM agent_sessions WHERE bot_id = $1 AND kind = 'terminal' AND state = 'live' LIMIT 1`, [botId])).rows.length > 0;
    const sessions = await reminderSessions(c, { channelId, threadId, botId });
    const reached = listening || sessions.length > 0;
    const ownerId = row.bot_owner_id?.trim() || null;
    const tellOwner = !reached && !!ownerId && (await c.query(`SELECT 1 FROM messages n WHERE n.system_event = 'handoff_nudge'
            AND n.id >= $1 AND n.system_data->>'waitingOnId' = $2 AND (n.system_data->>'ownerTold')::boolean
            AND (n.system_data->>'at')::double precision > $3 LIMIT 1`,
        [ulidFloor(now - OWNER_NOTICE_MINUTES * 60_000), botId, now - OWNER_NOTICE_MINUTES * 60_000])).rows.length === 0;

    const waited = Math.max(minutes, Math.round((now - new Date(row.began).getTime()) / 60_000));
    const reason = waiting.for ? ` (for: ${plain(waiting.for)})` : '';
    const content = `@${name} this thread has waited on you for ${waited} min${reason}. `
        + 'If you owe the next step, post it now. If you are still waiting on something, post STATE=WAIT '
        + `ending with [WAIT on=${name} for=<what>].${reached ? '' : ` Agora can't reach ${name} here${tellOwner ? ', so its owner was told' : ''}.`}`;
    const data = { waitingOn: name, waitingOnId: botId, for: waiting.for, protocolMessageId: protocolId, minutes: waited, at: now, ownerTold: tellOwner };

    const id = generateUlid();
    const inserted = await c.query(`INSERT INTO messages (id, channel_id, author_id, content, system_event, system_data, thread_id)
        VALUES ($1, $2, NULL, $3, 'handoff_nudge', $4, $5) RETURNING created_at`,
    [id, channelId, content, JSON.stringify(data), threadId]);
    await c.query('INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, botId]);
    await queueReminder(c, sessions, id, threadId);
    const parent = await c.query(`UPDATE messages SET reply_count = reply_count + 1, last_reply_at = NOW()
        WHERE id = $1 RETURNING reply_count, last_reply_at, thread_closed_at`, [threadId]);
    const told = tellOwner && ownerId
        ? await notify(c, { type: 'collab', recipients: [ownerId], channelId, threadId, label: ch => `${name} has kept a thread waiting in #${ch}` })
        : [];

    const room = `channel:${channelId}`;
    return { told: told.length, events: [
        { room, event: 'Message', data: {
            id, content, authorId: null, authorUsername: null, authorBot: false, channelId, threadId,
            createdAt: new Date(inserted.rows[0].created_at).toISOString(), systemEvent: 'handoff_nudge', systemData: data,
            mentions: [botId], mentionsEveryone: false,
        } },
        { room, event: 'ThreadMetadataUpdate', data: {
            channelId, messageId: threadId, replyCount: parent.rows[0].reply_count, lastReplyAt: parent.rows[0].last_reply_at,
            threadClosedAt: parent.rows[0].thread_closed_at ?? null,
        } },
    ] };
}

/** Agent names and reasons are the agents' own text: no mentions or markup from them. */
function plain(text: string): string {
    return text.replace(/[@<>\[\]`*_\\]/g, '').slice(0, 120);
}

/** Every minute in the API process. Returns a stop function that waits for a pass in flight. */
export function startHandoffNudgeWorker(deps: HandoffNudgeDeps, intervalMs = 60_000): () => Promise<void> {
    let running: Promise<unknown> | null = null;
    const timer = setInterval(() => {
        if (running) return;
        running = runHandoffNudges(deps)
            .catch(err => deps.log?.warn({ err }, 'Handoff nudge pass failed'))
            .finally(() => { running = null; });
    }, intervalMs);
    timer.unref();
    return async () => { clearInterval(timer); await running; };
}
