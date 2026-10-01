import { QUESTION_VERSIONS } from '../ai/decision-questions';

/**
 * The file tagging queue (docs/planning/jev-wbs.md, C.3–C.5): `file_tag_jobs`, one
 * row per file. This module creates and re-queues jobs; `src/workers/file-tagging.ts`
 * works them.
 *
 * A file "needs tagging" when an enabled tag of its server has no result made with
 * that tag's current revision and the current question wording. That one rule
 * covers new files, new tags, edited criteria and reworded questions.
 *
 * Jobs exist only for servers with file tagging switched on. Switching it on later
 * is picked up by the sweep; switching it off pauses what is pending.
 */

interface Queryable {
    query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** An enabled tag of the job's server that this file has no current result for. */
const STALE_TAG = (job: string) => `
    EXISTS (
        SELECT 1 FROM file_tag_definitions t
        WHERE t.server_id = ${job}.server_id AND t.enabled
          AND NOT EXISTS (
              SELECT 1 FROM file_tags ft
              WHERE ft.file_id = ${job}.file_id AND ft.tag_id = t.id
                AND ft.tag_revision = t.revision AND ft.question_version = '${QUESTION_VERSIONS.tagging}'
          )
    )`;

/**
 * Queue a just-stored file for tagging, if its server has tagging on. Called after
 * the blob is written. Never throws: an upload must not fail because of tagging,
 * and the sweep picks up anything this misses.
 */
export async function enqueueFileTagging(pool: Queryable, fileId: string, channelId: string): Promise<boolean> {
    try {
        const res = await pool.query(
            `INSERT INTO file_tag_jobs (file_id, server_id)
             SELECT $1, c.server_id
             FROM channels c JOIN ai_decision_settings s ON s.server_id = c.server_id
             WHERE c.id = $2 AND s.tagging_enabled
             ON CONFLICT DO NOTHING
             RETURNING file_id`,
            [fileId, channelId]
        );
        return res.rows.length > 0;
    } catch {
        return false;
    }
}

export interface SweepResult {
    /** Jobs created for files that had none. */
    created: number;
    /** Finished jobs put back because a tag was added or its criteria changed. */
    requeued: number;
}

/**
 * Reconcile the queue with the files, for servers with tagging on:
 * files with a blob and no job get one, and finished jobs whose results are stale
 * are put back. Bounded per call; run it periodically.
 */
export async function sweepFileTagging(pool: Queryable, opts: { limit?: number; minAgeSeconds?: number; serverId?: string } = {}): Promise<SweepResult> {
    const limit = opts.limit ?? 500;
    // A file's row is committed just before its blob is written: leave very new ones alone
    const minAge = opts.minAgeSeconds ?? 30;
    const serverFilter = opts.serverId ? 'AND c.server_id = $3' : '';
    const params = (base: unknown[]) => (opts.serverId ? [...base, opts.serverId] : base);

    const created = await pool.query(
        `INSERT INTO file_tag_jobs (file_id, server_id)
         SELECT f.id, c.server_id
         FROM files f
         JOIN channels c ON c.id = f.channel_id
         JOIN ai_decision_settings s ON s.server_id = c.server_id AND s.tagging_enabled
         WHERE f.deleted_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > NOW())
           AND f.created_at <= NOW() - ($2 || ' seconds')::interval
           AND NOT EXISTS (SELECT 1 FROM file_tag_jobs j WHERE j.file_id = f.id)
           ${serverFilter}
         ORDER BY f.id DESC
         LIMIT $1
         ON CONFLICT DO NOTHING
         RETURNING file_id`,
        params([limit, String(minAge)])
    );

    const requeued = await pool.query(
        `UPDATE file_tag_jobs SET state = 'pending', run_after = NOW(), attempts = 0, detail = NULL, updated_at = NOW()
         WHERE file_id IN (
             SELECT j.file_id
             FROM file_tag_jobs j
             JOIN ai_decision_settings s ON s.server_id = j.server_id AND s.tagging_enabled
             WHERE j.state = 'done' AND ${STALE_TAG('j')}
               ${opts.serverId ? 'AND j.server_id = $2' : ''}
             LIMIT $1
         )
         RETURNING file_id`,
        opts.serverId ? [limit, opts.serverId] : [limit]
    );

    return { created: created.rows.length, requeued: requeued.rows.length };
}

/**
 * An admin asked for files to be tagged again (after editing a tag, or to retry
 * failures). Creates missing jobs and re-queues stale ones for this server now,
 * without waiting for the sweep. With `includeFailed`, failed jobs get a fresh start.
 */
export async function requeueFileTagging(pool: Queryable, serverId: string, opts: { includeFailed?: boolean } = {}): Promise<SweepResult & { retried: number }> {
    const swept = await sweepFileTagging(pool, { serverId, limit: 10_000, minAgeSeconds: 0 });
    let retried = 0;
    if (opts.includeFailed) {
        const res = await pool.query(
            `UPDATE file_tag_jobs SET state = 'pending', run_after = NOW(), attempts = 0, detail = NULL, updated_at = NOW()
             WHERE server_id = $1 AND state = 'failed'
             RETURNING file_id`,
            [serverId]
        );
        retried = res.rows.length;
    }
    return { ...swept, retried };
}

export interface TaggingStats {
    pending: number;
    running: number;
    done: number;
    skipped: number;
    failed: number;
    /** Finished files whose results predate a tag change (waiting for the sweep or a re-tag). */
    stale: number;
}

export async function taggingStats(db: Queryable, serverId: string): Promise<TaggingStats> {
    const res = await db.query(
        `SELECT j.state, COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE j.state = 'done' AND ${STALE_TAG('j')})::int AS stale
         FROM file_tag_jobs j WHERE j.server_id = $1 GROUP BY j.state`,
        [serverId]
    );
    const stats: TaggingStats = { pending: 0, running: 0, done: 0, skipped: 0, failed: 0, stale: 0 };
    for (const row of res.rows) {
        stats[row.state as 'pending'] = row.n;
        stats.stale += row.stale;
    }
    return stats;
}

/** Tags of this server that the file has no current result for (what a job must still ask). */
export const STALE_TAGS_SQL = `
    SELECT t.id, t.name, t.instructions, t.criteria_true, t.criteria_false, t.revision
    FROM file_tag_definitions t
    WHERE t.server_id = $1 AND t.enabled
      AND NOT EXISTS (
          SELECT 1 FROM file_tags ft
          WHERE ft.file_id = $2 AND ft.tag_id = t.id
            AND ft.tag_revision = t.revision AND ft.question_version = '${QUESTION_VERSIONS.tagging}'
      )
    ORDER BY t.id`;
