import { createHash, randomBytes } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { generateUlid } from '../utils/ulid';
import { claimHandoffs } from './handoffs';
import { readAuthorities } from './direct-agents';
import { duration, expireLiveRequests, fileDeniedTools, hostStatus, openLiveRequest, sleepUntil, takeGrants } from './agent-permissions';
import { lurkBatchReady } from './agent-lurk';
import { consumeRunApproval, runApprovalGate, RUN_APPROVAL_TTL_HOURS, planNotice, PLAN_OWNER_SQL, SIWC_ERRORS } from './provider-terms';
import { recordCheckpoint, type CheckpointReport } from './agent-checkpoints';
import { claimProject, ownerAuthoredProject, readProject, verificationNotice, type ClaimProject, type VerificationReport } from './channel-projects';
import { reportSubtask } from './agent-subtasks';
import { budgetShelveNotice, creditShelveNotice, type ExhaustedBudget } from './agent-budget-notice';

/**
 * Runs: an agent host claims a batch of inbox rows, runs the agent, and reports back
 * (docs/planning/agent-sessions-wbs.md, "Host wire contract").
 *
 * These functions run their own short transactions on the pool: host routes release the
 * per-request transaction first, so a long poll never holds a pooled connection open. They
 * run as the table owner and scope every query to the host's own server and profiles.
 */

export const LEASE_SECONDS = 120;
export const HEARTBEAT_SECONDS = 30;
export const MAX_ATTEMPTS = 3;
export const MAX_BATCH = 20;

/** A channel event to emit after the transaction that produced it commits. */
export interface Notice { channelId: string; event: any; eventName?: 'Message' | 'MessageUpdate' | 'AgentSessionUpdate' | 'ThreadMetadataUpdate' | 'TaskCardUpdate' | 'AgentRunProgress' }
/** What an ACP run reports with its heartbeats; the step is the agent's own text. */
export interface RunProgress { step: string | null; toolCalls: number; planDone?: number | null; planTotal?: number | null }

export interface Host { id: string; serverId: string }

/** The host's token was revoked after the request authenticated. */
export class HostRevokedError extends Error {
    constructor() { super('host_revoked'); }
}

export function hashClaimToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

function deliveryKeyFor(inboxIds: string[]): string {
    return 'dk_' + createHash('sha256').update([...inboxIds].sort().join(',')).digest('hex').slice(0, 32);
}

async function inTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Insert a system notice in a channel, or as a reply in `threadId`; returns the socket event
 * to emit after commit. A thread reply also needs threadReplyCounted.
 */
export async function postNotice(c: PoolClient | any, channelId: string, content: string, threadId: string | null = null): Promise<Notice> {
    const id = generateUlid();
    await c.query(
        `INSERT INTO messages (id, channel_id, author_id, content, system_event, thread_id)
         VALUES ($1, $2, NULL, $3, 'agent_session', $4)`,
        [id, channelId, content, threadId]
    );
    return {
        channelId: channelId.trim(),
        event: {
            id, content, authorId: null, authorUsername: null,
            channelId: channelId.trim(), createdAt: new Date().toISOString(), systemEvent: 'agent_session',
            ...(threadId ? { threadId: threadId.trim() } : {}),
        },
    };
}

/** A reply was added to a thread: count it on the parent; returns the thread's update event. */
export async function threadReplyCounted(c: PoolClient | any, channelId: string, threadId: string): Promise<Notice> {
    const parent = await c.query(
        `UPDATE messages SET reply_count = reply_count + 1, last_reply_at = NOW() WHERE id = $1
         RETURNING reply_count, last_reply_at, thread_closed_at`,
        [threadId]
    );
    return {
        channelId: channelId.trim(), eventName: 'ThreadMetadataUpdate',
        event: { channelId: channelId.trim(), messageId: threadId.trim(), replyCount: parent.rows[0].reply_count,
            lastReplyAt: parent.rows[0].last_reply_at, threadClosedAt: parent.rows[0].thread_closed_at ?? null },
    };
}

/** A session notice: in the session's own thread for a task card or subtask session, else in the channel. */
export async function postSessionNotice(c: PoolClient | any, channelId: string, threadId: string | null, content: string): Promise<Notice[]> {
    const notice = await postNotice(c, channelId, content, threadId);
    return threadId ? [notice, await threadReplyCounted(c, channelId, threadId)] : [notice];
}

// ─── Claim ───

export async function sessionUpdate(c: PoolClient, sessionId: string, running: boolean): Promise<Notice> {
    const result = await c.query(`SELECT s.channel_id, s.state, s.end_reason, s.sleeping_until, s.kind, s.working, s.tool_calls,
        (SELECT json_build_object('id', btrim(r.id), 'status', r.status, 'startedAt', r.created_at,
            'finishedAt', r.finished_at, 'error', r.error, 'changedPaths', r.changed_paths)
         FROM agent_runs r WHERE r.session_id = s.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS run
        FROM agent_sessions s WHERE s.id = $1`, [sessionId]);
    const row = result.rows[0];
    const channelId = row.channel_id.trim();
    // A terminal session (#112) has no runs: "running" is what its agora-mcp last reported
    const terminal = row.kind === 'terminal';
    return { channelId, eventName: 'AgentSessionUpdate', event: { channelId, sessionId: sessionId.trim(), kind: row.kind,
        running: terminal ? row.state === 'live' && !!row.working : row.run?.status === 'claimed' && running,
        ...(terminal ? { toolCalls: row.tool_calls } : {}),
        run: row.run, state: row.state, endReason: row.end_reason, sleepingUntil: row.sleeping_until ?? null } };
}

