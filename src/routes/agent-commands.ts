import { FastifyInstance } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { canViewChannel } from '../lib/channel-access';
import { cannotDirect, stampAuthority, isServerOwner } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';
import { limitReached, postNotice, postSessionNotice, sessionUpdate, type Notice } from '../lib/agent-runs';
import { LIMIT_SCHEMA, limitOf, limitStopSummary } from '../lib/agent-budget-notice';
import { expireLiveRequests } from '../lib/agent-permissions';
import { noticeStandby } from '../lib/terminal-sessions';
import { CONTROLS, controlsOf, LIVE_COMMAND_SQL, runControl, type ControlName } from '../lib/session-commands';
import { PLAN_OWNER_ONLY, PLAN_OWNER_ONLY_MESSAGE, SUBSCRIPTION_OWNER_ONLY, SUBSCRIPTION_OWNER_ONLY_MESSAGE, terminalOwnerStateSql, wakeAuthMode } from '../lib/provider-terms';

/**
 * Session commands (docs/planning/agent-sessions-wbs.md, "Commands"): /start, /end,
 * /sessions and /resume, sent by the message box (and by agents through agora-mcp).
 *
 * Starting, ending and resuming need authority in the channel: the owner, a member with
 * DirectAgents, or a bot the owner allowed to direct there. Listing needs only access.
 * Results are posted as system notices so everyone in the channel sees them.
 *
 * An agent on a 'subscription' profile (the CLI's own account login) can only be started or
 * resumed by the server owner, and one on a 'siwc' profile (a ChatGPT plan connected through
 * Sign in with ChatGPT) only by that plan's owner (src/lib/provider-terms.ts).
 *
 * /start, /end and lurk by profile name act on the agent's channel session. Sessions scoped
 * to a thread (task cards and subtasks, docs/task-board.md) are ended and resumed by ID.
 *
 * Terminal sessions (#112, src/lib/terminal-sessions.ts) are listed by /sessions but never
 * started, ended, resumed or budgeted here: they live exactly as long as the user's own CLI
 * is connected. /start for an agent connected from a terminal asks first (409
 * terminal_connected): keep the terminal, or start the hosted session on standby.
 */

export class CommandError extends Error {
    constructor(public status: number, public body: any) { super(body?.error ?? 'error'); }
}

/**
 * Why a terminal session does or doesn't count as its bot owner's for the plan-owner rule's
 * owner bots (docs/provider-terms.md, src/lib/provider-terms.ts terminalOwnerStateSql, which
 * ownerBotOf uses too): 'ok' when the bot
 * has an owner, no other token shares the session, the owner started it, and it has a live
 * personal or invite token ('no_token': none on record, or revoked; 'agent_token': an agent
 * host's, box's or model agent's token) that no other person made. With the server set to
 * 'owner_only' (#361) the bot's owner must have made the token ('owner_only_token' when not).
 */
export type OwnerTokenState = 'ok' | 'mixed' | 'other_bot_owner' | 'started_by_other' | 'no_token' | 'agent_token'
    | 'other_maker' | 'owner_only_token';

/**
 * `viewerId`: the caller, so a terminal session can say whether its bot is theirs. Without it
 * (and for hosted sessions) ownedByYou is left out.
 */
