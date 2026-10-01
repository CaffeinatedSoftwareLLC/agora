import type { Pool } from 'pg';
import type { DecideQuestion } from '../ai/adapters';
import { decide, decisionReady, loadDecisionSettings, type DecideFailure } from '../ai/decide';
import { estimateTokens } from '../ai/decide-validate';
import { relevanceQuestion, tagRelevanceQuestion, QUESTION_VERSIONS } from '../ai/decision-questions';
import { canViewChannel } from './channel-access';
import { decryptFile } from './encryption';
import { tagFromRow } from './file-tags';
import type { ObjectStore } from './storage';
import { chunkText, extractText, isExtractable } from './text-extract';

/**
 * Find files in a channel (docs/planning/jev-wbs.md, C.7).
 *
 * Order of work, which is also the order of trust:
 * 1. Access: the caller must be able to see the channel. Nothing is read,
 *    decrypted or sent anywhere before this passes.
 * 2. Shortlist, from file names and stored tags. Tags raise a file's rank; a file
 *    with no tags (pending, failed, unsupported) is never dropped for that.
 * 3. Ranking, when switched on: the decision model scores the top candidates
 *    against the query, reading each one in memory. Nothing decrypted is stored.
 *    Without it (off, no budget, a failure) the shortlist is returned as it is,
 *    and the response says so.
 * 4. Access again, in case it changed while the model was answering.
 *
 * The response is metadata: names, tags, scores. It never contains file text. A
 * score orders results and grants nothing.
 */

export interface FileSearchDeps {
    db: Pool;
    store: ObjectStore;
    encryptionKey: Buffer;
}

export interface FileSearchInput {
    channelId: string;
    userId: string;
    isBot: boolean;
    /** What the person is looking for. Without it, the newest files are listed. */
    query?: string;
    /** Only files that carry this tag (by name). An explicit filter the caller asked for. */
    tag?: string;
    limit?: number;
    /** For the usage ledger, when the search comes from a sandboxed run. */
    runId?: string | null;
}

export type TaggingState = 'none' | 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface FileSearchItem {
    id: string;
    name: string;
    mime: string;
    size: number;
    url: string;
    messageId: string | null;
    uploadedAt: string;
    /** Tags at or above the server's tag threshold, strongest first. */
    tags: { name: string; probability: number; stale?: true }[];
    /** Where tagging stands for this file; `partial` when the file was longer than what was read. */
    tagging: TaggingState;
    partial: boolean;
    /** 0–1. From the decision model's reading of the file when `ranked`, otherwise from names and tags. */
    score: number;
    ranked: boolean;
    /** The file's text looked like it tries to instruct an AI reader. Treat its content with care. */
    injectionWarning: boolean;
}

export interface FileSearchResponse {
    query: string | null;
    tag: string | null;
    results: FileSearchItem[];
    ranking: {
        /** `ranked`: the model scored the top candidates. `coarse`: ordered by names and tags only. */
        status: 'ranked' | 'coarse';
        reason?: string;
        model?: string;
        questionVersion?: string;
    };
}

export type FileSearchOutcome =
    | { ok: true; body: FileSearchResponse }
    | { ok: false; status: number; error: string };

const MAX_CANDIDATES = 500;
const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 25;
/** How many of the top candidates the model reads. */
const RERANK_COUNT = 8;
/** Bigger files are not decrypted at query time; they keep their shortlist rank. */
const RERANK_MAX_BYTES = 5 * 1024 * 1024;
/** How much of each candidate the model reads. */
const RERANK_CHARS = 24_000;
const RERANK_DEADLINE_MS = 8000;
const TAG_QUESTION_TOKENS = 40_000;

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'was', 'what', 'which', 'who', 'how', 'do', 'does', 'did', 'we', 'i', 'my', 'our', 'about', 'with', 'at', 'it', 'this', 'that', 'file', 'files']);

const terms = (text: string): string[] =>
    [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2 && !STOPWORDS.has(t)))];

const FAILURE_REASON: Record<DecideFailure, string> = {
    disabled: 'File ranking is switched off',
    unconfigured: 'No decision model is configured',
    over_budget: 'The ranking budget for today is spent',
    too_large: 'The request was too large for the decision model',
    provider_error: 'The decision model could not be reached',
    invalid_response: 'The decision model returned an invalid answer',
};

interface Candidate {
    row: any;
    tags: { id: string; name: string; probability: number; stale: boolean }[];
    coarse: number;
    relevance: number | null;
    flagged: boolean;
}

