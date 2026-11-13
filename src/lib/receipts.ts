import { generateUlid } from '../utils/ulid';
import type { ProtocolInfo, ProtocolMode } from './protocol';
import type { Notice } from './agent-runs';

/**
 * The receipts ledger (docs/receipts.md, migration 095): a durable record of what a thread
 * decided and claimed, graded against what the server itself holds.
 *
 * - 'claim': a DONE. Graded `verified`, `unverified` or `contradicted` against the hosted run
 *   it was posted from, with `basis` saying whether a test backs it ('tested') or not ('assumed').
 * - 'decision': one DECIDE round, with a vote per participant (receipt_votes).
 * - 'stop': a thread-level BLOCK, or a CANCEL from someone who may direct agents.
 * - 'artifact': a file posted in a protocol thread, by its file ID.
 * - 'gate': a reply by an account that may direct agents, quoting an artifact's file ID with
 *   exactly `approved`, `agreed`, `accepted`, `confirmed` or `rejected: <reason>`.
 *
 * Rules:
 * - Receipts are written by the server only. Agents can't create or grade one; what they attach
 *   (attachEvidence) is kept under `evidence.selfReported` and never changes a grade.
 * - The writer runs inside the post's own transaction, as the service role (the tables have no
 *   write policy for app_user), behind a savepoint: a post never fails because its receipt
 *   could not be written (recordMessage, onRunFinished).
 * - Everything an author wrote (summary, reasons, file names, self-reported evidence) is
 *   untrusted data. It is stored and returned as data and never put into a notice or a prompt.
 * - A receipt records the post as first made. Editing the post leaves the copied text alone and
 *   marks the receipt `source_edited`; deleting it (by its author, or with the account) blanks
 *   the copied text and marks the receipt `source_removed`. The receipt itself stays: that a
 *   claim was made matters (markSourceEdited, markSourceRemoved).
 */

export type ReceiptKind = 'claim' | 'decision' | 'stop' | 'artifact' | 'gate';
export type Grade = 'verified' | 'unverified' | 'contradicted';
export type Basis = 'tested' | 'assumed';
export type GateWord = 'approved' | 'agreed' | 'accepted' | 'confirmed' | 'rejected';
export const RECEIPT_KINDS: readonly ReceiptKind[] = ['claim', 'decision', 'stop', 'artifact', 'gate'];
export const GATE_WORDS: readonly GateWord[] = ['approved', 'agreed', 'accepted', 'confirmed', 'rejected'];

const MAX_SUMMARY = 500;
const MAX_PATHS = 200;
const MAX_SELF_REPORTS = 10;

// ─── Grading (pure) ───

/** What the server holds about the run a claim was posted from. */
export interface RunFacts {
    status: 'claimed' | 'succeeded' | 'failed' | 'expired' | string;
    error?: string | null;
    cancelRequested?: boolean;
    headSha?: string | null;
    baseSha?: string | null;
    /**
     * Where the branch stood when this run began: the previous finished run's head in the same
     * session, else the session's base. A commit counts for a run only when `headSha` moved
     * past it. Unset (older callers, unit tests): `baseSha`.
     */
    startSha?: string | null;
    /**
     * Was the run woken for the claim's thread (or does it belong to it)? `false` grades the
     * claim `other_thread`: a run's work is only evidence for the thread it was doing. Unset: yes.
     */
    sameThread?: boolean;
    changedPaths?: string[] | null;
    verification?: { status: 'passed' | 'failed' | 'skipped' | string } | null;
}

export interface GradeResult { grade: Grade; reason: string; basis: Basis }

/** A failed run with one of these errors was stopped from outside: it says nothing about the claim. */
const INTERRUPTED = new Set(['rate_limited', 'credit_exhausted', 'host_stopped', 'run_timeout', 'lease_expired']);

/**
 * Grade a DONE against its run. Only what the server holds counts; self-reported evidence is
 * not an input.
 *
 * - no run (a terminal agent, a person, a post outside a hosted run): unverified `no_run`;
 * - the run was doing another thread's work: unverified `other_thread`, whatever happened to it;
 * - the run is still going: unverified `run_in_progress`, graded again when it finishes;
 * - the owner's verify command failed: contradicted `verification_failed`;
 * - the run failed: contradicted `run_failed` (unverified `run_interrupted` when it was
 *   cancelled, expired or stopped by a limit);
 * - a `fix` claim from a run that committed nothing and changed no file: contradicted `no_changes`;
 * - this run added no commit (its head is where the run started, which is the previous run's
 *   head, not the session's base): unverified `not_committed` (files changed) or `no_commit`;
 * - a commit and a passed verify command: verified `tests_passed`, basis `tested`;
 * - a commit without a passed verify command: verified `committed`, basis `assumed`.
 */
export function gradeClaim(mode: ProtocolMode | string | null, run: RunFacts | null): GradeResult {
    if (!run) return { grade: 'unverified', reason: 'no_run', basis: 'assumed' };
    if (run.sameThread === false) return { grade: 'unverified', reason: 'other_thread', basis: 'assumed' };
    if (run.status === 'claimed') return { grade: 'unverified', reason: 'run_in_progress', basis: 'assumed' };
    if (run.verification?.status === 'failed') return { grade: 'contradicted', reason: 'verification_failed', basis: 'tested' };
    if (run.status === 'failed') {
        return run.cancelRequested || INTERRUPTED.has(run.error ?? '')
            ? { grade: 'unverified', reason: 'run_interrupted', basis: 'assumed' }
            : { grade: 'contradicted', reason: 'run_failed', basis: 'assumed' };
    }
    if (run.status !== 'succeeded') return { grade: 'unverified', reason: 'run_interrupted', basis: 'assumed' };

    const since = run.startSha ?? run.baseSha;
    const committed = !!run.headSha && !!since && run.headSha !== since;
    const changed = (run.changedPaths ?? []).length > 0;
    if (!committed) {
        if (mode === 'fix' && !changed) return { grade: 'contradicted', reason: 'no_changes', basis: 'assumed' };
        return { grade: 'unverified', reason: changed ? 'not_committed' : 'no_commit', basis: 'assumed' };
    }
    return run.verification?.status === 'passed'
        ? { grade: 'verified', reason: 'tests_passed', basis: 'tested' }
        : { grade: 'verified', reason: 'committed', basis: 'assumed' };
}

