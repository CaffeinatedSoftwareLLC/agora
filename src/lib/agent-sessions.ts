import { generateUlid } from '../utils/ulid';
import type { ProtocolInfo } from './protocol';

/**
 * Agent sessions: which posts wake which agent (docs/planning/agent-sessions-wbs.md,
 * "Wake routing"). Called by the message routes inside the request's transaction, right
 * after the INSERT, so a wake is recorded exactly when its message commits.
 *
 * Inbox rows are only written for sessions that are live in the message's channel:
 * - a top-level post from someone who can direct, mentioning the agent (or with only one
 *   agent live in the channel) → 'direct';
 * - a top-level START from an agent with a live session binds a collaboration thread and
 *   wakes the other participants → 'protocol';
 * - in a bound thread, protocol messages from participants hand off (YIELD, ACK, DECIDE),
 *   and messages from someone who can direct reach every participant.
 * Nothing else wakes an agent: other bots' chatter, unbound threads and system notices.
 *
 * Members can read sessions through RLS but can't write them, so the writes here run as
 * the service role on the request's own connection.
 */

export interface RoutedMessage {
    channelId: string;
    messageId: string;
    /** Thread parent for a reply, null for a top-level post. */
    threadId: string | null;
    authorId: string;
    /** The author's authority stamp, taken in this transaction (stampAuthority). */
    couldDirect: boolean;
    protocol: ProtocolInfo | null;
    /** Users the post @mentions (resolveMentions). */
    mentionedUserIds: string[];
}

interface LiveSession {
    id: string;
    botId: string;
    names: string[];
}

/**
 * Run `fn` as the service role (no RLS) on the request's connection and put the request's
 * role back. Errors roll back to the savepoint and propagate: a wake that can't be recorded
 * must not commit silently.
 */
export async function asService<T>(client: any, fn: () => Promise<T>): Promise<T> {
    const role = (await client.query('SELECT current_user AS role')).rows[0].role as string;
    await client.query('SAVEPOINT agent_sessions_write');
    try {
        await client.query('SET LOCAL ROLE NONE');
        const result = await fn();
        await client.query(`SET LOCAL ROLE "${role.split('"').join('""')}"`);
        await client.query('RELEASE SAVEPOINT agent_sessions_write');
        return result;
    } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT agent_sessions_write');
        await client.query('RELEASE SAVEPOINT agent_sessions_write');
        throw err;
    }
}

/** Live sessions in a channel, with the names a START or YIELD may use for each agent. */
async function liveSessions(db: any, channelId: string): Promise<LiveSession[]> {
    const rows = await db.query(
        `SELECT s.id, s.bot_id, u.username, p.name AS profile_name
         FROM agent_sessions s
         JOIN users u ON u.id = s.bot_id
         JOIN agent_profiles p ON p.id = s.profile_id
         WHERE s.channel_id = $1 AND s.state = 'live'`,
        [channelId]
    );
    return rows.rows.map((r: any) => ({
        id: r.id.trim(),
        botId: r.bot_id.trim(),
        names: [String(r.username).toLowerCase(), String(r.profile_name).toLowerCase()],
    }));
}

function byName(sessions: LiveSession[], name: string): LiveSession | undefined {
    const wanted = name.toLowerCase().replace(/^@/, '');
    return sessions.find(s => s.names.includes(wanted));
}

async function addInbox(db: any, sessionIds: string[], messageId: string, threadId: string | null, reason: 'direct' | 'handoff' | 'protocol'): Promise<void> {
    for (const sessionId of new Set(sessionIds)) {
        await db.query(
            `INSERT INTO agent_inbox (id, session_id, message_id, thread_id, reason)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (session_id, message_id) DO NOTHING`,
            [generateUlid(), sessionId, messageId, threadId, reason]
        );
    }
}

/**
 * Close a bound thread: its unclaimed inbox rows are acknowledged without work. With
 * `cancel`, runs in progress for its participants are asked to stop.
 */
async function closeThread(db: any, threadId: string, sessionIds: string[], cancel: boolean): Promise<void> {
    await db.query(
        `UPDATE agent_session_threads SET state = 'closed', closed_at = NOW() WHERE thread_id = $1`,
        [threadId]
    );
    await db.query(
        `UPDATE agent_inbox SET acked_at = NOW()
         WHERE thread_id = $1 AND batch_id IS NULL AND acked_at IS NULL`,
        [threadId]
    );
    if (cancel && sessionIds.length > 0) {
        await db.query(
            `UPDATE agent_runs SET cancel_requested = true, cancel_reason = 'thread_cancelled'
             WHERE session_id = ANY($1) AND status = 'claimed'`,
            [sessionIds]
        );
    }
}