export function sessionJson(r: any, viewerId?: string) {
    return {
        id: r.id.trim(), kind: r.kind ?? 'hosted', profile: r.profile_name, botId: r.bot_id.trim(), botUsername: r.bot_username, state: r.state,
        endReason: r.end_reason ?? null, wakesUsed: r.wakes_used, tokensUsed: Number(r.tokens_used),
        // What stopped a session shelved with endReason 'budget': { kind: 'wake' | 'token', used, limit, sessionId } or { kind: 'credit' }
        limitStop: r.limit_stop ?? null,
        lurkMode: r.lurk_mode ?? null,
        authMode: r.auth_mode ?? 'subscription', runApproval: !!r.run_approval,
        // As in the profile JSON (docs/agent-boxes.md §10): hostMode drives the owner-only rule, boxed the label
        hostMode: !!r.host_mode, boxed: !!r.boxed,
        // What `@agent /command` can do for this session's CLI (docs/agent-commands.md); a terminal session can't be driven from Agora
        adapter: r.adapter ?? null, commands: r.kind === 'terminal' ? [] : controlsOf(r.adapter), pendingCommand: r.pending_command ?? null,
        branch: r.branch ?? null, baseSha: r.base_sha ?? null, headSha: r.head_sha ?? null,
        workspaceId: r.workspace_id,
        threadId: r.thread_id?.trim() ?? null, parentSessionId: r.parent_session_id?.trim() ?? null, title: r.title ?? null,
        createdAt: r.created_at, lastActiveAt: r.last_active_at, shelvedAt: r.shelved_at ?? null, endedAt: r.ended_at ?? null,
        running: !!r.running, sleepingUntil: r.sleeping_until ?? null, tokenBudget: limitOf(r.effective_token_budget), wakeBudget: limitOf(r.wake_budget), run: r.run ?? null, recentRuns: r.recent_runs ?? [],
        // Terminal sessions: what agora-mcp reports. No budget applies to a user's own CLI.
        ...(r.kind === 'terminal' ? {
            tokenBudget: null, wakeBudget: null, toolCalls: r.tool_calls, usageKnown: !!r.usage_known,
            terminalMode: r.terminal_mode ?? null, budgetEnforced: false,
            // #230: listening (a chat_wait open), idle since when, and what the agent reported itself
            listening: !!r.listening, idleSince: r.idle_since ?? null, lastTool: r.last_tool ?? null,
            contextPercent: r.context_percent ?? null, usagePercent: r.usage_percent ?? null, usageLabel: r.usage_label ?? null,
            statusNote: r.status_note ?? null, statusAt: r.status_at ?? null,
            // Its hand-offs count as the bot owner's (docs/provider-terms.md); the reason when not
            ownerToken: r.owner_token_state === 'ok',
            ownerTokenReason: r.owner_token_state === 'ok' ? null : (r.owner_token_state ?? 'other_bot_owner') as OwnerTokenState,
            // The server's setting: with 'owner_only' a counting terminal wakes subscription agents by hand-offs only
            subscriptionWakes: r.subscription_wakes ?? null,
            ...(viewerId ? { ownedByYou: !!r.bot_owner_id && r.bot_owner_id.trim() === viewerId.trim() } : {}),
        } : {}),
    };
}

// running: a host has claimed a run for this session and is working on it now
// A terminal session has no profile: it is named after its bot
export const SESSION_SELECT = `SELECT s.*, COALESCE(p.name, u.username) AS profile_name, u.username AS bot_username, COALESCE(s.token_budget, p.token_budget) AS effective_token_budget, p.wake_budget,
        p.auth_mode, p.host_mode, p.run_approval, p.plan_owner_id, p.adapter,
        (SELECT json_build_object('command', c.command, 'status', c.status) FROM agent_session_commands c WHERE c.session_id = s.id AND ${LIVE_COMMAND_SQL('c.')} ORDER BY c.id DESC LIMIT 1) AS pending_command,
        COALESCE((SELECT h.kind = 'box' FROM agent_hosts h WHERE h.id = p.host_id), false) AS boxed,
        (SELECT json_build_object('id', btrim(r.id), 'status', r.status, 'startedAt', r.created_at,
            'finishedAt', r.finished_at, 'error', r.error, 'changedPaths', r.changed_paths)
         FROM agent_runs r WHERE r.session_id = s.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS run,
        (SELECT COALESCE(json_agg(recent.run ORDER BY recent.created_at DESC, recent.id DESC), '[]'::json) FROM
            (SELECT r.id, r.created_at, json_build_object('id', btrim(r.id), 'status', r.status, 'startedAt', r.created_at,
                'finishedAt', r.finished_at, 'error', r.error, 'changedPaths', r.changed_paths) AS run
             FROM agent_runs r WHERE r.session_id = s.id ORDER BY r.created_at DESC, r.id DESC LIMIT 5) recent) AS recent_runs,
        CASE WHEN s.kind = 'terminal' THEN s.state = 'live' AND s.working
             ELSE EXISTS (SELECT 1 FROM agent_runs r WHERE r.session_id = s.id AND r.status = 'claimed') END AS running,
        u.bot_owner_id,
        -- The same definition routing uses (provider-terms.ts terminalOwnerStateSql)
        CASE WHEN s.kind <> 'terminal' THEN NULL ELSE ${terminalOwnerStateSql('s', 'u', 'srv_wakes')} END AS owner_token_state,
        srv_wakes.subscription_wakes
    FROM agent_sessions s LEFT JOIN agent_profiles p ON p.id = s.profile_id JOIN users u ON u.id = s.bot_id
    LEFT JOIN servers srv_wakes ON srv_wakes.id = s.server_id`;

