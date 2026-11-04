import type { Pool, PoolClient } from 'pg';
import { queueReminder, reminderSessions } from '../lib/agent-sessions';
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
 * owner gets a notification, at most once an hour per bot.
 *
 * Limits, so a deploy or a hostile poster can't set off a wave:
 * - One reminder per waiting message. A new protocol message (a TURN, or a fresh WAIT saying
 *   what the agent still waits for) starts a new wait.
 * - Only waits younger than 4× the nudge time (at least an hour) are looked at, so old
 *   unfinished threads are left alone when nudges are deployed or turned back on.
 * - Only an agent that has already posted in the thread is nudged; humans never are.
 */

export const NUDGE_SETTING = 'threads.nudge_minutes';
export const DEFAULT_NUDGE_MINUTES = 15;
/** An owner hears about the same quiet bot at most this often. */
const OWNER_NOTICE_MINUTES = 60;

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
    thread_id: string; id: string; channel_id: string; protocol: ProtocolInfo; author_username: string | null; created_at: Date;
}

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

        // The newest protocol message of each open thread (a top-level protocol post is its own
        // thread), when it waits on someone and has no reminder yet. idx_messages_protocol_id
        // keeps the scan to the protocol messages of the lookback window.
        const candidates = await c.query<Candidate>(`WITH latest AS (
                SELECT DISTINCT ON (COALESCE(m.thread_id, m.id)) COALESCE(m.thread_id, m.id) AS thread_id,
                       m.id, m.channel_id, m.protocol, m.author_id, m.created_at
                FROM messages m
                WHERE m.protocol IS NOT NULL AND m.id >= $1 AND m.deleted_at IS NULL
                ORDER BY COALESCE(m.thread_id, m.id), m.id DESC
            )
            SELECT l.thread_id, l.id, l.channel_id, l.protocol, l.created_at, au.username AS author_username
            FROM latest l
            JOIN messages p ON p.id = l.thread_id AND p.thread_id IS NULL AND p.deleted_at IS NULL AND p.thread_closed_at IS NULL
            LEFT JOIN users au ON au.id = l.author_id
            WHERE l.created_at <= to_timestamp($2::double precision / 1000)
              AND (l.protocol->>'yieldTo' IS NOT NULL OR l.protocol->>'state' = 'WAIT')
              AND NOT EXISTS (SELECT 1 FROM messages n WHERE n.thread_id = l.thread_id
                  AND n.system_event = 'handoff_nudge' AND n.system_data->>'protocolMessageId' = l.id::text)
            ORDER BY l.id
            LIMIT 200`,
        [ulidFloor(now - lookbackMs), now - minutes * 60_000]);

        for (const row of candidates.rows) {
            const waiting = threadWaiting(row.protocol, row.author_username);
            if (!waiting) continue;
            const threadId = row.thread_id.trim(), protocolId = row.id.trim(), channelId = row.channel_id.trim();

            // A bot in this channel that has posted in the thread up to the waiting message,
            // and nothing since
            const bot = (await c.query(`SELECT u.id, u.username, u.bot_owner_id FROM users u
                JOIN bot_channel_access a ON a.bot_id = u.id AND a.channel_id = $2
                WHERE lower(u.username) = lower($1) AND u.bot = true
                  AND EXISTS (SELECT 1 FROM messages x WHERE (x.thread_id = $3 OR x.id = $3) AND x.author_id = u.id AND x.id <= $4)
                  AND NOT EXISTS (SELECT 1 FROM messages x WHERE (x.thread_id = $3 OR x.id = $3) AND x.author_id = u.id
                      AND x.id > $4 AND x.deleted_at IS NULL)
                LIMIT 1`, [waiting.on, channelId, threadId, protocolId])).rows[0];
            if (!bot) continue;
            const botId = bot.id.trim();

            const listening = deps.isConnected?.(botId) || (await c.query(
                `SELECT 1 FROM agent_sessions WHERE bot_id = $1 AND kind = 'terminal' AND state = 'live' LIMIT 1`, [botId])).rows.length > 0;
            const waited = Math.max(minutes, Math.round((now - new Date(row.created_at).getTime()) / 60_000));
            const reason = waiting.for ? ` (for: ${plain(waiting.for)})` : '';
            const data = { waitingOn: bot.username, waitingOnId: botId, for: waiting.for, protocolMessageId: protocolId, minutes: waited };

            await c.query('BEGIN');
            try {
                const id = generateUlid();
                const sessions = await reminderSessions(c, { channelId, threadId, botId });
                const reached = listening || sessions.length > 0;
                const content = `@${bot.username} this thread has waited on you for ${waited} min${reason}. `
                    + 'If you owe the next step, post it now. If you are still waiting on something, post STATE=WAIT '
                    + `ending with [WAIT on=${bot.username} for=<what>].${reached ? '' : ` Agora can't reach ${bot.username} here, so its owner was told.`}`;
                const inserted = await c.query(`INSERT INTO messages (id, channel_id, author_id, content, system_event, system_data, thread_id)
                    VALUES ($1, $2, NULL, $3, 'handoff_nudge', $4, $5) RETURNING created_at`,
                [id, channelId, content, JSON.stringify(data), threadId]);
                await c.query('INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, botId]);
                await queueReminder(c, sessions, id, threadId);
                const parent = await c.query(`UPDATE messages SET reply_count = reply_count + 1, last_reply_at = NOW()
                    WHERE id = $1 RETURNING reply_count, last_reply_at`, [threadId]);
                let told: string[] = [];
                const owner = bot.bot_owner_id?.trim();
                if (!reached && owner) {
                    const label = `${bot.username} has kept a thread waiting`;
                    const recent = await c.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'collab'
                        AND left(label, $2) = $3 AND created_at > NOW() - make_interval(mins => $4) LIMIT 1`,
                    [owner, label.length, label, OWNER_NOTICE_MINUTES]);
                    if (recent.rows.length === 0) {
                        told = await notify(c, { type: 'collab', recipients: [owner], channelId, threadId, label: ch => `${label} in #${ch}` });
                    }
                }
                await c.query('COMMIT');
                nudged++; ownersNotified += told.length;
                const room = `channel:${channelId}`;
                events.push({ room, event: 'Message', data: {
                    id, content, authorId: null, authorUsername: null, authorBot: false, channelId, threadId,
                    createdAt: new Date(inserted.rows[0].created_at).toISOString(), systemEvent: 'handoff_nudge', systemData: data,
                    mentions: [botId], mentionsEveryone: false,
                } });
                events.push({ room, event: 'ThreadMetadataUpdate', data: {
                    channelId, messageId: threadId, replyCount: parent.rows[0].reply_count, lastReplyAt: parent.rows[0].last_reply_at, threadClosedAt: null,
                } });
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