/** Record the wakes a newly inserted message causes. */
export async function routeMessage(db: any, msg: RoutedMessage): Promise<void> {
    // Cheap check first: most channels have no agent sessions
    const any: { rows: unknown[] } = await asService(db, () => db.query(
        `SELECT 1 FROM agent_sessions WHERE channel_id = $1 AND state = 'live' LIMIT 1`,
        [msg.channelId]
    ));
    if (any.rows.length === 0) return;

    await asService(db, async () => {
        const sessions = await liveSessions(db, msg.channelId);
        const authorId = msg.authorId.trim();
        const authorSession = sessions.find(s => s.botId === authorId);

        if (msg.threadId === null) {
            await routeTopLevel(db, msg, sessions, authorSession);
        } else {
            await routeThreadReply(db, msg, sessions, authorId);
        }
    });
}

async function routeTopLevel(db: any, msg: RoutedMessage, sessions: LiveSession[], authorSession: LiveSession | undefined): Promise<void> {
    // An agent with a live session opens a collaboration thread
    if (authorSession && msg.protocol?.state === 'START') {
        const peers = (msg.protocol.participants ?? [])
            .map(name => byName(sessions, name))
            .filter((s): s is LiveSession => !!s && s.id !== authorSession.id);
        const peerIds = [...new Set(peers.map(p => p.id))];
        if (peerIds.length === 0) return;
        await db.query(
            `INSERT INTO agent_session_threads (thread_id, channel_id, initiator_session_id, session_ids)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (thread_id) DO NOTHING`,
            [msg.messageId, msg.channelId, authorSession.id, [authorSession.id, ...peerIds]]
        );
        await addInbox(db, peerIds, msg.messageId, msg.messageId, 'protocol');
        return;
    }

    // Someone who can direct addresses an agent: by @mention, or the only agent here
    if (!msg.couldDirect) return;
    const others = sessions.filter(s => s.botId !== msg.authorId.trim());
    const mentioned = new Set(msg.mentionedUserIds.map(id => id.trim()));
    let targets = others.filter(s => mentioned.has(s.botId));
    if (targets.length === 0 && others.length === 1 && sessions.length === 1) targets = others;
    await addInbox(db, targets.map(t => t.id), msg.messageId, null, 'direct');
}

async function routeThreadReply(db: any, msg: RoutedMessage, sessions: LiveSession[], authorId: string): Promise<void> {
    const threadId = msg.threadId!;
    const binding = await db.query(
        `SELECT initiator_session_id, session_ids FROM agent_session_threads
         WHERE thread_id = $1 AND state = 'open' FOR UPDATE`,
        [threadId]
    );
    const bound = binding.rows[0];
    if (!bound) return;

    const boundIds = new Set<string>((bound.session_ids as string[]).map(id => id.trim()));
    const participants = sessions.filter(s => boundIds.has(s.id));
    const author = participants.find(s => s.botId === authorId);
    const others = participants.filter(s => s.botId !== authorId);
    const state = msg.protocol?.state;

    // CANCEL counts only from someone who can direct now; it stops the thread's runs too
    if (state === 'CANCEL' && msg.couldDirect) {
        await closeThread(db, threadId, [...boundIds], true);
        return;
    }

    if (author && msg.protocol) {
        switch (state) {
            case 'ACK': {
                const initiator = bound.initiator_session_id.trim();
                if (initiator !== author.id && participants.some(p => p.id === initiator)) {
                    await addInbox(db, [initiator], msg.messageId, threadId, 'protocol');
                }
                return;
            }
            case 'TURN':
            case 'CHECKPOINT': {
                const target = msg.protocol.yieldTo ? byName(participants, msg.protocol.yieldTo) : undefined;
                if (target && target.id !== author.id) {
                    await addInbox(db, [target.id], msg.messageId, threadId, 'handoff');
                }
                return;
            }
            case 'DECIDE':
                await addInbox(db, others.map(o => o.id), msg.messageId, threadId, 'protocol');
                return;
            case 'DONE':
            case 'BLOCK':
                await closeThread(db, threadId, [...boundIds], false);
                return;
            default:
                // START inside a thread, or CANCEL without authority: ordinary text
                break;
        }
    }

    // Someone who can direct speaks in the thread: every other participant hears it
    if (msg.couldDirect) {
        await addInbox(db, others.map(o => o.id), msg.messageId, threadId, 'direct');
    }
}