export async function profileByName(db: any, channelId: string, name: string) {
    // Lock order is profile → session (as in profile edits and completions): take the
    // profile first, before any session lock, so /start can't deadlock with a PATCH.
    const row = await db.query(
        `SELECT p.* FROM agent_profiles p JOIN channels c ON c.server_id = p.server_id
         WHERE c.id = $1 AND p.name = $2
         FOR SHARE OF p`,
        [channelId, name]
    );
    if (!row.rows[0]) throw new CommandError(404, { error: 'unknown_profile' });
    return row.rows[0];
}

/**
 * A subscription profile runs on the owner's own CLI login: only the owner starts or resumes it.
 * A siwc profile runs on its plan owner's ChatGPT plan: only that person does. Callers pass
 * wakeAuthMode(profile), so a host-mode api_key profile is owner-only too (§10).
 */
export async function requireOwnerForSubscription(db: any, authMode: string | null, serverId: string, userId: string, planOwnerId: string | null = null) {
    if (authMode === 'api_key') return;
    if (authMode === 'siwc') {
        if (!planOwnerId || planOwnerId.trim() !== userId) throw new CommandError(403, { error: PLAN_OWNER_ONLY, message: PLAN_OWNER_ONLY_MESSAGE });
        return;
    }
    if (!await isServerOwner(db, serverId.trim(), userId)) {
        throw new CommandError(403, { error: SUBSCRIPTION_OWNER_ONLY, message: SUBSCRIPTION_OWNER_ONLY_MESSAGE });
    }
}

export async function botInChannel(db: any, botId: string, channelId: string) {
    const row = await db.query(
        `SELECT 1 FROM bot_channel_access WHERE bot_id = $1 AND channel_id = $2`, [botId, channelId]
    );
    if (row.rows.length === 0) throw new CommandError(400, { error: 'bot_not_in_channel' });
}

/** The agent's live channel session, or with `threadId` its live session in that thread. */
async function liveFor(db: any, channelId: string, botId: string, threadId: string | null = null) {
    const row = await db.query(`${SESSION_SELECT} WHERE s.channel_id = $1 AND s.bot_id = $2 AND s.state = 'live' AND s.kind = 'hosted'
        AND s.thread_id IS NOT DISTINCT FROM $3 FOR UPDATE OF s`, [channelId, botId, threadId]);
    return row.rows[0] ?? null;
}

/** The agent's live terminal session here (its user's own CLI, connected through agora-mcp). */
async function terminalFor(db: any, channelId: string, botId: string) {
    const row = await db.query(`${SESSION_SELECT} WHERE s.channel_id = $1 AND s.bot_id = $2 AND s.state = 'live' AND s.kind = 'terminal'`, [channelId, botId]);
    return row.rows[0] ?? null;
}

