import { FastifyInstance } from 'fastify';
import { generateUlid } from '../utils/ulid';

async function checkChannelMembership(db: any, channelId: string, userId: string): Promise<boolean> {
    const channel = await db.query(
        'SELECT id, channel_type, server_id FROM channels WHERE id = $1',
        [channelId]
    );
    if (channel.rows.length === 0) return false;

    const ch = channel.rows[0];

    if (ch.server_id) {
        const member = await db.query(
            'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
            [ch.server_id, userId]
        );
        return member.rows.length > 0;
    } else {
        const member = await db.query(
            'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
            [channelId, userId]
        );
        return member.rows.length > 0;
    }
}

export async function messageRoutes(app: FastifyInstance) {

    // POST /channels/:id/messages → 201 { id, content, authorId, channelId }
    app.post('/channels/:id/messages', {
        schema: {
            body: {
                type: 'object',
                required: ['content'],
                properties: {
                    content: { type: 'string', minLength: 1, maxLength: 4000 },
                },
            },
        },
    }, async (request, reply) => {
        const { id: channelId } = request.params as any;
        const userId = (request as any).userId;
        const { content } = request.body as any;
        const db = (request as any).dbClient;

        const isMember = await checkChannelMembership(db, channelId, userId);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        const messageId = generateUlid();

        await db.query(
            `INSERT INTO messages (id, channel_id, author_id, content)
             VALUES ($1, $2, $3, $4)`,
            [messageId, channelId, userId, content]
        );

        const message = {
            id: messageId.trim(),
            content,
            authorId: userId.trim(),
            channelId: channelId.trim(),
        };

        // Stash for post-commit broadcast (emitted in onResponse after COMMIT)
        (request as any).pendingEvents = (request as any).pendingEvents || [];
        (request as any).pendingEvents.push({
            room: `channel:${channelId.trim()}`,
            event: 'Message',
            data: message,
        });

        return reply.status(201).send(message);
    });

    // GET /channels/:id/messages?limit&before → 200 [{ id, content, authorId, channelId, editedAt, deletedAt, createdAt }]
    app.get('/channels/:id/messages', async (request, reply) => {
        const { id: channelId } = request.params as any;
        const userId = (request as any).userId;
        const { limit: rawLimit, before } = request.query as any;
        const db = (request as any).dbClient;

        const isMember = await checkChannelMembership(db, channelId, userId);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        let limit = rawLimit ? parseInt(rawLimit, 10) : 50;
        if (isNaN(limit) || limit < 1) limit = 50;
        if (limit > 100) limit = 100;

        let query: string;
        let params: any[];

        if (before) {
            query = `SELECT id, content, author_id, channel_id, edited_at, deleted_at, created_at
                     FROM messages
                     WHERE channel_id = $1 AND id < $2
                     ORDER BY id DESC
                     LIMIT $3`;
            params = [channelId, before, limit];
        } else {
            query = `SELECT id, content, author_id, channel_id, edited_at, deleted_at, created_at
                     FROM messages
                     WHERE channel_id = $1
                     ORDER BY id DESC
                     LIMIT $2`;
            params = [channelId, limit];
        }

        const result = await db.query(query, params);

        const messages = result.rows.map((row: any) => ({
            id: row.id.trim(),
            content: row.content,
            authorId: row.author_id ? row.author_id.trim() : null,
            channelId: row.channel_id.trim(),
            editedAt: row.edited_at,
            deletedAt: row.deleted_at,
            createdAt: row.created_at,
        }));

        return reply.status(200).send(messages);
    });

    // PATCH /channels/:id/messages/:msgId → 200 { id, content, editedAt }
    app.patch('/channels/:id/messages/:msgId', {
        schema: {
            body: {
                type: 'object',
                required: ['content'],
                properties: {
                    content: { type: 'string', minLength: 1, maxLength: 4000 },
                },
            },
        },
    }, async (request, reply) => {
        const { id: channelId, msgId } = request.params as any;
        const userId = (request as any).userId;
        const { content } = request.body as any;
        const db = (request as any).dbClient;

        const isMember = await checkChannelMembership(db, channelId, userId);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        // Find the message
        const msg = await db.query(
            'SELECT id, author_id FROM messages WHERE id = $1 AND channel_id = $2',
            [msgId, channelId]
        );
        if (msg.rows.length === 0) {
            return reply.status(404).send({ error: 'Message not found' });
        }

        if (msg.rows[0].author_id.trim() !== userId.trim()) {
            return reply.status(403).send({ error: 'Not the message author' });
        }

        const result = await db.query(
            `UPDATE messages SET content = $1, edited_at = NOW()
             WHERE id = $2
             RETURNING id, content, edited_at`,
            [content, msgId]
        );

        const updated = result.rows[0];

        // Stash for post-commit broadcast (emitted in onResponse after COMMIT)
        (request as any).pendingEvents = (request as any).pendingEvents || [];
        (request as any).pendingEvents.push({
            room: `channel:${channelId.trim()}`,
            event: 'MessageUpdate',
            data: { id: updated.id.trim(), channelId: channelId.trim(), content: updated.content, editedAt: updated.edited_at },
        });

        return reply.status(200).send({
            id: updated.id.trim(),
            content: updated.content,
            editedAt: updated.edited_at,
        });
    });

    // DELETE /channels/:id/messages/:msgId → 200 { id, deletedAt }
    app.delete('/channels/:id/messages/:msgId', async (request, reply) => {
        const { id: channelId, msgId } = request.params as any;
        const userId = (request as any).userId;
        const db = (request as any).dbClient;

        const isMember = await checkChannelMembership(db, channelId, userId);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        // Find the message
        const msg = await db.query(
            'SELECT id, author_id FROM messages WHERE id = $1 AND channel_id = $2',
            [msgId, channelId]
        );
        if (msg.rows.length === 0) {
            return reply.status(404).send({ error: 'Message not found' });
        }

        if (msg.rows[0].author_id.trim() !== userId.trim()) {
            return reply.status(403).send({ error: 'Not the message author' });
        }

        const result = await db.query(
            `UPDATE messages SET content = NULL, deleted_at = NOW()
             WHERE id = $1
             RETURNING id, deleted_at`,
            [msgId]
        );

        const deleted = result.rows[0];

        // Stash for post-commit broadcast (emitted in onResponse after COMMIT)
        (request as any).pendingEvents = (request as any).pendingEvents || [];
        (request as any).pendingEvents.push({
            room: `channel:${channelId.trim()}`,
            event: 'MessageDelete',
            data: { id: deleted.id.trim(), channelId: channelId.trim(), deletedAt: deleted.deleted_at },
        });

        return reply.status(200).send({
            id: deleted.id.trim(),
            deletedAt: deleted.deleted_at,
        });
    });
}