export interface ClaimResult {
    run: {
        id: string; claimToken: string; attempt: number; deliveryKey: string;
        leaseSeconds: number; leaseUntil: string; heartbeatSeconds: number; timeoutSeconds: number;
        grantedTools: string[];
        /** The owner approved this run on its card (profiles with run approval). */
        ownerApproved: boolean;
    };
    session: {
        id: string; channelId: string; channelName: string;
        nativeSessionId: string | null; summary: string | null;
        wakesUsed: number; wakeBudget: number; tokensUsed: number; tokenBudget: number;
        wokeFromSleep: boolean;
        lurkMode: 'quiet' | 'balanced' | 'vocal' | null;
        /** The profile's plan owner started or last resumed this session (provider-terms.ts). */
        startedByOwner: boolean;
        /** A task card or subtask session works only in this thread (docs/task-board.md). */
        threadId: string | null;
        /** A subtask's parent session: the child's summary is posted back to it. */
        parentSessionId: string | null;
        scope: { kind: 'task' | 'subtask'; title: string } | null;
    };
    profile: {
        id: string; name: string; botId: string; adapter: string;
        authMode: 'subscription' | 'api_key' | 'siwc'; runApproval: boolean;
        /** Whose plan a 'subscription' or 'siwc' profile runs on; null for api_key or not yet connected. */
        planOwnerId: string | null;
        model: string | null; effort: string | null; workdirAlias: string;
        toolPresets: string[]; allowedTools: string[];
    };
    /** The channel's pinned instructions and files (channel-projects.ts); null when there are none. */
    project: ClaimProject | null;
    /** The owner's verify command for this channel; the host runs it only if its config allows it. */
    verify: { command: string; maxRetries: number } | null;
    inbox: Array<{
        messageId: string; threadId: string | null; reason: string;
        authorId: string | null; authorName: string | null; authorBot: boolean;
        authority: 'owner' | 'director' | null; content: string | null; createdAt: string;
    }>;
    /** Handoff offers in this batch addressed to the session, and handoffs that made it a thread's owner (handoffs.ts). */
    handoffs: Array<{ offerId: string; threadId: string; from: string; status: 'pending' | 'accepted';
        branch: string | null; headSha: string | null; senderRunning: boolean }>;
}

/** Try to claim work for this host. Returns null when there is none right now. */
export async function claimNext(pool: Pool, host: Host, notices: Notice[]): Promise<ClaimResult | null> {
    const candidates = await pool.query(
        `SELECT s.id FROM agent_sessions s
         JOIN agent_profiles p ON p.id = s.profile_id
         WHERE p.host_id = $1 AND p.server_id = $2 AND s.state = 'live'
           AND (s.sleeping_until IS NULL OR s.sleeping_until <= NOW())
           AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.session_id = s.id AND r.status = 'claimed')
           -- Waiting for the owner to answer a run approval card
           AND NOT (p.run_approval AND EXISTS (SELECT 1 FROM agent_run_approvals a WHERE a.session_id = s.id AND a.status = 'pending'
                    AND a.created_at > NOW() - make_interval(hours => $3)))
           AND (EXISTS (SELECT 1 FROM agent_batches b WHERE b.session_id = s.id AND b.status = 'retry')
                OR EXISTS (SELECT 1 FROM agent_inbox i WHERE i.session_id = s.id AND i.batch_id IS NULL AND i.acked_at IS NULL))
         ORDER BY s.last_active_at
         LIMIT 10`,
        [host.id, host.serverId, RUN_APPROVAL_TTL_HOURS]
    );
    for (const row of candidates.rows) {
        const result = await inTx(pool, c => claimSession(c, host, row.id.trim(), notices));
        if (result) return result;
    }
    return null;
}