/** Shelve or end a session: queued work is dropped and a run in progress is asked to stop. */
async function stopSession(db: any, sessionId: string, to: 'shelved' | 'ended', reason: string, notices: Notice[] = []) {
    if (to === 'shelved') {
        await db.query(`UPDATE agent_sessions SET state = 'shelved', end_reason = $2, shelved_at = NOW() WHERE id = $1`, [sessionId, reason]);
    } else {
        await db.query(`UPDATE agent_sessions SET state = 'ended', end_reason = $2, ended_at = NOW() WHERE id = $1`, [sessionId, reason]);
    }
    await db.query(`UPDATE agent_inbox SET acked_at = NOW() WHERE session_id = $1 AND batch_id IS NULL AND acked_at IS NULL`, [sessionId]);
    await db.query(
        `UPDATE agent_batches SET status = 'dropped', finished_at = NOW() WHERE session_id = $1 AND status = 'retry'`,
        [sessionId]
    );
    await db.query(
        `UPDATE agent_runs SET cancel_requested = true, cancel_reason = $2 WHERE session_id = $1 AND status = 'claimed'`,
        [sessionId, to === 'shelved' ? 'shelved' : 'ended']
    );
    // A step the run was holding for a tool card must not run after the stop (#93)
    await expireLiveRequests(db, { sessionIds: [sessionId] }, 'stopped', notices);
}

/**
 * Post the session notice and queue it as the agent's first wake. A session scoped to a
 * thread hears it in that thread.
 */
export async function announce(db: any, channelId: string, sessionId: string, text: string, notices: Notice[], threadId: string | null = null) {
    const posted = await postSessionNotice(db, channelId, threadId, text);
    notices.push(...posted);
    await db.query(
        `INSERT INTO agent_inbox (id, session_id, message_id, thread_id, reason) VALUES ($1, $2, $3, $4, 'command')`,
        [generateUlid(), sessionId, posted[0].event.id, threadId]
    );
}