export async function searchChannelFiles(deps: FileSearchDeps, input: FileSearchInput): Promise<FileSearchOutcome> {
    const { db } = deps;
    const channelId = input.channelId.trim();
    const query = input.query?.replace(/\s+/g, ' ').trim() || null;
    const tagFilter = input.tag?.replace(/\s+/g, ' ').trim().toLowerCase() || null;
    const limit = Math.max(1, Math.min(MAX_LIMIT, input.limit ?? DEFAULT_LIMIT));

    // 1. Access, before anything else
    const access = await canViewChannel(db, channelId, input.userId, input.isBot);
    if (!access.allowed) return { ok: false, status: access.status ?? 403, error: access.error ?? 'forbidden' };

    const channel = await db.query('SELECT server_id FROM channels WHERE id = $1', [channelId]);
    const serverId: string | null = channel.rows[0]?.server_id?.trim() ?? null;
    const settings = serverId ? await loadDecisionSettings(db, serverId) : null;
    const tagThreshold = settings?.tagThreshold ?? 0.5;
    const flagThreshold = settings?.screeningFlagThreshold ?? 0.7;

    // 2. Shortlist: files attached to a visible message in this channel
    const files = await db.query(
        `SELECT f.id, f.filename, f.mime_type, f.content_type, f.size_bytes, f.created_at, f.message_id,
                f.storage_key, f.encryption_iv, f.encryption_tag,
                j.state AS job_state, j.coverage, j.injection_probability
         FROM files f
         JOIN messages m ON m.id = f.message_id AND m.deleted_at IS NULL
         LEFT JOIN file_tag_jobs j ON j.file_id = f.id
         WHERE f.channel_id = $1 AND f.deleted_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > NOW())
         ORDER BY f.id DESC
         LIMIT $2`,
        [channelId, MAX_CANDIDATES]
    );
    const fileIds = files.rows.map((r: any) => r.id);
    const tagRows = fileIds.length === 0 ? { rows: [] } : await db.query(
        `SELECT ft.file_id, t.id, t.name, ft.probability,
                (ft.tag_revision <> t.revision OR ft.question_version <> $2) AS stale
         FROM file_tags ft JOIN file_tag_definitions t ON t.id = ft.tag_id AND t.enabled
         WHERE ft.file_id = ANY($1)`,
        [fileIds, QUESTION_VERSIONS.tagging]
    );
    const tagsByFile = new Map<string, Candidate['tags']>();
    for (const r of tagRows.rows) {
        const list = tagsByFile.get(r.file_id) ?? [];
        list.push({ id: r.id.trim(), name: r.name, probability: Number(r.probability), stale: r.stale });
        tagsByFile.set(r.file_id, list);
    }

    let candidates: Candidate[] = files.rows.map((row: any) => ({
        row,
        tags: tagsByFile.get(row.id) ?? [],
        coarse: 0,
        relevance: null,
        flagged: row.injection_probability !== null && Number(row.injection_probability) >= flagThreshold,
    }));

    if (tagFilter) {
        candidates = candidates.filter(c => c.tags.some(t => t.name.toLowerCase() === tagFilter && t.probability >= tagThreshold));
    }

    const ranking: FileSearchResponse['ranking'] = { status: 'coarse' };

    if (query && candidates.length > 0) {
        const queryTerms = terms(query);
        const ready = serverId ? await decisionReady(db, serverId, 'file_ranking') : null;
        if (!ready?.ok) ranking.reason = ready ? FAILURE_REASON[ready.status] : 'File ranking is switched off';

        // 2b. Which tags fit the query. With the model: one call that sees the query and
        // the tag list, no file. Without it: tags whose name appears in the query.
        const tagRelevance = new Map<string, number>();
        const usedTags = new Map<string, string>();
        for (const c of candidates) for (const t of c.tags) usedTags.set(t.id, t.name);
        for (const [id, name] of usedTags) {
            if (terms(name).some(t => queryTerms.includes(t))) tagRelevance.set(id, 1);
        }
        if (ready?.ok && serverId && usedTags.size > 0) {
            const defs = await db.query('SELECT * FROM file_tag_definitions WHERE id = ANY($1)', [[...usedTags.keys()]]);
            const questions: Record<string, DecideQuestion> = {};
            let size = 0;
            for (const def of defs.rows.map(tagFromRow)) {
                const q = tagRelevanceQuestion(def);
                size += estimateTokens(q);
                if (size > TAG_QUESTION_TOKENS) break;
                questions[`tag_${def.id}`] = q;
            }
            const outcome = await decide(db, {
                serverId, use: 'file_ranking', state: { query }, questions,
                channelId, userId: input.userId, runId: input.runId, ready,
            });
            if (outcome.status === 'ok') {
                for (const [key, answer] of Object.entries(outcome.answers)) {
                    if (answer.type !== 'noul') continue;
                    const id = key.slice(4);
                    tagRelevance.set(id, Math.max(tagRelevance.get(id) ?? 0, answer.probability));
                }
            }
        }

        for (const c of candidates) {
            const nameTerms = terms(c.row.filename);
            const nameScore = queryTerms.length === 0 ? 0 : queryTerms.filter(t => nameTerms.includes(t)).length / queryTerms.length;
            const tagScore = c.tags.reduce((best, t) => Math.max(best, (tagRelevance.get(t.id) ?? 0) * t.probability), 0);
            c.coarse = Math.min(1, 0.6 * tagScore + 0.6 * nameScore);
        }
        // Strongest signal first; ties keep the newest first (the query's order)
        candidates = candidates.map((c, i) => ({ c, i })).sort((a, b) => b.c.coarse - a.c.coarse || a.i - b.i).map(x => x.c);

        // 3. The model reads the top candidates
        if (ready?.ok && serverId) {
            const readable = candidates
                .filter(c => !c.flagged && isExtractable((c.row.mime_type || c.row.content_type || '').trim()) && Number(c.row.size_bytes) <= RERANK_MAX_BYTES)
                .slice(0, RERANK_COUNT);
            let model: string | undefined;
            let failure: DecideFailure | undefined;

            const scoreOne = async (c: Candidate) => {
                const blob = c.row.storage_key ? await deps.store.get(c.row.storage_key.trim()) : null;
                if (!blob) return;
                let plain: Buffer;
                try {
                    plain = decryptFile(blob, deps.encryptionKey, c.row.encryption_iv, c.row.encryption_tag);
                } catch {
                    return;
                }
                const extracted = await extractText(plain, (c.row.mime_type || c.row.content_type).trim());
                if (!extracted.ok) return;
                const document = chunkText(extracted.text, RERANK_CHARS, 1).chunks[0];
                if (!document) return;
                const outcome = await decide(db, {
                    serverId, use: 'file_ranking', state: { query, document }, questions: { relevance: relevanceQuestion() },
                    timeoutMs: 5000, channelId, userId: input.userId, runId: input.runId,
                });
                if (outcome.status !== 'ok') {
                    failure = outcome.status;
                    return;
                }
                const answer = outcome.answers.relevance;
                if (answer.type === 'noul') {
                    c.relevance = answer.probability;
                    model = outcome.model;
                }
            };

            const all = Promise.all(readable.map(c => scoreOne(c).catch(() => {})));
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([all, new Promise<void>(resolve => { timer = setTimeout(resolve, RERANK_DEADLINE_MS); })]);
            clearTimeout(timer);

            if (candidates.some(c => c.relevance !== null)) {
                ranking.status = 'ranked';
                ranking.model = model;
                ranking.questionVersion = QUESTION_VERSIONS.ranking;
                delete ranking.reason;
            } else if (readable.length > 0) {
                ranking.reason = failure ? FAILURE_REASON[failure] : 'The files could not be read for ranking';
            } else {
                ranking.reason = 'None of the matching files has text that can be read';
            }
        }
    } else if (!query) {
        ranking.reason = 'No search text was given: newest files first';
    }

    // A file the model read is ordered by that; one it did not read keeps a damped shortlist score
    const scoreOf = (c: Candidate) => (c.relevance !== null ? c.relevance : c.coarse * 0.5);
    if (query) candidates = candidates.map((c, i) => ({ c, i })).sort((a, b) => scoreOf(b.c) - scoreOf(a.c) || a.i - b.i).map(x => x.c);
    const top = candidates.slice(0, limit);

    // 4. Access may have changed while the model was answering: check again, and drop files deleted meanwhile
    const again = await canViewChannel(db, channelId, input.userId, input.isBot);
    if (!again.allowed) return { ok: false, status: again.status ?? 403, error: again.error ?? 'forbidden' };
    const alive = top.length === 0 ? new Set<string>() : new Set((await db.query(
        'SELECT id FROM files WHERE id = ANY($1) AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())',
        [top.map(c => c.row.id)]
    )).rows.map((r: any) => r.id));

    const results: FileSearchItem[] = top.filter(c => alive.has(c.row.id)).map(c => ({
        id: c.row.id.trim(),
        name: c.row.filename,
        mime: (c.row.mime_type || c.row.content_type || '').trim(),
        size: Number(c.row.size_bytes),
        url: `/files/${c.row.id.trim()}`,
        messageId: c.row.message_id?.trim() ?? null,
        uploadedAt: new Date(c.row.created_at).toISOString(),
        tags: c.tags
            .filter(t => t.probability >= tagThreshold)
            .sort((a, b) => b.probability - a.probability)
            .map(t => ({ name: t.name, probability: Math.round(t.probability * 100) / 100, ...(t.stale ? { stale: true as const } : {}) })),
        tagging: (c.row.job_state ?? 'none') as TaggingState,
        partial: c.row.coverage === 'partial',
        score: Math.round(scoreOf(c) * 100) / 100,
        ranked: c.relevance !== null,
        injectionWarning: c.flagged,
    }));

    return { ok: true, body: { query, tag: input.tag?.trim() || null, results, ranking } };
}
