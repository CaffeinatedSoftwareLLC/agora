import type { Pool } from 'pg';
import { queueScan } from '../lib/github-rules';

/**
 * GitHub issue automation (docs/github-issues.md "Automatic import"): every minute, queue an
 * `issue_scan` for each channel whose rule is on and whose own interval (poll_minutes, default 5,
 * at least 2) has passed. The owner's host answers it with `gh`; src/lib/github-rules.ts applies
 * the answer. A host that is offline, revoked or too old is not asked: the reason lands in the
 * rule's status and nothing is posted. Idle while no channel has a rule.
 */
export interface GithubPollDeps {
    db: Pool;
    log?: { warn(obj: unknown, msg: string): void };
}

export async function runGithubPolls(deps: GithubPollDeps): Promise<number> {
    const due = (await deps.db.query(
        `SELECT btrim(channel_id) AS channel_id FROM channel_github_repos
         WHERE import_mode <> 'off' AND (last_poll_at IS NULL OR last_poll_at <= NOW() - make_interval(mins => poll_minutes))
         ORDER BY last_poll_at NULLS FIRST LIMIT 100`)).rows;
    let queued = 0;
    for (const { channel_id } of due) {
        const c = await deps.db.connect();
        try {
            await c.query('BEGIN');
            if ((await queueScan(c, channel_id, null)).status === 'queued') queued++;
            await c.query('COMMIT');
        } catch (err) {
            await c.query('ROLLBACK').catch(() => {});
            deps.log?.warn({ err, channel_id }, 'GitHub poll failed');
        } finally { c.release(); }
    }
    return queued;
}

export function startGithubPollWorker(deps: GithubPollDeps, intervalMs = 60_000): () => Promise<void> {
    let running: Promise<unknown> | null = null;
    const timer = setInterval(() => {
        if (running) return;
        running = runGithubPolls(deps)
            .catch(err => deps.log?.warn({ err }, 'GitHub poll pass failed'))
            .finally(() => { running = null; });
    }, intervalMs);
    timer.unref();
    return async () => { clearInterval(timer); await running; };
}
