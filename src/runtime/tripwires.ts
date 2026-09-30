import type { Pool } from 'pg';
import { generateUlid } from '../utils/ulid';
import { postSystemMessage } from '../gateway/post-message';
import type { BridgedEvent } from '../lib/event-bridge';

/**
 * Runtime tripwires (WBS 3.8, sandbox-isolation-spec §12). Auto-pause the bot that
 * submitted a run when it:
 *   - has 3 failed or timed-out runs within 10 minutes,
 *   - presents a run token outside its run (revoked, expired, or the run ended),
 *   - hits its per-run capability-call cap.
 *
 * Pausing reuses `users.bot_paused_at`: the gateway then rejects the bot's calls
 * (423), the runner kills its running containers and refuses its queued runs, and
 * the decider denies new submissions. A member with Manage Bots resumes it.
 */

export type TripwireKind = 'repeated_failures' | 'token_misuse' | 'call_cap';

export const FAILURE_THRESHOLD = 3;
export const FAILURE_WINDOW_MINUTES = 10;

const REASONS: Record<TripwireKind, string> = {
    repeated_failures: `${FAILURE_THRESHOLD} failed or timed-out runs within ${FAILURE_WINDOW_MINUTES} minutes`,
    token_misuse: 'a run token was used outside its run',
    call_cap: 'a run hit its capability-call limit',
};

export interface TripResult {
    /** False if the bot was already paused (or isn't a bot); no notice is posted then. */
    paused: boolean;
    events: BridgedEvent[];
}

/**
 * Pause the run's submitting bot and post a notice in the run's thread. Idempotent:
 * only the call that actually pauses the bot writes the audit entry and the notice.
 */
export async function tripBot(db: Pool, runId: string, kind: TripwireKind): Promise<TripResult> {
    const run = (await db.query(
        'SELECT server_id, channel_id, thread_id, submitted_by FROM exec_runs WHERE id = $1',
        [runId]
    )).rows[0];
    if (!run?.submitted_by) return { paused: false, events: [] };
    const botId = run.submitted_by.trim();
    const reason = `Tripwire: ${REASONS[kind]} (run ${runId.trim()})`;

    const paused = await db.query(
        `UPDATE users SET bot_paused_at = NOW(), bot_paused_reason = $2
         WHERE id = $1 AND bot = true AND bot_paused_at IS NULL
         RETURNING username`,
        [botId, reason]
    );
    if (paused.rows.length === 0) return { paused: false, events: [] };

    // audit_log.actor_id is required; the bot is the actor whose behavior tripped it
    await db.query(
        `INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, reason)
         VALUES ($1, $2, $3, 'bot_pause_tripwire', 'bot', $3, $4)`,
        [generateUlid(), run.server_id.trim(), botId, reason]
    );

    if (!run.channel_id) return { paused: true, events: [] };
    const { events } = await postSystemMessage(db, {
        channelId: run.channel_id,
        threadId: run.thread_id,
        systemEvent: 'runtime_tripwire',
        systemData: { kind: 'runtime_tripwire', runId: runId.trim(), status: 'paused', trigger: kind, botId },
        content: `${paused.rows[0].username} was paused automatically: ${REASONS[kind]}. `
            + 'Its running code was stopped and pending runs will not start. A member with Manage Bots can resume it.',
    });
    return { paused: true, events };
}

/**
 * Called by the runner after a run finishes. Counts the bot's failed and timed-out
 * runs in the window, ignoring any that finished before the bot was last resumed so
 * a resume starts a fresh count.
 */
export async function checkFailureTripwire(db: Pool, runId: string): Promise<TripResult> {
    const res = await db.query(
        `SELECT COUNT(*)::int AS n
         FROM exec_runs r
         JOIN exec_runs cur ON cur.id = $1
         JOIN users u ON u.id = cur.submitted_by AND u.bot = true
         WHERE r.submitted_by = cur.submitted_by
           AND r.status IN ('failed', 'timeout')
           AND r.finished_at > GREATEST(
                 NOW() - make_interval(mins => $2),
                 COALESCE((SELECT MAX(a.created_at) FROM audit_log a
                           WHERE a.action = 'bot_resume' AND a.target_id = cur.submitted_by), '-infinity'))`,
        [runId, FAILURE_WINDOW_MINUTES]
    );
    if ((res.rows[0]?.n ?? 0) < FAILURE_THRESHOLD) return { paused: false, events: [] };
    return tripBot(db, runId, 'repeated_failures');
}

/**
 * Called by the gateway when a bearer token fails authentication. A token that
 * matches a real run but is no longer valid can only come from outside that run's
 * container (the container is gone before the token is revoked), so the run leaked
 * it. Returns null when the token is unknown.
 */
export async function checkTokenMisuse(db: Pool, tokenHash: string): Promise<TripResult | null> {
    const res = await db.query('SELECT run_id FROM exec_run_tokens WHERE token_hash = $1', [tokenHash]);
    if (res.rows.length === 0) return null;
    return tripBot(db, res.rows[0].run_id, 'token_misuse');
}

/** Whether the run's submitting bot is paused (the runner polls this while a run executes). */
export async function isSubmitterPaused(db: Pool, runId: string): Promise<boolean> {
    const res = await db.query(
        `SELECT u.bot_paused_at FROM exec_runs r JOIN users u ON u.id = r.submitted_by WHERE r.id = $1`,
        [runId]
    );
    return !!res.rows[0]?.bot_paused_at;
}
