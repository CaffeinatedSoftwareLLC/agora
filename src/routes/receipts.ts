import type { FastifyInstance, FastifyRequest } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { canViewChannel } from '../lib/channel-access';
import { cannotDirect, readAuthorities, stampAuthority } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';
import { postNotice, threadReplyCounted, type Notice } from '../lib/agent-runs';
import { planNotice, PLAN_OWNER_SQL, WAKE_AUTH_SQL } from '../lib/provider-terms';
import { sanitizeMessageText } from '../lib/sanitize-text';
import {
    RECEIPT_KINDS, attachEvidence, listChannelReceipts, listThreadReceipts, readReceipt, receiptUpdate, setVerdict, settleFinishedRuns,
    type Receipt, type SelfReport,
} from '../lib/receipts';

/**
 * The receipts ledger over HTTP (docs/receipts.md, src/lib/receipts.ts).
 *
 * Anyone who can see the channel reads its receipts. Receipts themselves are written by the
 * server when a protocol post or a run arrives; these routes only add to one:
 * - the owner or a director gives a verdict (`accepted` or `disputed`); a dispute posts a
 *   message in the thread and wakes the claiming agent, under the same rule as any wake by a
 *   person (a plan-owned agent wakes for its plan owner only, src/lib/provider-terms.ts);
 * - a claim's own author attaches self-reported evidence, which never changes the grade.
 */

const ID = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' } as const;
const KIND = { type: 'string', enum: [...RECEIPT_KINDS] } as const;

function emit(request: FastifyRequest, notices: Notice[]) {
    request.pendingEvents ??= [];
    for (const n of notices) request.pendingEvents.push({ room: `channel:${n.channelId}`, event: n.eventName ?? 'Message', data: n.event });
}

/** One block of plain text: escapes and private keys out, as for any message (#88). */
function clean(text: string | undefined, max: number): string | null {
    const out = text === undefined ? '' : sanitizeMessageText(text).trim();
    return out ? out.slice(0, max) : null;
}

export interface DisputeWake { woke: boolean; sessionId?: string; reason?: 'no_live_session' | 'terminal_session' | 'plan_owner_only' | 'not_an_agent' | 'already_disputed' }

/**
 * Post the dispute where the claim was made and wake the agent that made it. The post is the
 * disputing person's own message (their note, with their authority stamp), so the wake is a
 * person's direct wake like any other: an API-key agent takes it from the owner or a director,
 * a plan-owned agent only from its plan owner, in a session that owner started. A refused wake
 * gets the usual notice. Runs as the service role.
 */
async function postDispute(db: any, receipt: Receipt, userId: string, note: string, notices: Notice[]): Promise<{ messageId: string; wake: DisputeWake }> {
    const channelId = receipt.channelId;
    const parent = (await db.query(`SELECT thread_closed_at FROM messages WHERE id = $1 AND channel_id = $2`, [receipt.threadId, channelId])).rows[0];
    // A closed thread takes no replies: the dispute goes to the channel
    const threadId = parent && !parent.thread_closed_at ? receipt.threadId : null;

    const messageId = generateUlid();
    // The receipt is named by its IDs only. Its summary is the agent's own text and stays out of
    // anything that wakes an agent; the note is the disputing person's own words.
    const content = `Disputed: receipt ${receipt.id} (${receipt.kind}${receipt.messageId ? `, message ${receipt.messageId}` : ''}).\nReason: ${note}`;
    const systemData = { kind: 'receipt_verdict', receiptId: receipt.id, receiptKind: receipt.kind, verdict: 'disputed', messageId: receipt.messageId };
    await db.query(
        `INSERT INTO messages (id, channel_id, author_id, content, thread_id, system_event, system_data, author_could_direct)
         VALUES ($1, $2, $3, $4, $5, 'receipt_verdict', $6, true)`,
        [messageId, channelId, userId, content, threadId, JSON.stringify(systemData)]
    );
    const author = (await db.query('SELECT username, avatar_url FROM users WHERE id = $1', [userId])).rows[0];
    const authority = (await readAuthorities(db, channelId, [{ id: messageId, author_id: userId, author_bot: false, author_could_direct: true }])).get(messageId) ?? null;
    notices.push({ channelId, event: {
        id: messageId, content, authorId: userId.trim(), authorUsername: author?.username ?? null, authorBot: false,
        authorAvatarUrl: author?.avatar_url || null, authorAuthority: authority, channelId, createdAt: new Date().toISOString(),
        ...(threadId ? { threadId } : {}), mentions: [], mentionsEveryone: false, attachments: [],
        systemEvent: 'receipt_verdict', systemData,
    } });
    if (threadId) notices.push(await threadReplyCounted(db, channelId, threadId));

    const say = async (text: string) => {
        notices.push(await postNotice(db, channelId, text, threadId));
        if (threadId) notices.push(await threadReplyCounted(db, channelId, threadId));
    };
    const wake = await wakeAuthor(db, receipt, userId, messageId, threadId, say);
    return { messageId, wake };
}

