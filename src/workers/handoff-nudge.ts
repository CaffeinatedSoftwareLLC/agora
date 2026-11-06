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
 * owner gets a notification. A terminal session that is neither listening nor working (idle,
 * #230: its CLI may have run out of context) does not count as reaching it: the reminder says
 * "isn't listening (idle since …)" and the owner is told.
 *
 * A reminder is Agora's own post, so the wait behind it must be one Agora trusts:
 * - Written by the agent waited on itself, by another active, unpaused bot with access to the
 *   channel, of the same owner, that took part in the thread before (a participant handing off), or by someone (a person or a bot) who
 *   could direct agents when they posted and still can. An ordinary member's WAIT or YIELD
 *   never produces one, and doesn't cancel one either: only those authors' protocol posts count.
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
/** Pages of BATCH looked at per pass. */
const MAX_PAGES = 20;

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
    /** The author is a bot that took part in the thread before this post. */
    author_participant: boolean;
}

/**
 * Waits due for a reminder, eligibility included, so ineligible waits never fill the batch.
 * $1 lookback floor (ULID), $2 due before (ms), $3 lookback (ms), $4 now (ms), $5 per-bot gap
 * (ms), $6 one thread only (the recheck) or null, $7 keyset: waits after this message id ('' for the start). Reminder times are kept in the reminder's
 * system_data (`at`, ms) so the limits use the same clock as the pass.
 */
