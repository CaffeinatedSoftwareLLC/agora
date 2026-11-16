import { FastifyInstance } from 'fastify';
import { asService } from '../lib/agent-sessions';
import { liveHub, viewerRole } from '../lib/boxes/live-hub';

/**
 * The page behind "Open terminal" on a live-terminal agent (docs/planning/live-terminals.md). This route
 * only says who the caller is for this session and what state it is in; the screen itself comes over the
 * live hub's socket (src/lib/boxes/live-hub.ts), which checks everything again. "No such session" and
 * "not yours to watch" answer the same, so the route is not a way to find sessions.
 */

const ID = { type: 'string', minLength: 26, maxLength: 26 } as const;

export async function liveTerminalRoutes(app: FastifyInstance) {
    // GET /servers/:serverId/live-terminals/:sessionId → { role, profile, channel, state, ... }
    app.get('/servers/:serverId/live-terminals/:sessionId', {
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
        schema: { params: { type: 'object', properties: { serverId: ID, sessionId: ID } } },
    }, async (request, reply) => {
        if (!request.userId || request.isBot) return reply.status(403).send({ error: 'forbidden' });
        const { serverId, sessionId } = request.params as { serverId: string; sessionId: string };
        const db = request.dbClient!;
        const out = await asService(db, async () => {
            const role = await viewerRole(app.db, sessionId, request.userId!.trim());
            const row = role ? (await db.query(
                `SELECT s.id, s.server_id, s.channel_id, s.live_state, s.live_note, s.wakes_used, c.name AS channel_name, p.name AS profile, p.wake_budget,
                        b.id AS box_id, h.live_protocol
                 FROM agent_sessions s JOIN agent_profiles p ON p.id = s.profile_id JOIN channels c ON c.id = s.channel_id
                 LEFT JOIN agent_boxes b ON b.profile_id = p.id AND b.deleted_at IS NULL LEFT JOIN agent_hosts h ON h.id = b.host_id
                 WHERE s.id = $1 AND s.server_id = $2`, [sessionId, serverId])).rows[0] : null;
            if (!role || !row) return { status: 404, body: { error: 'not_found' } };
            const hub = liveHub()?.stateOf(sessionId) ?? null;
            const hostConnected = !!row.box_id && !!liveHub()?.hostConnected(row.box_id.trim());
            return { status: 200, body: {
                sessionId, profile: row.profile, channelId: row.channel_id.trim(), channelName: row.channel_name,
                role, canType: role === 'owner',
                state: hub?.state ?? row.live_state ?? 'stopped', note: hub?.note ?? row.live_note ?? null,
                controlsBy: hub?.controlsBy ?? null, held: hub?.held ?? false,
                hostConnected, needsUpdate: !!row.box_id && !(Number(row.live_protocol) >= 1),
                // Token use is not measured from an interactive CLI
                tokensMeasured: false, wakesUsed: Number(row.wakes_used),
            } };
        });
        return reply.status(out.status).send(out.body);
    });
}