/** The message this person's dispute of the receipt was posted as, the latest if there are several. */
async function disputeMessageOf(db: any, receiptId: string, userId: string): Promise<string | null> {
    const row = (await db.query(
        `SELECT btrim(id) AS id FROM messages WHERE system_event = 'receipt_verdict' AND author_id = $2 AND system_data->>'receiptId' = $1
         ORDER BY id DESC LIMIT 1`,
        [receiptId, userId]
    )).rows[0];
    return row?.id ?? null;
}

async function wakeAuthor(db: any, receipt: Receipt, userId: string, messageId: string, threadId: string | null,
                          say: (text: string) => Promise<void>): Promise<DisputeWake> {
    if (!receipt.author?.bot) return { woke: false, reason: 'not_an_agent' };
    const botId = receipt.author.id;
    // Single responder (#112): an agent connected from a terminal hears the thread itself
    const terminal = await db.query(
        `SELECT 1 FROM agent_sessions WHERE channel_id = $1 AND bot_id = $2 AND state = 'live' AND kind = 'terminal' LIMIT 1`,
        [receipt.channelId, botId]
    );
    if (terminal.rows.length > 0) return { woke: false, reason: 'terminal_session' };
    // The session that made the claim while it is live; else the agent's session for this thread, else its channel session
    const session = (await db.query(
        `SELECT btrim(s.id) AS id, p.name AS profile_name, ${WAKE_AUTH_SQL} AS auth_mode, btrim(${PLAN_OWNER_SQL}) AS plan_owner_id, btrim(s.started_by) AS started_by
         FROM agent_sessions s
         JOIN agent_profiles p ON p.id = s.profile_id
         JOIN servers srv ON srv.id = s.server_id
         WHERE s.channel_id = $1 AND s.bot_id = $2 AND s.state = 'live' AND s.kind = 'hosted'
           AND (s.id = $3 OR s.thread_id IS NULL OR s.thread_id = $4)
         ORDER BY (s.id = $3) DESC NULLS LAST, (s.thread_id IS NOT NULL) DESC, s.id DESC LIMIT 1`,
        [receipt.channelId, botId, receipt.sessionId, receipt.threadId]
    )).rows[0];
    if (!session) return { woke: false, reason: 'no_live_session' };
    // The plan-owner rule, as termsAllow applies it to a person's direct wake; the claim reruns it
    if (session.auth_mode !== 'api_key' && !(session.plan_owner_id && session.plan_owner_id === userId.trim() && session.started_by === session.plan_owner_id)) {
        await say(planNotice(session.profile_name, session.auth_mode, !!session.plan_owner_id));
        return { woke: false, sessionId: session.id, reason: 'plan_owner_only' };
    }
    await db.query(
        `INSERT INTO agent_inbox (id, session_id, message_id, thread_id, reason) VALUES ($1, $2, $3, $4, 'direct')
         ON CONFLICT (session_id, message_id) DO NOTHING`,
        [generateUlid(), session.id, messageId, threadId]
    );
    return { woke: true, sessionId: session.id };
}