export async function agentCommandRoutes(app: FastifyInstance) {
    // POST /channels/:id/agent-commands
    app.post('/channels/:id/agent-commands', {
        schema: {
            body: {
                type: 'object',
                required: ['command'],
                additionalProperties: false,
                properties: {
                    command: { type: 'string', enum: ['start', 'end', 'sessions', 'resume', 'budget', 'wake', 'lurk', 'control'] },
                    // 'control': a command for the agent's CLI (docs/agent-commands.md), the same as `@agent /compact` in a message
                    control: { type: 'string', enum: Object.keys(CONTROLS) },
                    threadId: { type: 'string', minLength: 26, maxLength: 26 },
                    lurkMode: { type: ['string', 'null'], enum: ['quiet', 'balanced', 'vocal', null] },
                    profile: { type: 'string', minLength: 1, maxLength: 32 },
                    sessionId: { type: 'string', minLength: 26, maxLength: 26 },
                    // 'standby': start even though the agent is connected from a terminal (#112)
                    onLive: { type: 'string', enum: ['ask', 'shelve', 'keep', 'standby'] },
                    fresh: { type: 'boolean' },
                    // The session's own token limit; null: none of its own, its profile's applies
                    tokenBudget: LIMIT_SCHEMA,
                },
            },
        },
    }, async (request, reply) => {
        const { id: channelId } = request.params as any;
        const { command, profile: profileName, sessionId, onLive = 'ask', fresh = false, tokenBudget, lurkMode, control, threadId } = request.body as any;
        const db = request.dbClient!;
        const userId = request.userId;

        const access = await canViewChannel(db, channelId, userId, !!request.isBot);
        if (!access.allowed) return reply.status(403).send({ error: 'Channel access denied' });

        if (command === 'sessions') {
            // Channel access was checked above; bots aren't server members, so read past RLS
            // Channel sessions first: task card and subtask sessions are listed on the board too
            // Ended terminal sessions are left out: one is made each time a user's CLI connects
            const rows = await asService(db, () => db.query(
                `${SESSION_SELECT} WHERE s.channel_id = $1 AND NOT (s.kind = 'terminal' AND s.state = 'ended')
                 ORDER BY (s.thread_id IS NULL) DESC, (s.state = 'live') DESC, s.last_active_at DESC LIMIT 25`,
                [channelId]
            ));
            return reply.send({ sessions: rows.rows.map((r: any) => sessionJson(r, userId)) });
        }

        if (!await stampAuthority(db, channelId, userId, !!request.isBot)) {
            // Only the owner and directors can start, end or resume agent sessions
            return reply.status(403).send(await cannotDirect(db, channelId, userId));
        }
        if (command === 'control') {
            if (!profileName || !control) return reply.status(400).send({ error: 'profile and control are required' });
            // Notices are queued as events like the other commands; a refused command answers 409 (the notice says why)
            let profile: any;
            try { profile = await asService(db, () => profileByName(db, channelId, profileName)); }
            catch (err: any) { if (err instanceof CommandError) return reply.status(err.status).send(err.body); throw err; }
            // A thread to answer in must be a live top-level message of this channel
            if (threadId && !(await asService(db, () => db.query(
                `SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2 AND thread_id IS NULL AND deleted_at IS NULL`, [threadId, channelId]))).rows.length) {
                return reply.status(400).send({ error: 'invalid_thread' });
            }
            const run = await runControl(db, { channelId, messageId: null, threadId: threadId ?? null, authorId: userId, authorIsBot: !!request.isBot,
                couldDirect: true, botId: profile.bot_id.trim(), agentName: profile.name, name: control as ControlName, arg: null });
            request.pendingEvents ??= [];
            for (const n of run.notices) request.pendingEvents.push({ room: `channel:${n.channelId}`, event: n.eventName ?? 'Message', data: n.event });
            if (run.outcome === 'not_agent') return reply.status(404).send({ error: 'unknown_profile' });
            // Refused: the notice in the channel says why
            return reply.status(run.outcome === 'refused' ? 409 : 200).send({ ...(run.outcome === 'refused' ? { error: 'command_refused' } : {}), action: 'control', control, outcome: run.outcome });
        }
        if (['start', 'lurk'].includes(command) && !profileName) return reply.status(400).send({ error: 'profile is required' });
        if (command === 'end' && !profileName && !sessionId) return reply.status(400).send({ error: 'profile or sessionId is required' });
        if (command === 'lurk' && lurkMode === undefined) return reply.status(400).send({ error: 'lurkMode is required' });
        if (lurkMode !== undefined && command !== 'lurk' && command !== 'start') return reply.status(400).send({ error: 'lurkMode requires start or lurk' });
        if ((command === 'resume' || command === 'budget' || command === 'wake') && !sessionId) return reply.status(400).send({ error: 'sessionId is required' });

        if ((command === 'budget' || tokenBudget !== undefined) &&
            (request.isBot || !await isServerOwner(db, (await db.query('SELECT server_id FROM channels WHERE id = $1', [channelId])).rows[0].server_id.trim(), userId))) {
            return reply.status(403).send({ error: 'Only the owner can change session budgets' });
        }
        if (command === 'budget' && tokenBudget === undefined) return reply.status(400).send({ error: 'tokenBudget is required' });
        const who = (await db.query('SELECT username FROM users WHERE id = $1', [userId])).rows[0]?.username ?? 'someone';
        const notices: Notice[] = [];
        try {
            const result = await asService(db, async () => {
                if (command === 'lurk') {
                    const profile = await profileByName(db, channelId, profileName);
                    const live = await liveFor(db, channelId, profile.bot_id.trim());
                    if (!live) throw new CommandError(404, { error: 'no_live_session' });
                    await db.query('UPDATE agent_sessions SET lurk_mode = $2 WHERE id = $1', [live.id, lurkMode]);
                    if (lurkMode === null) await db.query(`UPDATE agent_inbox SET acked_at = NOW()
                        WHERE session_id = $1 AND reason = 'lurk' AND batch_id IS NULL AND acked_at IS NULL`, [live.id]);
                    notices.push(await sessionUpdate(db, live.id.trim(), !!live.running));
                    notices.push(await postNotice(db, channelId, `${who} set ${profile.name}'s lurk mode to ${lurkMode ?? 'off'}.`));
                    const row = await db.query(`${SESSION_SELECT} WHERE s.id = $1`, [live.id]);
                    return { status: 200, body: { action: 'lurk_updated', session: sessionJson(row.rows[0]) } };
                }
                if (command === 'budget') {
                    const updated = await db.query(`UPDATE agent_sessions SET token_budget = $3 WHERE id = $1 AND channel_id = $2 AND state <> 'ended' AND kind = 'hosted' RETURNING id`, [sessionId, channelId, tokenBudget]);
                    if (!updated.rows.length) throw new CommandError(404, { error: 'not_resumable' });
                    notices.push(await sessionUpdate(db, sessionId, true));
                    const row = await db.query(`${SESSION_SELECT} WHERE s.id = $1`, [sessionId]);
                    return { status: 200, body: { action: 'budget_updated', session: sessionJson(row.rows[0]) } };
                }
                if (command === 'wake') {
                    // Wake a session sleeping through a rate limit now; its next claim delivers what was held (#87)
                    const woken = await db.query(`UPDATE agent_sessions SET sleeping_until = NOW()
                        WHERE id = $1 AND channel_id = $2 AND state = 'live' AND sleeping_until > NOW() RETURNING id`, [sessionId, channelId]);
                    if (!woken.rows.length) throw new CommandError(409, { error: 'not_sleeping' });
                    notices.push(await sessionUpdate(db, sessionId, false));
                    notices.push(await postNotice(db, channelId, `${who} woke session ${sessionId} early.`));
                    const row = await db.query(`${SESSION_SELECT} WHERE s.id = $1`, [sessionId]);
                    return { status: 200, body: { action: 'woken', session: sessionJson(row.rows[0]) } };
                }
                if (command === 'end') return sessionId && !profileName
                    ? endSessionById(db, channelId, sessionId, who, notices) : endSession(db, channelId, profileName, who, notices);
                if (command === 'resume') return resumeSession(db, channelId, sessionId, onLive, userId, who, notices, tokenBudget);
                const started = await startSession(db, channelId, profileName, onLive, fresh, userId, who, notices);
                if (lurkMode !== undefined) {
                    await db.query('UPDATE agent_sessions SET lurk_mode = $2 WHERE id = $1', [started.body.session.id, lurkMode]);
                    started.body.session.lurkMode = lurkMode;
                }
                return started;
            });
            request.pendingEvents ??= [];
            for (const n of notices) request.pendingEvents.push({ room: `channel:${n.channelId}`, event: n.eventName ?? 'Message', data: n.event });
            return reply.status(result.status).send(result.body);
        } catch (err: any) {
            if (err instanceof CommandError) return reply.status(err.status).send(err.body);
            // Two /start commands raced: the other one created the live session
            if (err.code === '23505') return reply.status(409).send({ error: 'session_live' });
            throw err;
        }
    });
}

