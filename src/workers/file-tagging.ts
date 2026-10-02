import type { Pool, PoolClient } from 'pg';
import type { DecideQuestion } from '../ai/adapters';
import { decide, decisionReady } from '../ai/decide';
import { estimateTokens } from '../ai/decide-validate';
import { injectionQuestion, tagQuestion, QUESTION_VERSIONS } from '../ai/decision-questions';
import { decryptFile } from '../lib/encryption';
import { STALE_TAGS_SQL, sweepFileTagging } from '../lib/file-tagging-queue';
import type { ObjectStore } from '../lib/storage';
import { chunkText, extractText, isExtractable, DEFAULT_EXTRACT_LIMITS, type ExtractLimits } from '../lib/text-extract';

/**
 * File tagging worker (docs/planning/jev-wbs.md, C.3). For each queued file: decrypt
 * it in memory, extract its text, ask the server's decision model one yes/no
 * question per tag (plus one about prompt injection), and store the probabilities.
 * No file text is stored.
 *
 * Durability, in the order things can go wrong:
 * - A job is claimed in a short transaction that sets a lease and a claim generation.
 *   A crashed worker's job is claimed again when its lease runs out.
 * - A worker writes results only while its generation is still current, so one that
 *   outlived its lease cannot overwrite the worker that replaced it.
 * - Before writing, it re-checks that the file still exists, that tagging is still
 *   switched on, and that each tag still has the revision that was asked about.
 * - Rate limits and timeouts retry with backoff up to a cap. A bad key or a bad
 *   request fails the job at once. A spent budget or a switched-off model leaves the
 *   job waiting and costs no attempt.
 */

