import { FastifyInstance } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { canViewChannel } from '../lib/channel-access';
import { isServerOwner } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';
import { notifyApproval } from '../lib/notifications';

/**
 * Permission relay for the Claude Code Channel (docs/claude-channel.md).
 *
 * A Claude Code session the user runs themselves, with `agora-mcp --channel-mode` loaded as
 * a channel, receives Claude Code's `notifications/claude/channel/permission_request` and
 * files it here. The server posts an approval card in the channel. Only the server owner
 * may answer it (the session runs on the owner's own login, and an answer approves a tool
 * call on the owner's machine). The verdict goes to the bot's sockets as
 * `PermissionRelayDecision`; the channel turns it into
 * `notifications/claude/channel/permission`.
 */

const ID = { type: 'string', minLength: 26, maxLength: 26 } as const;
/** How long a card can be answered. Claude Code has usually moved on long before. */
export const RELAY_TTL_HOURS = 24;

export function relayCardText(bot: string, tool: string, status: string, who?: string): string {
    if (status === 'allow') return `${who ?? 'The owner'} allowed \`${tool}\` for ${bot}.`;
    if (status === 'deny') return `${who ?? 'The owner'} denied \`${tool}\` for ${bot}.`;
    return `${bot} (own Claude Code session) asks to use \`${tool}\`. Only the server owner can allow or deny it.`;
}

class Refusal extends Error {
    constructor(public status: number, public body: any) { super(body?.error ?? 'error'); }
}

