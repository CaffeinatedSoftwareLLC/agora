import { generateUlid } from '../utils/ulid';
import { postNotice, threadReplyCounted, type Notice } from './agent-runs';
import { canViewChannel } from './channel-access';
import { noticePathList } from './file-reservations';
import { PLAN_OWNER_SQL, planNotice } from './provider-terms';

/**
 * Ownership handoffs between agents (#84, docs/agent-sessions.md "Handoffs").
 *
 * YIELD passes the turn; a handoff passes the task. An agent with a live session offers a
 * thread's task to another live agent (handoff_offer). The offer pins the sender's last
 * committed `branch @ sha` (the head Agora committed at the end of its latest finished run,
 * never uncommitted edits) and its active reservations, posts a card in the thread and wakes
 * the recipient. Only the recipient can accept (handoff_accept) or decline; the sender, the
 * owner and directors can cancel. Accepting makes the recipient's session the thread's task
 * owner and moves the reservations to it with a fresh TTL, in one transaction.
 *
 * Plan-owned recipients ('subscription', 'siwc') take a handoff only inside work their plan
 * owner started: both sessions started by that owner (the agent-to-agent rule in
 * agent-sessions.ts termsAllow).
 *
 * Everything here runs as the service role inside the request's transaction (asService).
 */

export const HANDOFF_TTL_DEFAULT = 1800;
export const HANDOFF_TTL_MAX = 86400;
/** Fresh TTL for reservations moved to the recipient (the reservation default). */
export const TRANSFER_TTL = 900;

export class HandoffError extends Error {
    constructor(public status: number, public body: Record<string, unknown>) { super(String(body.error)); }
}
const fail = (status: number, error: string, message?: string): never => {
    throw new HandoffError(status, message ? { error, message } : { error });
};

export type HandoffStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';

interface Offer {
    id: string; serverId: string; channelId: string; threadId: string; messageId: string | null;
    fromSessionId: string; toSessionId: string; fromBotId: string; toBotId: string;
    from: string; to: string; summary: string; workspaceId: string;
    branch: string | null; headSha: string | null; senderRunning: boolean;
    reservationIds: string[]; transferredIds: string[]; paths: string[];
    status: HandoffStatus; reason: string | null; resolvedBy: string | null;
    createdAt: string; expiresAt: string; resolvedAt: string | null;
}

const OFFER_SELECT = `SELECT h.*, fu.username AS from_name, tu.username AS to_name,
        COALESCE((SELECT array_agg(DISTINCT p ORDER BY p) FROM agent_file_reservations r, unnest(r.paths) p
                  WHERE r.id = ANY(CASE WHEN h.status = 'accepted' THEN h.transferred_ids ELSE h.reservation_ids END)), '{}') AS paths
    FROM agent_handoffs h JOIN users fu ON fu.id = h.from_bot_id JOIN users tu ON tu.id = h.to_bot_id`;

function offerJson(r: any): Offer {
    const t = (v: any) => (v == null ? null : String(v).trim());
    return {
        id: r.id.trim(), serverId: r.server_id.trim(), channelId: r.channel_id.trim(), threadId: r.thread_id.trim(),
        messageId: t(r.message_id), fromSessionId: r.from_session_id.trim(), toSessionId: r.to_session_id.trim(),
        fromBotId: r.from_bot_id.trim(), toBotId: r.to_bot_id.trim(), from: r.from_name, to: r.to_name,
        summary: r.summary, workspaceId: r.workspace_id, branch: r.branch ?? null, headSha: r.head_sha ?? null,
        senderRunning: !!r.sender_running,
        reservationIds: (r.reservation_ids ?? []).map((x: string) => x.trim()),
        transferredIds: (r.transferred_ids ?? []).map((x: string) => x.trim()),
        paths: r.paths ?? [], status: r.status, reason: r.reason ?? null, resolvedBy: t(r.resolved_by),
        createdAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(),
        resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    };
}

async function readOffer(db: any, id: string, lock = false): Promise<Offer | null> {
    if (lock) await db.query('SELECT 1 FROM agent_handoffs WHERE id = $1 FOR UPDATE', [id]);
    const row = (await db.query(`${OFFER_SELECT} WHERE h.id = $1`, [id])).rows[0];
    return row ? offerJson(row) : null;
}