export async function receiptRoutes(app: FastifyInstance) {

    // GET /channels/:id/threads/:threadId/receipts?kind → 200 { receipts }, oldest first
    app.get('/channels/:id/threads/:threadId/receipts', {
        schema: {
            params: { type: 'object', required: ['id', 'threadId'], properties: { id: ID, threadId: ID } },
            querystring: { type: 'object', additionalProperties: false, properties: { kind: KIND } },
        },
    }, async (request, reply) => {
        const { id: channelId, threadId } = request.params as any;
        const { kind } = request.query as any;
        const db = request.dbClient!;
        const access = await canViewChannel(db, channelId, request.userId, !!request.isBot);
        if (!access.allowed) return reply.status(403).send({ error: 'Channel access denied' });

        emit(request, await settleFinishedRuns(db, channelId, request.log));
        return reply.send({ receipts: await listThreadReceipts(db, channelId, threadId, kind) });
    });

    // GET /channels/:id/receipts?since&kind&limit → 200 { receipts }, most recently changed first
    app.get('/channels/:id/receipts', {
        schema: {
            params: { type: 'object', required: ['id'], properties: { id: ID } },
            querystring: { type: 'object', additionalProperties: false, properties: {
                since: { type: 'string', minLength: 1, maxLength: 64 },
                kind: KIND,
                limit: { type: 'integer', minimum: 1, maximum: 200 },
            } },
        },
    }, async (request, reply) => {
        const { id: channelId } = request.params as any;
        const { since, kind, limit } = request.query as any;
        const db = request.dbClient!;
        const access = await canViewChannel(db, channelId, request.userId, !!request.isBot);
        if (!access.allowed) return reply.status(403).send({ error: 'Channel access denied' });
        if (since !== undefined && Number.isNaN(Date.parse(since))) return reply.status(400).send({ error: 'since must be a timestamp' });

        emit(request, await settleFinishedRuns(db, channelId, request.log));
        const receipts = await listChannelReceipts(db, channelId, { since: since ? new Date(since).toISOString() : undefined, kind, limit: limit ?? 50 });
        return reply.send({ receipts });
    });

    // POST /channels/:id/receipts/:receiptId/verdict → 200 { receipt, messageId?, wake? }
    app.post('/channels/:id/receipts/:receiptId/verdict', {
        schema: {
            params: { type: 'object', required: ['id', 'receiptId'], properties: { id: ID, receiptId: ID } },
            body: {
                type: 'object', additionalProperties: false, required: ['verdict'],
                properties: {
                    verdict: { type: 'string', enum: ['accepted', 'disputed'] },
                    note: { type: 'string', maxLength: 1000 },
                },
            },
        },
    }, async (request, reply) => {
        const { id: channelId, receiptId } = request.params as any;
        const { verdict } = request.body as any;
        const userId = request.userId;
        const db = request.dbClient!;
        const access = await canViewChannel(db, channelId, userId, !!request.isBot);
        if (!access.allowed) return reply.status(403).send({ error: 'Channel access denied' });
        // A verdict is a person's judgement: the owner's or a director's, never an agent's
        if (request.isBot) return reply.status(403).send({ error: 'people_only' });
        if (!await stampAuthority(db, channelId, userId, false)) return reply.status(403).send(await cannotDirect(db, channelId, userId));

        const note = clean((request.body as any).note, 1000);
        // The agent is woken with the reason: a dispute without one tells it nothing
        if (verdict === 'disputed' && !note) return reply.status(400).send({ error: 'note_required' });
        const receipt = await readReceipt(db, receiptId, channelId);
        if (!receipt) return reply.status(404).send({ error: 'receipt_not_found' });

        const notices: Notice[] = [];
        const result = await asService(db, async () => {
            // The same person disputing the same receipt again (a double submit, a retry) posts nothing
            // and wakes nobody: it returns the dispute already made. A changed note replaces the stored one.
            const again = verdict === 'disputed' && receipt.verdict?.value === 'disputed' && receipt.verdict.by?.id === userId.trim();
            if (again && receipt.verdict!.note === note) {
                return { receipt, messageId: await disputeMessageOf(db, receiptId, userId), wake: { woke: false, reason: 'already_disputed' } as DisputeWake };
            }
            const updated = await setVerdict(db, { receiptId, channelId, userId, verdict, note });
            if (!updated) return null;
            if (again) {
                notices.push(receiptUpdate(updated));
                return { receipt: updated, messageId: await disputeMessageOf(db, receiptId, userId), wake: { woke: false, reason: 'already_disputed' } as DisputeWake };
            }
            const dispute = verdict === 'disputed' ? await postDispute(db, updated, userId, note!, notices) : null;
            notices.push(receiptUpdate(updated));
            return { receipt: updated, ...(dispute ?? {}) };
        });
        if (!result) return reply.status(404).send({ error: 'receipt_not_found' });
        emit(request, notices);
        return reply.send(result);
    });

    // POST /channels/:id/receipts/:receiptId/attach → 200 { receipt }
    app.post('/channels/:id/receipts/:receiptId/attach', {
        schema: {
            params: { type: 'object', required: ['id', 'receiptId'], properties: { id: ID, receiptId: ID } },
            body: {
                type: 'object', additionalProperties: false, minProperties: 1,
                properties: {
                    sha: { type: 'string', pattern: '^[0-9a-f]{7,64}$' },
                    paths: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 400 } },
                    tested: { type: 'boolean' },
                    note: { type: 'string', maxLength: 500 },
                },
            },
        },
    }, async (request, reply) => {
        const { id: channelId, receiptId } = request.params as any;
        const body = request.body as any;
        const userId = request.userId;
        const db = request.dbClient!;
        const access = await canViewChannel(db, channelId, userId, !!request.isBot);
        if (!access.allowed) return reply.status(403).send({ error: 'Channel access denied' });

        const receipt = await readReceipt(db, receiptId, channelId);
        if (!receipt) return reply.status(404).send({ error: 'receipt_not_found' });
        if (receipt.kind !== 'claim') return reply.status(400).send({ error: 'not_a_claim' });
        // Evidence for a claim comes from whoever made it
        if (receipt.author?.id !== userId.trim()) return reply.status(403).send({ error: 'not_the_claimant' });

        const report: SelfReport = {};
        if (body.sha !== undefined) report.sha = body.sha;
        if (body.paths !== undefined) report.paths = (body.paths as string[]).map(p => clean(p, 400)).filter((p): p is string => !!p);
        if (body.tested !== undefined) report.tested = body.tested;
        const note = clean(body.note, 500);
        if (note) report.note = note;
        if (Object.keys(report).length === 0) return reply.status(400).send({ error: 'empty_evidence' });

        const updated = await asService(db, () => attachEvidence(db, { receiptId, channelId, userId, report }));
        if (!updated) return reply.status(409).send({ error: 'evidence_full' });
        emit(request, [receiptUpdate(updated)]);
        return reply.send({ receipt: updated });
    });
}
