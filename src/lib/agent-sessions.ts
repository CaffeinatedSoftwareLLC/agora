import { generateUlid, ulidFloor } from '../utils/ulid';
import type { ProtocolInfo } from './protocol';
import { postNotice, threadReplyCounted, type Notice } from './agent-runs';
import { expireLiveRequests } from './agent-permissions';
import { ownerBotOf, planNotice, PLAN_OWNER_SQL, subscriptionWakesOf, WAKE_AUTH_SQL, type SubscriptionWakes } from './provider-terms';
import { noticeStandby } from './terminal-sessions';
import { stampAuthority } from './direct-agents';

/**
 * Agent sessions: which posts wake which agent (docs/planning/agent-sessions-wbs.md,
 * "Wake routing"). Called by the message routes inside the request's transaction, right
 * after the INSERT, so a wake is recorded exactly when its message commits.
 *
 * Inbox rows are only written for sessions that are live in the message's channel:
 * - a top-level post from someone who can direct, mentioning the agent (or with only one
 *   agent live in the channel) → 'direct';
 * - a top-level START from an agent with a live session binds a collaboration thread and
 *   wakes the other participants → 'protocol'. From a terminal agent (posting with the token
 *   that opened its terminal session), only when it names a live agent and it or the person
 *   whose token opened the terminal can direct agents here; otherwise it is an ordinary post. A
 *   participant with a live terminal session is bound too, so its own protocol messages
 *   route, but is never woken: it hears the thread itself;
 * - in a bound thread, protocol messages from participants hand off (YIELD, ACK, DECIDE),
 *   and messages from someone who can direct reach every participant.
 * - in any other thread (#120), a reply from someone who can direct that @mentions an agent
 *   wakes that agent's channel session with the thread as its destination ('direct'); in a
 *   bound thread this adds only agents that aren't participants.
 * - a follow-up: in a thread that is neither a collaboration thread nor a task card's or
 *   subtask's, a reply from a person who can direct that @mentions nobody wakes the agent
 *   the thread is "with" ('direct', destination that thread): the agent of the latest of these
 *   in the thread or its parent: its own post, if it was addressed in the thread (wrote the
 *   parent, was @mentioned by a director, or had a non-lurk wake there), or an @mention of it
 *   by a person who could direct. After a handoff, the thread's owner unless one of these is
 *   newer than the acceptance (never an agent from before the handoff). One agent at
 *   most; none, and no notice, when it has no live channel session here, is on standby, the
 *   plan-owner rule refuses it, or the latest message names two.
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
 * (src/lib/provider-terms.ts); anyone else's is refused with a notice. With the server's
 * subscription_wakes 'owner_bots' (default), a post by the plan owner's own bot (ownerBotOf)
 * counts as theirs for every reason, when the target was started by them; toward those targets
 * it may address them directly without can_direct (mayDirect). With 'owner_only',
 * direct and lurk wakes need the plan owner's own message, and agent-to-agent wakes (handoff,
 * protocol) count as the plan owner's when the target was started by them and the author is
 * either a session they started or their own bot in a live terminal session here, opened with a
 * personal or invite token the plan owner minted, posting with that token.
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
    /** The bot token the post was made with (a bot author only). */
    authorTokenId?: string | null;
}