/** `branch @ sha` as people read it: 12 characters of the sha. */
export function codeRef(branch: string | null, headSha: string | null): string | null {
    return branch && headSha ? `${branch}@${headSha.slice(0, 12)}` : null;
}

const STATUS_LINE: Record<HandoffStatus, (o: Offer, by?: string) => string> = {
    pending: o => `${o.to}: accept with handoff_accept or decline with handoff_decline (offer ${o.id}). Expires ${o.expiresAt}.`,
    accepted: o => `Accepted: ${o.to} now owns this.`,
    declined: o => `Declined by ${o.to}${o.reason ? `: ${o.reason}` : '.'}`,
    expired: () => 'Expired without an answer.',
    cancelled: (_o, by) => `Cancelled${by ? ` by ${by}` : ''}.`,
};

/** The offer card's text. It is what the recipient's wake shows, so it carries the branch and sha. */
export function offerContent(o: Offer, by?: string): string {
    const code = o.branch && o.headSha
        ? `Code: ${o.branch} @ ${o.headSha} — the last commit Agora made at the end of ${o.from}'s finished turn.`
            + (o.senderRunning ? ` ${o.from} was mid-turn: edits from that turn are not in this commit.` : '')
            + ' Read it with git in your own worktree (git diff HEAD...<sha>); never write to the sender\'s worktree.'
        : `Code: no committed branch yet (${o.from} has no finished hosted turn).`;
    const paths = o.paths.length ? `Reservations that move with it: ${noticePathList(o.paths, ', ', 1200)}` : 'Reservations that move with it: none.';
    return [`[HANDOFF offer=${o.id} to=${o.to}]`, `${o.from} offers ${o.to} ownership of this thread's task.`,
        o.summary, code, paths, STATUS_LINE[o.status](o, by)].join('\n');
}

function cardData(o: Offer) {
    return { kind: 'agent_handoff', offerId: o.id, status: o.status, from: o.from, to: o.to,
        branch: o.branch, headSha: o.headSha, senderRunning: o.senderRunning, paths: o.paths, expiresAt: o.expiresAt, reason: o.reason };
}

/** Rewrite the card for a new status and queue its MessageUpdate. */
async function updateCard(db: any, o: Offer, notices: Notice[], by?: string) {
    if (!o.messageId) return;
    const content = offerContent(o, by);
    const updated = await db.query(
        `UPDATE messages SET content = $2, system_data = $3::jsonb, edited_at = NOW() WHERE id = $1 RETURNING system_data, edited_at`,
        [o.messageId, content, JSON.stringify(cardData(o))]
    );
    if (updated.rows[0]) notices.push({ channelId: o.channelId, eventName: 'MessageUpdate',
        event: { id: o.messageId, channelId: o.channelId, threadId: o.threadId, content, editedAt: updated.rows[0].edited_at, systemData: updated.rows[0].system_data } });
}

async function threadNotice(db: any, o: { channelId: string; threadId: string }, content: string, notices: Notice[]): Promise<Notice> {
    const notice = await postNotice(db, o.channelId, content, o.threadId);
    notices.push(notice, await threadReplyCounted(db, o.channelId, o.threadId));
    return notice;
}

/** Mark pending offers past their expiry as expired (in a thread, or one offer). */
export async function expireStale(db: any, where: { threadId?: string; offerId?: string }, notices: Notice[]): Promise<void> {
    const rows = await db.query(
        `UPDATE agent_handoffs SET status = 'expired', resolved_at = NOW()
         WHERE status = 'pending' AND expires_at <= clock_timestamp()
           AND ($1::text IS NULL OR thread_id = $1) AND ($2::text IS NULL OR id = $2)
         RETURNING id`,
        [where.threadId ?? null, where.offerId ?? null]
    );
    for (const r of rows.rows) {
        const o = await readOffer(db, r.id.trim());
        if (!o) continue;
        await updateCard(db, o, notices);
        // A queued wake for a dead offer is dropped
        if (o.messageId) await db.query(`UPDATE agent_inbox SET acked_at = NOW() WHERE message_id = $1 AND batch_id IS NULL AND acked_at IS NULL`, [o.messageId]);
    }
}