async function claimSession(c: PoolClient, host: Host, sessionId: string, notices: Notice[]): Promise<ClaimResult | null> {
    // 1. Lock the session; skip it if another claim holds it or a run is active
    const s = await c.query(
        `SELECT s.*, p.name AS profile_name, p.adapter, p.model, p.effort, p.workdir_alias, p.wake_budget,
                COALESCE(s.token_budget, p.token_budget) AS token_budget, p.run_timeout_sec, p.generation, p.host_id, ch.name AS channel_name,
                p.tool_presets, p.allowed_tools, (s.sleeping_until > NOW()) AS asleep,
                p.auth_mode, p.run_approval, ${PLAN_OWNER_SQL} AS plan_owner_id,
                (s.started_by IS NOT NULL AND s.started_by = ${PLAN_OWNER_SQL}) AS started_by_owner,
                (SELECT t.title FROM task_cards t WHERE t.session_id = s.id) AS task_title
         FROM agent_sessions s
         JOIN agent_profiles p ON p.id = s.profile_id
         JOIN channels ch ON ch.id = s.channel_id
         JOIN servers srv ON srv.id = s.server_id
         WHERE s.id = $1 AND p.host_id = $2 AND s.server_id = $3
         FOR UPDATE OF s SKIP LOCKED`,
        [sessionId, host.id, host.serverId]
    );
    const session = s.rows[0];
    if (!session || session.state !== 'live' || session.asleep) return null;
    if ((await c.query(`SELECT 1 FROM agent_workspace_commands WHERE session_id=$1 AND status IN ('queued','claimed')`, [sessionId])).rows.length) return null;
    const active = await c.query(`SELECT 1 FROM agent_runs WHERE session_id = $1 AND status = 'claimed'`, [sessionId]);
    if (active.rows.length > 0) return null;
    // The host may have been revoked while its long poll was waiting
    const hostOk = await c.query(`SELECT 1 FROM agent_hosts WHERE id = $1 AND revoked_at IS NULL FOR SHARE`, [host.id]);
    if (hostOk.rows.length === 0) throw new HostRevokedError();

    const channelId = session.channel_id.trim();
    const botId = session.bot_id.trim();

    // 2. Budgets; a subtask also stops when a parent's budget is used up
    const exhausted: ExhaustedBudget | null = session.wakes_used >= session.wake_budget
        ? { sessionId, kind: 'wake', used: session.wakes_used, limit: session.wake_budget }
        : await exhaustedTokenBudget(c, sessionId);
    if (exhausted) {
        await shelveForBudget(c, sessionId, channelId, session.profile_name, notices, exhausted);
        return null;
    }

    // The agent must still be able to act in this channel at all
    if (!await botCanAct(c, botId, channelId)) {
        await c.query(
            `UPDATE agent_inbox SET acked_at = NOW() WHERE session_id = $1 AND acked_at IS NULL`,
            [sessionId]
        );
        await c.query(
            `UPDATE agent_batches SET status = 'dropped', finished_at = NOW() WHERE session_id = $1 AND status = 'retry'`,
            [sessionId]
        );
        return null;
    }

    // A session that slept through a rate limit (#87) wakes with everything held for it:
    // the batch that hit the limit goes back into the inbox and one new batch takes the
    // oldest rows, so the held messages arrive together in one turn.
    const wokeFromSleep = session.sleeping_until !== null;
    if (wokeFromSleep) {
        await c.query(
            `UPDATE agent_inbox SET batch_id = NULL
             WHERE acked_at IS NULL AND batch_id IN (SELECT id FROM agent_batches WHERE session_id = $1 AND status = 'retry')`,
            [sessionId]
        );
        await c.query(`UPDATE agent_batches SET status = 'dropped', finished_at = NOW() WHERE session_id = $1 AND status = 'retry'`, [sessionId]);
        await c.query(`UPDATE agent_sessions SET sleeping_until = NULL WHERE id = $1`, [sessionId]);
    }

    // 3. Pick the batch: a retry first, unchanged; otherwise the oldest pending rows
    let batchId: string;
    let attempt: number;
    const retry = await c.query(
        `SELECT id, delivery_key, attempts FROM agent_batches
         WHERE session_id = $1 AND status = 'retry' ORDER BY created_at LIMIT 1`,
        [sessionId]
    );
    const isRetry = !!retry.rows[0];
    let candidates;
    if (isRetry) {
        batchId = retry.rows[0].id.trim();
        attempt = retry.rows[0].attempts + 1;
        candidates = (await c.query(
            `SELECT id, thread_id FROM agent_inbox WHERE batch_id = $1 AND acked_at IS NULL ORDER BY id`,
            [batchId]
        )).rows;
    } else {
        candidates = (await c.query(
            `SELECT id, thread_id, reason, created_at, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::float8 AS db_now_ms
             FROM agent_inbox
             WHERE session_id = $1 AND batch_id IS NULL AND acked_at IS NULL
             ORDER BY id LIMIT $2`,
            [sessionId, MAX_BATCH]
        )).rows;
        // Measure the window on the database clock that stamped created_at, not the API's
        if (!lurkBatchReady(candidates, candidates[0]?.db_now_ms)) return null;
        batchId = generateUlid();
        attempt = 1;
    }

    // A CANCEL or DONE closes a thread under an exclusive lock on its binding and
    // acknowledges that thread's unclaimed rows. Hold a shared lock on the bindings
    // these rows belong to, then read the rows again: whatever a concurrent close
    // acknowledged before we got the lock is gone, and a close that comes later waits
    // for this claim and then finds (and flags) the run.
    const threadIds = [...new Set(candidates.filter((r: any) => r.thread_id).map((r: any) => r.thread_id.trim()))];
    if (threadIds.length > 0) {
        await c.query(`SELECT 1 FROM agent_session_threads WHERE thread_id = ANY($1) FOR SHARE`, [threadIds]);
    }
    const rows = candidates.length === 0 ? [] : (await c.query(
        `SELECT * FROM agent_inbox
         WHERE id = ANY($1) AND acked_at IS NULL AND ${isRetry ? 'batch_id = $2' : 'batch_id IS NULL'}
         ORDER BY id`,
        isRetry ? [candidates.map((r: any) => r.id), batchId] : [candidates.map((r: any) => r.id)]
    )).rows;
    // A retry keeps its batch's key; a new batch's key comes from the rows it actually took
    const deliveryKey: string = isRetry ? retry.rows[0].delivery_key : deliveryKeyFor(rows.map((r: any) => r.id.trim()));

    // 4. Recheck each row; rows that fail are acknowledged without work
    const subscription = session.auth_mode !== 'api_key';
    const planOwnerId: string | null = session.plan_owner_id?.trim() ?? null;
    const kept = await recheckRows(c, channelId, rows, subscription ? { startedByOwner: !!session.started_by_owner, planOwnerId } : null);
    // Turning lurk off invalidates pending passive work, including retry batches.
    for (let i = kept.length - 1; i >= 0; i--) {
        if (kept[i].row.reason === 'lurk' && !session.lurk_mode) kept.splice(i, 1);
    }
    const dropped = rows.filter((r: any) => !kept.some(k => k.row.id === r.id));
    if (dropped.length > 0) {
        await c.query(`UPDATE agent_inbox SET acked_at = NOW() WHERE id = ANY($1)`, [dropped.map((r: any) => r.id)]);
    }
    if (kept.length === 0) {
        if (isRetry) {
            await c.query(`UPDATE agent_batches SET status = 'dropped', finished_at = NOW() WHERE id = $1`, [batchId]);
        }
        // Work dropped only because someone other than the plan owner started this session
        if (subscription && !session.started_by_owner && rows.some((r: any) => r.reason !== 'lurk')) {
            notices.push(await postNotice(c, channelId, planNotice(session.profile_name, session.auth_mode, !!planOwnerId)));
        }
        return null;
    }

    // Profiles with run approval: the owner approves each wake on a card first
    let ownerApproved = false; let takeApproval = false;
    if (session.run_approval) {
        const first = kept.find(k => k.entry.content)?.entry;
        const preview = first ? `${first.authorName ?? 'notice'}: ${first.content}` : null;
        const gate = await runApprovalGate(c, { id: sessionId, server_id: session.server_id, channel_id: channelId, profile_name: session.profile_name },
            batchId, isRetry, preview, notices);
        if (gate === 'waiting') return null;
        ownerApproved = true; takeApproval = gate === 'approved';
    }

    // 5. Reserve the wake, create the batch (if new) and the run
    if (isRetry) {
        await c.query(`UPDATE agent_batches SET status = 'running', attempts = $2 WHERE id = $1`, [batchId, attempt]);
    } else {
        await c.query(
            `INSERT INTO agent_batches (id, session_id, delivery_key, attempts, status) VALUES ($1, $2, $3, 1, 'running')`,
            [batchId, sessionId, deliveryKey]
        );
        await c.query(
            `UPDATE agent_inbox SET batch_id = $1 WHERE id = ANY($2) AND batch_id IS NULL`,
            [batchId, rows.map((r: any) => r.id)]
        );
    }
    await c.query(`UPDATE agent_sessions SET wakes_used = wakes_used + 1 WHERE id = $1`, [sessionId]);
    if (takeApproval) await consumeRunApproval(c, sessionId, batchId);

    const runId = generateUlid();
    const claimToken = 'rt_' + randomBytes(32).toString('hex');
    const lease = await c.query(
        `INSERT INTO agent_runs (id, batch_id, session_id, host_id, claim_token_hash, attempt, profile_generation, lease_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + make_interval(secs => $8))
         RETURNING lease_until`,
        [runId, batchId, sessionId, host.id, hashClaimToken(claimToken), attempt, session.generation, LEASE_SECONDS]
    );

    const grantedTools = await takeGrants(c, sessionId, batchId, runId);
    const channelProject = await readProject(c, channelId);
    // Plan-owned profiles take project context from their plan owner only (provider-terms.ts)
    const wakeProject = subscription ? await ownerAuthoredProject(c, channelId, channelProject, planOwnerId) : channelProject;
    const project = claimProject(wakeProject, session.project_version_seen ?? null, !session.native_session_id);
    if (project) await c.query(`UPDATE agent_runs SET project_version = $2 WHERE id = $1`, [runId, project.version]);

    notices.push(await sessionUpdate(c, sessionId, true));
    return {
        run: {
            id: runId, claimToken, attempt, deliveryKey,
            leaseSeconds: LEASE_SECONDS, leaseUntil: new Date(lease.rows[0].lease_until).toISOString(),
            heartbeatSeconds: HEARTBEAT_SECONDS, timeoutSeconds: session.run_timeout_sec, grantedTools, ownerApproved,
        },
        session: {
            id: sessionId, channelId, channelName: session.channel_name,
            nativeSessionId: session.native_session_id ?? null, summary: session.summary ?? null,
            wakesUsed: session.wakes_used + 1, wakeBudget: session.wake_budget,
            tokensUsed: Number(session.tokens_used), tokenBudget: Number(session.token_budget), wokeFromSleep,
            lurkMode: session.lurk_mode ?? null, startedByOwner: !!session.started_by_owner,
            threadId: session.thread_id?.trim() ?? null, parentSessionId: session.parent_session_id?.trim() ?? null,
            scope: session.task_title != null ? { kind: 'task', title: session.task_title }
                : session.parent_session_id ? { kind: 'subtask', title: session.title ?? 'Subtask' } : null,
        },
        profile: {
            id: session.profile_id.trim(), name: session.profile_name, botId, adapter: session.adapter,
            authMode: session.auth_mode === 'siwc' ? 'siwc' : subscription ? 'subscription' : 'api_key', runApproval: !!session.run_approval,
            planOwnerId: subscription ? planOwnerId : null,
            model: session.model ?? null, effort: session.effort ?? null, workdirAlias: session.workdir_alias,
            toolPresets: session.tool_presets ?? [], allowedTools: session.allowed_tools ?? [],
        },
        project,
        // Lurk runs only read along; they never get a verify step
        verify: kept.every(k => k.entry.reason === 'lurk') ? null : channelProject.verify,
        inbox: kept.map(k => k.entry),
        handoffs: await claimHandoffs(c, sessionId, kept.map(k => k.entry.messageId),
            [...new Set(kept.map(k => k.entry.threadId).filter((t): t is string => !!t))]),
    };
}

