import { FastifyInstance } from 'fastify';
import { checkChannelMembership } from './shared';

export async function unreadRoutes(app: FastifyInstance) {

    // PUT /channels/:channelId/ack → 200 { channelId, lastReadId, mentionCount }
    app.put('/channels/:channelId/ack', {
        schema: {
            body: {
                type: 'object',
                required: ['messageId'],
                properties: {
                    messageId: { type: 'string', minLength: 1, maxLength: 26 },
                },
            },
        },
    }, async (request, reply) => {
        const { channelId } = request.params as any;
        const userId = request.userId;
        const { messageId } = request.body as any;
        const db = request.dbClient!;

        const isMember = await checkChannelMembership(db, channelId, userId);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        // Upsert — only advance the read marker forward (don't move backwards)
        await db.query(
            `INSERT INTO channel_unreads (channel_id, user_id, last_read_id, mention_count)
             VALUES ($1, $2, $3, 0)
             ON CONFLICT (channel_id, user_id) DO UPDATE
                SET last_read_id = CASE
                        WHEN channel_unreads.last_read_id IS NULL THEN EXCLUDED.last_read_id
                        WHEN EXCLUDED.last_read_id > channel_unreads.last_read_id THEN EXCLUDED.last_read_id
                        ELSE channel_unreads.last_read_id
                    END,
                    mention_count = CASE
                        WHEN channel_unreads.last_read_id IS NULL OR EXCLUDED.last_read_id > channel_unreads.last_read_id THEN 0
                        ELSE channel_unreads.mention_count
                    END`,
            [channelId, userId, messageId]
        );

        return reply.status(200).send({
            channelId: channelId.trim(),
            lastReadId: messageId.trim(),
            mentionCount: 0,
        });
    });

    // GET /channels/:channelId/unreads → 200 { channelId, lastReadId, mentionCount, unreadCount }
    app.get('/channels/:channelId/unreads', async (request, reply) => {
        const { channelId } = request.params as any;
        const userId = request.userId;
        const db = request.dbClient!;

        const isMember = await checkChannelMembership(db, channelId, userId);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        const unreadRow = await db.query(
            'SELECT last_read_id, mention_count FROM channel_unreads WHERE channel_id = $1 AND user_id = $2',
            [channelId, userId]
        );

        if (unreadRow.rows.length === 0) {
            return reply.status(200).send({
                channelId: channelId.trim(),
                lastReadId: null,
                mentionCount: 0,
                unreadCount: 0,
            });
        }

        const { last_read_id, mention_count } = unreadRow.rows[0];

        let unreadCount = 0;
        if (last_read_id) {
            const countResult = await db.query(
                `SELECT COUNT(*)::int AS count FROM messages
                 WHERE channel_id = $1 AND id > $2 AND deleted_at IS NULL`,
                [channelId, last_read_id]
            );
            unreadCount = countResult.rows[0].count;
        }

        return reply.status(200).send({
            channelId: channelId.trim(),
            lastReadId: last_read_id ? last_read_id.trim() : null,
            mentionCount: mention_count,
            unreadCount,
        });
    });

    // GET /unreads → 200 [{ channelId, lastReadId, mentionCount, unreadCount }]
    app.get('/unreads', async (request, reply) => {
        const userId = request.userId;
        const db = request.dbClient!;

        // Get all channels the user is a member of:
        // Server channels (via server_members) + DM/group channels (via channel_members)
        const result = await db.query(
            `WITH user_channels AS (
                -- Server channels: user is a server member
                SELECT c.id AS channel_id
                FROM channels c
                INNER JOIN server_members sm ON sm.server_id = c.server_id
                WHERE sm.user_id = $1 AND c.server_id IS NOT NULL

                UNION

                -- DM/group channels: user is a channel member
                SELECT cm.channel_id
                FROM channel_members cm
                WHERE cm.user_id = $1
            )
            SELECT
                uc.channel_id,
                cu.last_read_id,
                COALESCE(cu.mention_count, 0)::int AS mention_count,
                COALESCE(unread.count, 0)::int AS unread_count
            FROM user_channels uc
            LEFT JOIN channel_unreads cu
                ON cu.channel_id = uc.channel_id AND cu.user_id = $1
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS count
                FROM messages m
                WHERE m.channel_id = uc.channel_id
                  AND m.deleted_at IS NULL
                  AND (cu.last_read_id IS NULL OR m.id > cu.last_read_id)
            ) unread ON true`,
            [userId]
        );

        const unreads = result.rows.map((row: any) => ({
            channelId: row.channel_id.trim(),
            lastReadId: row.last_read_id ? row.last_read_id.trim() : null,
            mentionCount: row.mention_count,
            unreadCount: row.unread_count,
        }));

        return reply.status(200).send(unreads);
    });
}