// ─── Gate recogniser (pure) ───

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const ULID_RE = new RegExp(`(?<![0-9A-Za-z])${ULID}(?![0-9A-Za-z])`, 'g');
/** A quoted file ID with its usual dressing: `file <id>`, `file ID: <id>`, `/files/<id>`, backticks, brackets. */
const FILE_REF_RE = new RegExp(
    `[(\\[]?(?:[Ff]ile(?:\\s+[Ii][Dd])?\\s*[:=#]?\\s*|/files/)?\`?(?<![0-9A-Za-z])${ULID}(?![0-9A-Za-z])\`?[)\\]]?`, 'g');
const MAX_GATE_LENGTH = 700;

export interface GateReply { word: GateWord; fileId: string; reason: string | null }

/**
 * Is this reply a gate? It must quote exactly one file ID and, apart from that ID, be exactly
 * one of `approved`, `agreed`, `accepted`, `confirmed` (nothing else), or `rejected: <reason>`.
 * Anything looser ("approved, but…", "looks good") is an ordinary message. Who may pass a gate
 * and whether the ID names an artifact are checked by the caller.
 */
export function recogniseGate(content: string | null | undefined): GateReply | null {
    if (!content) return null;
    const text = content.trim();
    if (!text || text.length > MAX_GATE_LENGTH) return null;
    const ids = new Set(text.match(ULID_RE) ?? []);
    if (ids.size !== 1) return null;
    const rest = text.replace(FILE_REF_RE, ' ').replace(/\s+/g, ' ')
        .replace(/^[\s,;:.\-–—]+/, '').replace(/[\s,;:.!\-–—]+$/, '');
    const fileId = [...ids][0];
    const plain = /^(approved|agreed|accepted|confirmed)$/i.exec(rest);
    if (plain) return { word: plain[1].toLowerCase() as GateWord, fileId, reason: null };
    const rejected = /^rejected\s*:\s*(\S[\s\S]*)$/i.exec(rest);
    if (rejected) return { word: 'rejected', fileId, reason: rejected[1].trim().slice(0, MAX_SUMMARY) };
    return null;
}

// ─── Text helpers (pure) ───

const HEADER_LINE_RE = /^\[AGORA\/v1[^\]]*\]\s*/i;
const TAIL_RE = /^\[(?:YIELD|WAIT)\s[^\]]*\]$/i;

/** A protocol post's own text: the header and a closing YIELD or WAIT line removed, shortened. */
export function claimSummary(content: string | null | undefined): string | null {
    if (!content) return null;
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return null;
    lines[0] = lines[0].replace(HEADER_LINE_RE, '');
    if (lines.length > 1 && TAIL_RE.test(lines[lines.length - 1])) lines.pop();
    const text = lines.filter(l => l.length > 0).join('\n').trim();
    return text ? text.slice(0, MAX_SUMMARY) : null;
}

/** The reason given with a DECIDE: what follows AGREE or BLOCK. */
export function voteReason(content: string | null | undefined): string | null {
    const text = claimSummary(content);
    if (!text) return null;
    const reason = text.replace(/^(?:AGREE|BLOCK)\b[\s:,\-–—]*/i, '').trim();
    return reason ? reason.slice(0, MAX_SUMMARY) : null;
}

export interface VoteTally { vote: 'agree' | 'block'; voterId: string }

/**
 * A round's outcome once its votes are in. `expected` is who the thread named as participants
 * (empty: unknown). While the thread runs, a round closes only when every expected participant
 * has voted. When the thread ends (`closing`), what was cast decides: any BLOCK is `blocked`;
 * agreement by everyone expected (or, with participants unknown, by at least two voters) is
 * `agreed`; anything less is `abandoned`.
 */
export function roundOutcome(votes: VoteTally[], expected: string[], closing: 'done' | 'blocked' | 'cancelled' | null): 'open' | 'agreed' | 'blocked' | 'abandoned' {
    const voters = new Set(votes.map(v => v.voterId));
    const blocked = votes.some(v => v.vote === 'block');
    const complete = expected.length > 0 && expected.every(id => voters.has(id));
    if (complete) return blocked ? 'blocked' : 'agreed';
    if (!closing) return 'open';
    if (closing === 'cancelled') return 'abandoned';
    if (blocked || closing === 'blocked') return 'blocked';
    return expected.length === 0 && voters.size >= 2 ? 'agreed' : 'abandoned';
}

// ─── Reading ───