/** Not paused, the bot and its owner active, and the bot still has access to the channel. */
async function botCanAct(c: PoolClient, botId: string, channelId: string): Promise<boolean> {
    const row = await c.query(
        `SELECT 1 FROM users u
         JOIN users o ON o.id = u.bot_owner_id
         JOIN bot_channel_access bca ON bca.bot_id = u.id AND bca.channel_id = $2
         WHERE u.id = $1 AND u.bot = true AND u.bot_paused_at IS NULL
           AND u.account_status = 'active' AND o.account_status = 'active'`,
        [botId, channelId]
    );
    return row.rows.length > 0;
}

/**
 * `terms` is set for a plan-owned profile (provider-terms.ts): only the plan owner's own
 * messages, the plan owner's commands, and hand-offs inside a session they started count.
 */
async function recheckRows(c: PoolClient, channelId: string, rows: any[], terms: { startedByOwner: boolean; planOwnerId: string | null } | null = null) {
    if (rows.length === 0) return [];
    const msgs = await c.query(
        `SELECT m.id, m.thread_id, m.author_id, m.content, m.created_at, m.author_could_direct, m.deleted_at,
                u.username, u.bot AS author_bot, m.system_event,
                -- A handoff offer card (src/lib/handoffs.ts) wakes its recipient while the offer is open,
                -- and still on a retry after the recipient accepted it in the failed attempt
                EXISTS (SELECT 1 FROM agent_handoffs h WHERE h.message_id = m.id
                        AND (h.status = 'accepted' OR (h.status = 'pending' AND h.expires_at > clock_timestamp()))) AS handoff_open
         FROM messages m LEFT JOIN users u ON u.id = m.author_id
         WHERE m.id = ANY($1)`,
        [rows.map(r => r.message_id)]
    );
    const byId = new Map<string, any>(msgs.rows.map((m: any) => [m.id.trim(), m]));
    const authorities = await readAuthorities(c, channelId, msgs.rows);

    const threadIds = [...new Set(rows.filter(r => r.thread_id).map(r => r.thread_id.trim()))];
    const openThreads = new Set<string>();
    if (threadIds.length > 0) {
        const open = await c.query(
            `SELECT thread_id FROM agent_session_threads WHERE thread_id = ANY($1) AND state = 'open'`,
            [threadIds]
        );
        for (const t of open.rows) openThreads.add(t.thread_id.trim());
    }

    const kept: Array<{ row: any; entry: ClaimResult['inbox'][number] }> = [];
    for (const row of rows) {
        const m = byId.get(row.message_id.trim());
        if (!m || m.deleted_at) continue;
        const authority = authorities.get(m.id.trim()) ?? null;
        if (row.reason === 'direct' && !authority) continue;
        // A session notice from /start or /resume: no author, valid while the session is live
        if (row.reason === 'command' && m.author_id) continue;
        const offer = row.reason === 'handoff' && m.system_event === 'agent_handoff';
        if (offer && !m.handoff_open) continue;
        if (!offer && (row.reason === 'handoff' || row.reason === 'protocol') && (!row.thread_id || !openThreads.has(row.thread_id.trim()))) continue;
        // A subtask's brief or summary: written by the server for a session it delegated, from an agent
        if (row.reason === 'delegate' && !m.author_bot) continue;
        if (terms) {
            if (!terms.startedByOwner || !terms.planOwnerId) continue;
            if ((row.reason === 'direct' || row.reason === 'lurk') && (!authority || m.author_bot || m.author_id?.trim() !== terms.planOwnerId)) continue;
            if ((row.reason === 'handoff' || row.reason === 'protocol') && !m.author_bot) continue;
        }
        kept.push({
            row,
            entry: {
                messageId: m.id.trim(),
                threadId: row.thread_id?.trim() ?? null,
                reason: row.reason,
                authorId: m.author_id?.trim() ?? null,
                authorName: m.username ?? null,
                authorBot: !!m.author_bot,
                authority,
                content: m.content,
                createdAt: new Date(m.created_at).toISOString(),
            },
        });
    }
    return kept;
}

interface Spend { id: string; depth: number; budget: number; spent: number }

/**
 * This session and each parent above it (depth 0 is the session), with its token budget and
 * what it and all its subtasks have spent: a subtask's tokens count against every parent
 * above it (docs/task-board.md). Reads only: never locks a parent, so a child's run can't
 * deadlock with its parent's.
 */