const DUE_WAITS = `WITH latest AS (
        -- Protocol posts by bots and by people who could direct agents; an ordinary member's
        -- protocol line neither starts nor cancels a wait
        SELECT DISTINCT ON (COALESCE(m.thread_id, m.id)) COALESCE(m.thread_id, m.id) AS thread_id,
               m.id, m.channel_id, m.protocol, m.author_id, m.author_could_direct,
               COALESCE(m.edited_at, m.created_at) AS began
        FROM messages m JOIN users mu ON mu.id = m.author_id
        WHERE m.protocol IS NOT NULL AND m.id >= $1 AND m.deleted_at IS NULL
          AND (m.author_could_direct OR mu.bot)
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
           w.author_could_direct, b.id AS bot_id, b.username AS bot_username, b.bot_owner_id,
           (w.author_bot AND EXISTS (
               -- An active, unpaused bot with access here, of the same (active) owner as the target,
               -- that took part in the thread before this post: one owner's agents handing off.
               -- Another owner's bot needs to be able to direct agents here (the stamp path)
               SELECT 1 FROM bot_channel_access aa JOIN users ua ON ua.id = aa.bot_id
               LEFT JOIN users uo ON uo.id = ua.bot_owner_id
               WHERE aa.bot_id = w.author_id AND aa.channel_id = w.channel_id AND ua.bot_paused_at IS NULL
                 AND ua.account_status = 'active' AND COALESCE(uo.account_status, 'active') = 'active'
                 AND ua.bot_owner_id = b.bot_owner_id
                 AND EXISTS (SELECT 1 FROM messages y WHERE (y.thread_id = w.thread_id OR y.id = w.thread_id)
                             AND y.author_id = w.author_id AND y.id < w.id AND y.deleted_at IS NULL)
           )) AS author_participant
    FROM waits w
    JOIN messages p ON p.id = w.thread_id AND p.thread_id IS NULL AND p.deleted_at IS NULL AND p.thread_closed_at IS NULL
    JOIN users b ON lower(b.username) = lower(w.target) AND b.bot = true AND b.bot_paused_at IS NULL
        AND b.account_status = 'active'
    JOIN bot_channel_access a ON a.bot_id = b.id AND a.channel_id = w.channel_id
    WHERE w.id > $7
      AND (w.author_id = b.id OR w.author_could_direct
           OR (w.author_bot AND EXISTS (
               SELECT 1 FROM bot_channel_access aa JOIN users ua ON ua.id = aa.bot_id
               LEFT JOIN users uo ON uo.id = ua.bot_owner_id
               WHERE aa.bot_id = w.author_id AND aa.channel_id = w.channel_id AND ua.bot_paused_at IS NULL
                 AND ua.account_status = 'active' AND COALESCE(uo.account_status, 'active') = 'active'
                 AND ua.bot_owner_id = b.bot_owner_id
                 AND EXISTS (SELECT 1 FROM messages y WHERE (y.thread_id = w.thread_id OR y.id = w.thread_id)
                             AND y.author_id = w.author_id AND y.id < w.id AND y.deleted_at IS NULL))))
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
        const params = (threadId: string | null, after = '') => [ulidFloor(now - lookbackMs), now - minutes * 60_000, lookbackMs, now, minutes * 60_000, threadId, after];

        // Keyset pages, so waits that a later check in remind() turns down (a director who lost
        // the right) can't fill every batch and starve the rest
        const due: Candidate[] = [];
        for (let page = 0, after = ''; page < MAX_PAGES; page++) {
            const rows = (await c.query<Candidate>(DUE_WAITS, params(null, after))).rows;
            due.push(...rows);
            if (rows.length < BATCH) break;
            after = rows[rows.length - 1].id;
        }
        // Waits that rest on someone's authority: drop the ones whose author can't direct any
        // more before taking a lock for each (remind() checks again inside the transaction)
        const lost = new Set<string>();
        const byChannel = new Map<string, Candidate[]>();
        for (const row of due) {
            if (!needsAuthority(row)) continue;
            const list = byChannel.get(row.channel_id.trim()) ?? [];
            list.push(row); byChannel.set(row.channel_id.trim(), list);
        }
        if (byChannel.size > 0) {
            // readAuthorities switches roles under a savepoint: it needs a transaction
            await c.query('BEGIN');
            try {
                for (const [channelId, rows] of byChannel) {
                    const authority = await readAuthorities(c, channelId, rows.map(authorRow));
                    for (const row of rows) if (!authority.get(row.id.trim())) lost.add(row.id.trim());
                }
            } finally {
                await c.query('COMMIT');
            }
        }
        for (const first of due) {
            if (lost.has(first.id.trim())) continue;
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

    // Someone else's wait counts from a participant bot, or while its author can still direct agents here
    if (needsAuthority(row)) {
        const authority = await readAuthorities(c, channelId, [authorRow(row)]);
        if (!authority.get(protocolId)) return null;
    }

    // A live terminal session reaches the agent while it listens (a chat_wait open, or a Claude
    // Code Channel) or works (#230). One that does neither is idle: its CLI may have stopped (its
    // context ran out) while agora-mcp stays connected, so it counts as not reached.
    const terminal = (await c.query(
        `SELECT listening, working, idle_since FROM agent_sessions
         WHERE bot_id = $1 AND channel_id = $2 AND kind = 'terminal' AND state = 'live' LIMIT 1`,
        [botId, channelId])).rows[0];
    const idle = terminal && !terminal.listening && !terminal.working;
    const listening = terminal ? !idle : !!deps.isConnected?.(botId);
    const sessions = await reminderSessions(c, { channelId, threadId, botId });
    const reached = listening || sessions.length > 0;
    const idleSince: Date | null = idle && terminal.idle_since ? new Date(terminal.idle_since) : null;
    const ownerId = row.bot_owner_id?.trim() || null;
    const tellOwner = !reached && !!ownerId && (await c.query(`SELECT 1 FROM messages n WHERE n.system_event = 'handoff_nudge'
            AND n.id >= $1 AND n.system_data->>'waitingOnId' = $2 AND (n.system_data->>'ownerTold')::boolean
            AND (n.system_data->>'at')::double precision > $3 LIMIT 1`,
        [ulidFloor(now - OWNER_NOTICE_MINUTES * 60_000), botId, now - OWNER_NOTICE_MINUTES * 60_000])).rows.length === 0;

    const waited = Math.max(minutes, Math.round((now - new Date(row.began).getTime()) / 60_000));
    const reason = waiting.for ? ` (for: ${plain(waiting.for)})` : '';
    const content = `@${name} this thread has waited on you for ${waited} min${reason}. `
        + 'If you owe the next step, post it now. If you are still waiting on something, post STATE=WAIT '
        + `ending with [WAIT on=${name} for=<what>].${reached ? '' : idle
            // Agora sees only its own tools: an agent busy in its shell looks the same as one that stopped
            ? ` ${name} isn't listening: no chat_wait and no Agora tool call${idleSince ? ` since ${utcTime(idleSince, now)}` : ''}. `
                + `It may be busy outside Agora, or its session may have stopped${tellOwner ? '; its owner was told' : ''}.`
            : ` Agora can't reach ${name} here${tellOwner ? ', so its owner was told' : ''}.`}`;
    const data = { waitingOn: name, waitingOnId: botId, for: waiting.for, protocolMessageId: protocolId, minutes: waited, at: now, ownerTold: tellOwner,
        ...(idle && !reached ? { notListening: true, idleSince: idleSince?.toISOString() ?? null } : {}) };

    const id = generateUlid();
    const inserted = await c.query(`INSERT INTO messages (id, channel_id, author_id, content, system_event, system_data, thread_id)
        VALUES ($1, $2, NULL, $3, 'handoff_nudge', $4, $5) RETURNING created_at`,
    [id, channelId, content, JSON.stringify(data), threadId]);
    await c.query('INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, botId]);
    await queueReminder(c, sessions, id, threadId);
    const parent = await c.query(`UPDATE messages SET reply_count = reply_count + 1, last_reply_at = NOW()
        WHERE id = $1 RETURNING reply_count, last_reply_at, thread_closed_at`, [threadId]);
    const told = tellOwner && ownerId
        ? await notify(c, { type: 'collab', recipients: [ownerId], channelId, threadId, label: ch => idle
            ? `${name} isn't listening, and a thread waits on it in #${ch}`
            : `${name} has kept a thread waiting in #${ch}` })
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

/** A wait by someone other than the target and not by a participant bot rests on its author's authority. */
function needsAuthority(row: Candidate): boolean {
    return !!row.author_id && row.author_id.trim() !== row.bot_id.trim() && !row.author_participant;
}

function authorRow(row: Candidate) {
    return { id: row.id.trim(), author_id: row.author_id!.trim(), author_bot: !!row.author_bot, author_could_direct: row.author_could_direct };
}

/** "15:31 UTC", with the date in front when it is not the day of `now`. */
export function utcTime(at: Date, now: number): string {
    const iso = at.toISOString();
    const sameDay = iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10);
    return `${sameDay ? '' : `${iso.slice(0, 10)} `}${iso.slice(11, 16)} UTC`;
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
