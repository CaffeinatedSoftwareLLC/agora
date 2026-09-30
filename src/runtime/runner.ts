import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { Worker, DelayedError, type Job, type ConnectionOptions } from 'bullmq';
import { buildContainerSpec } from './container-spec';
import type { SandboxDocker, RunOutcome } from './docker';
import type { RunLimits } from './limits';
import type { BridgedEvent } from '../lib/event-bridge';
import { checkFailureTripwire, isSubmitterPaused } from './tripwires';

/**
 * Sandbox runner (WBS 3.2). Consumes `{ runId }` jobs from the `runtime` queue,
 * re-checks the run is cleared to execute, mints a per-run token, runs the code in a
 * fresh hardened container, records the outcome, and revokes the token.
 *
 * The runner never interprets run code; it only passes it into the container.
 */

export const RUNTIME_QUEUE = 'runtime';

export interface RunnerConfig {
    image: string;
    network: string;
    runtime: 'runsc' | 'runc';
    capUrl: string;
    perServerConcurrency: number;
    /** How long to wait before retrying a run whose server is at capacity. */
    capacityRetryMs: number;
    /** How often to check whether the submitting bot was paused while a run executes. */
    stopPollMs?: number;
    /** Name (substring) of the gateway container on the sandbox network; defaults to the capUrl hostname. */
    capContainer?: string;
}

/**
 * The gateway's sandbox-network IP, for the run's /etc/hosts. Under runsc, Docker's
 * embedded DNS doesn't work (gVisor doesn't apply its NAT rules), so a run can only
 * reach the gateway this way; failing here gives a clear error instead of a
 * "fetch failed" inside the run. Under runc (dev) Docker's DNS works, so a missing
 * gateway or a failed lookup is not fatal.
 */
async function resolveGatewayIp(sandbox: SandboxDocker, config: RunnerConfig): Promise<string | undefined> {
    const host = new URL(config.capUrl).hostname;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return undefined;
    const name = config.capContainer ?? host;
    let ip: string | null = null;
    try {
        ip = await sandbox.gatewayAddress(config.network, name);
    } catch (err) {
        if (config.runtime === 'runsc') throw err;
    }
    if (!ip && config.runtime === 'runsc') {
        throw new Error(`Capability gateway container "${name}" was not found on the "${config.network}" network`);
    }
    return ip ?? undefined;
}

export interface RunnerDeps {
    db: Pool;
    sandbox: SandboxDocker;
    config: RunnerConfig;
    log?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
    /** Called after a run reaches a terminal state (the API posts results to the thread). */
    onFinished?: (runId: string, status: FinalStatus | 'denied') => Promise<void>;
    /** Publishes Socket.IO events (tripwire notices) through the event bridge. */
    publish?: (events: BridgedEvent[]) => Promise<void>;
}

export type FinalStatus = 'succeeded' | 'failed' | 'timeout' | 'killed' | 'error';
export type ProcessResult = { kind: 'ran'; status: FinalStatus } | { kind: 'skipped'; reason: string } | { kind: 'deferred' };

export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export function redact(text: string, secrets: string[]): string {
    let out = text;
    for (const s of secrets) if (s) out = out.split(s).join('[REDACTED]');
    return out;
}

export function statusFor(outcome: RunOutcome): { status: FinalStatus; error: string | null } {
    if (outcome.stopped) return { status: 'killed', error: 'Run stopped because the submitting bot was paused' };
    if (outcome.timedOut) return { status: 'timeout', error: 'Run exceeded its time limit' };
    if (outcome.oomKilled) return { status: 'killed', error: 'Run exceeded its memory limit' };
    if (outcome.exitCode === 0) return { status: 'succeeded', error: null };
    return { status: 'failed', error: null };
}

/**
 * Atomically move a cleared run from `queued` to `running`, respecting the per-server
 * concurrency limit. Returns null if the run isn't claimable (wrong state, not
 * approved), 'full' if the server is at capacity, or 'paused' if the submitting bot
 * is paused (the run is then denied).
 */