/** The thread must be a live top-level message in this channel. */
async function checkThread(db: any, channelId: string, threadId: string, open: boolean) {
    const row = (await db.query(
        `SELECT thread_closed_at FROM messages WHERE id = $1 AND channel_id = $2 AND thread_id IS NULL AND deleted_at IS NULL`,
        [threadId, channelId]
    )).rows[0];
    if (!row) fail(404, 'thread_not_found');
    if (open && row.thread_closed_at) fail(409, 'thread_closed');
}

/**
 * The caller's session for this thread: the hosted one running now, else its terminal
 * session, else its session scoped to this thread, else its channel session.
 */
async function senderSession(db: any, botId: string, channelId: string, threadId: string) {
    const row = (await db.query(
        `SELECT s.* FROM agent_sessions s
         WHERE s.bot_id = $1 AND s.channel_id = $2 AND s.state = 'live' AND (s.thread_id IS NULL OR s.thread_id = $3)
         ORDER BY EXISTS (SELECT 1 FROM agent_runs r WHERE r.session_id = s.id AND r.status = 'claimed') DESC,
                  (s.kind = 'terminal') DESC, (s.thread_id IS NOT NULL) DESC, s.id
         LIMIT 1 FOR UPDATE OF s`,
        [botId, channelId, threadId]
    )).rows[0];
    return row ?? fail(409, 'no_live_session', 'You need a live session in this channel to offer a handoff.');
}

/**
 * The recipient's session for this thread: its session scoped to the thread, else its live
 * terminal session (its hosted channel session takes no wakes meanwhile), else its channel session.
 */
async function recipientSession(db: any, botId: string, channelId: string, threadId: string) {
    return (await db.query(
        `SELECT s.* FROM agent_sessions s
         WHERE s.bot_id = $1 AND s.channel_id = $2 AND s.state = 'live' AND (s.thread_id IS NULL OR s.thread_id = $3)
         ORDER BY (s.thread_id IS NOT NULL) DESC, (s.kind = 'terminal') DESC, s.id
         LIMIT 1`,
        [botId, channelId, threadId]
    )).rows[0] ?? null;
}

/** The recipient named by username or profile name, a bot on this server other than the sender. */
async function resolveRecipient(db: any, serverId: string, name: string, senderBot: string) {
    const wanted = name.trim().replace(/^@/, '').toLowerCase();
    const row = (await db.query(
        `SELECT u.id, u.username FROM users u
         WHERE u.bot = true AND u.id <> $3 AND (
             lower(u.username) = $2
             OR EXISTS (SELECT 1 FROM agent_profiles p WHERE p.bot_id = u.id AND p.server_id = $1 AND lower(p.name) = $2))
           AND (EXISTS (SELECT 1 FROM agent_profiles p WHERE p.bot_id = u.id AND p.server_id = $1)
                OR EXISTS (SELECT 1 FROM server_members m WHERE m.user_id = u.id AND m.server_id = $1))
         ORDER BY (lower(u.username) = $2) DESC, u.id LIMIT 1`,
        [serverId, wanted, senderBot]
    )).rows[0];
    return row ? { id: row.id.trim(), username: row.username as string } : fail(404, 'recipient_not_found', `No other agent named ${name} on this server.`);
}

/**
 * The plan-owner rule for a handoff: a recipient on a personal plan takes it only when both
 * sessions were started (or last resumed) by that plan's owner. Returns the refusal, or null.
 */
async function planRefusal(db: any, fromSessionId: string, toSessionId: string): Promise<HandoffError | null> {
    const row = (await db.query(
        `SELECT t.kind, p.name AS profile_name, p.auth_mode, ${PLAN_OWNER_SQL} AS plan_owner_id,
                t.started_by AS to_started_by, f.started_by AS from_started_by
         FROM agent_sessions t
         LEFT JOIN agent_profiles p ON p.id = t.profile_id
         JOIN servers srv ON srv.id = t.server_id
         JOIN agent_sessions f ON f.id = $2
         WHERE t.id = $1`,
        [toSessionId, fromSessionId]
    )).rows[0];
    // A terminal recipient is its user's own CLI: nothing here starts a run on anyone's plan
    if (!row || row.kind !== 'hosted' || row.auth_mode === 'api_key') return null;
    const owner = row.plan_owner_id?.trim() ?? null;
    if (owner && row.to_started_by?.trim() === owner && row.from_started_by?.trim() === owner) return null;
    return new HandoffError(403, { error: 'plan_owner_only',
        message: `${planNotice(row.profile_name, row.auth_mode, !!owner)} A handoff reaches it only inside work its plan owner started.` });
}

