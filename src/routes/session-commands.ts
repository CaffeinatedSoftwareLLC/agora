import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { asService } from '../lib/agent-sessions';
import { canViewChannel } from '../lib/channel-access';
import { hashClaimToken } from '../lib/agent-runs';
import { claimCommand, COMMAND_RESULT_SCHEMA, expireStale, finishCommand } from '../lib/session-commands';

/**
 * Agent commands, host side and read side (docs/agent-commands.md). Commands are queued from a
 * message or `POST /channels/:id/agent-commands` (src/lib/session-commands.ts runControl); the
 * session's host claims one when no run is going and reports what the CLI did.
 */
const ID = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' } as const;
const response = (httpStatus: number, body?: object) => ({ httpStatus, body });

async function respondService(request: FastifyRequest, reply: FastifyReply, fn: () => Promise<any>) {
    const value = await asService(request.dbClient!, fn);
    return value?.httpStatus ? reply.code(value.httpStatus).send(value.body) : value;
}

export async function sessionCommandRoutes(app: FastifyInstance) {
    // GET /agent-hosts/@me/session-commands/next?v=1 → 200 { id, claimToken, sessionId, profile, adapter, workdirAlias, nativeSessionId, command, arg } | 204
    // Without v=1 (an agora-host from before this existed) nothing is ever handed out.
    app.get('/agent-hosts/@me/session-commands/next', async (request, reply) => {
        const db = request.dbClient!, host = request.agentHost!;
        const supported = (request.query as any)?.v === '1';
        return respondService(request, reply, async () => {
            if (!(await db.query('SELECT 1 FROM agent_hosts WHERE id = $1 AND server_id = $2 AND revoked_at IS NULL FOR SHARE', [host.id, host.serverId])).rows.length) {
                return response(401, { error: 'host_revoked' });
            }
            if (!supported) return response(204);
            const claimed = await claimCommand(db, host, n => (request.pendingEvents ??= []).push({ room: `channel:${n.channelId}`, event: n.eventName ?? 'Message', data: n.event }));
            return claimed ?? response(204);
        });
    });

    // POST /agent-hosts/@me/session-commands/:commandId/result { claimToken, success, result } → 200 { ok }
    app.post('/agent-hosts/@me/session-commands/:commandId/result', {
        schema: { params: { type: 'object', properties: { commandId: ID } }, body: COMMAND_RESULT_SCHEMA },
    }, async (request, reply) => {
        const db = request.dbClient!, host = request.agentHost!;
        const { commandId } = request.params as any, b = request.body as any;
        return respondService(request, reply, async () => {
            if (!(await db.query('SELECT 1 FROM agent_hosts WHERE id = $1 AND server_id = $2 AND revoked_at IS NULL FOR SHARE', [host.id, host.serverId])).rows.length) {
                return response(401, { error: 'host_revoked' });
            }
            const meta = (await db.query(
                `SELECT c.session_id, s.profile_id FROM agent_session_commands c JOIN agent_sessions s ON s.id = c.session_id
                 WHERE c.id = $1 AND c.host_id = $2 AND s.server_id = $3`, [commandId, host.id, host.serverId])).rows[0];
            if (!meta) return response(404, { error: 'not_found' });
            // Profile before session, as everywhere else
            await db.query('SELECT 1 FROM agent_profiles WHERE id = $1 FOR SHARE', [meta.profile_id]);
            await db.query('SELECT 1 FROM agent_sessions WHERE id = $1 FOR UPDATE', [meta.session_id]);
            const c = (await db.query('SELECT *, lease_until <= NOW() AS expired FROM agent_session_commands WHERE id = $1 FOR UPDATE', [commandId])).rows[0];
            if (c.claim_token_hash !== hashClaimToken(b.claimToken)) return response(409, { error: 'stale_claim' });
            if (['succeeded', 'failed'].includes(c.status)) return { ok: true, repeated: true };
            if (c.status !== 'claimed' || c.expired) return response(409, { error: 'lease_expired' });
            const profile = (await db.query('SELECT host_id, generation FROM agent_profiles WHERE id = $1', [meta.profile_id])).rows[0];
            if (profile.host_id.trim() !== host.id || profile.generation !== c.profile_generation) return response(409, { error: 'binding_changed' });
            await db.query('UPDATE agent_session_commands SET status = $2, result = $3, finished_at = NOW() WHERE id = $1',
                [c.id, b.success ? 'succeeded' : 'failed', b.result]);
            for (const n of await finishCommand(db, c, b.success, b.result)) {
                (request.pendingEvents ??= []).push({ room: `channel:${n.channelId}`, event: n.eventName ?? 'Message', data: n.event });
            }
            return { ok: true };
        });
    });

    // GET /channels/:id/sessions/:sessionId/commands → { commands: [{ id, command, status, requestedBy, createdAt, finishedAt, error }] } (latest 10)
    app.get('/channels/:id/sessions/:sessionId/commands', async (request, reply) => {
        const { id, sessionId } = request.params as any;
        const db = request.dbClient!;
        if (!(await canViewChannel(db, id, request.userId, !!request.isBot)).allowed) return reply.code(403).send({ error: 'forbidden' });
        return respondService(request, reply, async () => {
            if (!(await db.query('SELECT 1 FROM agent_sessions WHERE id = $1 AND channel_id = $2', [sessionId, id])).rows.length) return response(404, { error: 'session_not_found' });
            for (const n of await expireStale(db, { sessionId })) (request.pendingEvents ??= []).push({ room: `channel:${n.channelId}`, event: n.eventName ?? 'Message', data: n.event });
            const rows = (await db.query(
                `SELECT btrim(c.id) AS id, c.command, c.status, u.username AS "requestedBy", c.created_at AS "createdAt", c.finished_at AS "finishedAt", c.result->>'error' AS error
                 FROM agent_session_commands c LEFT JOIN users u ON u.id = c.requested_by WHERE c.session_id = $1 ORDER BY c.id DESC LIMIT 10`, [sessionId])).rows;
            return { commands: rows };
        });
    });
}