async function claimRun(db: Pool, runId: string, perServer: number): Promise<any | null | 'full' | 'paused'> {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const peek = await client.query('SELECT server_id FROM exec_runs WHERE id = $1', [runId]);
        if (peek.rows.length === 0) { await client.query('ROLLBACK'); return null; }
        const serverId = peek.rows[0].server_id.trim();

        // Serialize claims per server so the running count can't race
        await client.query("SELECT pg_advisory_xact_lock(hashtext('agora:runtime:' || $1))", [serverId]);
        const running = await client.query(
            "SELECT COUNT(*)::int AS n FROM exec_runs WHERE server_id = $1 AND status = 'running'",
            [serverId]
        );
        if (running.rows[0].n >= perServer) { await client.query('ROLLBACK'); return 'full'; }

        // A bot paused after its run was queued or approved (manually or by a tripwire) doesn't get to run it
        const refused = await client.query(
            `UPDATE exec_runs r SET status = 'denied', error = 'The submitting bot is paused', finished_at = NOW()
             FROM users u
             WHERE r.id = $1 AND r.status = 'queued' AND u.id = r.submitted_by AND u.bot_paused_at IS NOT NULL
             RETURNING r.id`,
            [runId]
        );
        if (refused.rows.length > 0) { await client.query('COMMIT'); return 'paused'; }

        // Defense in depth (T8): only runs the gate cleared, and approved if approval was required
        const claimed = await client.query(
            `UPDATE exec_runs SET status = 'running', started_at = NOW()
             WHERE id = $1 AND status = 'queued' AND code IS NOT NULL
               AND (gate_decision = 'auto_run' OR (gate_decision = 'needs_approval' AND approved_at IS NOT NULL))
             RETURNING *`,
            [runId]
        );
        await client.query('COMMIT');
        return claimed.rows[0] ?? null;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export async function processRun(deps: RunnerDeps, runId: string): Promise<ProcessResult> {
    const { db, sandbox, config } = deps;

    const run = await claimRun(db, runId, config.perServerConcurrency);
    if (run === 'full') return { kind: 'deferred' };
    if (run === 'paused') {
        await deps.onFinished?.(runId, 'denied').catch(e => deps.log?.error({ err: e, runId }, 'onFinished hook failed'));
        return { kind: 'skipped', reason: 'bot paused' };
    }
    if (!run) {
        deps.log?.warn({ runId }, 'Run is not claimable (not queued or not cleared by the gate); skipping');
        return { kind: 'skipped', reason: 'not claimable' };
    }

    const limits = run.limits as RunLimits;
    const token = `art_${randomBytes(32).toString('base64url')}`;
    const serverId = run.server_id.trim();

    let final: { status: FinalStatus; error: string | null };
    let outcome: RunOutcome | null = null;
    try {
        await db.query(
            `INSERT INTO exec_run_tokens (token_hash, run_id, server_id, capabilities, expires_at)
             VALUES ($1, $2, $3, $4, NOW() + ($5 || ' milliseconds')::interval + INTERVAL '30 seconds')`,
            [hashToken(token), runId, serverId, run.requested_capabilities ?? [], String(limits.wallClockMs)]
        );

        const spec = buildContainerSpec({
            runId,
            serverId,
            image: config.image,
            network: config.network,
            runtime: config.runtime,
            code: run.code,
            runToken: token,
            capUrl: config.capUrl,
            limits,
            gatewayIp: await resolveGatewayIp(sandbox, config),
        });

        outcome = await sandbox.run(spec, {
            timeoutMs: limits.wallClockMs,
            outputBytes: limits.outputBytes,
            onStarted: async (containerId) => {
                await db.query('UPDATE exec_runs SET container_id = $1 WHERE id = $2', [containerId, runId]);
            },
            shouldStop: () => isSubmitterPaused(db, runId),
            stopPollMs: config.stopPollMs,
        });
        final = statusFor(outcome);
    } catch (err) {
        deps.log?.error({ err, runId }, 'Sandbox run failed to execute');
        final = { status: 'error', error: err instanceof Error ? err.message : String(err) };
    } finally {
        await db.query('UPDATE exec_run_tokens SET revoked_at = NOW() WHERE run_id = $1 AND revoked_at IS NULL', [runId])
            .catch(e => deps.log?.error({ err: e, runId }, 'Failed to revoke run token'));
    }

    const truncNote = (truncated: boolean) => (truncated ? '\n[output truncated]' : '');
    await db.query(
        `UPDATE exec_runs
         SET status = $1, error = $2, exit_code = $3, stdout_tail = $4, stderr_tail = $5, finished_at = NOW()
         WHERE id = $6`,
        [
            final.status,
            final.error,
            outcome?.exitCode ?? null,
            outcome ? redact(outcome.stdout, [token]) + truncNote(outcome.stdoutTruncated) : null,
            outcome ? redact(outcome.stderr, [token]) + truncNote(outcome.stderrTruncated) : null,
            runId,
        ]
    );

    await deps.onFinished?.(runId, final.status).catch(e => deps.log?.error({ err: e, runId }, 'onFinished hook failed'));

    // Tripwire (3.8): repeated failures pause the bot; posted after the result card
    if (final.status === 'failed' || final.status === 'timeout') {
        try {
            const trip = await checkFailureTripwire(db, runId);
            if (trip.events.length) await deps.publish?.(trip.events);
        } catch (e) {
            deps.log?.error({ err: e, runId }, 'Failure tripwire check failed');
        }
    }
    return { kind: 'ran', status: final.status };
}

/** On startup: runs left 'running' by a crashed runner can't be resumed. */
export async function reconcileInterruptedRuns(db: Pool): Promise<number> {
    const res = await db.query(
        `UPDATE exec_runs SET status = 'error', error = 'Runner restarted while the run was in progress', finished_at = NOW()
         WHERE status = 'running' RETURNING id`
    );
    await db.query(
        `UPDATE exec_run_tokens SET revoked_at = NOW()
         WHERE revoked_at IS NULL AND run_id = ANY($1)`,
        [res.rows.map(r => r.id)]
    );
    return res.rowCount ?? 0;
}

export function startRunnerWorker(deps: RunnerDeps, connection: ConnectionOptions, instanceConcurrency: number): Worker {
    return new Worker(RUNTIME_QUEUE, async (job: Job<{ runId: string }>, token?: string) => {
        const result = await processRun(deps, job.data.runId);
        if (result.kind === 'deferred') {
            // Server at capacity: retry later without consuming an attempt
            await job.moveToDelayed(Date.now() + deps.config.capacityRetryMs, token);
            throw new DelayedError();
        }
        return result;
    }, { connection, concurrency: instanceConcurrency });
}
