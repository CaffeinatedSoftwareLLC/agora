import { FastifyInstance } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { canViewChannel } from '../lib/channel-access';
import { cannotDirect, isServerOwner, stampAuthority } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';
import { postNotice, sessionUpdate, type Notice } from '../lib/agent-runs';
import { cardText, REQUEST_TTL_HOURS } from '../lib/agent-permissions';

/**
 * Approve or deny a tool a hosted agent was denied (#73), from the card in the channel.
 *
 * - once: the owner or a director (people only, not bots); the rule is granted to the
 *   session's next run, and the agent is woken to retry.
 * - always: the server owner only; the rule is added to the agent's profile.
 * - deny: the owner or a director.
 */

const ID = { type: 'string', minLength: 26, maxLength: 26 } as const;

class Refusal extends Error {
    constructor(public status: number, public body: any) { super(body?.error ?? 'error'); }
}

export async function agentToolRequestRoutes(app: FastifyInstance) {
    // POST /channels/:id/agent-tool-requests/:requestId → 200 { id, status }
    app.post('/channels/:id/agent-tool-requests/:requestId', {
        schema: {
            params: { type: 'object', properties: { id: ID, requestId: ID } },
            body: {
                type: 'object', required: ['decision'], additionalProperties: false,
                properties: { decision: { type: 'string', enum: ['once', 'always', 'deny'] } },
            },
        },
    }, async (request, reply) => {
        const { id: channelId, requestId } = request.params as { id: string; requestId: string };
        const { decision } = request.body as { decision: 'once' | 'always' | 'deny' };
        const db = request.dbClient!;
        const userId = request.userId!;
        if (request.isBot) return reply.status(403).send({ error: 'Only people can approve agent tools' });

        const access = await canViewChannel(db, channelId, userId, false);
        if (!access.allowed) return reply.status(403).send({ error: 'Channel access denied' });
        if (!await stampAuthority(db, channelId, userId, false)) return reply.status(403).send(await cannotDirect(db, channelId, userId));

        const notices: Notice[] = [];
        try {
            const result = await asService(db, async () => {
                const found = await db.query(
                    `SELECT r.session_id, r.profile_id, r.server_id FROM agent_tool_requests r
                     JOIN agent_sessions s ON s.id = r.session_id
                     WHERE r.id = $1 AND s.channel_id = $2`,
                    [requestId, channelId]
                );
                const ref = found.rows[0];
                if (!ref) throw new Refusal(404, { error: 'Request not found' });
                if (decision === 'always' && !await isServerOwner(db, ref.server_id.trim(), userId)) {
                    throw new Refusal(403, { error: 'Only the server owner can always allow a tool' });
                }
                // Lock order, as everywhere: profile → session → request
                await db.query(`SELECT 1 FROM agent_profiles WHERE id = $1 ${decision === 'always' ? 'FOR UPDATE' : 'FOR SHARE'}`, [ref.profile_id]);
                const s = await db.query(
                    `SELECT s.state, p.name FROM agent_sessions s JOIN agent_profiles p ON p.id = s.profile_id WHERE s.id = $1 FOR UPDATE OF s`,
                    [ref.session_id]
                );
                const r = await db.query(
                    `SELECT *, created_at < NOW() - make_interval(hours => $2) AS expired FROM agent_tool_requests WHERE id = $1 FOR UPDATE`,
                    [requestId, REQUEST_TTL_HOURS]
                );
                const req = r.rows[0];
                if (req.status !== 'pending') throw new Refusal(409, { error: 'already_decided', status: req.status });
                if (req.expired && decision !== 'deny') throw new Refusal(410, { error: 'expired' });

                const status = decision === 'deny' ? 'denied' : decision;
                await db.query(
                    `UPDATE agent_tool_requests SET status = $2, decided_by = $3, decided_at = NOW() WHERE id = $1`,
                    [requestId, status, userId]
                );
                if (decision === 'always') {
                    await db.query(
                        `UPDATE agent_profiles SET allowed_tools = array_append(allowed_tools, $2::text), updated_at = NOW()
                         WHERE id = $1 AND NOT ($2::text = ANY(allowed_tools)) AND cardinality(allowed_tools) < 100`,
                        [ref.profile_id, req.tool]
                    );
                }

                const who = (await db.query('SELECT username FROM users WHERE id = $1', [userId])).rows[0]?.username ?? 'someone';
                const profile = s.rows[0].name;
                if (req.message_id) {
                    const content = cardText(profile, req.tool, status, who);
                    const updated = await db.query(
                        `UPDATE messages SET content = $2, system_data = system_data || $3::jsonb, edited_at = NOW()
                         WHERE id = $1 RETURNING system_data, edited_at`,
                        [req.message_id, content, JSON.stringify({ status, decidedBy: userId })]
                    );
                    if (updated.rows[0]) {
                        notices.push({
                            channelId: channelId.trim(), eventName: 'MessageUpdate',
                            event: { id: req.message_id.trim(), channelId: channelId.trim(), content, editedAt: updated.rows[0].edited_at, systemData: updated.rows[0].system_data },
                        });
                    }
                }
                // An approval wakes a live agent to retry; the notice is its batch
                if (decision !== 'deny' && s.rows[0].state === 'live') {
                    const notice = await postNotice(db, channelId,
                        `${who} ${decision === 'always' ? 'always allowed' : 'approved once'} \`${req.tool}\` for ${profile}. Retry the step that needed it.`);
                    notices.push(notice);
                    await db.query(
                        `INSERT INTO agent_inbox (id, session_id, message_id, reason) VALUES ($1, $2, $3, 'command')`,
                        [generateUlid(), ref.session_id, notice.event.id]
                    );
                    notices.push(await sessionUpdate(db, ref.session_id, false));
                }
                return { id: requestId, status };
            });
            request.pendingEvents ??= [];
            for (const n of notices) request.pendingEvents.push({ room: `channel:${n.channelId}`, event: n.eventName ?? 'Message', data: n.event });
            return reply.send(result);
        } catch (err) {
            if (err instanceof Refusal) return reply.status(err.status).send(err.body);
            throw err;
        }
    });
}