async function startSession(db: any, channelId: string, profileName: string, onLive: string, fresh: boolean,
                            userId: string, who: string, notices: Notice[]) {
    const profile = await profileByName(db, channelId, profileName);
    await requireOwnerForSubscription(db, wakeAuthMode(profile), profile.server_id, userId, profile.plan_owner_id);
    const botId = profile.bot_id.trim();
    await botInChannel(db, botId, channelId);

    // Connected from a terminal: the terminal answers here, so ask before starting a hosted session
    const terminal = await terminalFor(db, channelId, botId);
    if (terminal && onLive !== 'standby') {
        if (onLive === 'keep') return { status: 200, body: { action: 'kept_terminal', session: sessionJson(terminal) } };
        if (onLive === 'ask') throw new CommandError(409, {
            error: 'terminal_connected', message: `${profile.name} is already connected from a terminal.`, session: sessionJson(terminal),
        });
    }
    // After 'standby', a live hosted session is asked about as usual
    if (onLive === 'standby') onLive = 'ask';

    let shelvedNow = false;
    const live = await liveFor(db, channelId, botId);
    if (live) {
        if (onLive === 'keep') return { status: 200, body: { action: 'kept', session: sessionJson(live) } };
        if (onLive !== 'shelve') throw new CommandError(409, { error: 'session_live', session: sessionJson(live) });
        await stopSession(db, live.id.trim(), 'shelved', 'replaced', notices);
        shelvedNow = true;
    }

    // "Shelve and start new" starts fresh; otherwise pick up this profile's latest shelved session here
    if (!fresh && !shelvedNow) {
        const shelved = await db.query(
            `${SESSION_SELECT} WHERE s.channel_id = $1 AND s.profile_id = $2 AND s.state = 'shelved' AND s.thread_id IS NULL
             ORDER BY s.last_active_at DESC LIMIT 1 FOR UPDATE OF s`,
            [channelId, profile.id]
        );
        if (shelved.rows[0]) {
            const previous = shelved.rows[0];
            const id = previous.id.trim();
            await refuseAtLimit(db, id);
            // Resuming makes it the resumer's session: started_by decides the subscription rule
            await db.query(
                `UPDATE agent_sessions SET state = 'live', end_reason = NULL, limit_stop = NULL, shelved_at = NULL, last_active_at = NOW(), started_by = $2 WHERE id = $1`,
                [id, userId]
            );
            await announce(db, channelId, id, `${who} resumed ${profile.name}'s session (${id}).`, notices);
            if (terminal) await noticeStandby(db, channelId, botId, notices);
            const row = await db.query(`${SESSION_SELECT} WHERE s.id = $1`, [id]);
            return { status: 200, body: { action: 'resumed', session: sessionJson(row.rows[0]) } };
        }
    }

    const id = generateUlid();
    await db.query(
        `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, profile.server_id, channelId, botId, profile.id, userId, profile.workspace_id]
    );
    await announce(db, channelId, id,
        `${who} started a ${profile.name} session (${id})${shelvedNow ? '; the previous one is shelved' : ''}.`, notices);
    if (terminal) await noticeStandby(db, channelId, botId, notices);
    const row = await db.query(`${SESSION_SELECT} WHERE s.id = $1`, [id]);
    return { status: 201, body: { action: 'started', session: sessionJson(row.rows[0]) } };
}

/**
 * A session at one of its limits can't be resumed: 409 budget_exhausted, with the limit
 * (`limit.kind` 'wake' or 'token', the numbers, whose it is) so the caller can name it.
 */
export async function refuseAtLimit(db: any, sessionId: string): Promise<void> {
    const limit = await limitReached(db, sessionId);
    if (limit) throw new CommandError(409, { error: 'budget_exhausted', limit, message: limitStopSummary(limit, sessionId.trim()) });
}

/** End one session by ID: how a task card's or subtask's session is stopped. */
async function endSessionById(db: any, channelId: string, sessionId: string, who: string, notices: Notice[]) {
    // Profile before session, as everywhere else
    const profileOf = await db.query(`SELECT profile_id, kind FROM agent_sessions WHERE id = $1 AND channel_id = $2`, [sessionId, channelId]);
    if (!profileOf.rows[0]) throw new CommandError(404, { error: 'no_live_session' });
    // A terminal session is the user's own CLI: it ends when they close it
    if (profileOf.rows[0].kind === 'terminal') throw new CommandError(409, { error: 'terminal_session' });
    await db.query(`SELECT 1 FROM agent_profiles WHERE id = $1 FOR SHARE`, [profileOf.rows[0].profile_id]);
    const live = (await db.query(`${SESSION_SELECT} WHERE s.id = $1 AND s.channel_id = $2 FOR UPDATE OF s`, [sessionId, channelId])).rows[0];
    if (!live || live.state === 'ended') throw new CommandError(404, { error: 'no_live_session' });
    await stopSession(db, sessionId, 'ended', 'user', notices);
    notices.push(await sessionUpdate(db, sessionId, false));
    notices.push(...await postSessionNotice(db, channelId, live.thread_id?.trim() ?? null, `${who} ended ${live.profile_name}'s session (${sessionId}).`));
    const row = await db.query(`${SESSION_SELECT} WHERE s.id = $1`, [sessionId]);
    return { status: 200, body: { action: 'ended', session: sessionJson(row.rows[0]) } };
}

async function endSession(db: any, channelId: string, profileName: string, who: string, notices: Notice[]) {
    const profile = await profileByName(db, channelId, profileName);
    const live = await liveFor(db, channelId, profile.bot_id.trim());
    if (!live) throw new CommandError(404, { error: 'no_live_session' });
    await stopSession(db, live.id.trim(), 'ended', 'user', notices);
    notices.push(await postNotice(db, channelId, `${who} ended ${profile.name}'s session (${live.id.trim()}).`));
    const row = await db.query(`${SESSION_SELECT} WHERE s.id = $1`, [live.id]);
    return { status: 200, body: { action: 'ended', session: sessionJson(row.rows[0]) } };
}

async function resumeSession(db: any, channelId: string, sessionId: string, onLive: string, userId: string, who: string, notices: Notice[], tokenBudget?: number | null) {
    // Profile before session, as everywhere else
    const profileOf = await db.query(`SELECT profile_id FROM agent_sessions WHERE id = $1`, [sessionId]);
    if (profileOf.rows[0]) {
        await db.query(`SELECT 1 FROM agent_profiles WHERE id = $1 FOR SHARE`, [profileOf.rows[0].profile_id]);
    }
    const target = await db.query(`${SESSION_SELECT} WHERE s.id = $1 FOR UPDATE OF s`, [sessionId]);
    const t = target.rows[0];
    if (!t || t.kind !== 'hosted' || t.channel_id.trim() !== channelId.trim() || t.state !== 'shelved') {
        throw new CommandError(400, { error: 'not_resumable' });
    }
    await requireOwnerForSubscription(db, wakeAuthMode(t), t.server_id, userId, t.plan_owner_id);
    if (tokenBudget !== undefined) {
        await db.query('UPDATE agent_sessions SET token_budget = $2 WHERE id = $1', [sessionId, tokenBudget]);
        t.effective_token_budget = tokenBudget;
    }
    await refuseAtLimit(db, sessionId);
    const botId = t.bot_id.trim();
    await botInChannel(db, botId, channelId);

    // A task card's or subtask's session competes only with the agent's other session in its thread
    const threadId: string | null = t.thread_id?.trim() ?? null;
    const live = await liveFor(db, channelId, botId, threadId);
    if (live) {
        if (onLive === 'keep') return { status: 200, body: { action: 'kept', session: sessionJson(live) } };
        if (onLive !== 'shelve') throw new CommandError(409, { error: 'session_live', session: sessionJson(live) });
        await stopSession(db, live.id.trim(), 'shelved', 'replaced', notices);
    }
    await db.query(
        `UPDATE agent_sessions SET state = 'live', end_reason = NULL, limit_stop = NULL, shelved_at = NULL, last_active_at = NOW(), started_by = $2 WHERE id = $1`,
        [sessionId, userId]
    );
    await announce(db, channelId, sessionId, `${who} resumed ${t.profile_name}'s session (${sessionId}).`, notices, threadId);
    const row = await db.query(`${SESSION_SELECT} WHERE s.id = $1`, [sessionId]);
    return { status: 200, body: { action: 'resumed', session: sessionJson(row.rows[0]) } };
}