const RECEIPT_SELECT = `
    SELECT r.*, a.username AS author_username, a.bot AS author_bot, vb.username AS verdict_username,
           COALESCE((SELECT json_agg(json_build_object(
                         'voterId', btrim(rv.voter_id), 'username', vu.username, 'bot', COALESCE(vu.bot, false), 'vote', rv.vote,
                         'reason', rv.reason, 'messageId', btrim(rv.message_id), 'votedAt', rv.voted_at, 'sourceState', rv.source_state)
                         ORDER BY rv.voted_at, rv.voter_id)
                     FROM receipt_votes rv LEFT JOIN users vu ON vu.id = rv.voter_id
                     WHERE rv.receipt_id = r.id), '[]'::json) AS votes,
           -- Gates only: the gate after this one on the same artifact, if any. Every gate stays;
           -- the latest one is the artifact's current state.
           (SELECT btrim(g2.id) FROM thread_receipts g2
             WHERE r.kind = 'gate' AND g2.kind = 'gate' AND g2.thread_id = r.thread_id AND g2.id > r.id
               AND g2.ref_receipt_id IS NOT DISTINCT FROM r.ref_receipt_id AND g2.file_id IS NOT DISTINCT FROM r.file_id
             ORDER BY g2.id DESC LIMIT 1) AS superseded_by
    FROM thread_receipts r
    LEFT JOIN users a ON a.id = r.author_id
    LEFT JOIN users vb ON vb.id = r.verdict_by`;

const trimmed = (v: string | null | undefined): string | null => v?.trim() || null;

