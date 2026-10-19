import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canViewChannel } from '../lib/channel-access';
import { stampAuthority } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';
import { postNotice } from '../lib/agent-runs';
import { normalizeReservationPath, noticePathList, reservationJson, reservationPathsOverlap } from '../lib/file-reservations';
import { generateUlid } from '../utils/ulid';

class ReservationError extends Error {
    constructor(public status: number, public body: any) { super(body.error); }
}
const fail = (status: number, error: string): never => { throw new ReservationError(status, { error }); };
const SELECT = `SELECT r.*, s.channel_id, p.name AS profile_name FROM agent_file_reservations r
    JOIN agent_sessions s ON s.id = r.session_id JOIN agent_profiles p ON p.id = s.profile_id`;
const ACTIVE = `r.released_at IS NULL AND r.expires_at > clock_timestamp()`;

async function liveSession(request: FastifyRequest, channelId: string) {
    if (!request.isBot) return fail(403, 'live_bot_session_required');
    const result = await request.dbClient!.query(`SELECT * FROM agent_sessions
        WHERE bot_id = $1 AND channel_id = $2 AND state = 'live' FOR UPDATE`, [request.userId, channelId]);
    return result.rows[0] ?? fail(409, 'no_live_session');
}
async function checkThread(db: any, channelId: string, threadId: string | null) {
    if (!threadId) return;
    const row = await db.query(`SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2 AND thread_id IS NULL AND deleted_at IS NULL`, [threadId, channelId]);
    if (!row.rows.length) fail(403, 'thread_access_denied');
}

