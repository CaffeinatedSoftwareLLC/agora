import { FastifyInstance } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { checkChannelMembership } from './shared';

export async function messageRoutes(app: FastifyInstance) {

    // POST /channels/:id/messages → 201 { id, content, authorId, authorUsername, channelId, createdAt }
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

        // Parse @mentions from content
        const mentionMatches: string[] = content.match(/@(\w+)/g) || [];
        const mentionedUsernames = [...new Set(mentionMatches.map((m) => m.slice(1)))];
        const mentionsEveryone = mentionedUsernames.includes('everyone');

        await db.query(
            `INSERT INTO messages (id, channel_id, author_id, content, mentions_everyone)
             VALUES ($1, $2, $3, $4, $5)`,
            [messageId, channelId, userId, content, mentionsEveryone]
        );

        // Look up the channel to determine how to check membership for mentioned users
        const channelRow = await db.query(
            'SELECT server_id FROM channels WHERE id = $1',
            [channelId]
        );
        const serverId = channelRow.rows[0]?.server_id?.trim() || null;

        // Resolve mentioned usernames to user IDs (batch query)
        const nonEveryoneUsernames = mentionedUsernames.filter((u: string) => u !== 'everyone');
        let mentionedUserIds: string[] = [];

        if (nonEveryoneUsernames.length > 0) {
            // Find users that exist AND are members of this channel/server
            let validMentions;
            if (serverId) {
                validMentions = await db.query(
                    `SELECT u.id FROM users u
                     INNER JOIN server_members sm ON sm.user_id = u.id AND sm.server_id = $2
                     WHERE u.username = ANY($1)`,
                    [nonEveryoneUsernames, serverId]
                );
            } else {
                validMentions = await db.query(
                    `SELECT u.id FROM users u
                     INNER JOIN channel_members cm ON cm.user_id = u.id AND cm.channel_id = $2
                     WHERE u.username = ANY($1)`,
                    [nonEveryoneUsernames, channelId]
                );
            }

            mentionedUserIds = validMentions.rows.map((r: any) => r.id.trim());

            // Insert into message_mentions
            if (mentionedUserIds.length > 0) {
                const mentionValues = mentionedUserIds
                    .map((_: string, i: number) => `($1, $${i + 2})`)
                    .join(', ');
                await db.query(
                    `INSERT INTO message_mentions (message_id, user_id) VALUES ${mentionValues}
                     ON CONFLICT DO NOTHING`,
                    [messageId, ...mentionedUserIds]
                );

                // Increment mention_count for each directly mentioned user
                await db.query(
                    `INSERT INTO channel_unreads (channel_id, user_id, mention_count)
                     SELECT $1, unnest($2::char(26)[]), 1
                     ON CONFLICT (channel_id, user_id) DO UPDATE
                        SET mention_count = channel_unreads.mention_count + 1`,
                    [channelId, mentionedUserIds]
                );
            }
        }

        // If @everyone, increment mention_count for all channel members except the author
        if (mentionsEveryone) {
            if (serverId) {
                await db.query(
                    `INSERT INTO channel_unreads (channel_id, user_id, mention_count)
                     SELECT $1, sm.user_id, 1
                     FROM server_members sm
                     WHERE sm.server_id = $2 AND sm.user_id != $3
                     ON CONFLICT (channel_id, user_id) DO UPDATE
                        SET mention_count = channel_unreads.mention_count + 1`,
                    [channelId, serverId, userId]
                );
            } else {
                await db.query(
                    `INSERT INTO channel_unreads (channel_id, user_id, mention_count)
                     SELECT $1, cm.user_id, 1
                     FROM channel_members cm
                     WHERE cm.channel_id = $1 AND cm.user_id != $2
                     ON CONFLICT (channel_id, user_id) DO UPDATE
                        SET mention_count = channel_unreads.mention_count + 1`,
                    [channelId, userId]
                );
            }
        }

        const userRow = await db.query(
            'SELECT username FROM users WHERE id = $1',
            [userId]
        );

        const message = {
            id: messageId.trim(),
            content,
            authorId: userId.trim(),
            authorUsername: userRow.rows[0].username,
            channelId: channelId.trim(),
            createdAt: new Date().toISOString(),
            mentions: mentionedUserIds,
            mentionsEveryone,
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

    // GET /channels/:id/messages?limit&before → 200 [{ id, content, authorId, authorUsername, channelId, editedAt, deletedAt, createdAt }]
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
            query = `SELECT m.id, m.content, m.author_id, m.channel_id, m.edited_at, m.deleted_at, m.created_at,
                            u.username AS author_username, m.system_event
                     FROM messages m
                     LEFT JOIN users u ON u.id = m.author_id
                     WHERE m.channel_id = $1 AND m.id < $2
                     ORDER BY m.id DESC
                     LIMIT $3`;
            params = [channelId, before, limit];
        } else {
            query = `SELECT m.id, m.content, m.author_id, m.channel_id, m.edited_at, m.deleted_at, m.created_at,
                            u.username AS author_username, m.system_event
                     FROM messages m
                     LEFT JOIN users u ON u.id = m.author_id
                     WHERE m.channel_id = $1
                     ORDER BY m.id DESC
                     LIMIT $2`;
            params = [channelId, limit];
        }

        const result = await db.query(query, params);

        // Fetch reactions for all returned messages in one query
        const messageIds = result.rows.map((r: any) => r.id);
        let reactionsMap: Record<string, { emoji: string; count: number; me: boolean }[]> = {};
        if (messageIds.length > 0) {
            const rxResult = await db.query(
                `SELECT message_id, emoji_unicode,
                        count(*)::int AS count,
                        bool_or(user_id = $2) AS me
                 FROM message_reactions
                 WHERE message_id = ANY($1)
                 GROUP BY message_id, emoji_unicode`,
                [messageIds, userId]
            );
            for (const row of rxResult.rows) {
                const mid = row.message_id.trim();
                if (!reactionsMap[mid]) reactionsMap[mid] = [];
                reactionsMap[mid].push({
                    emoji: row.emoji_unicode,
                    count: row.count,
                    me: row.me,
                });
            }
        }

        const messages = result.rows.map((row: any) => ({
            id: row.id.trim(),
            content: row.content,
            authorId: row.author_id ? row.author_id.trim() : null,
            authorUsername: row.author_username ?? null,
            channelId: row.channel_id.trim(),
            editedAt: row.edited_at,
            deletedAt: row.deleted_at,
            createdAt: row.created_at,
            reactions: reactionsMap[row.id.trim()] || [],
            ...(row.system_event ? { systemEvent: row.system_event } : {}),
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