/** Branch and head of the sender's latest finished run (falls back to the session's record). */
async function committedHead(db: any, session: any) {
    const run = (await db.query(
        `SELECT branch, head_sha FROM agent_runs WHERE session_id = $1 AND status = 'succeeded' AND head_sha IS NOT NULL
         ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1`,
        [session.id]
    )).rows[0];
    const running = (await db.query(`SELECT 1 FROM agent_runs WHERE session_id = $1 AND status = 'claimed' LIMIT 1`, [session.id])).rows.length > 0;
    return { branch: run?.branch ?? session.branch ?? null, headSha: run?.head_sha ?? session.head_sha ?? null, running };
}

export interface OfferInput { threadId: string; to: string; summary: string; ttlSeconds?: number }

export async function createOffer(db: any, botId: string, channelId: string, input: OfferInput, notices: Notice[]): Promise<Offer> {
    const threadId = input.threadId;
    await checkThread(db, channelId, threadId, true);
    const sender = await senderSession(db, botId, channelId, threadId);
    const serverId = sender.server_id.trim();
    const recipient = await resolveRecipient(db, serverId, input.to, botId);
    if (!(await canViewChannel(db, channelId, recipient.id, true)).allowed) {
        fail(403, 'recipient_cannot_see_thread', `${recipient.username} has no access to this channel, so it can't see the thread.`);
    }
    const target = await recipientSession(db, recipient.id, channelId, threadId);
    if (!target) fail(409, 'recipient_not_live', `${recipient.username} has no live session in this channel. Ask the owner or a director to /start it first.`);
    const refusal = await planRefusal(db, sender.id, target.id);
    if (refusal) throw refusal;
    const owner = (await db.query('SELECT bot_id FROM agent_thread_owners WHERE thread_id = $1', [threadId])).rows[0];
    if (owner && owner.bot_id.trim() !== botId) fail(403, 'not_task_owner', 'Another agent owns this thread\'s task; only its owner can hand it off.');

    await expireStale(db, { threadId }, notices);
    // The partial unique index also serializes two concurrent offers in one thread
    const pending = (await db.query(`SELECT id FROM agent_handoffs WHERE thread_id = $1 AND status = 'pending'`, [threadId])).rows[0];
    if (pending) throw new HandoffError(409, { error: 'offer_pending', offerId: pending.id.trim(), message: 'This thread already has an open handoff offer; wait for it or cancel it.' });

    const head = await committedHead(db, sender);
    const reservations = (await db.query(
        `SELECT id FROM agent_file_reservations WHERE session_id = $1 AND server_id = $2 AND workspace_id = $3
           AND released_at IS NULL AND expires_at > clock_timestamp() ORDER BY id`,
        [sender.id, serverId, sender.workspace_id]
    )).rows.map((r: any) => r.id.trim());
    const id = generateUlid();
    const ttl = Math.min(Math.max(input.ttlSeconds ?? HANDOFF_TTL_DEFAULT, 60), HANDOFF_TTL_MAX);
    await db.query(
        `INSERT INTO agent_handoffs (id, server_id, channel_id, thread_id, from_session_id, to_session_id, from_bot_id, to_bot_id,
             summary, workspace_id, branch, head_sha, sender_running, reservation_ids, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, clock_timestamp() + $15 * interval '1 second')`,
        [id, serverId, channelId, threadId, sender.id, target.id, botId, recipient.id, input.summary.trim(), sender.workspace_id,
            head.branch, head.headSha, head.running, reservations, ttl]
    );
    let offer = (await readOffer(db, id))!;
    // The card is the sender's own post in the thread: a hand-off between agents, as YIELD is
    const messageId = generateUlid();
    const content = offerContent(offer);
    await db.query(
        `INSERT INTO messages (id, channel_id, author_id, content, thread_id, author_could_direct, system_event, system_data)
         VALUES ($1, $2, $3, $4, $5, false, 'agent_handoff', $6)`,
        [messageId, channelId, botId, content, threadId, JSON.stringify(cardData(offer))]
    );
    await db.query('UPDATE agent_handoffs SET message_id = $2 WHERE id = $1', [id, messageId]);
    offer = { ...offer, messageId };
    const author = (await db.query('SELECT username, avatar_url FROM users WHERE id = $1', [botId])).rows[0];
    notices.push({ channelId: channelId.trim(), event: {
        id: messageId, content, authorId: botId, authorUsername: author?.username ?? null, authorBot: true,
        authorAvatarUrl: author?.avatar_url ?? null, authorAuthority: null, channelId: channelId.trim(), threadId,
        createdAt: new Date().toISOString(), mentions: [], mentionsEveryone: false, systemEvent: 'agent_handoff', systemData: cardData(offer),
    } });
    notices.push(await threadReplyCounted(db, channelId, threadId));
    // Wake the recipient (a terminal agent reads the thread itself)
    if (target.kind === 'hosted') {
        await db.query(
            `INSERT INTO agent_inbox (id, session_id, message_id, thread_id, reason) VALUES ($1, $2, $3, $4, 'handoff')
             ON CONFLICT (session_id, message_id) DO NOTHING`,
            [generateUlid(), target.id, messageId, threadId]
        );
    }
    return offer;
}