export async function fileReservationRoutes(app: FastifyInstance) {
    app.get('/channels/:id/file-reservations', async (request, reply) => {
        const channelId = (request.params as any).id, db = request.dbClient!;
        if (!(await canViewChannel(db, channelId, request.userId!, !!request.isBot)).allowed) return reply.status(403).send({ error: 'forbidden' });
        try {
            const rows = await asService(db, async () => {
                const session = request.isBot ? await liveSession(request, channelId) : null;
                // Bots see their canonical workspace across accessible channels. Humans list this channel.
                const result = session ? await db.query(`${SELECT} WHERE r.server_id = $1 AND r.workspace_id = $2 AND ${ACTIVE} ORDER BY r.id`, [session.server_id, session.workspace_id])
                    : await db.query(`${SELECT} WHERE s.channel_id = $1 AND ${ACTIVE} ORDER BY r.id`, [channelId]);
                const visible = [];
                for (const r of result.rows) {
                    if (!(await canViewChannel(db, r.channel_id.trim(), request.userId!, !!request.isBot)).allowed) continue;
                    if (r.thread_id) {
                        const parent = await db.query('SELECT 1 FROM messages WHERE id = $1 AND deleted_at IS NULL', [r.thread_id]);
                        if (!parent.rows.length) continue;
                    }
                    visible.push(reservationJson(r));
                }
                return visible;
            });
            return reply.send({ reservations: rows });
        } catch (e) { if (e instanceof ReservationError) return reply.status(e.status).send(e.body); throw e; }
    });

    app.post('/channels/:id/file-reservations', {
        schema: { body: { type: 'object', additionalProperties: false, required: ['action'], properties: {
            action: { type: 'string', enum: ['reserve', 'renew', 'release'] },
            reservationId: { type: 'string', minLength: 26, maxLength: 26 },
            paths: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 4096 } },
            ttlSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
            reason: { type: 'string', maxLength: 200 },
            threadId: { type: 'string', minLength: 26, maxLength: 26 }, force: { type: 'boolean' },
        } } },
    }, async (request, reply) => {
        const channelId = (request.params as any).id, db = request.dbClient!, b = request.body as any;
        if (!(await canViewChannel(db, channelId, request.userId!, !!request.isBot)).allowed) return reply.status(403).send({ error: 'forbidden' });
        try {
            const result = await asService(db, async () => {
                if (b.force) {
                    if (b.action !== 'release' || !b.reservationId) fail(400, 'force_release_requires_id');
                    if (!await stampAuthority(db, channelId, request.userId!, !!request.isBot)) fail(403, 'cannot_direct');
                    const row = await db.query(`${SELECT} WHERE r.id = $1 AND s.channel_id = $2 AND ${ACTIVE}`, [b.reservationId, channelId]);
                    const held = row.rows[0]; if (!held) fail(404, 'reservation_not_found');
                    // Same lock order as /end and reserves: holder session, then workspace, then reservation.
                    await db.query('SELECT 1 FROM agent_sessions WHERE id = $1 FOR UPDATE', [held.session_id]);
                    await lockWorkspace(db, held.server_id, held.workspace_id);
                    const updated = await db.query(`UPDATE agent_file_reservations r SET released_at = clock_timestamp() WHERE r.id = $1 AND ${ACTIVE} RETURNING id`, [b.reservationId]);
                    if (!updated.rows.length) fail(404, 'reservation_not_found');
                    const notice = await postNotice(db, channelId, `Reservation ${b.reservationId} held by ${held.profile_name} (session ${held.session_id.trim()}) was force-released by a channel owner/director. Paths: ${noticePathList(held.paths)}`);
                    await db.query(`INSERT INTO agent_inbox (id, session_id, message_id, reason)
                        SELECT $1, id, $2, 'command' FROM agent_sessions WHERE id = $3 AND state = 'live'`, [generateUlid(), notice.event.id, held.session_id]);
                    return { released: [b.reservationId], notice };
                }
                const session = await liveSession(request, channelId);
                await lockWorkspace(db, session.server_id, session.workspace_id);
                await db.query(`UPDATE agent_file_reservations SET released_at = clock_timestamp()
                    WHERE server_id = $1 AND workspace_id = $2 AND released_at IS NULL AND expires_at <= clock_timestamp()`, [session.server_id, session.workspace_id]);
                if (b.action === 'reserve') {
                    if (!b.paths) fail(400, 'paths_required');
                    let paths: string[];
                    try { paths = [...new Set<string>(b.paths.map(normalizeReservationPath))]; } catch { return fail(400, 'invalid_reservation_path'); }
                    await checkThread(db, channelId, b.threadId ?? null);
                    const held = await db.query(`${SELECT} WHERE r.server_id = $1 AND r.workspace_id = $2 AND r.session_id <> $3 AND ${ACTIVE}`, [session.server_id, session.workspace_id, session.id]);
                    const conflict = held.rows.find(r => r.paths.some((p: string) => paths.some(q => reservationPathsOverlap(p, q))));
                    if (conflict) throw new ReservationError(409, { error: 'reservation_conflict', holder: {
                        sessionId: conflict.session_id.trim(), profile: conflict.profile_name, reservationId: conflict.id.trim(), expiresAt: conflict.expires_at,
                    } });
                    const id = generateUlid();
                    await db.query(`INSERT INTO agent_file_reservations (id, server_id, workspace_id, session_id, thread_id, paths, reason, expires_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp() + $8 * interval '1 second')`,
                        [id, session.server_id, session.workspace_id, session.id, b.threadId ?? null, paths, b.reason ?? null, b.ttlSeconds ?? 900]);
                    return { reservation: reservationJson((await db.query(`${SELECT} WHERE r.id = $1`, [id])).rows[0]) };
                }
                if (b.action === 'renew') {
                    if (!b.reservationId) fail(400, 'reservation_id_required');
                    const row = await db.query(`${SELECT} WHERE r.id = $1 AND r.session_id = $2 AND ${ACTIVE}`, [b.reservationId, session.id]);
                    if (!row.rows[0]) fail(404, 'reservation_not_found');
                    await checkThread(db, channelId, row.rows[0].thread_id);
                    await db.query(`UPDATE agent_file_reservations SET expires_at = clock_timestamp() + $2 * interval '1 second' WHERE id = $1`, [b.reservationId, b.ttlSeconds ?? 900]);
                    return { reservation: reservationJson((await db.query(`${SELECT} WHERE r.id = $1`, [b.reservationId])).rows[0]) };
                }
                const row = await db.query(`UPDATE agent_file_reservations r SET released_at = clock_timestamp()
                    WHERE r.session_id = $1 AND ($2::text IS NULL OR r.id = $2) AND ${ACTIVE} RETURNING id`, [session.id, b.reservationId ?? null]);
                if (b.reservationId && !row.rows.length) fail(404, 'reservation_not_found');
                return { released: row.rows.map(r => r.id.trim()) };
            });
            const { notice, ...body } = result as any;
            if (notice) { request.pendingEvents ??= []; request.pendingEvents.push({ room: `channel:${notice.channelId}`, event: 'Message', data: notice.event }); }
            return reply.status(b.action === 'reserve' ? 201 : 200).send(body);
        } catch (e) { if (e instanceof ReservationError) return reply.status(e.status).send(e.body); throw e; }
    });
}
async function lockWorkspace(db: any, serverId: string, workspaceId: string) {
    // Transaction-scoped serialization also covers different sessions, channels and hosts.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${serverId.trim()}:${workspaceId}`]);
}
