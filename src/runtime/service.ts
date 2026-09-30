import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { generateUlid } from '../utils/ulid';
import { config } from '../config';
import { CAPABILITIES, type Capability } from '../ai/adapters';
import { publishEvents, type BridgedEvent } from '../lib/event-bridge';
import { postSystemMessage, updateSystemMessage } from '../gateway/post-message';
import { RUNTIME_QUEUE } from './runner';
import { resolveLimits, timeProfileFor, type RunLimits } from './limits';
import { RulesDecider, type Decider, type Decision } from './decider';

/**
 * Run submission, approval, and results (WBS 3.5 / 3.6). Writes use the pool
 * (autocommit) so a job is only enqueued after its row is committed.
 */

export const APPROVAL_TTL_MS = 30 * 60 * 1000;
const TERMINAL = ['succeeded', 'failed', 'timeout', 'killed', 'error', 'denied'];

let queue: Queue | null = null;
let redis: Redis | null = null;

function redisConnection() {
    const url = new URL(config.redisUrl);
    return {
        host: url.hostname,
        port: Number(url.port || 6379),
        db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
        password: url.password || undefined,
        maxRetriesPerRequest: null,
    };
}

export function runtimeQueue(): Queue {
    queue ??= new Queue(RUNTIME_QUEUE, { connection: redisConnection() });
    return queue;
}

export function runtimeRedis(): Redis {
    redis ??= new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    return redis;
}

export async function closeRuntimeClients(): Promise<void> {
    await queue?.close().catch(() => {});
    redis?.disconnect();
    queue = null;
    redis = null;
}

let decider: Decider = new RulesDecider();
/** Swap the decider (webhook / Jev in WBS 2.2–2.3; tests). */
export function setDecider(d: Decider) { decider = d; }

export async function codeRetentionDays(db: Pool): Promise<number | null> {
    const res = await db.query("SELECT value FROM instance_settings WHERE key = 'runtime.code_retention_days'");
    const v = res.rows[0]?.value;
    return typeof v === 'number' && v > 0 ? v : v === null ? null : 30;
}

export function codeExpiresAt(createdAt: Date, retentionDays: number | null): Date | null {
    return retentionDays ? new Date(createdAt.getTime() + retentionDays * 86_400_000) : null;
}

function retentionNote(expires: Date | null): string {
    return expires ? `Code for this run will be deleted on ${expires.toISOString().slice(0, 10)}.` : 'Code for this run is kept indefinitely.';
}

async function enqueue(runId: string) {
    await runtimeQueue().add('run', { runId }, { jobId: runId, removeOnComplete: true, removeOnFail: 100, attempts: 1 });
}

export interface SubmitInput {
    serverId: string;
    channelId: string;
    threadId: string | null;
    submitterId: string;
    code: string;
    capabilities: Capability[];
    limits?: Partial<RunLimits>;
}

export interface SubmitResult {
    id: string;
    status: string;
    gate: Decision;
    limits: RunLimits;
    timeProfile: string;
    codeExpiresAt: string | null;
}

