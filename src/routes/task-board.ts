import type { FastifyInstance, FastifyRequest } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { canViewChannel } from '../lib/channel-access';
import { cannotDirect, isServerOwner, stampAuthority } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';
import { budgetExhausted, sessionUpdate, type Notice } from '../lib/agent-runs';
import { CARD_SELECT, CARD_STATUSES, cardJson, cardUpdate, kickoffText, notifyCardReview } from '../lib/task-cards';
import { sanitizeMessageText } from '../lib/sanitize-text';
import {
    CommandError, SESSION_SELECT, announce, botInChannel, profileByName, requireOwnerForSubscription,
} from './agent-commands';

/**
 * Task board (docs/task-board.md): cards per channel with a title, a description, an
 * assignee agent and a status. Starting a card opens its thread and a worktree session
 * scoped to that thread (the #91 sessions); the card then follows the session's branch and
 * the pull request opened from its review sheet (#102, src/lib/task-cards.ts).
 *
 * Anyone who can see the channel can read the board. Creating, editing, moving, deleting
 * and starting cards needs the authority to direct agents there (owner, DirectAgents, or a
 * bot the owner lets direct); starting a card on a 'subscription' profile is owner-only, as
 * /start is (src/lib/provider-terms.ts).
 */

const ID = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' } as const;
const fields = {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 3000 },
    status: { type: 'string', enum: [...CARD_STATUSES] },
    profile: { type: ['string', 'null'], minLength: 1, maxLength: 32 },
} as const;

function emit(request: FastifyRequest, notices: Array<Notice | null>) {
    request.pendingEvents ??= [];
    for (const n of notices) if (n) request.pendingEvents.push({ room: `channel:${n.channelId}`, event: n.eventName ?? 'Message', data: n.event });
}

/** One line, control characters out: a title is shown in notices and wake prompts. */
const cleanTitle = (t: string) => sanitizeMessageText(t).replace(/[\x00-\x1f\x7f]+/g, ' ').trim();

async function resolveProfile(db: any, channelId: string, name: string | null | undefined): Promise<string | null | undefined> {
    if (name === undefined || name === null) return name;
    return (await profileByName(db, channelId, name)).id.trim();
}

/**
 * Start (or resume) the card's session. Lock order is profile → session → card, as in
 * workspace results; the card is read first without a lock and rechecked after.
 */