async function lockWorkspace(db: any, serverId: string, workspaceId: string) {
    // Same key as the reservation routes: serializes with reserves in that workspace
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${serverId.trim()}:${workspaceId}`]);
}

/** Lock both sessions (ID order, as everywhere), then the offer, and read it under the lock. */
async function lockOffer(db: any, offerId: string, channelId: string): Promise<Offer> {
    const found = (await db.query('SELECT from_session_id, to_session_id FROM agent_handoffs WHERE id = $1 AND channel_id = $2', [offerId, channelId])).rows[0];
    if (!found) fail(404, 'offer_not_found');
    await db.query('SELECT 1 FROM agent_sessions WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[found.from_session_id, found.to_session_id].sort()]);
    return (await readOffer(db, offerId, true))!;
}

export interface AcceptResult { offer: Offer; alreadyAccepted: boolean; transferred: string[]; skipped: string[] }

/** Resolves to a HandoffError (rather than throwing it) for an expired offer, so the expiry commits. */
export async function acceptOffer(db: any, botId: string, channelId: string, offerId: string, notices: Notice[]): Promise<AcceptResult | HandoffError> {
    const peek = (await db.query('SELECT to_bot_id FROM agent_handoffs WHERE id = $1 AND channel_id = $2', [offerId, channelId])).rows[0];
    if (!peek) fail(404, 'offer_not_found');
    if (peek.to_bot_id.trim() !== botId) fail(403, 'not_recipient', 'Only the agent the offer names can accept it.');
    let offer = await lockOffer(db, offerId, channelId);
    // Idempotent: a repeated or concurrent accept by the recipient gets the same answer
    if (offer.status === 'accepted') return { offer, alreadyAccepted: true, transferred: offer.transferredIds, skipped: [] };
    if (offer.status !== 'pending') fail(409, `offer_${offer.status}`);
    if (Date.parse(offer.expiresAt) <= Date.now() || (await db.query(`SELECT 1 FROM agent_handoffs WHERE id = $1 AND expires_at <= clock_timestamp()`, [offerId])).rows.length) {
        // Returned, not thrown: the expiry and its card update must commit with the refusal
        await expireStale(db, { offerId }, notices);
        return new HandoffError(410, { error: 'offer_expired' });
    }
    // Recheck everything the offer relied on, under the locks
    const sessions = (await db.query(`SELECT id, state, server_id, workspace_id FROM agent_sessions WHERE id = ANY($1)`, [[offer.fromSessionId, offer.toSessionId]])).rows;
    const to = sessions.find((s: any) => s.id.trim() === offer.toSessionId);
    if (!to || to.state !== 'live') fail(409, 'recipient_session_ended', 'Your session that the offer names has ended; ask for a new offer.');
    await checkThread(db, channelId, offer.threadId, true);
    if (!(await canViewChannel(db, channelId, botId, true)).allowed) fail(403, 'forbidden');
    if (!(await canViewChannel(db, channelId, offer.fromBotId, true)).allowed) fail(409, 'sender_lost_access', `${offer.from} no longer has access to this channel.`);
    const refusal = await planRefusal(db, offer.fromSessionId, offer.toSessionId);
    if (refusal) throw refusal;
    const owner = (await db.query('SELECT bot_id FROM agent_thread_owners WHERE thread_id = $1 FOR UPDATE', [offer.threadId])).rows[0];
    if (owner && owner.bot_id.trim() !== offer.fromBotId) fail(409, 'owner_changed', 'The thread\'s task changed owner after this offer was made.');

    // Move the sender's reservations that are still its own and active, in the recipient's workspace
    const sameWorkspace = to.server_id.trim() === offer.serverId && to.workspace_id === offer.workspaceId;
    let transferred: string[] = [];
    if (sameWorkspace && offer.reservationIds.length) {
        await lockWorkspace(db, offer.serverId, offer.workspaceId);
        transferred = (await db.query(
            `UPDATE agent_file_reservations SET session_id = $3, expires_at = clock_timestamp() + $4 * interval '1 second'
             WHERE id = ANY($1) AND session_id = $2 AND released_at IS NULL AND expires_at > clock_timestamp()
             RETURNING id`,
            [offer.reservationIds, offer.fromSessionId, offer.toSessionId, TRANSFER_TTL]
        )).rows.map((r: any) => r.id.trim());
    }
    const skipped = offer.reservationIds.filter(id => !transferred.includes(id));

    await db.query(
        `INSERT INTO agent_thread_owners (thread_id, server_id, channel_id, session_id, bot_id, handoff_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (thread_id) DO UPDATE SET session_id = EXCLUDED.session_id, bot_id = EXCLUDED.bot_id,
             handoff_id = EXCLUDED.handoff_id, since = NOW()`,
        [offer.threadId, offer.serverId, channelId, offer.toSessionId, botId, offerId]
    );
    await db.query(
        `UPDATE agent_handoffs SET status = 'accepted', resolved_at = NOW(), resolved_by = $2, transferred_ids = $3 WHERE id = $1`,
        [offerId, botId, transferred]
    );
    offer = (await readOffer(db, offerId))!;
    await updateCard(db, offer, notices);
    const ref = codeRef(offer.branch, offer.headSha);
    const moved = offer.paths.length ? ` Reservations moved to ${offer.to} for ${TRANSFER_TTL / 60} minutes: ${noticePathList(offer.paths, ', ', 1500)}.` : '';
    const notMoved = skipped.length ? ` ${skipped.length} reservation${skipped.length === 1 ? '' : 's'} had expired, been released or ${sameWorkspace ? 'changed holder' : 'belong to another workspace'} and stayed put.` : '';
    await threadNotice(db, offer, `${offer.to} now owns this (from ${offer.from}${ref ? ` @ ${ref}` : ''}).${moved}${notMoved}`, notices);
    return { offer, alreadyAccepted: false, transferred, skipped };
}

export async function declineOffer(db: any, botId: string, channelId: string, offerId: string, reason: string | undefined, notices: Notice[]): Promise<Offer> {
    const peek = (await db.query('SELECT to_bot_id FROM agent_handoffs WHERE id = $1 AND channel_id = $2', [offerId, channelId])).rows[0];
    if (!peek) fail(404, 'offer_not_found');
    if (peek.to_bot_id.trim() !== botId) fail(403, 'not_recipient', 'Only the agent the offer names can decline it.');
    let offer = await lockOffer(db, offerId, channelId);
    if (offer.status === 'declined') return offer;
    if (offer.status !== 'pending') fail(409, `offer_${offer.status}`);
    await db.query(`UPDATE agent_handoffs SET status = 'declined', reason = $3, resolved_at = NOW(), resolved_by = $2 WHERE id = $1`,
        [offerId, botId, reason?.trim() || null]);
    offer = (await readOffer(db, offerId))!;
    await updateCard(db, offer, notices);
    const notice = await threadNotice(db, offer, `${offer.to} declined the handoff from ${offer.from}${offer.reason ? `: ${offer.reason}` : '.'} ${offer.from} still owns the work.`, notices);
    // Tell the sender (as a force-release does): the server's notice, valid for any plan
    await db.query(
        `INSERT INTO agent_inbox (id, session_id, message_id, thread_id, reason)
         SELECT $1, id, $2, $3, 'command' FROM agent_sessions WHERE id = $4 AND state = 'live' AND kind = 'hosted'
         ON CONFLICT (session_id, message_id) DO NOTHING`,
        [generateUlid(), notice.event.id, offer.threadId, offer.fromSessionId]
    );
    return offer;
}

/** Cancel a pending offer: its sender, or the owner or a director (`canDirect`). */
export async function cancelOffer(db: any, userId: string, isBot: boolean, canDirect: boolean, channelId: string, offerId: string, notices: Notice[]): Promise<Offer> {
    const peek = (await db.query('SELECT from_bot_id FROM agent_handoffs WHERE id = $1 AND channel_id = $2', [offerId, channelId])).rows[0];
    if (!peek) fail(404, 'offer_not_found');
    const isSender = isBot && peek.from_bot_id.trim() === userId;
    if (!isSender && !canDirect) fail(403, 'cannot_cancel', 'Only the agent that made the offer, the owner or a director can cancel it.');
    let offer = await lockOffer(db, offerId, channelId);
    if (offer.status === 'cancelled') return offer;
    if (offer.status !== 'pending') fail(409, `offer_${offer.status}`);
    await db.query(`UPDATE agent_handoffs SET status = 'cancelled', resolved_at = NOW(), resolved_by = $2 WHERE id = $1`, [offerId, userId]);
    if (offer.messageId) await db.query(`UPDATE agent_inbox SET acked_at = NOW() WHERE message_id = $1 AND batch_id IS NULL AND acked_at IS NULL`, [offer.messageId]);
    offer = (await readOffer(db, offerId))!;
    const by = (await db.query('SELECT username FROM users WHERE id = $1', [userId])).rows[0]?.username as string | undefined;
    await updateCard(db, offer, notices, by);
    await threadNotice(db, offer, `${by ?? 'Someone'} cancelled the handoff from ${offer.from} to ${offer.to}.`, notices);
    return offer;
}

/** A thread's task owner and its offers, newest first. Expires stale offers on the way. */
export async function threadHandoffs(db: any, channelId: string, threadId: string, notices: Notice[]) {
    await checkThread(db, channelId, threadId, false);
    await expireStale(db, { threadId }, notices);
    const owner = (await db.query(
        `SELECT o.session_id, o.bot_id, o.since, o.handoff_id, u.username, s.state, h.branch, h.head_sha, fu.username AS from_name
         FROM agent_thread_owners o JOIN users u ON u.id = o.bot_id JOIN agent_sessions s ON s.id = o.session_id
         LEFT JOIN agent_handoffs h ON h.id = o.handoff_id LEFT JOIN users fu ON fu.id = h.from_bot_id
         WHERE o.thread_id = $1`,
        [threadId]
    )).rows[0];
    const offers = (await db.query(`${OFFER_SELECT} WHERE h.thread_id = $1 ORDER BY h.created_at DESC, h.id DESC LIMIT 20`, [threadId])).rows.map(offerJson);
    return {
        owner: owner ? { sessionId: owner.session_id.trim(), botId: owner.bot_id.trim(), username: owner.username, sessionState: owner.state,
            since: new Date(owner.since).toISOString(), handoffId: owner.handoff_id?.trim() ?? null,
            from: owner.from_name ?? null, branch: owner.branch ?? null, headSha: owner.head_sha ?? null } : null,
        offers,
    };
}

/**
 * What a claim tells the host about handoffs (agora-host prompt.ts): the offers in this batch
 * addressed to the session, and the handoffs that made it the owner of a thread in the batch.
 */
export async function claimHandoffs(c: any, sessionId: string, messageIds: string[], threadIds: string[]) {
    if (!messageIds.length && !threadIds.length) return [];
    const rows = (await c.query(
        `${OFFER_SELECT}
         WHERE (h.to_session_id = $1 AND h.status = 'pending' AND h.expires_at > clock_timestamp() AND h.message_id = ANY($2))
            OR (h.status = 'accepted' AND h.thread_id = ANY($3)
                AND EXISTS (SELECT 1 FROM agent_thread_owners o WHERE o.thread_id = h.thread_id AND o.handoff_id = h.id AND o.session_id = $1))
         ORDER BY h.created_at DESC LIMIT 5`,
        [sessionId, messageIds, threadIds]
    )).rows.map(offerJson);
    return rows.map((o: Offer) => ({ offerId: o.id, threadId: o.threadId, from: o.from, status: o.status as 'pending' | 'accepted',
        branch: o.branch, headSha: o.headSha, senderRunning: o.senderRunning }));
}