async function familySpend(c: PoolClient | any, sessionId: string): Promise<Spend[]> {
    const r = await c.query(
        `WITH RECURSIVE up AS (
             SELECT id, parent_session_id, 0 AS depth FROM agent_sessions WHERE id = $1
             UNION ALL
             SELECT p.id, p.parent_session_id, up.depth + 1 FROM agent_sessions p JOIN up ON p.id = up.parent_session_id WHERE up.depth < ${MAX_SUBTASK_DEPTH}
         ), down AS (
             SELECT id AS root, id, 0 AS depth FROM up
             UNION ALL
             SELECT down.root, s.id, down.depth + 1 FROM agent_sessions s JOIN down ON s.parent_session_id = down.id WHERE down.depth < ${MAX_SUBTASK_DEPTH}
         )
         SELECT btrim(r.id) AS id, up.depth, COALESCE(r.token_budget, p.token_budget) AS budget, SUM(s.tokens_used) AS spent
         FROM down
         JOIN agent_sessions s ON s.id = down.id
         JOIN agent_sessions r ON r.id = down.root JOIN agent_profiles p ON p.id = r.profile_id
         JOIN up ON up.id = down.root
         GROUP BY r.id, up.depth, r.token_budget, p.token_budget
         ORDER BY up.depth`,
        [sessionId]
    );
    return r.rows.map((row: any) => ({ id: row.id, depth: row.depth, budget: Number(row.budget), spent: Number(row.spent) }));
}

/** The ID of the session whose budget is used up (this one, or a parent it spends from), or null. */
export async function budgetExhausted(c: PoolClient | any, sessionId: string): Promise<string | null> {
    return (await exhaustedTokenBudget(c, sessionId))?.sessionId ?? null;
}

async function exhaustedTokenBudget(c: PoolClient | any, sessionId: string): Promise<ExhaustedBudget | null> {
    const spent = (await familySpend(c, sessionId)).find(s => s.spent >= s.budget);
    return spent ? { sessionId: spent.id, kind: 'token', used: spent.spent, limit: spent.budget } : null;
}

/** Tokens this session may still spend: the least any budget in its family has left. */
export async function budgetRemaining(c: PoolClient | any, sessionId: string): Promise<number> {
    return Math.min(...(await familySpend(c, sessionId)).map(s => s.budget - s.spent));
}

/** How deep subtasks may nest: a parent, its child and a grandchild. */
export const MAX_SUBTASK_DEPTH = 2;

async function shelveForBudget(c: PoolClient, sessionId: string, channelId: string, profileName: string, notices: Notice[], exhausted: ExhaustedBudget) {
    await shelveWithNotice(c, sessionId, channelId, notices, budgetShelveNotice(profileName, sessionId, exhausted));
}

/**
 * The host stopped a run because the profile's API key is out of credit (agora-host
 * `credit_exhausted`, e.g. an OpenRouter key whose credit limit is used up). Every further
 * wake would fail the same way, so the session is shelved like one over its own budget.
 */
async function shelveForCredit(c: PoolClient, run: any, notices: Notice[]) {
    const s = await c.query(`SELECT s.state, s.channel_id, p.name, p.api_key_env FROM agent_sessions s
        JOIN agent_profiles p ON p.id = s.profile_id WHERE s.id = $1`, [run.session_id]);
    const session = s.rows[0];
    if (run.cancel_requested || session?.state !== 'live') return;
    await shelveWithNotice(c, run.session_id.trim(), session.channel_id.trim(), notices, creditShelveNotice(session.name, run.session_id.trim(), session.api_key_env ?? null));
}

async function shelveWithNotice(c: PoolClient, sessionId: string, channelId: string, notices: Notice[], text: string) {
    await c.query(
        `UPDATE agent_sessions SET state = 'shelved', end_reason = 'budget', shelved_at = NOW() WHERE id = $1 AND state = 'live'`,
        [sessionId]
    );
    await c.query(`UPDATE agent_runs SET cancel_requested = true, cancel_reason = 'budget' WHERE session_id = $1 AND status = 'claimed'`, [sessionId]);
    await expireLiveRequests(c, { sessionIds: [sessionId] }, 'stopped', notices);
    notices.push(await sessionUpdate(c, sessionId, false));
    notices.push(await postNotice(c, channelId, text));
}

// ─── Heartbeat, complete, fail ───

export type RunCheck =
    | { ok: true; run: any }
    | { ok: false; status: number; body: any };

/**
 * Load a run for a host call and apply the fencing rules, in the contract's order. Locks the
 * run row. `finished` says which terminal status a repeat of this call may find.
 */
export async function checkRun(c: PoolClient, host: Host, runId: string, claimToken: string, finished: 'succeeded' | 'failed' | null,
                        notices: Notice[], lockProfile = false): Promise<RunCheck> {
    // Lock order, everywhere: profile → session → run → batch → inbox. Commands, claims and
    // the sweeper lock the session first too, so /end and a completion can't deadlock, and a
    // profile edit (profile, then its sessions) can't interleave with a completion's
    // generation check.
    const meta = await c.query(
        `SELECT r.session_id, s.profile_id FROM agent_runs r JOIN agent_sessions s ON s.id = r.session_id
         WHERE r.id = $1 AND r.host_id = $2 AND s.server_id = $3`,
        [runId, host.id, host.serverId]
    );
    if (!meta.rows[0]) return { ok: false, status: 404, body: { error: 'not_found' } };
    if (lockProfile) await c.query(`SELECT 1 FROM agent_profiles WHERE id = $1 FOR SHARE`, [meta.rows[0].profile_id]);
    await c.query(`SELECT 1 FROM agent_sessions WHERE id = $1 FOR UPDATE`, [meta.rows[0].session_id]);

    const r = await c.query(
        `SELECT r.*, (r.lease_until <= NOW()) AS lease_over
         FROM agent_runs r JOIN agent_sessions s ON s.id = r.session_id
         WHERE r.id = $1 AND r.host_id = $2 AND s.server_id = $3
         FOR UPDATE OF r`,
        [runId, host.id, host.serverId]
    );
    const run = r.rows[0];
    if (!run) return { ok: false, status: 404, body: { error: 'not_found' } };
    if (run.claim_token_hash !== hashClaimToken(claimToken)) return { ok: false, status: 409, body: { error: 'stale_claim' } };

    if (run.status !== 'claimed') {
        if (finished && run.status === finished) return { ok: false, status: 200, body: { ok: true, repeated: true } };
        if (run.status === 'expired') return { ok: false, status: 409, body: { error: 'lease_expired' } };
        return { ok: false, status: 409, body: { error: 'already_finished', status: run.status } };
    }
    if (run.lease_over) {
        await expireRun(c, run, notices);
        return { ok: false, status: 409, body: { error: 'lease_expired' } };
    }
    return { ok: true, run };
}