export interface TaggingDeps {
    db: Pool;
    store: ObjectStore;
    encryptionKey: Buffer;
    /** How long a claim lasts without being renewed. */
    leaseMs?: number;
    /** Jobs in flight per server, across all worker processes. */
    perServerConcurrency?: number;
    extractLimits?: ExtractLimits;
    /** Text per decision call, and the most chunks of one file that are read. */
    chunkChars?: number;
    maxChunks?: number;
    /** The most decision calls spent on one file. */
    maxCallsPerFile?: number;
    decideTimeoutMs?: number;
    /** Test seam: runs after the model has answered, before results are written. */
    beforeStore?: (job: ClaimedJob) => Promise<void>;
    log?: { warn(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void };
}

export interface ClaimedJob {
    fileId: string;
    serverId: string;
    generation: number;
    attempts: number;
    hasInjectionResult: boolean;
}

export type JobResult =
    | 'done'        // results stored
    | 'requeued'    // results stored, but a tag changed meanwhile: back in the queue
    | 'skipped'     // nothing to read (unsupported type, empty, too large)
    | 'failed'      // gave up
    | 'retry'       // will be tried again after a delay
    | 'waiting'     // no budget or no model right now; not counted as an attempt
    | 'paused'      // tagging was switched off; results were not written
    | 'dropped'     // the file is gone
    | 'fenced';     // another worker has the job now

const DEFAULTS = {
    leaseMs: 120_000,
    perServerConcurrency: 2,
    chunkChars: 24_000,
    maxChunks: 8,
    maxCallsPerFile: 24,
    decideTimeoutMs: 20_000,
};
/** A job is failed after this many counted attempts (claims that ended in an error or a lost lease). */
export const MAX_TAGGING_ATTEMPTS = 5;
/** Tag questions are packed into calls of about this many tokens, leaving room for the text. */
const QUESTION_TOKENS_PER_CALL = 24_000;
const WAIT_BUDGET_S = 600;
const WAIT_MODEL_S = 300;

const backoffSeconds = (attempts: number) => Math.min(30 * 2 ** Math.max(0, attempts - 1), 1800);
const questionId = (tagId: string) => `tag_${tagId}`;

/**
 * Claim the next job that is due: pending, or running with an expired lease.
 * Claims are serialized (one advisory lock) so the per-server limit is exact even
 * with several worker processes; the transaction is a few statements long.
 */
export async function claimTaggingJob(deps: TaggingDeps): Promise<ClaimedJob | null> {
    const leaseMs = deps.leaseMs ?? DEFAULTS.leaseMs;
    const perServer = deps.perServerConcurrency ?? DEFAULTS.perServerConcurrency;
    const client = await deps.db.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('file_tag_claim'))");
        const res = await client.query(
            `UPDATE file_tag_jobs SET
                 state = 'running', claim_generation = claim_generation + 1, attempts = attempts + 1,
                 lease_expires_at = NOW() + ($1 || ' milliseconds')::interval, updated_at = NOW()
             WHERE file_id = (
                 SELECT j.file_id
                 FROM file_tag_jobs j
                 JOIN ai_decision_settings s ON s.server_id = j.server_id AND s.tagging_enabled
                 WHERE ((j.state = 'pending' AND j.run_after <= NOW())
                        OR (j.state = 'running' AND j.lease_expires_at <= NOW()))
                   AND (SELECT COUNT(*) FROM file_tag_jobs b
                        WHERE b.server_id = j.server_id AND b.state = 'running' AND b.lease_expires_at > NOW()) < $2
                 ORDER BY j.run_after, j.file_id
                 FOR UPDATE OF j SKIP LOCKED
                 LIMIT 1
             )
             RETURNING file_id, server_id, claim_generation, attempts, injection_probability`,
            [String(leaseMs), perServer]
        );
        await client.query('COMMIT');
        const row = res.rows[0];
        if (!row) return null;
        return {
            fileId: row.file_id.trim(), serverId: row.server_id.trim(), generation: row.claim_generation,
            attempts: row.attempts, hasInjectionResult: row.injection_probability !== null,
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/** Change a job this worker still owns. False when another worker has claimed it since. */
async function settle(db: Pool | PoolClient, job: ClaimedJob, sets: string, params: unknown[] = []): Promise<boolean> {
    const res = await db.query(
        `UPDATE file_tag_jobs SET ${sets}, lease_expires_at = NULL, updated_at = NOW()
         WHERE file_id = $1 AND claim_generation = $2 AND state = 'running'`,
        [job.fileId, job.generation, ...params]
    );
    return (res.rowCount ?? 0) > 0;
}

const own = (ok: boolean, result: JobResult): JobResult => (ok ? result : 'fenced');

async function finish(db: Pool, job: ClaimedJob, state: 'skipped' | 'failed', detail: string): Promise<JobResult> {
    return own(await settle(db, job, 'state = $3, detail = $4', [state, detail.slice(0, 500)]), state);
}

/** Try again later. Counts as an attempt; past the cap the job fails. */
async function retry(db: Pool, job: ClaimedJob, detail: string): Promise<JobResult> {
    if (job.attempts >= MAX_TAGGING_ATTEMPTS) return finish(db, job, 'failed', `Gave up after ${job.attempts} attempts: ${detail}`);
    return own(await settle(db, job, "state = 'pending', run_after = NOW() + ($3 || ' seconds')::interval, detail = $4",
        [String(backoffSeconds(job.attempts)), detail.slice(0, 500)]), 'retry');
}

/** Nothing is wrong with the file: there is no budget or no model right now. Not an attempt. */
async function wait(db: Pool, job: ClaimedJob, seconds: number, detail: string, result: JobResult = 'waiting'): Promise<JobResult> {
    return own(await settle(db, job, "state = 'pending', attempts = GREATEST(attempts - 1, 0), run_after = NOW() + ($3 || ' seconds')::interval, detail = $4",
        [String(seconds), detail.slice(0, 500)]), result);
}

async function renewLease(deps: TaggingDeps, job: ClaimedJob): Promise<boolean> {
    const res = await deps.db.query(
        `UPDATE file_tag_jobs SET lease_expires_at = NOW() + ($3 || ' milliseconds')::interval
         WHERE file_id = $1 AND claim_generation = $2 AND state = 'running'`,
        [job.fileId, job.generation, String(deps.leaseMs ?? DEFAULTS.leaseMs)]
    );
    return (res.rowCount ?? 0) > 0;
}

interface AskedTag {
    id: string;
    revision: number;
    question: DecideQuestion;
}

/** Pack tag questions into calls that fit the model's request size. */
function questionBatches(tags: AskedTag[]): AskedTag[][] {
    const out: AskedTag[][] = [];
    let current: AskedTag[] = [];
    let size = 0;
    for (const tag of tags) {
        const tokens = estimateTokens(tag.question);
        if (current.length > 0 && size + tokens > QUESTION_TOKENS_PER_CALL) {
            out.push(current);
            current = [];
            size = 0;
        }
        current.push(tag);
        size += tokens;
    }
    if (current.length > 0) out.push(current);
    return out;
}

/** Work one claimed job to an outcome. Throws only for unexpected errors (the lease then expires and the job is claimed again). */
export async function processTaggingJob(deps: TaggingDeps, job: ClaimedJob): Promise<JobResult> {
    const { db } = deps;

    // A job abandoned over and over (a file that crashes its worker) must not loop forever
    if (job.attempts > MAX_TAGGING_ATTEMPTS) return finish(db, job, 'failed', `Gave up after ${job.attempts - 1} attempts: the job kept being abandoned`);

    const fileRes = await db.query(
        `SELECT f.id, f.channel_id, f.uploader_id, f.mime_type, f.content_type, f.storage_key, f.encryption_iv, f.encryption_tag
         FROM files f
         WHERE f.id = $1 AND f.deleted_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > NOW())`,
        [job.fileId]
    );
    const file = fileRes.rows[0];
    if (!file) {
        await db.query('DELETE FROM file_tag_jobs WHERE file_id = $1 AND claim_generation = $2', [job.fileId, job.generation]);
        return 'dropped';
    }

    const ready = await decisionReady(db, job.serverId, 'file_tagging');
    if (!ready.ok) return wait(db, job, ready.status === 'over_budget' ? WAIT_BUDGET_S : WAIT_MODEL_S, ready.reason);

    const stale = await db.query(STALE_TAGS_SQL, [job.serverId, job.fileId]);
    const tags: AskedTag[] = stale.rows.map((r: any) => ({
        id: r.id.trim(),
        revision: r.revision,
        question: tagQuestion({ name: r.name, instructions: r.instructions, criteriaTrue: r.criteria_true, criteriaFalse: r.criteria_false }),
    }));
    const askInjection = !job.hasInjectionResult;
    if (tags.length === 0 && !askInjection) return own(await settle(db, job, "state = 'done', attempts = 0, detail = NULL"), 'done');

    const mime = (file.mime_type || file.content_type || '').trim();
    if (!isExtractable(mime)) return finish(db, job, 'skipped', `Text cannot be read from ${mime || 'this type of'} files`);

    const blob = file.storage_key ? await deps.store.get(file.storage_key.trim()) : null;
    if (!blob) return retry(db, job, 'The stored file could not be found');

    let plain: Buffer;
    try {
        plain = decryptFile(blob, deps.encryptionKey, file.encryption_iv, file.encryption_tag);
    } catch {
        return finish(db, job, 'failed', 'The stored file could not be decrypted');
    }

    const extracted = await extractText(plain, mime, deps.extractLimits ?? DEFAULT_EXTRACT_LIMITS);
    if (!extracted.ok) return finish(db, job, extracted.reason === 'failed' ? 'failed' : 'skipped', extracted.detail);

    const chunked = chunkText(extracted.text, deps.chunkChars ?? DEFAULTS.chunkChars, deps.maxChunks ?? DEFAULTS.maxChunks);
    let chunks = chunked.chunks;
    let partial = extracted.truncated || chunked.truncated;

    // With no tags to ask (injection check only) there is still one call per chunk
    const batches = tags.length > 0 ? questionBatches(tags) : [[]];
    const maxCalls = deps.maxCallsPerFile ?? DEFAULTS.maxCallsPerFile;
    if (chunks.length * batches.length > maxCalls) {
        chunks = chunks.slice(0, Math.max(1, Math.floor(maxCalls / batches.length)));
        partial = true;
    }

    const probabilities = new Map<string, number>();
    let injection: number | null = null;
    let model = '';

    for (const chunk of chunks) {
        for (let b = 0; b < batches.length; b++) {
            // Also the fencing check: stop as soon as another worker owns the job
            if (!(await renewLease(deps, job))) return 'fenced';

            const questions: Record<string, DecideQuestion> = {};
            for (const tag of batches[b]) questions[questionId(tag.id)] = tag.question;
            if (askInjection && b === 0) questions.injection = injectionQuestion('document');

            const outcome = await decide(db, {
                serverId: job.serverId, use: 'file_tagging', state: { document: chunk }, questions,
                timeoutMs: deps.decideTimeoutMs ?? DEFAULTS.decideTimeoutMs,
                channelId: file.channel_id?.trim() ?? null, userId: file.uploader_id?.trim() ?? null,
            });
            if (outcome.status !== 'ok') {
                switch (outcome.status) {
                    case 'over_budget': return wait(db, job, WAIT_BUDGET_S, outcome.reason);
                    case 'disabled': return wait(db, job, WAIT_MODEL_S, outcome.reason, 'paused');
                    case 'unconfigured': return wait(db, job, WAIT_MODEL_S, outcome.reason);
                    case 'too_large': return finish(db, job, 'failed', outcome.reason);
                    case 'invalid_response': return retry(db, job, outcome.reason);
                    default: return outcome.retryable ? retry(db, job, outcome.reason) : finish(db, job, 'failed', outcome.reason);
                }
            }
            model = outcome.model;
            for (const tag of batches[b]) {
                const answer = outcome.answers[questionId(tag.id)];
                if (answer.type !== 'noul') continue;
                probabilities.set(tag.id, Math.max(probabilities.get(tag.id) ?? 0, answer.probability));
            }
            const inj = outcome.answers.injection;
            if (inj?.type === 'noul') injection = Math.max(injection ?? 0, inj.probability);
        }
    }

    if (deps.beforeStore) await deps.beforeStore(job);

    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const mine = await client.query(
            `SELECT 1 FROM file_tag_jobs WHERE file_id = $1 AND claim_generation = $2 AND state = 'running' FOR UPDATE`,
            [job.fileId, job.generation]
        );
        if (mine.rows.length === 0) {
            await client.query('ROLLBACK');
            return 'fenced';
        }

        const stillThere = await client.query(
            'SELECT 1 FROM files WHERE id = $1 AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())',
            [job.fileId]
        );
        if (stillThere.rows.length === 0) {
            await client.query('DELETE FROM file_tag_jobs WHERE file_id = $1', [job.fileId]);
            await client.query('COMMIT');
            return 'dropped';
        }

        // Switched off while the model was answering: nothing is published
        const on = await client.query('SELECT tagging_enabled FROM ai_decision_settings WHERE server_id = $1', [job.serverId]);
        if (!on.rows[0]?.tagging_enabled) {
            await settle(client, job, "state = 'pending', attempts = GREATEST(attempts - 1, 0), detail = 'File tagging is switched off'");
            await client.query('COMMIT');
            return 'paused';
        }

        for (const tag of tags) {
            const probability = probabilities.get(tag.id);
            if (probability === undefined) continue;
            // Only if the tag is still what was asked about: same revision, still enabled
            await client.query(
                `INSERT INTO file_tags (file_id, tag_id, tag_revision, question_version, probability, model)
                 SELECT $1, t.id, t.revision, $4, $5, $6
                 FROM file_tag_definitions t
                 WHERE t.id = $2 AND t.revision = $3 AND t.enabled
                 ON CONFLICT (file_id, tag_id) DO UPDATE SET
                     tag_revision = EXCLUDED.tag_revision, question_version = EXCLUDED.question_version,
                     probability = EXCLUDED.probability, model = EXCLUDED.model, tagged_at = NOW()`,
                [job.fileId, tag.id, tag.revision, QUESTION_VERSIONS.tagging, probability, model.slice(0, 100)]
            );
        }

        // A tag added or edited during the job leaves the file stale: straight back in the queue
        const remaining = await client.query(STALE_TAGS_SQL, [job.serverId, job.fileId]);
        const state = remaining.rows.length > 0 ? 'pending' : 'done';
        await settle(client, job,
            `state = $3, attempts = 0, detail = NULL, run_after = NOW(), coverage = $4,
             injection_probability = COALESCE($5, injection_probability)`,
            [state, partial ? 'partial' : 'full', injection]);
        await client.query('COMMIT');
        return state === 'done' ? 'done' : 'requeued';
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Claim and work jobs until none are due, at most `maxJobs`. Returns what happened
 * to each. Safe to run from several processes at once.
 */
export async function runTaggingOnce(deps: TaggingDeps, opts: { maxJobs?: number; parallel?: number } = {}): Promise<JobResult[]> {
    const results: JobResult[] = [];
    let budget = opts.maxJobs ?? 20;
    const loop = async () => {
        while (budget > 0) {
            budget--;
            const job = await claimTaggingJob(deps);
            if (!job) return;
            try {
                results.push(await processTaggingJob(deps, job));
            } catch (err) {
                // Left running: the lease expires and the job is claimed again
                deps.log?.error({ err, fileId: job.fileId }, 'File tagging job crashed');
            }
        }
    };
    await Promise.all(Array.from({ length: opts.parallel ?? 2 }, loop));
    return results;
}

/** Poll the queue and sweep it periodically. Returns a function that stops the worker. */
export function startFileTaggingWorker(deps: TaggingDeps, opts: { pollMs?: number; sweepMs?: number } = {}): () => Promise<void> {
    const pollMs = opts.pollMs ?? 5000;
    const sweepMs = opts.sweepMs ?? 60_000;
    let stopped = false;
    let lastSweep = 0;
    let running: Promise<void> = Promise.resolve();

    const tick = async () => {
        if (stopped) return;
        try {
            if (Date.now() - lastSweep >= sweepMs) {
                lastSweep = Date.now();
                await sweepFileTagging(deps.db);
            }
            await runTaggingOnce(deps);
        } catch (err) {
            deps.log?.error({ err }, 'File tagging worker tick failed');
        }
    };
    let busy = false;
    const timer = setInterval(() => {
        // One tick at a time: a slow one is not queued up behind
        if (busy) return;
        busy = true;
        running = tick().finally(() => { busy = false; });
    }, pollMs);
    timer.unref();

    return async () => {
        stopped = true;
        clearInterval(timer);
        await running;
    };
}
