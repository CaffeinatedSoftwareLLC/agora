import { FastifyInstance } from 'fastify';
import { checkChannelMembership } from './shared';

export async function reactionRoutes(app: FastifyInstance) {

    // PUT /channels/:channelId/messages/:msgId/reactions → 200 { messageId, emoji, userId }
    app.put('/channels/:channelId/messages/:msgId/reactions', {
        schema: {
            body: {
                type: 'object',
                required: ['emoji'],
                properties: {
                    emoji: { type: 'string', minLength: 1, maxLength: 32 },
                },
            },
        },
    }, async (request, reply) => {
        const { channelId, msgId } = request.params as any;
        const userId = (request as any).userId;
        const { emoji } = request.body as any;
        const db = (request as any).dbClient;

        const isMember = await checkChannelMembership(db, channelId, userId);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        // Check message exists in this channel
        const msg = await db.query(
            'SELECT id FROM messages WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL',
            [msgId, channelId]
        );
        if (msg.rows.length === 0) {
            return reply.status(404).send({ error: 'Message not found' });
        }

        // Insert reaction (idempotent — WHERE NOT EXISTS guards against duplicates
        // because the uq_reaction UNIQUE constraint includes nullable emoji_id,
        // and NULLs don't match in unique constraints)
        await db.query(
            `INSERT INTO message_reactions (message_id, user_id, emoji_type, emoji_unicode)
             SELECT $1, $2, 0, $3
             WHERE NOT EXISTS (
                 SELECT 1 FROM message_reactions
                 WHERE message_id = $1 AND user_id = $2 AND emoji_type = 0 AND emoji_unicode = $3
             )`,
            [msgId, userId, emoji]
        );

        (request as any).pendingEvents = (request as any).pendingEvents || [];
        (request as any).pendingEvents.push({
            room: `channel:${channelId.trim()}`,
            event: 'ReactionAdd',
            data: { messageId: msgId.trim(), channelId: channelId.trim(), userId: userId.trim(), emoji },
        });

        return reply.status(200).send({
            messageId: msgId.trim(),
            emoji,
            userId: userId.trim(),
        });
    });

    // DELETE /channels/:channelId/messages/:msgId/reactions/:emoji → 200 { messageId, emoji, userId }
    app.delete('/channels/:channelId/messages/:msgId/reactions/:emoji', async (request, reply) => {
        const { channelId, msgId, emoji: rawEmoji } = request.params as any;
        const userId = (request as any).userId;
        const db = (request as any).dbClient;
        const emoji = decodeURIComponent(rawEmoji);

        const isMember = await checkChannelMembership(db, channelId, userId);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        const result = await db.query(
            `DELETE FROM message_reactions
             WHERE message_id = $1 AND user_id = $2 AND emoji_type = 0 AND emoji_unicode = $3`,
            [msgId, userId, emoji]
        );

        if (result.rowCount === 0) {
            return reply.status(404).send({ error: 'Reaction not found' });
        }

        (request as any).pendingEvents = (request as any).pendingEvents || [];
        (request as any).pendingEvents.push({
            room: `channel:${channelId.trim()}`,
            event: 'ReactionRemove',
            data: { messageId: msgId.trim(), channelId: channelId.trim(), userId: userId.trim(), emoji },
        });

        return reply.status(200).send({
            messageId: msgId.trim(),
            emoji,
            userId: userId.trim(),
        });
    });

    // GET /channels/:channelId/messages/:msgId/reactions → 200 [{ emoji, count, userIds, me }]
    app.get('/channels/:channelId/messages/:msgId/reactions', async (request, reply) => {
        const { channelId, msgId } = request.params as any;
        const userId = (request as any).userId;
        const db = (request as any).dbClient;

        const isMember = await checkChannelMembership(db, channelId, userId);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        const result = await db.query(
            `SELECT emoji_unicode, array_agg(user_id) AS user_ids, count(*)::int AS count
             FROM message_reactions
             WHERE message_id = $1
             GROUP BY emoji_unicode`,
            [msgId]
        );

        const reactions = result.rows.map((row: any) => ({
            emoji: row.emoji_unicode,
            count: row.count,
            userIds: row.user_ids.map((id: string) => id.trim()),
            me: row.user_ids.some((id: string) => id.trim() === userId.trim()),
        }));

        return reply.status(200).send(reactions);
    });
}