export async function heartbeat(pool: Pool, host: Host, runId: string, claimToken: string, notices: Notice[], tokensUsed?: number | null, progress?: RunProgress) {
    return inTx(pool, async c => {
        const check = await checkRun(c, host, runId, claimToken, null, notices);
        if (!check.ok) return { status: check.status, body: check.body };
        const run = check.run;
        await chargeUsage(c, run, tokensUsed);
        await enforceTokenBudget(c, run.session_id.trim(), notices);

        const reason = await cancelReason(c, run);
        if (reason) return { status: 200, body: { cancel: true, reason } };

        const lease = await c.query(
            `UPDATE agent_runs SET lease_until = NOW() + make_interval(secs => $2) WHERE id = $1 RETURNING lease_until`,
            [runId, LEASE_SECONDS]
        );
        if (progress) {
            // Live only: the channel shows it next to "is working…"; nothing is stored
            const s = await c.query(`SELECT channel_id FROM agent_sessions WHERE id = $1`, [run.session_id]);
            const channelId = s.rows[0]?.channel_id?.trim();
            if (channelId) notices.push({ channelId, eventName: 'AgentRunProgress', event: {
                channelId, sessionId: run.session_id.trim(), runId: run.id.trim(), step: cleanStep(progress.step),
                toolCalls: progress.toolCalls, planDone: progress.planDone ?? null, planTotal: progress.planTotal ?? null,
            } });
        }
        return { status: 200, body: { cancel: false, leaseUntil: new Date(lease.rows[0].lease_until).toISOString() } };
    });
}

/**
 * A running turn's approval request (#93): post its card, or report the one already posted
 * for this key. The host waits for the decision with liveToolRequest().
 */
export async function openToolRequest(pool: Pool, host: Host, runId: string, body: { claimToken: string; tool: string; requestKey: string; waitSeconds: number; detail?: string | null; cwd?: string | null },
                                      notices: Notice[]) {
    return inTx(pool, async c => {
        const check = await checkRun(c, host, runId, body.claimToken, null, notices);
        if (!check.ok) return { status: check.status, body: check.body };
        // A stopped, shelved, ended, paused or locked-out session waits on nothing
        if (await cancelReason(c, check.run)) {
            await expireLiveRequests(c, { runId }, 'stopped', notices);
            return { status: 200, body: { id: null, status: 'cancelled' } };
        }
        return { status: 200, body: await openLiveRequest(c, check.run, body, notices) };
    });
}

/** The decision on a live request; `close` ends the wait, expiring it if still undecided. */
export async function liveToolRequest(pool: Pool, host: Host, runId: string, requestId: string, body: { claimToken: string; close?: 'timeout' | 'resolved' | 'stopped' },
                                      notices: Notice[]) {
    return inTx(pool, async c => {
        const check = await checkRun(c, host, runId, body.claimToken, null, notices);
        if (!check.ok) return { status: check.status, body: check.body };
        // Session is locked by checkRun, so a decision can't interleave (lock order: session → request)
        const r = await c.query(`SELECT status FROM agent_tool_requests WHERE id = $1 AND run_id = $2 AND request_key IS NOT NULL FOR UPDATE`, [requestId, runId]);
        if (!r.rows[0]) return { status: 404, body: { error: 'not_found' } };
        // Once the run must stop, nothing it waited on may run, even a decision made before the
        // stop that the host hasn't read yet
        if (await cancelReason(c, check.run)) {
            await expireLiveRequests(c, { runId }, 'stopped', notices);
            return { status: 200, body: { status: 'cancelled' } };
        }
        if (body.close && r.rows[0].status === 'waiting') {
            await expireLiveRequests(c, { runId, requestId }, body.close, notices);
            return { status: 200, body: { status: 'expired' } };
        }
        return { status: 200, body: { status: hostStatus(r.rows[0].status) } };
    });
}

/** The step is agent-controlled text: drop control, format and line-separator characters before broadcast. */
export function cleanStep(step: string | null | undefined): string | null {
    if (typeof step !== 'string') return null;
    return step.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
}

/** Why the host must stop this run, or null. */
export async function cancelReason(c: PoolClient, run: any): Promise<string | null> {
    if (run.cancel_requested) return run.cancel_reason ?? 'ended';
    const s = await c.query(
        `SELECT s.state, s.channel_id, s.bot_id FROM agent_sessions s WHERE s.id = $1`,
        [run.session_id]
    );
    const session = s.rows[0];
    if (!session) return 'ended';
    if (session.state === 'shelved') return 'shelved';
    if (session.state !== 'live') return 'ended';
    const bot = await c.query(`SELECT bot_paused_at FROM users WHERE id = $1`, [session.bot_id]);
    if (bot.rows[0]?.bot_paused_at) return 'paused';
    if (!await botCanAct(c, session.bot_id.trim(), session.channel_id.trim())) return 'access_lost';
    return null;
}

export interface CompleteBody { checkpoint?: CheckpointReport; claimToken: string; nativeSessionId?: string | null; tokensUsed?: number | null; summary?: string | null; changedPaths?: string[]; branch?: string; baseSha?: string; headSha?: string; deniedTools?: string[]; verification?: VerificationReport }