export function receiptJson(r: any) {
    return {
        id: r.id.trim(),
        channelId: r.channel_id.trim(),
        threadId: r.thread_id.trim(),
        kind: r.kind as ReceiptKind,
        messageId: trimmed(r.message_id),
        author: r.author_id ? { id: r.author_id.trim(), username: r.author_username ?? null, bot: !!r.author_bot } : null,
        mode: r.mode ?? null,
        /** The author's own words: data, not instructions. */
        summary: r.summary ?? null,
        grade: (r.grade ?? null) as Grade | null,
        gradeReason: r.grade_reason ?? null,
        basis: (r.basis ?? null) as Basis | null,
        outcome: r.outcome ?? null,
        sessionId: trimmed(r.session_id),
        runId: trimmed(r.run_id),
        fileId: trimmed(r.file_id),
        refReceiptId: trimmed(r.ref_receipt_id),
        evidence: r.evidence ?? {},
        history: r.history ?? [],
        /** Gates: false when a later gate on the same artifact exists (`supersededBy`). Null for other kinds. */
        isLatest: r.kind === 'gate' ? !r.superseded_by : null,
        supersededBy: trimmed(r.superseded_by),
        /** `source_edited`: the post was edited after the receipt copied its text. `source_removed`: the post was deleted and the copied text blanked. */
        sourceState: (r.source_state ?? null) as 'source_edited' | 'source_removed' | null,
        verdict: r.verdict
            ? { value: r.verdict as 'accepted' | 'disputed', by: r.verdict_by ? { id: r.verdict_by.trim(), username: r.verdict_username ?? null } : null,
                note: r.verdict_note ?? null, at: r.verdict_at }
            : null,
        /** `voterId` and `username` are null once the voter's account is gone: the vote stays. */
        votes: (r.votes ?? []) as Array<{ voterId: string | null; username: string | null; bot: boolean; vote: 'agree' | 'block'; reason: string | null; messageId: string | null; votedAt: string;
                                         sourceState: 'source_edited' | 'source_removed' | null }>,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

export type Receipt = ReturnType<typeof receiptJson>;

export async function readReceipt(db: any, receiptId: string, channelId?: string): Promise<Receipt | null> {
    const row = (await db.query(`${RECEIPT_SELECT} WHERE r.id = $1 AND ($2::char(26) IS NULL OR r.channel_id = $2)`, [receiptId, channelId ?? null])).rows[0];
    return row ? receiptJson(row) : null;
}

/** A thread's receipts, oldest first. Runs as the caller: RLS decides what it may see. */
export async function listThreadReceipts(db: any, channelId: string, threadId: string, kind?: ReceiptKind): Promise<Receipt[]> {
    const rows = await db.query(
        `${RECEIPT_SELECT} WHERE r.channel_id = $1 AND r.thread_id = $2 AND ($3::text IS NULL OR r.kind = $3) ORDER BY r.id`,
        [channelId, threadId, kind ?? null]
    );
    return rows.rows.map(receiptJson);
}

/** A channel's receipts changed since `since` (all, without it), newest change first. */
export async function listChannelReceipts(db: any, channelId: string, opts: { since?: string; kind?: ReceiptKind; limit: number }): Promise<Receipt[]> {
    const rows = await db.query(
        `${RECEIPT_SELECT} WHERE r.channel_id = $1 AND ($2::timestamptz IS NULL OR r.updated_at > $2) AND ($3::text IS NULL OR r.kind = $3)
         ORDER BY r.updated_at DESC, r.id DESC LIMIT $4`,
        [channelId, opts.since ?? null, opts.kind ?? null, opts.limit]
    );
    return rows.rows.map(receiptJson);
}

export function receiptUpdate(receipt: Receipt): Notice {
    return { channelId: receipt.channelId, eventName: 'ReceiptUpdate', event: { channelId: receipt.channelId, threadId: receipt.threadId, receipt } };
}

// ─── Writing ───

type Logger = { warn: (obj: unknown, msg?: string) => void } | undefined;

/**
 * Run `fn` as the service role on this connection, behind a savepoint, and put the caller's
 * role back. Unlike asService (agent-sessions.ts) an error does not propagate: the ledger is a
 * record of the work, and failing to write it must not undo the work. Returns `fallback` then.
 */
async function quietly<T>(db: any, log: Logger, what: string, fallback: T, fn: () => Promise<T>): Promise<T> {
    let role: string;
    try {
        role = (await db.query('SELECT current_user AS role')).rows[0].role as string;
        await db.query('SAVEPOINT receipts_write');
    } catch (err) {
        log?.warn({ err, what }, 'receipt not written');
        return fallback;
    }
    try {
        await db.query('SET LOCAL ROLE NONE');
        const result = await fn();
        await db.query(`SET LOCAL ROLE "${role.split('"').join('""')}"`);
        await db.query('RELEASE SAVEPOINT receipts_write');
        return result;
    } catch (err) {
        // Rolling back to the savepoint also puts the role back
        await db.query('ROLLBACK TO SAVEPOINT receipts_write').catch(() => {});
        await db.query('RELEASE SAVEPOINT receipts_write').catch(() => {});
        log?.warn({ err, what }, 'receipt not written');
        return fallback;
    }
}

/**
 * Like `quietly`, but an error rolls back to the savepoint and propagates: for the changes that
 * must not be skipped silently (blanking a deleted post's text), so the delete fails with it.
 */
async function strictly<T>(db: any, fn: () => Promise<T>): Promise<T> {
    const role = (await db.query('SELECT current_user AS role')).rows[0].role as string;
    await db.query('SAVEPOINT receipts_source');
    try {
        await db.query('SET LOCAL ROLE NONE');
        const result = await fn();
        await db.query(`SET LOCAL ROLE "${role.split('"').join('""')}"`);
        await db.query('RELEASE SAVEPOINT receipts_source');
        return result;
    } catch (err) {
        await db.query('ROLLBACK TO SAVEPOINT receipts_source');
        await db.query('RELEASE SAVEPOINT receipts_source');
        throw err;
    }
}

/** A post as the message routes see it, right after its INSERT. */
export interface PostedMessage {
    channelId: string;
    messageId: string;
    /** Thread parent for a reply, null for a top-level post. */
    threadId: string | null;
    authorId: string;
    /** The author's authority stamp, taken in this transaction (stampAuthority). */
    couldDirect: boolean;
    /** The bot token the post was made with (a bot author only). */
    authorTokenId?: string | null;
    protocol: ProtocolInfo | null;
    content: string | null;
    attachments: Array<{ id: string; name: string; mime: string; size: number }>;
}

const RECEIPT_STATES = new Set(['DECIDE', 'DONE', 'BLOCK', 'CANCEL']);

/**
 * Write the receipts a new post makes. Called by the message and reply routes after the
 * INSERT, in the post's transaction. Never throws; returns the events to emit after commit.
 */
export async function recordMessage(db: any, msg: PostedMessage, log?: Logger): Promise<Notice[]> {
    const state = msg.protocol && RECEIPT_STATES.has(msg.protocol.state) ? msg.protocol.state : null;
    const gate = msg.threadId && msg.couldDirect ? recogniseGate(msg.content) : null;
    if (!state && !gate && msg.attachments.length === 0) return [];

    return quietly(db, log, `message ${msg.messageId}`, [], async () => {
        const threadId = (msg.threadId ?? msg.messageId).trim();
        const scope = (await db.query(
            `SELECT btrim(c.server_id) AS server_id, btrim(s.owner_id) AS owner_id, t.protocol AS root_protocol, btrim(t.author_id) AS root_author
             FROM channels c JOIN servers s ON s.id = c.server_id LEFT JOIN messages t ON t.id = $2 AND t.channel_id = c.id
             WHERE c.id = $1`,
            [msg.channelId, threadId]
        )).rows[0];
        if (!scope?.server_id) return [];
        const ctx: WriteContext = { ...msg, authorId: msg.authorId.trim(), threadId, serverId: scope.server_id, ownerId: scope.owner_id,
            rootProtocol: scope.root_protocol ?? null, rootAuthor: scope.root_author ?? null };

        const touched: string[] = [];
        if (state === 'DECIDE') touched.push(...await recordVote(db, ctx));
        if (state === 'DONE') touched.push(...await recordClaim(db, ctx));
        if (state === 'BLOCK' || (state === 'CANCEL' && msg.couldDirect)) touched.push(...await recordStop(db, ctx, state));
        // A file posted in a protocol thread is an artifact
        if (msg.attachments.length > 0 && (ctx.rootProtocol || msg.protocol)) touched.push(...await recordArtifacts(db, ctx));
        if (gate) touched.push(...await recordGate(db, ctx, gate));

        const notices: Notice[] = [];
        for (const id of new Set(touched)) {
            const receipt = await readReceipt(db, id);
            if (receipt) notices.push(receiptUpdate(receipt));
        }
        return notices;
    });
}

interface WriteContext extends PostedMessage {
    threadId: string;
    serverId: string;
    ownerId: string | null;
    rootProtocol: ProtocolInfo | null;
    rootAuthor: string | null;
}

interface InsertFields {
    kind: ReceiptKind; summary?: string | null; grade?: GradeResult | null; outcome?: string | null;
    sessionId?: string | null; runId?: string | null; fileId?: string | null; refReceiptId?: string | null; evidence?: unknown;
}

/** Insert a receipt for this post, once: a second write for the same post and kind returns null. */
async function insertReceipt(db: any, ctx: WriteContext, f: InsertFields): Promise<string | null> {
    const id = generateUlid();
    const inserted = await db.query(
        `INSERT INTO thread_receipts (id, server_id, channel_id, thread_id, kind, message_id, author_id, mode, summary,
                                      grade, grade_reason, basis, session_id, run_id, outcome, file_id, ref_receipt_id, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT DO NOTHING RETURNING id`,
        [id, ctx.serverId, ctx.channelId, ctx.threadId, f.kind, ctx.messageId, ctx.authorId, ctx.protocol?.mode ?? null, f.summary ?? null,
         f.grade?.grade ?? null, f.grade?.reason ?? null, f.grade?.basis ?? null, f.sessionId ?? null, f.runId ?? null, f.outcome ?? null,
         f.fileId ?? null, f.refReceiptId ?? null, JSON.stringify(f.evidence ?? {})]
    );
    return inserted.rows.length > 0 ? id : null;
}

/** One writer at a time per thread: rounds open and close under this lock. */
async function lockThread(db: any, threadId: string): Promise<void> {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('agora:receipts'), hashtext($1))`, [threadId]);
}

/**
 * Who is expected to vote: the participants the thread's START names (by username or agent
 * profile name), its author, and the agents bound to it. Empty when the thread names nobody.
 */
async function expectedVoters(db: any, ctx: WriteContext): Promise<string[]> {
    const names = (ctx.rootProtocol?.participants ?? []).map(n => n.toLowerCase());
    const rows = await db.query(
        `SELECT btrim(u.id) AS id FROM users u
         WHERE lower(u.username) = ANY($1)
           AND (EXISTS (SELECT 1 FROM server_members sm WHERE sm.server_id = $2 AND sm.user_id = u.id)
                OR EXISTS (SELECT 1 FROM bot_channel_access b WHERE b.channel_id = $3 AND b.bot_id = u.id))
         UNION
         SELECT btrim(p.bot_id) FROM agent_profiles p WHERE p.server_id = $2 AND lower(p.name) = ANY($1)
         UNION
         SELECT btrim(s.bot_id) FROM agent_session_threads t JOIN agent_sessions s ON btrim(s.id) = ANY(t.session_ids)
         WHERE t.thread_id = $4`,
        [names, ctx.serverId, ctx.channelId, ctx.threadId]
    );
    const ids = new Set<string>(rows.rows.map((r: any) => r.id));
    if (ids.size > 0 && ctx.rootProtocol?.state === 'START' && ctx.rootAuthor) ids.add(ctx.rootAuthor);
    return [...ids].sort();
}

async function roundVotes(db: any, receiptId: string): Promise<VoteTally[]> {
    const rows = await db.query(`SELECT btrim(voter_id) AS voter_id, vote FROM receipt_votes WHERE receipt_id = $1`, [receiptId]);
    return rows.rows.map((r: any) => ({ voterId: r.voter_id, vote: r.vote }));
}

/** A DECIDE: a vote in the thread's open round, which it opens when there is none. */
async function recordVote(db: any, ctx: WriteContext): Promise<string[]> {
    const decision = ctx.protocol?.decision;
    if (!decision) return [];
    await lockThread(db, ctx.threadId);
    const expected = await expectedVoters(db, ctx);
    // A named thread takes votes from its participants and from whoever may direct agents
    if (expected.length > 0 && !expected.includes(ctx.authorId) && !ctx.couldDirect) return [];

    let receiptId: string | null = (await db.query(
        `SELECT btrim(id) AS id FROM thread_receipts WHERE thread_id = $1 AND kind = 'decision' AND outcome = 'open'`, [ctx.threadId]
    )).rows[0]?.id ?? null;
    if (!receiptId) {
        receiptId = await insertReceipt(db, ctx, { kind: 'decision', outcome: 'open', evidence: { expectedVoters: expected } });
        // This DECIDE already opened a round (a replayed post)
        if (!receiptId) return [];
    }
    const vote = decision === 'AGREE' ? 'agree' : 'block';
    await db.query(
        `INSERT INTO receipt_votes (receipt_id, voter_id, vote, reason, message_id) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (receipt_id, voter_id) DO UPDATE SET vote = EXCLUDED.vote, reason = EXCLUDED.reason, message_id = EXCLUDED.message_id, source_state = NULL, voted_at = NOW()`,
        [receiptId, ctx.authorId, vote, voteReason(ctx.content), ctx.messageId]
    );
    const outcome = roundOutcome(await roundVotes(db, receiptId), expected, null);
    await db.query(
        `UPDATE thread_receipts SET outcome = $2, evidence = jsonb_set(evidence, '{expectedVoters}', $3::jsonb), updated_at = NOW() WHERE id = $1`,
        [receiptId, outcome, JSON.stringify(expected)]
    );
    return [receiptId];
}

/** The thread ended: its open round, if any, closes on the votes that were cast. */
async function closeRound(db: any, ctx: WriteContext, closing: 'done' | 'blocked' | 'cancelled'): Promise<string[]> {
    const open = (await db.query(
        `SELECT btrim(id) AS id, evidence FROM thread_receipts WHERE thread_id = $1 AND kind = 'decision' AND outcome = 'open' FOR UPDATE`, [ctx.threadId]
    )).rows[0];
    if (!open) return [];
    const expected: string[] = Array.isArray(open.evidence?.expectedVoters) ? open.evidence.expectedVoters : [];
    const outcome = roundOutcome(await roundVotes(db, open.id), expected, closing);
    await db.query(`UPDATE thread_receipts SET outcome = $2, updated_at = NOW() WHERE id = $1`, [open.id, outcome]);
    return [open.id];
}

/** The run row as evidence: what the server holds, never the agent's own account of it. */
function runEvidence(run: any, checkpoint: any | null) {
    const paths: string[] = run.changed_paths ?? [];
    const v = run.verification;
    return {
        id: run.id.trim(),
        status: run.status as string,
        error: run.error ?? null,
        branch: run.branch ?? null,
        baseSha: run.base_sha ?? null,
        headSha: run.head_sha ?? null,
        changedPaths: paths.slice(0, MAX_PATHS),
        changedPathCount: paths.length,
        // The command's output stays on the run: it is long, and it is the agent's text
        verification: v ? { command: v.command ?? null, status: v.status ?? null, attempts: v.attempts ?? 0, exitCode: v.exitCode ?? null, reason: v.reason ?? null } : null,
        checkpoint: checkpoint ? { sha: checkpoint.sha, ref: checkpoint.ref } : null,
        finishedAt: run.finished_at ?? null,
    };
}

/**
 * What the server holds about a run, for grading the claim of `threadId` by `botId`.
 *
 * - `startSha`: where the branch stood when the run began. The host reports `base_sha` as the
 *   session's original base, which never moves, so a run that changes nothing after an earlier
 *   run committed would otherwise look committed. The start is the head the session's previous
 *   successful run ended at (a failed run reports none), else the base.
 * - `sameThread`: the run was woken for the claim's thread (a message of it is in the run's batch),
 *   its session is bound to that thread, or the agent started the thread during the run. A
 *   channel-wide session's run belongs to the thread it was woken for, not to every thread the
 *   agent posts in meanwhile.
 */
async function runFactsFor(db: any, run: any, threadId: string, botId: string): Promise<RunFacts> {
    const prev = (await db.query(
        `SELECT head_sha FROM agent_runs WHERE session_id = $1 AND id < $2 AND status = 'succeeded' AND head_sha IS NOT NULL ORDER BY id DESC LIMIT 1`,
        [run.session_id, run.id]
    )).rows[0];
    const scope = (await db.query(
        `SELECT (s.thread_id = $2
                 OR EXISTS (SELECT 1 FROM agent_inbox i WHERE i.batch_id = r.batch_id AND (i.thread_id = $2 OR i.message_id = $2))
                 OR EXISTS (SELECT 1 FROM messages t WHERE t.id = $2 AND t.author_id = $3 AND t.created_at >= r.created_at)) AS same
         FROM agent_runs r JOIN agent_sessions s ON s.id = r.session_id WHERE r.id = $1`,
        [run.id, threadId, botId]
    )).rows[0];
    return { status: run.status, error: run.error, cancelRequested: !!run.cancel_requested, headSha: run.head_sha, baseSha: run.base_sha,
        startSha: prev?.head_sha ?? run.base_sha ?? null, sameThread: !!scope?.same,
        changedPaths: run.changed_paths, verification: run.verification };
}

async function runWithCheckpoint(db: any, runId: string): Promise<{ run: any; checkpoint: any | null } | null> {
    const run = (await db.query(`SELECT * FROM agent_runs WHERE id = $1`, [runId])).rows[0];
    if (!run) return null;
    const checkpoint = (await db.query(`SELECT sha, ref FROM agent_checkpoints WHERE run_id = $1`, [runId])).rows[0] ?? null;
    return { run, checkpoint };
}

/**
 * The hosted run a DONE was posted from: the author's own run that is going right now in this
 * channel (its session for this thread first), when the post came with that run's own token
 * (the agent host's or box's). A post with any other token is not tied to a run.
 */
async function liveRunOf(db: any, ctx: WriteContext): Promise<{ runId: string; sessionId: string } | null> {
    if (!ctx.authorTokenId) return null;
    const token = await db.query(
        `SELECT 1 FROM bot_tokens WHERE id = $1 AND bot_id = $2 AND revoked_at IS NULL AND purpose IN ('host', 'box')`,
        [ctx.authorTokenId, ctx.authorId]
    );
    if (token.rows.length === 0) return null;
    const row = (await db.query(
        `SELECT btrim(r.id) AS run_id, btrim(s.id) AS session_id
         FROM agent_runs r JOIN agent_sessions s ON s.id = r.session_id
         WHERE s.bot_id = $1 AND s.channel_id = $2 AND s.kind = 'hosted' AND r.status = 'claimed'
           AND (s.thread_id IS NULL OR s.thread_id = $3)
         ORDER BY (s.thread_id IS NOT NULL) DESC, r.created_at DESC, r.id DESC LIMIT 1`,
        [ctx.authorId, ctx.channelId, ctx.threadId]
    )).rows[0];
    return row ? { runId: row.run_id, sessionId: row.session_id } : null;
}

/** A DONE: a claim, graded against its run; the thread's open round closes. */
async function recordClaim(db: any, ctx: WriteContext): Promise<string[]> {
    await lockThread(db, ctx.threadId);
    const live = await liveRunOf(db, ctx);
    const held = live ? await runWithCheckpoint(db, live.runId) : null;
    const grade = gradeClaim(ctx.protocol?.mode ?? null, held ? await runFactsFor(db, held.run, ctx.threadId, ctx.authorId) : null);
    const id = await insertReceipt(db, ctx, {
        kind: 'claim', summary: claimSummary(ctx.content), grade,
        sessionId: live?.sessionId ?? null, runId: live?.runId ?? null,
        evidence: held ? { run: runEvidence(held.run, held.checkpoint) } : {},
    });
    if (!id) return [];
    return [id, ...await closeRound(db, ctx, 'done')];
}

/** A thread-level BLOCK, or a CANCEL from someone who may direct agents. */
async function recordStop(db: any, ctx: WriteContext, state: 'BLOCK' | 'CANCEL'): Promise<string[]> {
    await lockThread(db, ctx.threadId);
    const outcome = state === 'BLOCK' ? 'blocked' : 'cancelled';
    const id = await insertReceipt(db, ctx, { kind: 'stop', outcome, summary: claimSummary(ctx.content) });
    if (!id) return [];
    return [id, ...await closeRound(db, ctx, outcome)];
}

async function recordArtifacts(db: any, ctx: WriteContext): Promise<string[]> {
    const ids: string[] = [];
    for (const file of ctx.attachments) {
        const id = await insertReceipt(db, ctx, {
            kind: 'artifact', fileId: file.id, summary: String(file.name ?? '').slice(0, MAX_SUMMARY),
            evidence: { filename: String(file.name ?? '').slice(0, MAX_SUMMARY), mime: file.mime ?? null, sizeBytes: file.size ?? null },
        });
        if (id) ids.push(id);
    }
    return ids;
}

/**
 * A gate reply: the file ID must name an artifact of this thread, and nobody passes a gate on
 * their own artifact. The caller has already checked that the author may direct agents here.
 */
async function recordGate(db: any, ctx: WriteContext, gate: GateReply): Promise<string[]> {
    const artifact = (await db.query(
        `SELECT btrim(id) AS id, btrim(author_id) AS author_id FROM thread_receipts
         WHERE thread_id = $1 AND kind = 'artifact' AND file_id = $2 ORDER BY id DESC LIMIT 1`,
        [ctx.threadId, gate.fileId]
    )).rows[0];
    if (!artifact || artifact.author_id === ctx.authorId) return [];
    // Who passed it, precisely: a bot the owner lets direct may pass a gate, and a reader must be able to tell
    // that from a person's approval (`byBot`)
    const byBot = !!(await db.query(`SELECT bot FROM users WHERE id = $1`, [ctx.authorId])).rows[0]?.bot;
    const id = await insertReceipt(db, ctx, {
        kind: 'gate', outcome: gate.word, summary: gate.reason, fileId: gate.fileId, refReceiptId: artifact.id,
        evidence: { authority: ctx.authorId === ctx.ownerId ? 'owner' : 'director', byBot },
    });
    return id ? [id] : [];
}

// ─── Re-grading when a run finishes ───

async function regrade(db: any, receipt: any, held: { run: any; checkpoint: any | null }): Promise<boolean> {
    const next = gradeClaim(receipt.mode, await runFactsFor(db, held.run, receipt.thread_id.trim(), receipt.author_id.trim()));
    const entry = { type: 'grade', at: new Date().toISOString(), from: { grade: receipt.grade, reason: receipt.grade_reason }, to: { grade: next.grade, reason: next.reason } };
    const changed = next.grade !== receipt.grade || next.reason !== receipt.grade_reason;
    await db.query(
        `UPDATE thread_receipts SET grade = $2, grade_reason = $3, basis = $4, run_id = $7,
                evidence = jsonb_set(evidence, '{run}', $5::jsonb),
                history = history || $6::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [receipt.id, next.grade, next.reason, next.basis, JSON.stringify(runEvidence(held.run, held.checkpoint)), JSON.stringify(changed ? [entry] : []), held.run.id]
    );
    return changed;
}