async function startCard(db: any, channelId: string, taskId: string, userId: string, who: string, notices: Notice[]) {
    const peek = (await db.query('SELECT profile_id, session_id FROM task_cards WHERE id = $1 AND channel_id = $2', [taskId, channelId])).rows[0];
    if (!peek) throw new CommandError(404, { error: 'card_not_found' });
    if (!peek.profile_id) throw new CommandError(400, { error: 'no_assignee' });
    const profile = (await db.query('SELECT * FROM agent_profiles WHERE id = $1 FOR SHARE', [peek.profile_id])).rows[0];
    const previous = peek.session_id
        ? (await db.query(`${SESSION_SELECT} WHERE s.id = $1 FOR UPDATE OF s`, [peek.session_id])).rows[0] : null;
    const card = (await db.query('SELECT * FROM task_cards WHERE id = $1 FOR UPDATE', [taskId])).rows[0];
    if (!card || card.profile_id !== peek.profile_id || card.session_id !== peek.session_id) throw new CommandError(409, { error: 'card_changed' });

    await requireOwnerForSubscription(db, profile.auth_mode, profile.server_id, userId, profile.plan_owner_id);
    const botId = profile.bot_id.trim();
    await botInChannel(db, botId, channelId);

    const same = previous && previous.profile_id === profile.id;
    if (previous?.state === 'live') {
        if (same) return { status: 200, action: 'kept' };
        throw new CommandError(409, { error: 'card_session_live' });
    }

    // The card's thread: a card notice in the channel, opened the first time the card starts
    let threadId: string | null = card.thread_id?.trim() ?? null;
    if (!threadId) {
        threadId = generateUlid();
        const content = `Task: ${card.title}`;
        const systemData = { kind: 'task_card', taskId };
        await db.query(
            `INSERT INTO messages (id, channel_id, author_id, content, system_event, system_data) VALUES ($1, $2, NULL, $3, 'task_card', $4)`,
            [threadId, channelId, content, JSON.stringify(systemData)]
        );
        notices.push({ channelId, event: { id: threadId, content, authorId: null, authorUsername: null, channelId,
            createdAt: new Date().toISOString(), systemEvent: 'task_card', systemData } });
    }

    let sessionId: string, action: string;
    if (same && previous.state === 'shelved') {
        sessionId = previous.id.trim();
        if (previous.wakes_used >= previous.wake_budget || await budgetExhausted(db, sessionId)) throw new CommandError(409, { error: 'budget_exhausted' });
        // Resuming makes it the resumer's session: started_by decides the subscription rule
        await db.query(
            `UPDATE agent_sessions SET state = 'live', end_reason = NULL, shelved_at = NULL, last_active_at = NOW(), started_by = $2 WHERE id = $1`,
            [sessionId, userId]
        );
        await announce(db, channelId, sessionId, `${who} resumed ${profile.name} on task "${card.title}" (session ${sessionId}).`, notices, threadId);
        action = 'resumed';
    } else {
        sessionId = generateUlid();
        await db.query(
            `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by, workspace_id, thread_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [sessionId, profile.server_id, channelId, botId, profile.id, userId, profile.workspace_id, threadId]
        );
        await announce(db, channelId, sessionId, kickoffText(who, profile.name, sessionId, card.title, card.description), notices, threadId);
        action = 'started';
    }
    await db.query(
        `UPDATE task_cards SET session_id = $2, thread_id = $3, updated_at = NOW(),
                status = CASE WHEN status = 'todo' THEN 'in_progress' ELSE status END
         WHERE id = $1`,
        [taskId, sessionId, threadId]
    );
    notices.push(await sessionUpdate(db, sessionId, false));
    return { status: action === 'started' ? 201 : 200, action };
}

export async function taskBoardRoutes(app: FastifyInstance) {
    const card = '/channels/:id/tasks/:taskId';

    /** Channel access, then the authority to direct agents here; null when allowed. */
    async function denied(request: FastifyRequest, channelId: string, manage: boolean) {
        const db = request.dbClient!;
        if (!(await canViewChannel(db, channelId, request.userId, !!request.isBot)).allowed) return { status: 403, body: { error: 'forbidden' } };
        if (manage && !await stampAuthority(db, channelId, request.userId, !!request.isBot)) return { status: 403, body: await cannotDirect(db, channelId, request.userId) };
        return null;
    }
    async function whoIs(db: any, userId: string): Promise<string> {
        return (await db.query('SELECT username FROM users WHERE id = $1', [userId])).rows[0]?.username ?? 'someone';
    }
    /** Run as the service role; CommandErrors become replies, the events go out after commit. */
    async function act(request: FastifyRequest, fn: (db: any, notices: Notice[]) => Promise<{ status: number; body: any }>) {
        const db = request.dbClient!, notices: Notice[] = [];
        try {
            const result = await asService(db, () => fn(db, notices));
            emit(request, notices);
            return result;
        } catch (err: any) {
            if (err instanceof CommandError) return { status: err.status, body: err.body };
            // The agent already has a live session in this card's thread
            if (err.code === '23505') return { status: 409, body: { error: 'session_live' } };
            throw err;
        }
    }

    app.get('/channels/:id/tasks', async (request, reply) => {
        const { id: channelId } = request.params as any, db = request.dbClient!;
        const no = await denied(request, channelId, false);
        if (no) return reply.status(no.status).send(no.body);
        const rows = await asService(db, () => db.query(`${CARD_SELECT} WHERE t.channel_id = $1 ORDER BY t.id LIMIT 500`, [channelId]));
        const serverId = (await db.query('SELECT server_id FROM channels WHERE id = $1', [channelId])).rows[0].server_id.trim();
        return reply.send({
            cards: rows.rows.map(cardJson),
            canManage: await stampAuthority(db, channelId, request.userId, !!request.isBot),
            isOwner: !request.isBot && await isServerOwner(db, serverId, request.userId),
        });
    });

    app.post('/channels/:id/tasks', {
        schema: { body: { type: 'object', required: ['title'], additionalProperties: false, properties: {
            ...fields, start: { type: 'boolean' },
        } } },
    }, async (request, reply) => {
        const { id: channelId } = request.params as any, b = request.body as any;
        const no = await denied(request, channelId, true);
        if (no) return reply.status(no.status).send(no.body);
        const title = cleanTitle(b.title);
        if (!title) return reply.status(400).send({ error: 'empty_title' });
        if (b.start && !b.profile) return reply.status(400).send({ error: 'no_assignee' });
        const r = await act(request, async (db, notices) => {
            const profileId = await resolveProfile(db, channelId, b.profile);
            const taskId = generateUlid();
            await db.query(
                `INSERT INTO task_cards (id, server_id, channel_id, title, description, status, profile_id, created_by)
                 SELECT $1, c.server_id, c.id, $3, $4, $5, $6, $7 FROM channels c WHERE c.id = $2`,
                [taskId, channelId, title, sanitizeMessageText(b.description ?? ''), b.status ?? 'todo', profileId ?? null, request.userId]
            );
            let action = 'created';
            if (b.start) action = (await startCard(db, channelId, taskId, request.userId, await whoIs(db, request.userId), notices)).action;
            const update = await cardUpdate(db, taskId);
            notices.push(update!);
            return { status: 201, body: { action, card: update!.event.card } };
        });
        return reply.status(r.status).send(r.body);
    });

    app.patch(card, {
        schema: { params: { type: 'object', properties: { id: ID, taskId: ID } },
            body: { type: 'object', additionalProperties: false, minProperties: 1, properties: fields } },
    }, async (request, reply) => {
        const { id: channelId, taskId } = request.params as any, b = request.body as any;
        const no = await denied(request, channelId, true);
        if (no) return reply.status(no.status).send(no.body);
        const title = b.title === undefined ? undefined : cleanTitle(b.title);
        if (title === '') return reply.status(400).send({ error: 'empty_title' });
        const r = await act(request, async (db, notices) => {
            // Profile before card, as when a card starts
            const profileId = await resolveProfile(db, channelId, b.profile);
            const current = (await db.query(`SELECT t.*, s.state AS session_state FROM task_cards t LEFT JOIN agent_sessions s ON s.id = t.session_id
                WHERE t.id = $1 AND t.channel_id = $2 FOR UPDATE OF t`, [taskId, channelId])).rows[0];
            if (!current) throw new CommandError(404, { error: 'card_not_found' });
            // Reassigning a card whose agent is working would leave that session without its card
            if (profileId !== undefined && profileId !== (current.profile_id?.trim() ?? null) && current.session_state === 'live')
                throw new CommandError(409, { error: 'card_session_live' });
            await db.query(
                `UPDATE task_cards SET title = COALESCE($3, title), description = COALESCE($4, description), status = COALESCE($5, status),
                        profile_id = CASE WHEN $6 THEN $7 ELSE profile_id END, updated_at = NOW()
                 WHERE id = $1 AND channel_id = $2`,
                [taskId, channelId, title ?? null, b.description === undefined ? null : sanitizeMessageText(b.description),
                 b.status ?? null, profileId !== undefined, profileId ?? null]
            );
            if (b.status === 'review' && current.status !== 'review') await notifyCardReview(db, taskId, request.userId);
            const update = await cardUpdate(db, taskId);
            notices.push(update!);
            return { status: 200, body: { card: update!.event.card } };
        });
        return reply.status(r.status).send(r.body);
    });

    // The card's session and thread stay: end the session from the board first if it should stop
    app.delete(card, { schema: { params: { type: 'object', properties: { id: ID, taskId: ID } } } }, async (request, reply) => {
        const { id: channelId, taskId } = request.params as any;
        const no = await denied(request, channelId, true);
        if (no) return reply.status(no.status).send(no.body);
        const deleted = await asService(request.dbClient!, () => request.dbClient!.query(
            'DELETE FROM task_cards WHERE id = $1 AND channel_id = $2 RETURNING id', [taskId, channelId]));
        if (!deleted.rows.length) return reply.status(404).send({ error: 'card_not_found' });
        (request.pendingEvents ??= []).push({ room: `channel:${channelId.trim()}`, event: 'TaskCardDelete', data: { channelId: channelId.trim(), id: taskId } });
        return reply.status(204).send();
    });

    app.post(`${card}/start`, { schema: { params: { type: 'object', properties: { id: ID, taskId: ID } } } }, async (request, reply) => {
        const { id: channelId, taskId } = request.params as any;
        const no = await denied(request, channelId, true);
        if (no) return reply.status(no.status).send(no.body);
        const r = await act(request, async (db, notices) => {
            const started = await startCard(db, channelId, taskId, request.userId, await whoIs(db, request.userId), notices);
            const update = await cardUpdate(db, taskId);
            notices.push(update!);
            return { status: started.status, body: { action: started.action, card: update!.event.card } };
        });
        return reply.status(r.status).send(r.body);
    });
}