export async function submitRun(db: Pool, input: SubmitInput): Promise<SubmitResult> {
    const capabilities = [...new Set(input.capabilities)].filter(c => (CAPABILITIES as readonly string[]).includes(c)) as Capability[];
    const profile = timeProfileFor(capabilities);
    const limits = resolveLimits(profile, input.limits ?? {});
    const id = generateUlid();
    const codeSha = createHash('sha256').update(input.code).digest('hex');

    await db.query(
        `INSERT INTO exec_runs (id, server_id, channel_id, thread_id, submitted_by, code, code_sha256,
                                requested_capabilities, time_profile, limits, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'submitted')`,
        [id, input.serverId, input.channelId, input.threadId, input.submitterId, input.code, codeSha,
         capabilities, profile, JSON.stringify(limits)]
    );

    const submitter = (await db.query('SELECT bot, runtime_access, bot_paused_at FROM users WHERE id = $1', [input.submitterId])).rows[0];
    const routes = await db.query('SELECT capability FROM ai_capability_routes WHERE server_id = $1 AND enabled = true', [input.serverId]);
    const queued = await db.query(
        "SELECT COUNT(*)::int AS n FROM exec_runs WHERE server_id = $1 AND status IN ('queued', 'awaiting_approval')",
        [input.serverId]
    );

    const gate = await decider.decideExecution({
        runId: id,
        serverId: input.serverId,
        submitterId: input.submitterId,
        submitterIsBot: !!submitter?.bot,
        runtimeAccess: submitter?.runtime_access ?? 'none',
        submitterPaused: !!submitter?.bot_paused_at,
        code: input.code,
        codeSha256: codeSha,
        requestedCapabilities: capabilities,
        enabledCapabilities: routes.rows.map((r: any) => r.capability),
        limits,
        queuedForServer: queued.rows[0].n,
    });

    const status = gate.decision === 'deny' ? 'denied' : gate.decision === 'needs_approval' ? 'awaiting_approval' : 'queued';
    const updated = await db.query(
        `UPDATE exec_runs SET status = $1, gate_decision = $2, gate_source = $3, gate_confidence = $4, gate_reason = $5
         ${status === 'denied' ? ', finished_at = NOW()' : ''}
         WHERE id = $6 RETURNING created_at`,
        [status, gate.decision, gate.source, gate.confidence ?? null, gate.reason, id]
    );
    const expires = codeExpiresAt(updated.rows[0].created_at, await codeRetentionDays(db));

    if (status === 'awaiting_approval') {
        const { events } = await postSystemMessage(db, {
            channelId: input.channelId,
            threadId: input.threadId,
            systemEvent: 'runtime_approval',
            systemData: { kind: 'runtime_approval', runId: id, status: 'pending', capabilities, submittedBy: input.submitterId, timeProfile: profile, wallClockMs: limits.wallClockMs },
            content: `A bot wants to run code (run ${id}). Capabilities: ${capabilities.length ? capabilities.join(', ') : 'none'}; `
                + `time limit ${Math.round(limits.wallClockMs / 1000)} s. A member with Manage Bots can review and approve it. `
                + `Approval expires in 30 minutes. ${retentionNote(expires)}`,
        });
        await publishEvents(runtimeRedis(), events);
    } else if (status === 'queued') {
        await enqueue(id);
    }

    return { id, status, gate, limits, timeProfile: profile, codeExpiresAt: expires?.toISOString() ?? null };
}

async function findApprovalMessage(db: Pool, runId: string): Promise<{ id: string; data: any } | null> {
    const res = await db.query(
        "SELECT id, system_data FROM messages WHERE system_event = 'runtime_approval' AND system_data->>'runId' = $1 LIMIT 1",
        [runId]
    );
    return res.rows[0] ? { id: res.rows[0].id.trim(), data: res.rows[0].system_data } : null;
}

export type ReviewResult = { ok: true; status: string } | { ok: false; status: number; error: string };

/** Approve or deny a run awaiting approval. Caller has already checked the reviewer's permissions. */
export async function reviewRun(db: Pool, runId: string, reviewerId: string, approve: boolean): Promise<ReviewResult> {
    const run = (await db.query('SELECT status, created_at, submitted_by FROM exec_runs WHERE id = $1', [runId])).rows[0];
    if (!run) return { ok: false, status: 404, error: 'Run not found' };
    if (run.submitted_by?.trim() === reviewerId.trim()) return { ok: false, status: 403, error: 'You cannot review your own run' };
    if (run.status !== 'awaiting_approval') return { ok: false, status: 409, error: `Run is ${run.status}, not awaiting approval` };

    const expired = Date.now() - new Date(run.created_at).getTime() > APPROVAL_TTL_MS;
    const finalStatus = approve && !expired ? 'queued' : 'denied';
    const approved = finalStatus === 'queued';
    const res = await db.query(
        `UPDATE exec_runs SET status = $1,
             approved_by = CASE WHEN $5::boolean THEN $2 ELSE approved_by END,
             approved_at = CASE WHEN $5::boolean THEN NOW() ELSE approved_at END,
             gate_reason = CASE WHEN $5::boolean THEN gate_reason ELSE $3 END,
             finished_at = CASE WHEN $5::boolean THEN finished_at ELSE NOW() END
         WHERE id = $4 AND status = 'awaiting_approval' RETURNING status`,
        [finalStatus, reviewerId, expired ? 'Approval window expired' : 'Denied by a reviewer', runId, approved]
    );
    if (res.rows.length === 0) return { ok: false, status: 409, error: 'Run was already reviewed' };

    await db.query(
        `INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, reason)
         SELECT $1, server_id, $2, $3, 'exec_run', id, $4 FROM exec_runs WHERE id = $5`,
        [generateUlid(), reviewerId, finalStatus === 'queued' ? 'runtime_approve' : 'runtime_deny', expired ? 'expired' : null, runId]
    );

    const reviewer = (await db.query('SELECT username FROM users WHERE id = $1', [reviewerId])).rows[0]?.username ?? 'a reviewer';
    const card = await findApprovalMessage(db, runId);
    if (card) {
        const label = finalStatus === 'queued' ? `Approved by ${reviewer}; running.` : expired ? 'Approval window expired.' : `Denied by ${reviewer}.`;
        const events = await updateSystemMessage(db, card.id, `Run ${runId}: ${label}`, { ...card.data, status: finalStatus === 'queued' ? 'approved' : 'denied', reviewedBy: reviewerId });
        await publishEvents(runtimeRedis(), events);
    }

    if (finalStatus === 'queued') await enqueue(runId);
    return expired && approve ? { ok: false, status: 410, error: 'Approval window expired; the run was denied' } : { ok: true, status: finalStatus };
}