interface LiveSession {
    id: string;
    /** 'terminal': the bot's own CLI connected through agora-mcp (no profile, never woken here). */
    kind: 'hosted' | 'terminal';
    botId: string;
    /** Who owns the bot (users.bot_owner_id); set for terminal sessions only. */
    botOwnerId: string | null;
    /** Terminal only: the bot token whose socket opened it (null: unknown, or several). */
    tokenId: string | null;
    /**
     * Terminal only: who minted that token, when it is a live personal or invite token (not a
     * host's, box's or model agent's).
     */
    tokenMintedBy: string | null;
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
    /**
     * The author's own live session in this channel, if it is an agent: its hosted channel
     * session, or its terminal session while it has one (then its hosted one is on standby).
     */
    authorSession: LiveSession | undefined;
    /** The server's subscription_wakes setting. */
    wakes: SubscriptionWakes;
    /** A bot author: the person whose own automation this post is (ownerBotOf), or null. */
    countsAs: string | null;
    /** An owner bot's direct wakes in this scope reached OWNER_BOT_HOP_LIMIT. */
    hopLimited: boolean;
    /** The loop guard held back a wake here. */
    hopBlocked: boolean;
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
        `SELECT s.id, s.bot_id, s.lurk_mode, s.started_by, u.username, p.name AS profile_name, ${WAKE_AUTH_SQL} AS auth_mode,
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
        kind: 'hosted' as const,
        botId: r.bot_id.trim(),
        botOwnerId: null,
        tokenId: null,
        tokenMintedBy: null,
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
 * Live terminal sessions in the channel (src/lib/terminal-sessions.ts), with the bot's owner.
 * They are never woken here (the agent hears messages itself); routing uses them for single
 * responder, as a message's author, and as members of a collaboration thread.
 */
async function terminalSessions(db: any, channelId: string): Promise<LiveSession[]> {
    const rows = await db.query(
        `SELECT s.id, s.bot_id, s.started_by, s.token_id, u.username, u.bot_owner_id,
                CASE WHEN t.revoked_at IS NULL AND t.purpose IN ('personal', 'invite') THEN t.created_by END AS token_minted_by,
                ARRAY(SELECT p.name FROM agent_profiles p WHERE p.bot_id = s.bot_id AND p.server_id = s.server_id) AS profile_names
         FROM agent_sessions s
         JOIN users u ON u.id = s.bot_id
         LEFT JOIN bot_tokens t ON t.id = s.token_id AND t.bot_id = s.bot_id
         WHERE s.channel_id = $1 AND s.state = 'live' AND s.kind = 'terminal'
         ORDER BY s.id`,
        [channelId]
    );
    return rows.rows.map((r: any) => ({
        id: r.id.trim(),
        kind: 'terminal' as const,
        botId: r.bot_id.trim(),
        botOwnerId: r.bot_owner_id?.trim() ?? null,
        tokenId: r.token_id?.trim() ?? null,
        tokenMintedBy: r.token_minted_by?.trim() ?? null,
        lurkMode: null,
        names: [String(r.username).toLowerCase(), ...(r.profile_names ?? []).map((n: string) => String(n).toLowerCase())],
        profileName: r.username,
        subscription: false,
        authMode: 'terminal',
        planOwnerId: null,
        startedBy: r.started_by?.trim() ?? null,
        startedByOwner: false,
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
    if (ctx.authorHuman) return (reason === 'direct' || reason === 'lurk') && ctx.couldDirect && ctx.authorId === owner;
    // Owner bots: the plan owner's own bot counts as them for every reason, to a session they
    // started (routing lets it address their plan-owned agents directly, mayDirect)
    if (ctx.wakes === 'owner_bots' && target.startedBy === owner && ctx.countsAs === owner) return true;
    if (reason === 'direct' || reason === 'lurk') return false;
    // #361, in either setting (owner_bots adds to it). Agent-to-agent: the target was started by this plan's owner, and so was the author's
    // session; or the author is the plan owner's own bot in a live terminal session here that
    // the owner's own token opened (routeMessage only takes a terminal as the author when the
    // post was made with that token)
    return target.startedBy === owner && authorIsOwners(ctx.authorSession, owner);
}

/**
 * May this message address this target directly (an @mention, the sole agent, a task card's
 * thread)? Whoever could direct agents here may. So may the plan owner's own bot (owner bots,
 * ownerBotOf) toward a plan-owned target of that same owner, without can_direct: the owner
 * needs no extra setup for their own agents to wake each other. Every other target (api_key,
 * another person's plan) keeps the plain authority rule. termsAllow still decides the wake.
 */
function mayDirect(target: LiveSession, ctx: RouteContext): boolean {
    if (ctx.couldDirect) return true;
    return !ctx.authorHuman && ctx.wakes === 'owner_bots' && target.subscription
        && !!target.planOwnerId && ctx.countsAs === target.planOwnerId;
}

/** The author's session counts as the plan owner's for an agent-to-agent wake. */
function authorIsOwners(author: LiveSession | undefined, owner: string): boolean {
    if (!author) return false;
    if (author.kind === 'terminal') return author.botOwnerId === owner && author.tokenMintedBy === owner;
    return author.startedBy === owner;
}

/** Split targets by the subscription rule; refused ones (except passive lurk) get a notice. */
function permitted(targets: LiveSession[], reason: 'direct' | 'handoff' | 'protocol' | 'lurk', ctx: RouteContext): string[] {
    const ok: string[] = [];
    for (const t of targets) {
        if (!termsAllow(t, reason, ctx)) {
            if (reason !== 'lurk') ctx.refused.set(t.id, t);
        } else if (reason === 'direct' && ctx.hopLimited && ownerBotWake(t, ctx)) {
            // Owner bots have talked long enough without the owner (OWNER_BOT_HOP_LIMIT)
            ctx.hopBlocked = true;
        } else {
            ok.push(t.id);
        }
    }
    return ok;
}

/** A wake of the owner's plan-owned agent by one of the owner's own bots (owner bots). */
function ownerBotWake(target: LiveSession, ctx: RouteContext): boolean {
    return !ctx.authorHuman && ctx.wakes === 'owner_bots' && target.subscription && !!target.planOwnerId && ctx.countsAs === target.planOwnerId;
}

/**
 * Loop guard for owner bots, which can direct-wake the owner's plan-owned agents without
 * can_direct while the thread hop guard is off by default: after this many bot-authored
 * messages in a row that woke an agent directly ('direct' inbox rows), in the same thread (its
 * parent included) or among the channel's top-level posts, with no person's message in between,
 * an owner bot's direct wakes stop and one notice says so. A person's message resets it.
 * Protocol and handoff wakes in bound threads keep their own guards.
 */
export const OWNER_BOT_HOP_LIMIT = 8;
export const OWNER_BOT_HOP_NOTICE = `Agents have been talking to each other for ${OWNER_BOT_HOP_LIMIT} turns without you; reply to continue.`;

/** The scope's bot-authored direct wakes since its latest person's message, and whether the notice was posted since. */
async function ownerBotHops(db: any, msg: RoutedMessage): Promise<{ count: number; noticed: boolean }> {
    // $2 is always typed: a top-level post's is NULL
    const scope = msg.threadId ? '(m.thread_id = $2::char(26) OR m.id = $2::char(26))' : '(m.thread_id IS NULL AND $2::char(26) IS NULL)';
    const row = (await db.query(
        `WITH last_human AS (
             SELECT max(m.id) AS id FROM messages m JOIN users u ON u.id = m.author_id
             WHERE m.channel_id = $1 AND ${scope} AND NOT u.bot AND m.deleted_at IS NULL AND m.id <> $3)
         SELECT
             (SELECT count(*)::int FROM messages m JOIN users u ON u.id = m.author_id
              WHERE m.channel_id = $1 AND ${scope} AND u.bot AND m.id <> $3
                AND m.id > COALESCE((SELECT id FROM last_human), '')
                AND EXISTS (SELECT 1 FROM agent_inbox i WHERE i.message_id = m.id AND i.reason = 'direct')) AS count,
             EXISTS (SELECT 1 FROM messages m
                     WHERE m.channel_id = $1 AND ${scope} AND m.author_id IS NULL AND m.content = $4
                       AND m.id > COALESCE((SELECT id FROM last_human), '')) AS noticed`,
        [msg.channelId, msg.threadId, msg.messageId, OWNER_BOT_HOP_NOTICE]
    )).rows[0];
    return { count: row.count, noticed: row.noticed };
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
 * A handoff reminder (#327, src/workers/handoff-nudge.ts) for a bot: the one hosted session
 * that should get it, as routeMessage would pick: the bot's session scoped to this thread (a
 * task or subtask worker) when there is one, as in routeThreadReply; otherwise none while the
 * bot has a live terminal session in the channel (single responder: it answers there), else
 * its channel session. Only api_key sessions: the reminder is Agora's automation, which the
 * subscription rule (provider-terms.ts) never lets wake a subscription session.
 * `reminderSessions` finds it before the reminder is written (so its text can say whether the
 * agent was reached); `queueReminder` queues the written one.
 */
export async function reminderSessions(db: any, input: { channelId: string; threadId: string; botId: string }): Promise<string[]> {
    return asService(db, async () => {
        const mine = (sessions: LiveSession[]) => sessions.filter(s => s.botId === input.botId);
        let target = mine(await liveSessions(db, input.channelId, input.threadId))[0];
        if (!target) {
            const terminal = await db.query(
                `SELECT 1 FROM agent_sessions WHERE channel_id = $1 AND bot_id = $2 AND state = 'live' AND kind = 'terminal' LIMIT 1`,
                [input.channelId, input.botId]
            );
            if (terminal.rows.length > 0) return [];
            target = mine(await liveSessions(db, input.channelId))[0];
        }
        return target && !target.subscription ? [target.id] : [];
    });
}

export async function queueReminder(db: any, sessionIds: string[], messageId: string, threadId: string): Promise<void> {
    if (sessionIds.length === 0) return;
    await asService(db, () => addInbox(db, sessionIds, messageId, threadId, 'direct'));
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
        await expireLiveRequests(db, { sessionIds }, 'stopped', []);
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
        const terminals = await terminalSessions(db, msg.channelId);
        const terminalBots = new Set<string>(terminals.map(s => s.botId));
        const all = await liveSessions(db, msg.channelId);
        const standby = all.filter(s => terminalBots.has(s.botId));
        const sessions = all.filter(s => !terminalBots.has(s.botId));
        // An agent writing from its terminal is that terminal session (its hosted one is on
        // standby), when the post was made with the token that opened it. Any other post by
        // the bot (another token: a hosted run, a plain API call) keeps the old rules.
        const authorSession = sessions.find(s => s.botId === authorId)
            ?? terminals.find(s => s.botId === authorId && !!s.tokenId && s.tokenId === msg.authorTokenId);
        const author = await db.query(
            `SELECT u.bot, srv.subscription_wakes FROM users u, channels c JOIN servers srv ON srv.id = c.server_id
             WHERE u.id = $1 AND c.id = $2`,
            [authorId, msg.channelId]
        );
        const authorHuman = author.rows[0]?.bot === false;
        const wakes = subscriptionWakesOf(author.rows[0]?.subscription_wakes);
        // Whose own automation a bot's post is, for plan-owned targets (owner bots)
        const countsAs = author.rows[0]?.bot === true && wakes === 'owner_bots'
            ? await ownerBotOf(db, { botId: authorId, tokenId: msg.authorTokenId, channelId: msg.channelId })
            : null;
        const hops = countsAs ? await ownerBotHops(db, msg) : null;
        const ctx: RouteContext = { authorId, couldDirect: msg.couldDirect, authorHuman, authorSession, wakes, countsAs,
            hopLimited: !!hops && hops.count >= OWNER_BOT_HOP_LIMIT, hopBlocked: false, refused: new Map() };

        if (msg.threadId === null) {
            const agents = new Set([...sessions.map(s => s.botId), ...terminalBots]).size;
            await routeTopLevel(db, msg, sessions, terminals, authorSession, ctx, agents);
        } else {
            await routeThreadReply(db, msg, sessions, authorId, ctx);
        }
        // Normal routing wins through the inbox's unique (session, message) key.
        // A lurker's output must never trigger a chain of passive interjections.
        if (!authorSession?.lurkMode) {
            await addInbox(db, permitted(sessions.filter(s => s.lurkMode && s.botId !== authorId), 'lurk', ctx),
                msg.messageId, msg.threadId, 'lurk');
        }
        // The bot's token on its wakes: the claim reruns ownerBotOf with it (agent-runs.ts)
        if (author.rows[0]?.bot === true && msg.authorTokenId) {
            await db.query('UPDATE agent_inbox SET author_token_id = $2 WHERE message_id = $1', [msg.messageId, msg.authorTokenId]);
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
        // Once per run of bot turns: a person's message resets it
        if (ctx.hopBlocked && !hops?.noticed) await say(OWNER_BOT_HOP_NOTICE);
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

/**
 * May a terminal agent's START open a collaboration thread? Only with authority to direct
 * agents in the channel: the bot's own (the post's stamp), or that of the person whose token
 * opened the terminal (a personal or invite token's minter). Not the bot's owner as such: a
 * token someone else minted for the bot doesn't borrow the owner's authority, and a host's,
 * box's or model agent's token has only the bot's own.
 */
async function terminalMayDirect(db: any, msg: RoutedMessage, author: LiveSession): Promise<boolean> {
    if (msg.couldDirect) return true;
    return !!author.tokenMintedBy && await stampAuthority(db, msg.channelId, author.tokenMintedBy, false);
}

/** Bind a START's thread to its author and peers, and wake the hosted peers ('protocol'). */
async function openThread(db: any, msg: RoutedMessage, author: LiveSession, peers: LiveSession[], peerIds: string[], ctx: RouteContext): Promise<void> {
    if (peerIds.length === 0) return;
    await db.query(
        `INSERT INTO agent_session_threads (thread_id, channel_id, initiator_session_id, session_ids)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (thread_id) DO NOTHING`,
        [msg.messageId, msg.channelId, author.id, [author.id, ...peerIds]]
    );
    const unique = peerIds.map(id => peers.find(p => p.id === id)!).filter(p => p.kind === 'hosted');
    await addInbox(db, permitted(unique, 'protocol', ctx), msg.messageId, msg.messageId, 'protocol');
}

async function routeTopLevel(db: any, msg: RoutedMessage, sessions: LiveSession[], terminals: LiveSession[], authorSession: LiveSession | undefined, ctx: RouteContext, agents: number): Promise<void> {
    // An agent with a live session (hosted or terminal) opens a collaboration thread. Terminal
    // participants are members of the thread, so their turns route, but are never woken: they
    // hear the thread themselves. A terminal agent opens one only with authority to direct
    // agents here (its own, or that of the person whose token opened the terminal); otherwise, or when
    // it names no live agent, its START is an ordinary post.
    if (authorSession && msg.protocol?.state === 'START') {
        const peers = (msg.protocol.participants ?? [])
            .map(name => byName(sessions, name) ?? byName(terminals, name))
            .filter((s): s is LiveSession => !!s && s.botId !== authorSession.botId);
        const peerIds = [...new Set(peers.map(p => p.id))];
        const opens = authorSession.kind === 'hosted'
            || (peerIds.length > 0 && await terminalMayDirect(db, msg, authorSession));
        if (opens) {
            await openThread(db, msg, authorSession, peers, peerIds, ctx);
            return;
        }
    }

    // Someone who can direct addresses an agent: by @mention, or the only agent here
    const others = sessions.filter(s => s.botId !== msg.authorId.trim());
    const mentioned = new Set(msg.mentionedUserIds.map(id => id.trim()));
    if (!msg.couldDirect && ctx.authorHuman) {
        // A person without DirectAgents @mentions a subscription agent: say why nothing happens
        for (const s of others) if (s.subscription && mentioned.has(s.botId)) ctx.refused.set(s.id, s);
        return;
    }
    // A bot without authority reaches only its owner's plan-owned agents (mayDirect)
    let targets = others.filter(s => mentioned.has(s.botId) && mayDirect(s, ctx));
    if (targets.length === 0 && others.length === 1 && sessions.length === 1 && agents === 1 && mayDirect(others[0], ctx)) {
        // The only agent here, unless the post is addressed to some other bot (#120)
        const otherBot = mentioned.size > 0 && (await db.query(
            `SELECT 1 FROM users WHERE id = ANY($1) AND bot = true LIMIT 1`, [[...mentioned]]
        )).rows.length > 0;
        if (!otherBot) targets = others;
    }
    await addInbox(db, permitted(targets, 'direct', ctx), msg.messageId, null, 'direct');
}

/**
 * The agent an ordinary thread is "with", for a follow-up reply that @mentions nobody: the
 * latest of these in the thread or its parent, newest first:
 * - a post by an agent that was addressed in this thread: it wrote the parent, a person who
 *   could direct @mentioned it there, or it has a wake for the thread other than a lurk.
 *   Handoff cards don't count (the recipient is the one addressed);
 * - an @mention of an agent by a person who could direct; nobody when it names two.
 * After a handoff, the thread's owner when nothing above is newer than its acceptance; then
 * the owner or nobody, never an agent from before the handoff.
 * "Agent" is a bot with a session in this channel, live or not. Its live channel session when it
 * has one that isn't on standby (`sessions` excludes those); otherwise nobody, without a notice,
 * since a plain reply addresses no one. Nobody in a collaboration thread (open or closed) or a
 * task card's or subtask's thread.
 */
async function followUpTarget(db: any, msg: RoutedMessage, sessions: LiveSession[]): Promise<LiveSession | undefined> {
    const threadId = msg.threadId!;
    const special = await db.query(
        `SELECT 1 FROM agent_session_threads WHERE thread_id = $1
         UNION ALL
         SELECT 1 FROM agent_sessions WHERE channel_id = $2 AND thread_id = $1
         LIMIT 1`,
        [threadId, msg.channelId]
    );
    if (special.rows.length > 0) return undefined;

    // A handoff made the recipient the thread's owner: only events after it can move the thread on
    const owner = (await db.query(
        `SELECT bot_id, since FROM agent_thread_owners WHERE thread_id = $1 AND channel_id = $2`,
        [threadId, msg.channelId]
    )).rows[0];
    const ownerBot: string | undefined = owner?.bot_id.trim();
    const floor = owner ? ulidFloor(new Date(owner.since).getTime()) : '';

    const agents: string[] = (await db.query(
        `SELECT DISTINCT bot_id FROM agent_sessions WHERE channel_id = $1`, [msg.channelId]
    )).rows.map((r: any) => r.bot_id);
    const latest = agents.length > 0 ? await latestEvent(db, msg, agents, floor, ownerBot) : undefined;
    // Nothing since the handoff (or no event at all): the owner, or nobody
    const botId = latest ?? ownerBot;
    return botId ? sessions.find(s => s.botId === botId) : undefined;
}

const WALK_BATCH = 20;

/**
 * The agent of the thread's latest event (see followUpTarget), walking candidates newest first
 * through the thread's index (replies, then the parent) and checking only those, from `floor`
 * (a ULID; '' for the whole thread). Undefined when there is none, or the latest names two agents.
 */
async function latestEvent(db: any, msg: RoutedMessage, agents: string[], floor: string, ownerBot: string | undefined): Promise<string | undefined> {
    const threadId = msg.threadId!;
    // Candidates: posts by agents (not handoff cards), and directors' messages that @mention one
    const candidates = (scope: string, before: string | null) => db.query(
        `SELECT m.id, m.author_id, NOT u.bot AS human
         FROM messages m JOIN users u ON u.id = m.author_id
         WHERE ${scope} AND m.deleted_at IS NULL AND m.id <> $2 AND m.id >= $4 AND ($5::char(26) IS NULL OR m.id < $5)
           AND ((u.bot AND m.author_id = ANY($3) AND m.system_event IS DISTINCT FROM 'agent_handoff')
                OR (NOT u.bot AND m.author_could_direct
                    AND EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = ANY($3))))
         ORDER BY m.id DESC
         LIMIT ${WALK_BATCH}`,
        [threadId, msg.messageId, agents, floor, before]
    );
    // Was this agent addressed in the thread? Point lookups for the one bot. After a handoff
    // (`floor` set) the owner is, and others only by what happened since: a wake there other
    // than a lurk, or a director's @mention. The sender, whose run may finish after the
    // acceptance, doesn't take the thread back.
    const checked = new Map<string, boolean>();
    const addressed = async (botId: string): Promise<boolean> => {
        if (botId === ownerBot) return true;
        if (!checked.has(botId)) {
            const r = await db.query(
                `SELECT ($4::text = '' AND EXISTS (SELECT 1 FROM messages p WHERE p.id = $1 AND p.author_id = $3))
                     OR EXISTS (SELECT 1 FROM agent_inbox i JOIN agent_sessions s ON s.id = i.session_id
                                WHERE i.thread_id = $1 AND s.bot_id = $3 AND i.reason <> 'lurk' AND i.message_id >= $4)
                     OR ($4::text = '' AND EXISTS (SELECT 1 FROM agent_sessions s JOIN agent_inbox i ON i.session_id = s.id AND i.message_id = $1
                                                    WHERE s.channel_id = $2 AND s.bot_id = $3 AND i.reason <> 'lurk'))
                     OR EXISTS (SELECT 1 FROM message_mentions dm
                                JOIN messages d ON d.id = dm.message_id
                                JOIN users du ON du.id = d.author_id AND NOT du.bot
                                WHERE dm.user_id = $3 AND (d.thread_id = $1 OR d.id = $1) AND d.id >= $4
                                  AND d.author_could_direct AND d.deleted_at IS NULL) AS addressed`,
                [threadId, msg.channelId, botId, floor]
            );
            checked.set(botId, r.rows[0].addressed);
        }
        return checked.get(botId)!;
    };
    for (const scope of ['m.thread_id = $1', 'm.id = $1']) {
        let before: string | null = null;
        for (;;) {
            const rows: Array<{ id: string; author_id: string; human: boolean }> = (await candidates(scope, before)).rows;
            for (const row of rows) {
                if (row.human) {
                    const named = (await db.query(
                        `SELECT user_id FROM message_mentions WHERE message_id = $1 AND user_id = ANY($2) LIMIT 2`,
                        [row.id, agents]
                    )).rows;
                    return named.length === 1 ? named[0].user_id.trim() : undefined;
                }
                const botId = row.author_id.trim();
                if (await addressed(botId)) return botId;
            }
            if (rows.length < WALK_BATCH) break;
            before = rows[rows.length - 1].id;
        }
    }
    return undefined;
}

async function routeThreadReply(db: any, msg: RoutedMessage, sessions: LiveSession[], authorId: string, ctx: RouteContext): Promise<void> {
    const threadId = msg.threadId!;
    // A task card's or subtask's own thread: someone who can direct speaks to its agent
    const scoped = (await liveSessions(db, msg.channelId, threadId)).filter(s => s.botId !== authorId);
    await addInbox(db, permitted(scoped.filter(s => mayDirect(s, ctx)), 'direct', ctx), msg.messageId, threadId, 'direct');
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
    if (msg.couldDirect || !ctx.authorHuman) {
        await addInbox(db, permitted(addressed.filter(s => mayDirect(s, ctx)), 'direct', ctx), msg.messageId, threadId, 'direct');
    } else {
        // As at the top level: a person without DirectAgents @mentions a plan-owned agent; say why nothing happens
        for (const s of addressed) if (s.subscription) ctx.refused.set(s.id, s);
    }
    if (!bound) {
        // A follow-up: a person who can direct replies without @mentioning any agent; the agent
        // the thread is with answers. Agents' replies never do this (no bot-to-bot chains).
        // A reply that @mentions anyone (a person too) is addressed to them, not a follow-up.
        // The plan-owner rule refuses silently here: a plain reply asked nothing of the agent.
        if (msg.couldDirect && ctx.authorHuman && scoped.length === 0 && ![...mentioned].some(id => id !== authorId)) {
            const target = await followUpTarget(db, msg, sessions);
            if (target && termsAllow(target, 'direct', ctx)) await addInbox(db, [target.id], msg.messageId, threadId, 'direct');
        }
        return;
    }

    const participants = sessions.filter(s => boundIds.has(s.id));
    let author = participants.find(s => s.botId === authorId);
    // A participant writing from its terminal: the bot is in the thread through one of its
    // sessions (this terminal session, an earlier one, or its hosted session now on standby)
    if (!author && ctx.authorSession?.kind === 'terminal') {
        const member = await db.query(`SELECT 1 FROM agent_sessions WHERE id = ANY($1) AND bot_id = $2 LIMIT 1`, [[...boundIds], authorId]);
        if (member.rows.length > 0) author = ctx.authorSession;
    }
    const others = participants.filter(s => s.botId !== authorId);
    const state = msg.protocol?.state;

    // CANCEL counts only from someone who can direct now; it stops the thread's runs too.
    // DONE and BLOCK from a participant close the thread without stopping runs.
    const cancel = state === 'CANCEL' && msg.couldDirect;
    const closing = cancel || (!!author && (state === 'DONE' || state === 'BLOCK'));
    if (closing) {
        // Lock order is session → binding (as in a claim): lock the participants' hosted sessions
        // in ID order first, then the binding, and recheck it is still open. Terminal sessions
        // never claim, and their heartbeats update them in no set order, so they aren't locked.
        await db.query(`SELECT 1 FROM agent_sessions WHERE id = ANY($1) AND kind = 'hosted' ORDER BY id FOR UPDATE`, [[...boundIds].sort()]);
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
            case 'WAIT': {
                // The agent that owes the next step (#327); a WAIT on oneself wakes nobody
                const target = msg.protocol.waitingOn ? byName(participants, msg.protocol.waitingOn) : undefined;
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

    // Someone who can direct speaks in the thread: every other participant hears it. So does a
    // participant that is the owner's own bot, to the owner's plan-owned participants (mayDirect),
    // under the loop guard; a bot outside the thread needs authority to direct
    const hearers = msg.couldDirect ? others : author ? others.filter(s => mayDirect(s, ctx)) : [];
    await addInbox(db, permitted(hearers, 'direct', ctx), msg.messageId, threadId, 'direct');
}
