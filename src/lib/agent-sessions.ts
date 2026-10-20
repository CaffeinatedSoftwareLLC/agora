import { generateUlid } from '../utils/ulid';
import type { ProtocolInfo } from './protocol';
import { postNotice, threadReplyCounted, type Notice } from './agent-runs';
import { planNotice, PLAN_OWNER_SQL } from './provider-terms';
import { noticeStandby } from './terminal-sessions';

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
 * - in any other thread (#120), a reply from someone who can direct that @mentions an agent
 *   wakes that agent's channel session with the thread as its destination ('direct'); in a
 *   bound thread this adds only agents that aren't participants.
 * - an @mention of a known agent by a person who can direct that wakes nothing (no live
 *   session here) gets a short notice saying why, where the mention was posted.
 * - opt-in lurkers hear otherwise unrouted channel posts and thread replies, except
 *   their own posts and posts by other lurkers. System notices never route here.
 * - a session scoped to a thread (a task card's or a subtask's, docs/task-board.md) takes no
 *   part in the rules above; in its own thread, a message from someone who can direct
 *   wakes it ('direct').
 *
 * - single responder (#112): while an agent has a live terminal session in the channel (its
 *   user's own CLI, connected through agora-mcp; src/lib/terminal-sessions.ts), its hosted
 *   channel session here takes no wakes. The terminal agent hears the message itself. The
 *   first time that happens, a notice says why. A terminal agent also counts as a live agent
 *   for "only one agent live in the channel".
 *
 * Sessions on a plan-owned profile ('subscription': the CLI's own account login, owned by the
 * server owner; 'siwc': a ChatGPT plan connected through Sign in with ChatGPT, owned by the
 * person who connected it) only take wakes their plan owner caused
 * (src/lib/provider-terms.ts); anyone else's is refused with a notice.
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
    lurkMode: string | null;
    profileName: string;
    /** Runs on someone's personal plan ('subscription' or 'siwc'): plan-owner wakes only. */
    subscription: boolean;
    authMode: string;
    /** Whose plan it runs on (server owner for 'subscription'); null: nobody's yet. */
    planOwnerId: string | null;
    /** Who started (or last resumed) this session. */
    startedBy: string | null;
    /** The plan owner started (or last resumed) this session. */
    startedByOwner: boolean;
}

/** Who wrote the message being routed, for the plan-owner rule. */
interface RouteContext {
    authorId: string;
    /** The author could direct agents here when the message was posted. */
    couldDirect: boolean;
    /** The author is a person, not a bot. */
    authorHuman: boolean;
    /** The author's own live session in this channel, if it is an agent. */
    authorSession: LiveSession | undefined;
    /** Sessions refused because of the subscription rule; one notice each. */
    refused: Map<string, LiveSession>;
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

/**
 * Live channel sessions (or, with `threadId`, the live sessions scoped to that thread), with
 * the names a START or YIELD may use for each agent.
 */
async function liveSessions(db: any, channelId: string, threadId: string | null = null): Promise<LiveSession[]> {
    const rows = await db.query(
        `SELECT s.id, s.bot_id, s.lurk_mode, s.started_by, u.username, p.name AS profile_name, p.auth_mode,
                ${PLAN_OWNER_SQL} AS plan_owner_id,
                (s.started_by IS NOT NULL AND s.started_by = ${PLAN_OWNER_SQL}) AS started_by_owner
         FROM agent_sessions s
         JOIN users u ON u.id = s.bot_id
         JOIN agent_profiles p ON p.id = s.profile_id
         JOIN servers srv ON srv.id = s.server_id
         WHERE s.channel_id = $1 AND s.state = 'live' AND s.kind = 'hosted' AND s.thread_id IS NOT DISTINCT FROM $2
         ORDER BY s.id`,
        [channelId, threadId]
    );
    return rows.rows.map((r: any) => ({
        id: r.id.trim(),
        botId: r.bot_id.trim(),
        lurkMode: r.lurk_mode,
        names: [String(r.username).toLowerCase(), String(r.profile_name).toLowerCase()],
        profileName: r.profile_name,
        subscription: r.auth_mode !== 'api_key',
        authMode: r.auth_mode,
        planOwnerId: r.plan_owner_id?.trim() ?? null,
        startedBy: r.started_by?.trim() ?? null,
        startedByOwner: !!r.started_by_owner,
    }));
}

/**
 * The plan-owner rule (provider-terms.ts): may this message wake this session for this
 * reason? api_key sessions always may (the caller already applied the authority rules).
 */
function termsAllow(target: LiveSession, reason: 'direct' | 'handoff' | 'protocol' | 'lurk', ctx: RouteContext): boolean {
    if (!target.subscription) return true;
    const owner = target.planOwnerId;
    if (!owner) return false;
    // A person's own message, with authority to direct agents now
    if (reason === 'direct' || reason === 'lurk') return ctx.authorHuman && ctx.couldDirect && ctx.authorId === owner;
    // Agent-to-agent: both sessions were started by this plan's owner
    return ctx.authorSession?.startedBy === owner && target.startedBy === owner;
}

/** Split targets by the subscription rule; refused ones (except passive lurk) get a notice. */
function permitted(targets: LiveSession[], reason: 'direct' | 'handoff' | 'protocol' | 'lurk', ctx: RouteContext): string[] {
    const ok: string[] = [];
    for (const t of targets) {
        if (termsAllow(t, reason, ctx)) ok.push(t.id);
        else if (reason !== 'lurk') ctx.refused.set(t.id, t);
    }
    return ok;
}

function byName(sessions: LiveSession[], name: string): LiveSession | undefined {
    const wanted = name.toLowerCase().replace(/^@/, '');
    return sessions.find(s => s.names.includes(wanted));
}

async function addInbox(db: any, sessionIds: string[], messageId: string, threadId: string | null, reason: 'direct' | 'handoff' | 'protocol' | 'lurk'): Promise<void> {
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
 * Close a bound thread: its unclaimed directed/protocol rows are acknowledged without
 * work; passive observations survive. With `cancel`, participants' runs are asked to stop.
 */
async function closeThread(db: any, threadId: string, sessionIds: string[], cancel: boolean): Promise<void> {
    await db.query(
        `UPDATE agent_session_threads SET state = 'closed', closed_at = NOW() WHERE thread_id = $1`,
        [threadId]
    );
    await db.query(
        `UPDATE agent_inbox SET acked_at = NOW()
         WHERE thread_id = $1 AND reason <> 'lurk' AND batch_id IS NULL AND acked_at IS NULL`,
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

/**
 * Record the wakes a newly inserted message causes. Returns the notices for wakes the
 * subscription rule refused, to emit after the transaction commits.
 */
export async function routeMessage(db: any, msg: RoutedMessage): Promise<Notice[]> {
    // Cheap check first: most channels have no agent sessions. A mention still needs a look:
    // it may address an agent that has no session here, which gets a notice.
    const mentionsSomeone = msg.couldDirect && msg.mentionedUserIds.length > 0;
    if (!mentionsSomeone) {
        const any: { rows: unknown[] } = await asService(db, () => db.query(
            `SELECT 1 FROM agent_sessions WHERE channel_id = $1 AND state = 'live' LIMIT 1`,
            [msg.channelId]
        ));
        if (any.rows.length === 0) return [];
    }

    return asService(db, async () => {
        const authorId = msg.authorId.trim();
        // Single responder: an agent connected from a terminal answers there, not through its hosted session
        const terminalBots = new Set<string>((await db.query(
            `SELECT bot_id FROM agent_sessions WHERE channel_id = $1 AND state = 'live' AND kind = 'terminal'`,
            [msg.channelId]
        )).rows.map((r: any) => r.bot_id.trim()));
        const all = await liveSessions(db, msg.channelId);
        const standby = all.filter(s => terminalBots.has(s.botId));
        const sessions = all.filter(s => !terminalBots.has(s.botId));
        const authorSession = sessions.find(s => s.botId === authorId);
        const author = await db.query(`SELECT u.bot FROM users u WHERE u.id = $1`, [authorId]);
        const authorHuman = author.rows[0]?.bot === false;
        const ctx: RouteContext = { authorId, couldDirect: msg.couldDirect, authorHuman, authorSession, refused: new Map() };

        if (msg.threadId === null) {
            const agents = new Set([...sessions.map(s => s.botId), ...terminalBots]).size;
            await routeTopLevel(db, msg, sessions, authorSession, ctx, agents);
        } else {
            await routeThreadReply(db, msg, sessions, authorId, ctx);
        }
        // Normal routing wins through the inbox's unique (session, message) key.
        // A lurker's output must never trigger a chain of passive interjections.
        if (!authorSession?.lurkMode) {
            await addInbox(db, permitted(sessions.filter(s => s.lurkMode && s.botId !== authorId), 'lurk', ctx),
                msg.messageId, msg.threadId, 'lurk');
        }
        const notices: Notice[] = [];
        // Someone who can direct addressed an agent on standby: say once why its hosted session stays quiet
        if (msg.couldDirect) {
            for (const s of standby) {
                if (s.botId !== authorId && msg.mentionedUserIds.some(id => id.trim() === s.botId)) await noticeStandby(db, msg.channelId, s.botId, notices);
            }
        }
        // A notice answers where the message was posted: in its thread for a reply
        const say = async (content: string) => {
            notices.push(await postNotice(db, msg.channelId, content, msg.threadId));
            if (msg.threadId) notices.push(await threadReplyCounted(db, msg.channelId, msg.threadId));
        };
        for (const s of ctx.refused.values()) await say(planNotice(s.profileName, s.authMode, !!s.planOwnerId));
        if (msg.couldDirect && authorHuman) {
            const refusedBots = new Set([...ctx.refused.values()].map(s => s.botId));
            for (const name of await unreachable(db, msg, authorId, terminalBots, refusedBots)) {
                await say(`${name.username} has no live session here, so nothing woke it. Start one with /start ${name.profile}.`);
            }
        }
        return notices;
    });
}

/**
 * Known agents (a profile on this server) the message @mentions that it woke nothing for and
 * that no other notice covers: no live session in the channel, nor one scoped to this thread.
 * An agent on standby (its live terminal session hears the message itself) or refused by the
 * plan-owner rule isn't listed; those have their own notices.
 */
async function unreachable(db: any, msg: RoutedMessage, authorId: string, terminalBots: Set<string>, refusedBots: Set<string>): Promise<Array<{ username: string; profile: string }>> {
    const ids = [...new Set(msg.mentionedUserIds.map(id => id.trim()))]
        .filter(id => id !== authorId && !terminalBots.has(id) && !refusedBots.has(id));
    if (ids.length === 0) return [];
    const rows = await db.query(
        `SELECT DISTINCT ON (p.bot_id) p.bot_id, u.username, p.name
         FROM agent_profiles p
         JOIN users u ON u.id = p.bot_id
         JOIN channels c ON c.id = $2 AND c.server_id = p.server_id
         WHERE p.bot_id = ANY($1)
           AND NOT EXISTS (SELECT 1 FROM agent_inbox i JOIN agent_sessions s ON s.id = i.session_id
                           WHERE i.message_id = $3 AND s.bot_id = p.bot_id)
           AND NOT EXISTS (SELECT 1 FROM agent_sessions s
                           WHERE s.bot_id = p.bot_id AND s.channel_id = $2 AND s.state = 'live'
                             AND (s.thread_id IS NULL OR s.thread_id = $4))
         ORDER BY p.bot_id, p.name`,
        [ids, msg.channelId, msg.messageId, msg.threadId]
    );
    return rows.rows.map((r: any) => ({ username: r.username, profile: r.name }));
}

async function routeTopLevel(db: any, msg: RoutedMessage, sessions: LiveSession[], authorSession: LiveSession | undefined, ctx: RouteContext, agents: number): Promise<void> {
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
        const unique = peerIds.map(id => peers.find(p => p.id === id)!);
        await addInbox(db, permitted(unique, 'protocol', ctx), msg.messageId, msg.messageId, 'protocol');
        return;
    }

    // Someone who can direct addresses an agent: by @mention, or the only agent here
    const others = sessions.filter(s => s.botId !== msg.authorId.trim());
    const mentioned = new Set(msg.mentionedUserIds.map(id => id.trim()));
    if (!msg.couldDirect) {
        // A person without DirectAgents @mentions a subscription agent: say why nothing happens
        if (ctx.authorHuman) for (const s of others) if (s.subscription && mentioned.has(s.botId)) ctx.refused.set(s.id, s);
        return;
    }
    let targets = others.filter(s => mentioned.has(s.botId));
    if (targets.length === 0 && others.length === 1 && sessions.length === 1 && agents === 1) {
        // The only agent here, unless the post is addressed to some other bot (#120)
        const otherBot = mentioned.size > 0 && (await db.query(
            `SELECT 1 FROM users WHERE id = ANY($1) AND bot = true LIMIT 1`, [[...mentioned]]
        )).rows.length > 0;
        if (!otherBot) targets = others;
    }
    await addInbox(db, permitted(targets, 'direct', ctx), msg.messageId, null, 'direct');
}

async function routeThreadReply(db: any, msg: RoutedMessage, sessions: LiveSession[], authorId: string, ctx: RouteContext): Promise<void> {
    const threadId = msg.threadId!;
    // A task card's or subtask's own thread: someone who can direct speaks to its agent
    const scoped = (await liveSessions(db, msg.channelId, threadId)).filter(s => s.botId !== authorId);
    if (msg.couldDirect) {
        await addInbox(db, permitted(scoped, 'direct', ctx), msg.messageId, threadId, 'direct');
    }
    const binding = await db.query(
        `SELECT initiator_session_id, session_ids FROM agent_session_threads WHERE thread_id = $1 AND state = 'open'`,
        [threadId]
    );
    const bound = binding.rows[0];
    const boundIds = new Set<string>(bound ? (bound.session_ids as string[]).map(id => id.trim()) : []);

    // An @mention in any thread (#120): the agent's channel session answers in this thread.
    // Participants of a bound thread keep the rules below; an agent with its own session
    // scoped to this thread already heard it there.
    const mentioned = new Set(msg.mentionedUserIds.map(id => id.trim()));
    const scopedBots = new Set(scoped.map(s => s.botId));
    const addressed = sessions.filter(s => mentioned.has(s.botId) && s.botId !== authorId && !boundIds.has(s.id) && !scopedBots.has(s.botId));
    if (msg.couldDirect) {
        await addInbox(db, permitted(addressed, 'direct', ctx), msg.messageId, threadId, 'direct');
    } else if (ctx.authorHuman) {
        // As at the top level: a person without DirectAgents @mentions a plan-owned agent; say why nothing happens
        for (const s of addressed) if (s.subscription) ctx.refused.set(s.id, s);
    }
    if (!bound) return;

    const participants = sessions.filter(s => boundIds.has(s.id));
    const author = participants.find(s => s.botId === authorId);
    const others = participants.filter(s => s.botId !== authorId);
    const state = msg.protocol?.state;

    // CANCEL counts only from someone who can direct now; it stops the thread's runs too.
    // DONE and BLOCK from a participant close the thread without stopping runs.
    const cancel = state === 'CANCEL' && msg.couldDirect;
    const closing = cancel || (!!author && (state === 'DONE' || state === 'BLOCK'));
    if (closing) {
        // Lock order is session → binding (as in a claim): lock the participants' sessions
        // in ID order first, then the binding, and recheck it is still open.
        await db.query(`SELECT 1 FROM agent_sessions WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [[...boundIds].sort()]);
        const still = await db.query(`SELECT 1 FROM agent_session_threads WHERE thread_id = $1 AND state = 'open' FOR UPDATE`, [threadId]);
        if (still.rows.length > 0) await closeThread(db, threadId, [...boundIds], cancel);
        return;
    }

    // Keep the thread from closing while this message's wakes are recorded
    const open = await db.query(`SELECT 1 FROM agent_session_threads WHERE thread_id = $1 AND state = 'open' FOR SHARE`, [threadId]);
    if (open.rows.length === 0) return;

    if (author && msg.protocol) {
        switch (state) {
            case 'ACK': {
                const initiator = bound.initiator_session_id.trim();
                const target = participants.find(p => p.id === initiator);
                if (initiator !== author.id && target) {
                    await addInbox(db, permitted([target], 'protocol', ctx), msg.messageId, threadId, 'protocol');
                }
                return;
            }
            case 'TURN':
            case 'CHECKPOINT': {
                const target = msg.protocol.yieldTo ? byName(participants, msg.protocol.yieldTo) : undefined;
                if (target && target.id !== author.id) {
                    await addInbox(db, permitted([target], 'handoff', ctx), msg.messageId, threadId, 'handoff');
                }
                return;
            }
            case 'DECIDE':
                await addInbox(db, permitted(others, 'protocol', ctx), msg.messageId, threadId, 'protocol');
                return;
            default:
                // START inside a thread, or CANCEL without authority: ordinary text
                break;
        }
    }

    // Someone who can direct speaks in the thread: every other participant hears it
    if (msg.couldDirect) {
        await addInbox(db, permitted(others, 'direct', ctx), msg.messageId, threadId, 'direct');
    }
}