function fmtDuration(start: Date | null, end: Date | null): string {
    if (!start || !end) return '—';
    const ms = new Date(end).getTime() - new Date(start).getTime();
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Post a result summary into the run's thread (called by the runner when a run finishes). */
export async function postRunResult(db: Pool, runId: string, publish: (events: BridgedEvent[]) => Promise<void>): Promise<void> {
    const run = (await db.query('SELECT * FROM exec_runs WHERE id = $1', [runId])).rows[0];
    if (!run?.channel_id || !TERMINAL.includes(run.status)) return;

    const icon: Record<string, string> = { succeeded: '✅', failed: '❌', timeout: '⏱️', killed: '🛑', error: '⚠️', denied: '🚫' };
    const expires = codeExpiresAt(run.created_at, await codeRetentionDays(db));
    const tail = (s: string | null, n = 1500) => (s ? (s.length > n ? `…${s.slice(-n)}` : s).trim() : '');
    const out = tail(run.stdout_tail);
    const err = tail(run.stderr_tail, 800);
    const lines = [
        `${icon[run.status] ?? ''} Run ${runId} ${run.status} in ${fmtDuration(run.started_at, run.finished_at)} · `
            + `${run.capability_calls} capability call(s) · ${run.artifact_count ?? 0} file(s)${run.error ? ` · ${run.error}` : ''}`,
        ...(out ? ['```', out, '```'] : []),
        ...(err ? ['stderr:', '```', err, '```'] : []),
        retentionNote(expires),
    ];

    const { events } = await postSystemMessage(db, {
        channelId: run.channel_id,
        threadId: run.thread_id,
        systemEvent: 'runtime_result',
        systemData: { kind: 'runtime_result', runId, status: run.status, capabilityCalls: run.capability_calls, artifacts: run.artifact_count ?? 0 },
        content: lines.join('\n'),
    });
    await publish(events);
}

/** Retention + approval expiry sweep (runner, hourly). */
export async function runtimeMaintenance(db: Pool): Promise<{ pruned: number; expired: number }> {
    const days = await codeRetentionDays(db);
    let pruned = 0;
    if (days) {
        const res = await db.query(
            `UPDATE exec_runs SET code = NULL, code_pruned_at = NOW()
             WHERE code IS NOT NULL AND status = ANY($1) AND created_at < NOW() - ($2 || ' days')::interval`,
            [TERMINAL, String(days)]
        );
        pruned = res.rowCount ?? 0;
    }
    const exp = await db.query(
        `UPDATE exec_runs SET status = 'denied', gate_reason = 'Approval window expired', finished_at = NOW()
         WHERE status = 'awaiting_approval' AND created_at < NOW() - INTERVAL '30 minutes' RETURNING id`
    );
    return { pruned, expired: exp.rowCount ?? 0 };
}

export async function countRunsPrunedBy(db: Pool, days: number): Promise<number> {
    const res = await db.query(
        `SELECT COUNT(*)::int AS n FROM exec_runs
         WHERE code IS NOT NULL AND status = ANY($1) AND created_at < NOW() - ($2 || ' days')::interval`,
        [TERMINAL, String(days)]
    );
    return res.rows[0].n;
}