export async function complete(pool: Pool, host: Host, runId: string, body: CompleteBody, notices: Notice[]) {
    return inTx(pool, async c => {
        const check = await checkRun(c, host, runId, body.claimToken, 'succeeded', notices, true);
        if (!check.ok) return { status: check.status, body: check.body };
        const run = check.run;
        const hasBranch = body.branch !== undefined || body.baseSha !== undefined || body.headSha !== undefined;
        if (hasBranch && (!/^agora\/[a-z0-9][a-z0-9_-]{0,31}\/[0-9A-HJKMNP-TV-Z]{26}$/.test(body.branch ?? '')
            || !body.branch?.endsWith(`/${run.session_id.trim()}`)
            || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(body.baseSha ?? '')
            || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(body.headSha ?? ''))) return { status: 400, body: { error: 'invalid_workspace_report' } };
        if (!await recordCheckpoint(c,run,body.checkpoint,notices)) return { status:400,body:{error:'invalid_checkpoint_binding'} };
        const tokens = await chargeUsage(c, run, body.tokensUsed);

        await c.query(
            `UPDATE agent_runs SET status = 'succeeded', finished_at = NOW(), tokens_used = $2,
                    native_session_id = $3, summary = $4, changed_paths = $5, branch = $6, base_sha = $7, head_sha = $8
             WHERE id = $1`,
            [runId, tokens, body.nativeSessionId ?? null, body.summary ?? null, [...new Set(body.changedPaths ?? [])], body.branch ?? null, body.baseSha ?? null, body.headSha ?? null]
        );
        await expireLiveRequests(c, { runId }, 'stopped', notices);
        await fileDeniedTools(c, run, body.deniedTools, notices);
        await recordVerification(c, run, body.verification, notices);
        // A subtask's summary is posted back to its parent for it, so it needn't post anything itself
        const subtask = (await c.query(`SELECT parent_session_id FROM agent_sessions WHERE id = $1`, [run.session_id])).rows[0]?.parent_session_id;
        const posted = await c.query(`SELECT 1 FROM messages m JOIN agent_sessions s ON s.bot_id = m.author_id
            WHERE s.id = $1 AND m.channel_id = s.channel_id AND m.created_at >= $2 LIMIT 1`, [run.session_id, run.created_at]);
        const addressed = await c.query(`SELECT 1 FROM agent_inbox WHERE batch_id = $1 AND reason <> 'lurk' AND acked_at IS NULL LIMIT 1`, [run.batch_id]);
        if (!subtask && !posted.rows.length && addressed.rows.length > 0) {
            await c.query(`UPDATE agent_runs SET error = 'nothing_posted' WHERE id = $1`, [runId]);
            const name = await c.query(`SELECT p.name, s.channel_id FROM agent_sessions s JOIN agent_profiles p ON p.id = s.profile_id WHERE s.id = $1`, [run.session_id]);
            notices.push(await postNotice(c, name.rows[0].channel_id.trim(), `${name.rows[0].name} finished without posting a reply. The run may be blocked; check its permissions or wake it again.`));
        }
        await c.query(`UPDATE agent_batches SET status = 'done', finished_at = NOW() WHERE id = $1`, [run.batch_id]);
        await c.query(`UPDATE agent_inbox SET acked_at = NOW() WHERE batch_id = $1 AND acked_at IS NULL`, [run.batch_id]);

        // A run claimed before an incompatible profile edit must not restore an old session ID
        const s = await c.query(
            `UPDATE agent_sessions s SET
                native_session_id = CASE WHEN $2::text IS NOT NULL AND p.generation = $4 THEN $2 ELSE s.native_session_id END,
                summary = COALESCE($3, s.summary),
                branch = CASE WHEN p.generation = $4 THEN COALESCE($5, s.branch) ELSE s.branch END,
                base_sha = CASE WHEN p.generation = $4 THEN COALESCE($6, s.base_sha) ELSE s.base_sha END,
                head_sha = CASE WHEN p.generation = $4 THEN COALESCE($7, s.head_sha) ELSE s.head_sha END,
                project_version_seen = COALESCE($8, s.project_version_seen),
                last_active_at = NOW()
             FROM agent_profiles p
             WHERE s.id = $1 AND p.id = s.profile_id
             RETURNING s.state, s.tokens_used, s.channel_id, COALESCE(s.token_budget, p.token_budget) AS token_budget, p.name AS profile_name`,
            [run.session_id, body.nativeSessionId ?? null, body.summary ?? null, run.profile_generation, body.branch ?? null, body.baseSha ?? null, body.headSha ?? null,
             run.project_version ?? null]
        );
        const session = s.rows[0];
        // A finished subtask: its summary goes back to the parent and the child is shelved as done
        const reported = !!subtask && !run.cancel_requested && session?.state === 'live'
            && await reportSubtask(c, run.session_id.trim(), body.summary ?? null, notices);
        notices.push(await sessionUpdate(c, run.session_id, false));
        const exhausted = session && session.state === 'live' && !reported ? await exhaustedTokenBudget(c, run.session_id.trim()) : null;
        if (exhausted) {
            await shelveForBudget(c, run.session_id.trim(), session.channel_id.trim(), session.profile_name, notices, exhausted);
        }
        return { status: 200, body: run.cancel_requested ? { ok: true, cancelled: true } : { ok: true } };
    });
}

export interface FailBody { checkpoint?: CheckpointReport; claimToken: string; error: string; message?: string; tokensUsed?: number | null; retryable?: boolean; changedPaths?: string[]; deniedTools?: string[]; rateLimit?: { resetAt?: string | null }; verification?: VerificationReport }

export async function fail(pool: Pool, host: Host, runId: string, body: FailBody, notices: Notice[]) {
    return inTx(pool, async c => {
        const check = await checkRun(c, host, runId, body.claimToken, 'failed', notices, true);
        if (!check.ok) return { status: check.status, body: check.body };
        const run = check.run;
        if (!await recordCheckpoint(c,run,body.checkpoint,notices)) return { status:400,body:{error:'invalid_checkpoint_binding'} };
        const tokens = await chargeUsage(c, run, body.tokensUsed);

        await c.query(
            `UPDATE agent_runs SET status = 'failed', finished_at = NOW(), tokens_used = $2, error = $3, error_message = $4, changed_paths = $5
             WHERE id = $1`,
            [runId, tokens, body.error.slice(0, 64), body.message?.slice(0, 2000) ?? null, [...new Set(body.changedPaths ?? [])]]
        );
        await enforceTokenBudget(c, run.session_id.trim(), notices);
        await expireLiveRequests(c, { runId }, 'stopped', notices);
        await fileDeniedTools(c, run, body.deniedTools, notices);
        await recordVerification(c, run, body.verification, notices);
        // Out of credit: shelved with its own notice; settleBatch then drops the batch quietly
        if (body.error === 'credit_exhausted') await shelveForCredit(c, run, notices);
        if (body.error === 'rate_limited' && await sleepForRateLimit(c, run, body.rateLimit?.resetAt ?? null, notices)) {
            notices.push(await sessionUpdate(c, run.session_id, false));
            return { status: 200, body: { ok: true, sleeping: true } };
        }
        notices.push(await sessionUpdate(c, run.session_id, false));
        await settleBatch(c, run, !!body.retryable && !run.cancel_requested, body.error, notices);
        return { status: 200, body: { ok: true } };
    });
}

/** Keep the host's verify result on the run and post it in the channel (docs/project-context.md). */
async function recordVerification(c: PoolClient, run: any, v: VerificationReport | undefined, notices: Notice[]) {
    if (!v) return;
    await c.query(`UPDATE agent_runs SET verification = $2 WHERE id = $1`, [run.id, JSON.stringify(v)]);
    const s = await c.query(`SELECT s.channel_id, p.name FROM agent_sessions s JOIN agent_profiles p ON p.id = s.profile_id WHERE s.id = $1`, [run.session_id]);
    notices.push(await postNotice(c, s.rows[0].channel_id.trim(), verificationNotice(s.rows[0].name, v)));
}

/**
 * After a failed or expired attempt: retry the batch unchanged, or give it up. Cancelled
 * work and work for sessions that are no longer live is dropped, never retried.
 */