export async function permissionRelayRoutes(app: FastifyInstance) {
    // POST /channels/:id/permission-relays → 201 { id, relayId, status }  (bots only)
    app.post('/channels/:id/permission-relays', {
        schema: {
            params: { type: 'object', properties: { id: ID } },
            body: {
                type: 'object', additionalProperties: false,
                required: ['relayId', 'toolName', 'description', 'inputPreview'],
                properties: {
                    relayId: { type: 'string', pattern: '^[a-km-z]{5}$' },
                    toolName: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_.:-]+$' },
                    description: { type: 'string', maxLength: 4000 },
                    inputPreview: { type: 'string', maxLength: 16000 },
                },
            },
        },
    }, async (request, reply) => {
        const { id: channelId } = request.params as { id: string };
        const body = request.body as { relayId: string; toolName: string; description: string; inputPreview: string };
        const db = request.dbClient!;
        const botId = request.userId!;
        if (!request.isBot) return reply.status(403).send({ error: 'Only bots relay permission prompts' });

        const access = await canViewChannel(db, channelId, botId, true);
        if (!access.allowed) return reply.status(403).send({ error: 'Channel access denied' });

        const result = await asService(db, async () => {
            const ch = await db.query(
                `SELECT c.server_id, u.username FROM channels c, users u WHERE c.id = $1 AND u.id = $2`,
                [channelId, botId]
            );
            const row = ch.rows[0];
            if (!row?.server_id) throw new Refusal(404, { error: 'Channel not found' });
            const id = generateUlid();
            const inserted = await db.query(
                `INSERT INTO permission_relays (id, server_id, channel_id, bot_id, relay_id, tool_name, description, input_preview)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (bot_id, relay_id) WHERE status = 'pending' DO NOTHING RETURNING id`,
                [id, row.server_id, channelId, botId, body.relayId, body.toolName, body.description, body.inputPreview]
            );
            if (inserted.rows.length === 0) {
                const existing = await db.query(
                    `SELECT id, status FROM permission_relays WHERE bot_id = $1 AND relay_id = $2 AND status = 'pending'`,
                    [botId, body.relayId]
                );
                return { created: false, id: existing.rows[0].id.trim(), status: existing.rows[0].status, event: null };
            }
            const messageId = generateUlid();
            const data = {
                kind: 'agent_permission_relay', requestId: id, relayId: body.relayId, botId: botId.trim(), bot: row.username,
                tool: body.toolName, description: body.description, inputPreview: body.inputPreview, status: 'pending',
            };
            const content = relayCardText(row.username, body.toolName, 'pending');
            await db.query(
                `INSERT INTO messages (id, channel_id, author_id, content, system_event, system_data)
                 VALUES ($1, $2, NULL, $3, 'agent_permission_relay', $4)`,
                [messageId, channelId, content, JSON.stringify(data)]
            );
            await db.query('UPDATE permission_relays SET message_id = $2 WHERE id = $1', [id, messageId]);
            await notifyApproval(db, { kind: 'relay', channelId });
            const event = {
                id: messageId, content, authorId: null, authorUsername: null, channelId: channelId.trim(),
                createdAt: new Date().toISOString(), systemEvent: 'agent_permission_relay', systemData: data,
            };
            return { created: true, id, status: 'pending', event };
        }).catch(err => { if (err instanceof Refusal) return err; throw err; });

        if (result instanceof Refusal) return reply.status(result.status).send(result.body);
        if (result.event) {
            request.pendingEvents ??= [];
            request.pendingEvents.push({ room: `channel:${channelId.trim()}`, event: 'Message', data: result.event });
        }
        return reply.status(result.created ? 201 : 200).send({ id: result.id, relayId: body.relayId, status: result.status });
    });

    // GET /channels/:id/permission-relays/:requestId → 200 { id, relayId, status }  (the filing bot only)
    // The channel asks after a reconnect, in case a decision went out while it was offline.
    app.get('/channels/:id/permission-relays/:requestId', {
        schema: { params: { type: 'object', properties: { id: ID, requestId: ID } } },
    }, async (request, reply) => {
        const { id: channelId, requestId } = request.params as { id: string; requestId: string };
        const db = request.dbClient!;
        const row = await asService(db, () => db.query(
            `SELECT id, relay_id, status, bot_id FROM permission_relays WHERE id = $1 AND channel_id = $2`,
            [requestId, channelId]
        ));
        const relay = row.rows[0];
        if (!relay || relay.bot_id.trim() !== request.userId!.trim()) return reply.status(404).send({ error: 'Request not found' });
        return reply.send({ id: relay.id.trim(), relayId: relay.relay_id, status: relay.status });
    });

    // POST /channels/:id/permission-relays/:requestId { decision } → 200 { id, status }  (server owner only)
    app.post('/channels/:id/permission-relays/:requestId', {
        schema: {
            params: { type: 'object', properties: { id: ID, requestId: ID } },
            body: {
                type: 'object', required: ['decision'], additionalProperties: false,
                properties: { decision: { type: 'string', enum: ['allow', 'deny'] } },
            },
        },
    }, async (request, reply) => {
        const { id: channelId, requestId } = request.params as { id: string; requestId: string };
        const { decision } = request.body as { decision: 'allow' | 'deny' };
        const db = request.dbClient!;
        const userId = request.userId!;
        if (request.isBot) return reply.status(403).send({ error: 'Only the server owner can answer a permission prompt' });

        const access = await canViewChannel(db, channelId, userId, false);
        if (!access.allowed) return reply.status(403).send({ error: 'Channel access denied' });

        try {
            const result = await asService(db, async () => {
                const r = await db.query(
                    `SELECT *, created_at < NOW() - make_interval(hours => $3) AS expired
                     FROM permission_relays WHERE id = $1 AND channel_id = $2 FOR UPDATE`,
                    [requestId, channelId, RELAY_TTL_HOURS]
                );
                const relay = r.rows[0];
                if (!relay) throw new Refusal(404, { error: 'Request not found' });
                if (!await isServerOwner(db, relay.server_id.trim(), userId)) {
                    throw new Refusal(403, { error: 'owner_only' });
                }
                if (relay.status !== 'pending') throw new Refusal(409, { error: 'already_decided', status: relay.status });
                if (relay.expired) throw new Refusal(410, { error: 'expired' });

                await db.query(
                    `UPDATE permission_relays SET status = $2, decided_by = $3, decided_at = NOW() WHERE id = $1`,
                    [requestId, decision, userId]
                );
                const names = await db.query(
                    'SELECT (SELECT username FROM users WHERE id = $1) AS who, (SELECT username FROM users WHERE id = $2) AS bot',
                    [userId, relay.bot_id]
                );
                const events: { room: string; event: string; data: any }[] = [];
                if (relay.message_id) {
                    const content = relayCardText(names.rows[0].bot ?? 'agent', relay.tool_name, decision, names.rows[0].who ?? undefined);
                    const updated = await db.query(
                        `UPDATE messages SET content = $2, system_data = system_data || $3::jsonb, edited_at = NOW()
                         WHERE id = $1 RETURNING system_data, edited_at`,
                        [relay.message_id, content, JSON.stringify({ status: decision, decidedBy: userId })]
                    );
                    if (updated.rows[0]) {
                        events.push({
                            room: `channel:${channelId.trim()}`, event: 'MessageUpdate',
                            data: { id: relay.message_id.trim(), channelId: channelId.trim(), content, editedAt: updated.rows[0].edited_at, systemData: updated.rows[0].system_data },
                        });
                    }
                }
                events.push({
                    room: `user:${relay.bot_id.trim()}`, event: 'PermissionRelayDecision',
                    data: { id: requestId, channelId: channelId.trim(), relayId: relay.relay_id, behavior: decision },
                });
                return { id: requestId, status: decision, events };
            });
            request.pendingEvents ??= [];
            request.pendingEvents.push(...result.events);
            return reply.send({ id: result.id, status: result.status });
        } catch (err) {
            if (err instanceof Refusal) return reply.status(err.status).send(err.body);
            throw err;
        }
    });
}