/**
 * A claim whose run failed but whose batch will be tried again: still open. It reads
 * `unverified` `run_retrying` until the retry's own run ends and grades it.
 */
async function holdForRetry(db: any, receipt: any, held: { run: any; checkpoint: any | null }): Promise<boolean> {
    if (receipt.grade_reason === 'run_retrying') return false;
    const entry = { type: 'grade', at: new Date().toISOString(), from: { grade: receipt.grade, reason: receipt.grade_reason }, to: { grade: 'unverified', reason: 'run_retrying' } };
    await db.query(
        `UPDATE thread_receipts SET grade = 'unverified', grade_reason = 'run_retrying', basis = 'assumed',
                evidence = jsonb_set(evidence, '{run}', $2::jsonb), history = history || $3::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [receipt.id, JSON.stringify(runEvidence(held.run, held.checkpoint)), JSON.stringify([entry])]
    );
    return true;
}

/**
 * A run ended (succeeded, failed or expired): grade the claims posted from it, now against its
 * result. Called from the run's own transaction (agent-runs.ts complete, fail and expireRun),
 * after the batch has been settled.
 *
 * A failed or expired run whose batch will be tried again (it is waiting to retry, or a newer
 * attempt exists) does not close its claims: they are held as `run_retrying`, and the retry's
 * run grades them, whichever way it ends. The claims of a batch are found through the batch,
 * so a claim made in the first attempt is graded by the last.
 * Never throws; returns the events to emit after commit.
 */
export async function onRunFinished(db: any, runId: string, log?: Logger): Promise<Notice[]> {
    return quietly(db, log, `run ${runId}`, [], async () => {
        const held = await runWithCheckpoint(db, runId);
        if (!held || held.run.status === 'claimed') return [];
        const receipts = await db.query(
            `SELECT r.* FROM thread_receipts r
             WHERE r.kind = 'claim' AND r.grade_reason IN ('run_in_progress', 'run_retrying')
               AND (r.run_id = $1 OR r.run_id IN (SELECT id FROM agent_runs WHERE batch_id = $2))
             ORDER BY r.id FOR UPDATE OF r`,
            [runId, held.run.batch_id]
        );
        if (receipts.rows.length === 0) return [];
        let retrying = false;
        if (held.run.status !== 'succeeded') {
            const batch = (await db.query(
                `SELECT b.status, EXISTS (SELECT 1 FROM agent_runs n WHERE n.batch_id = b.id AND n.id > $2) AS newer FROM agent_batches b WHERE b.id = $1`,
                [held.run.batch_id, runId]
            )).rows[0];
            retrying = !!batch && (batch.status === 'retry' || batch.newer);
        }
        const notices: Notice[] = [];
        for (const row of receipts.rows) {
            const touched = retrying ? await holdForRetry(db, row, held) : (await regrade(db, row, held), true);
            if (!touched) continue;
            const receipt = await readReceipt(db, row.id);
            if (receipt) notices.push(receiptUpdate(receipt));
        }
        return notices;
    });
}

/**
 * Claims in this channel still waiting on a run that has since finished: the run ended without
 * its hook seeing the claim (it finished while the DONE was still being posted, or the hook
 * failed), or its batch was given up after a retry was expected. The read routes call this
 * first, so a list never shows a stale "run in progress".
 */
export async function settleFinishedRuns(db: any, channelId: string, log?: Logger): Promise<Notice[]> {
    return quietly(db, log, `channel ${channelId}`, [], async () => {
        const stale = await db.query(
            `SELECT DISTINCT btrim(r.run_id) AS run_id FROM thread_receipts r
             JOIN agent_runs ar ON ar.id = r.run_id JOIN agent_batches b ON b.id = ar.batch_id
             WHERE r.channel_id = $1 AND r.kind = 'claim'
               AND ((r.grade_reason = 'run_in_progress' AND ar.status <> 'claimed')
                    OR (r.grade_reason = 'run_retrying' AND b.status NOT IN ('retry', 'running')))`,
            [channelId]
        );
        const notices: Notice[] = [];
        for (const row of stale.rows) notices.push(...await onRunFinished(db, row.run_id, log));
        return notices;
    });
}

// ─── Editing and deleting the post a receipt copied from ───

function sourceNotices(receipts: Receipt[]): Notice[] { return receipts.map(receiptUpdate); }

/**
 * A post was edited: its receipts keep the text they copied when it was first made, and are
 * marked `source_edited` so a reader knows. Does nothing for a post that made no receipt.
 * Never throws; returns the events to emit after commit.
 */
export async function markSourceEdited(db: any, messageId: string, log?: Logger): Promise<Notice[]> {
    return quietly(db, log, `edit ${messageId}`, [], async () => {
        const ids = new Set<string>();
        const own = await db.query(
            `UPDATE thread_receipts SET source_state = 'source_edited', updated_at = NOW() WHERE message_id = $1 AND source_state IS NULL RETURNING btrim(id) AS id`, [messageId]);
        for (const r of own.rows) ids.add(r.id);
        const votes = await db.query(
            `UPDATE receipt_votes SET source_state = 'source_edited' WHERE message_id = $1 AND source_state IS NULL RETURNING btrim(receipt_id) AS id`, [messageId]);
        for (const r of votes.rows) ids.add(r.id);
        if (votes.rows.length > 0) await db.query(`UPDATE thread_receipts SET updated_at = NOW() WHERE id = ANY($1)`, [votes.rows.map((r: any) => r.id)]);
        return sourceNotices((await Promise.all([...ids].map(id => readReceipt(db, id)))).filter((r): r is Receipt => !!r));
    });
}

/**
 * Posts were deleted (by their author, or with their account): every receipt and vote made
 * from them loses the copied text (a claim's summary, a vote's reason, a gate's rejection
 * reason, an artifact's file name) and is marked `source_removed`. The receipts stay: that a
 * claim, vote or gate was made is the record. Runs as the service role in the delete's own
 * transaction and propagates errors, so a delete never commits with the text still in the ledger.
 */
export async function markSourceRemoved(db: any, messageIds: string[]): Promise<Notice[]> {
    if (messageIds.length === 0) return [];
    return strictly(db, async () => {
        const ids = new Set<string>();
        const own = await db.query(
            `UPDATE thread_receipts SET summary = NULL, evidence = evidence - 'filename', source_state = 'source_removed', updated_at = NOW()
             WHERE message_id = ANY($1) RETURNING btrim(id) AS id`, [messageIds]);
        for (const r of own.rows) ids.add(r.id);
        const votes = await db.query(
            `UPDATE receipt_votes SET reason = NULL, source_state = 'source_removed' WHERE message_id = ANY($1) RETURNING btrim(receipt_id) AS id`, [messageIds]);
        for (const r of votes.rows) ids.add(r.id);
        if (votes.rows.length > 0) await db.query(`UPDATE thread_receipts SET updated_at = NOW() WHERE id = ANY($1)`, [votes.rows.map((r: any) => r.id)]);
        return sourceNotices((await Promise.all([...ids].map(id => readReceipt(db, id)))).filter((r): r is Receipt => !!r));
    });
}

// ─── Verdicts and self-reported evidence (the routes have checked who may) ───

/**
 * Record the owner's or a director's verdict. The grade is untouched: the verdict is the
 * person's own judgement, kept beside it. Runs as the service role; propagates errors.
 */
export async function setVerdict(db: any, input: { receiptId: string; channelId: string; userId: string; verdict: 'accepted' | 'disputed'; note: string | null }): Promise<Receipt | null> {
    const entry = { type: 'verdict', at: new Date().toISOString(), by: input.userId.trim(), verdict: input.verdict, note: input.note };
    const updated = await db.query(
        `UPDATE thread_receipts SET verdict = $3, verdict_by = $4, verdict_note = $5, verdict_at = NOW(),
                history = history || $6::jsonb, updated_at = NOW()
         WHERE id = $1 AND channel_id = $2 RETURNING id`,
        [input.receiptId, input.channelId, input.verdict, input.userId, input.note, JSON.stringify([entry])]
    );
    return updated.rows.length > 0 ? readReceipt(db, input.receiptId) : null;
}

export interface SelfReport { sha?: string; paths?: string[]; tested?: boolean; note?: string }

/**
 * Keep what a claim's own author says backs it, under `evidence.selfReported`. It is the
 * author's word: shown as such, and never an input to the grade or the basis.
 * Returns null when the list is full.
 */
export async function attachEvidence(db: any, input: { receiptId: string; channelId: string; userId: string; report: SelfReport }): Promise<Receipt | null> {
    const entry = { ...input.report, by: input.userId.trim(), at: new Date().toISOString() };
    const updated = await db.query(
        `UPDATE thread_receipts
         SET evidence = jsonb_set(evidence, '{selfReported}', COALESCE(evidence->'selfReported', '[]'::jsonb) || $3::jsonb), updated_at = NOW()
         WHERE id = $1 AND channel_id = $2 AND jsonb_array_length(COALESCE(evidence->'selfReported', '[]'::jsonb)) < $4
         RETURNING id`,
        [input.receiptId, input.channelId, JSON.stringify([entry]), MAX_SELF_REPORTS]
    );
    return updated.rows.length > 0 ? readReceipt(db, input.receiptId) : null;
}