async function settleBatch(c: PoolClient, run: any, retryable: boolean, error: string, notices: Notice[]) {
    const s = await c.query(
        `SELECT s.state, s.channel_id, p.name AS profile_name, p.auth_mode FROM agent_sessions s
         JOIN agent_profiles p ON p.id = s.profile_id WHERE s.id = $1`,
        [run.session_id]
    );
    const session = s.rows[0];
    const b = await c.query(`SELECT attempts FROM agent_batches WHERE id = $1`, [run.batch_id]);
    const attempts = b.rows[0]?.attempts ?? MAX_ATTEMPTS;

    if (run.cancel_requested || !session || session.state !== 'live') {
        await c.query(`UPDATE agent_batches SET status = 'dropped', finished_at = NOW() WHERE id = $1`, [run.batch_id]);
        await c.query(`UPDATE agent_inbox SET acked_at = NOW() WHERE batch_id = $1 AND acked_at IS NULL`, [run.batch_id]);
        return;
    }
    if (retryable && attempts < MAX_ATTEMPTS) {
        await c.query(`UPDATE agent_batches SET status = 'retry' WHERE id = $1`, [run.batch_id]);
        return;
    }
    await c.query(`UPDATE agent_batches SET status = 'failed', finished_at = NOW() WHERE id = $1`, [run.batch_id]);
    await c.query(`UPDATE agent_inbox SET acked_at = NOW() WHERE batch_id = $1 AND acked_at IS NULL`, [run.batch_id]);
    // The host refused the run under the provider-terms rules (agora-host/src/terms.ts)
    const text = error === 'subscription_owner_only' ? planNotice(session.profile_name, 'subscription')
        : Object.hasOwn(SIWC_ERRORS, error) ? `${session.profile_name} ${SIWC_ERRORS[error]}`
        : error === 'run_not_approved' ? `${session.profile_name} needs the owner's approval for every run; its host refused a run without one.`
        : `${session.profile_name} couldn't handle its last wake after ${attempts} attempt(s): ${error}.`;
    notices.push(await postNotice(c, session.channel_id.trim(), text));
}

/**
 * The CLI hit its account's rate limit (#87): the session sleeps until the limit resets and
 * its batch waits, without spending a retry or a wake. Other live sessions of the same
 * profile share the CLI login, so they sleep too (skipping any locked by their own run).
 * Returns false when the session can't sleep (no longer live, or cancelled).
 */
async function sleepForRateLimit(c: PoolClient, run: any, resetAt: string | null, notices: Notice[]): Promise<boolean> {
    const s = await c.query(
        `SELECT s.state, s.channel_id, s.profile_id, p.name AS profile_name FROM agent_sessions s
         JOIN agent_profiles p ON p.id = s.profile_id WHERE s.id = $1`,
        [run.session_id]
    );
    const session = s.rows[0];
    if (run.cancel_requested || !session || session.state !== 'live') return false;
    const until = sleepUntil(resetAt);
    await c.query(`UPDATE agent_sessions SET sleeping_until = $2, wakes_used = GREATEST(wakes_used - 1, 0) WHERE id = $1`, [run.session_id, until]);
    await c.query(`UPDATE agent_batches SET status = 'retry', attempts = GREATEST(attempts - 1, 0) WHERE id = $1`, [run.batch_id]);
    const others = await c.query(
        `UPDATE agent_sessions SET sleeping_until = GREATEST(COALESCE(sleeping_until, $2), $2)
         WHERE id IN (SELECT id FROM agent_sessions WHERE profile_id = $1 AND state = 'live' AND id <> $3 FOR UPDATE SKIP LOCKED)
         RETURNING id`,
        [session.profile_id, until, run.session_id]
    );
    for (const o of others.rows) notices.push(await sessionUpdate(c, o.id, false));
    notices.push(await postNotice(c, session.channel_id.trim(),
        `${session.profile_name} hit its rate limit and is sleeping for about ${duration(until.getTime() - Date.now())} (until ${until.toISOString().slice(11, 16)} UTC). `
        + 'Messages for it are held and delivered together when it wakes.'));
    return true;
}

/** Expire one claimed run whose lease is over. Keep usage already reported by heartbeats. */
async function expireRun(c: PoolClient, run: any, notices: Notice[]) {
    await c.query(
        `UPDATE agent_runs SET status = 'expired', finished_at = NOW() WHERE id = $1 AND status = 'claimed'`,
        [run.id]
    );
    await expireLiveRequests(c, { runId: run.id }, 'stopped', notices);
    notices.push(await sessionUpdate(c, run.session_id, false));
    await settleBatch(c, run, true, 'lease_expired', notices);
}

/** Sweeper: expire every claimed run past its lease. Returns how many it expired. */
export async function sweepExpiredRuns(pool: Pool, notices: Notice[]): Promise<number> {
    const due = await pool.query(`SELECT id, session_id FROM agent_runs WHERE status = 'claimed' AND lease_until <= NOW()`);
    let n = 0;
    for (const { id, session_id } of due.rows) {
        await inTx(pool, async c => {
            // Same lock order as everywhere else: session, then run
            await c.query(`SELECT 1 FROM agent_sessions WHERE id = $1 FOR UPDATE`, [session_id]);
            const r = await c.query(
                `SELECT * FROM agent_runs WHERE id = $1 AND status = 'claimed' AND lease_until <= NOW() FOR UPDATE`,
                [id]
            );
            if (r.rows[0]) { await expireRun(c, r.rows[0], notices); n++; }
        });
    }
    return n;
}

/** Hosts report cumulative usage for this run. Repeated or older reports never double charge. */
async function chargeUsage(c: PoolClient, run: any, reported?: number | null): Promise<number | null> {
    const previous = Number(run.tokens_used ?? 0);
    if (reported == null) return run.tokens_used == null ? null : previous;
    const total = Math.max(previous, reported);
    await c.query('UPDATE agent_runs SET tokens_used = $2 WHERE id = $1', [run.id, total]);
    await c.query('UPDATE agent_sessions SET tokens_used = tokens_used + $2 WHERE id = $1', [run.session_id, total - previous]);
    run.tokens_used = total;
    return total;
}

async function enforceTokenBudget(c: PoolClient, sessionId: string, notices: Notice[]) {
    const r = await c.query(`SELECT s.state, s.channel_id, p.name
        FROM agent_sessions s JOIN agent_profiles p ON p.id = s.profile_id WHERE s.id = $1`, [sessionId]);
    const s = r.rows[0];
    if (s?.state !== 'live') return;
    const exhausted = await exhaustedTokenBudget(c, sessionId);
    if (exhausted) await shelveForBudget(c, sessionId, s.channel_id.trim(), s.name, notices, exhausted);
}
