import { FastifyInstance } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { checkChannelMembership, resolveMentions } from './shared';
import { loadAndComputePermissions } from './bots';
import { Permissions } from '../permissions';
import { getRedis } from '../auth/token-blacklist';

export async function threadRoutes(app: FastifyInstance) {

    // POST /channels/:id/messages/:msgId/replies → 201
    app.post('/channels/:id/messages/:msgId/replies', {
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
        const isBot = (request as any).isBot;
        const { content } = request.body as any;
        const db = (request as any).dbClient;

        const isMember = await checkChannelMembership(db, channelId, userId, isBot);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        // Fetch parent message
        const parent = await db.query(
            'SELECT id, channel_id, thread_id, thread_closed_at FROM messages WHERE id = $1 AND channel_id = $2',
            [msgId, channelId]
        );
        if (parent.rows.length === 0) {
            return reply.status(404).send({ error: 'Message not found' });
        }

        // Reject nested replies (flat threads only)
        if (parent.rows[0].thread_id !== null) {
            return reply.status(400).send({ error: 'Cannot reply to a reply' });
        }

        // Reject replies to closed threads
        if (parent.rows[0].thread_closed_at !== null) {
            return reply.status(409).send({ error: 'Thread is closed' });
        }

        // Fetch channel details for mention resolution, rate limiting, loop guard
        const channelRow = await db.query(
            'SELECT server_id, max_bot_hops, bot_rate_limit FROM channels WHERE id = $1',
            [channelId]
        );
        const serverId = channelRow.rows[0]?.server_id?.trim() || null;
        const maxBotHops = channelRow.rows[0]?.max_bot_hops ?? 4;
        const botRateLimit = channelRow.rows[0]?.bot_rate_limit ?? 10;

        // Bot rate limiting (same channel context as regular messages)
        if (isBot) {
            try {
                const redis = getRedis();
                const rateKey = `botrate:${userId}:${channelId}`;
                const count = await redis.incr(rateKey);
                if (count === 1) await redis.expire(rateKey, 60);

                if (count > botRateLimit) {
                    const retryAfter = await redis.ttl(rateKey);
                    return reply.code(429).send({ error: 'Rate limited', retryAfter });
                }
            } catch { /* Redis failure is non-fatal */ }
        }

        // Loop guard (same channel context)
        if (isBot && maxBotHops > 0) {
            try {
                const redis = getRedis();
                const guardKey = `loopguard:${channelId}`;
                const count = await redis.incr(guardKey);
                if (count === 1) await redis.expire(guardKey, 300);

                if (count > maxBotHops) {
                    await redis.del(guardKey);
                    const sysId = generateUlid();
                    await db.query(
                        `INSERT INTO messages (id, channel_id, author_id, content, system_event)
                         VALUES ($1, $2, NULL, $3, 'loop_guard')`,
                        [sysId, channelId,
                         `Loop guard: ${maxBotHops} consecutive bot messages. Human input required to continue.`]
                    );
                    (request as any).pendingEvents ??= [];
                    (request as any).pendingEvents.push({
                        room: `channel:${channelId.trim()}`,
                        event: 'Message',
                        data: {
                            id: sysId.trim(),
                            content: `Loop guard: ${maxBotHops} consecutive bot messages. Human input required to continue.`,
                            authorId: null, authorUsername: null,
                            channelId: channelId.trim(),
                            createdAt: new Date().toISOString(),
                            systemEvent: 'loop_guard',
                        },
                    });
                    (request as any).pendingEvents.push({
                        room: `channel:${channelId.trim()}`,
                        event: 'ChannelLoopGuard',
                        data: { channelId: channelId.trim(), paused: true },
                    });
                    return reply.status(429).send({ error: 'Loop guard triggered' });
                }
            } catch { /* Redis failure is non-fatal */ }
        } else if (!isBot) {
            try { await getRedis().del(`loopguard:${channelId}`); } catch { /* non-fatal */ }
        }

        const replyId = generateUlid();

        // Parse mentionsEveryone for INSERT column
        const mentionContent = content || '';
        const mentionMatches: string[] = mentionContent.match(/@(\w+)/g) || [];
        const mentionedUsernames = [...new Set(mentionMatches.map((m: string) => m.slice(1)))];
        const mentionsEveryone = mentionedUsernames.includes('everyone');

        await db.query(
            `INSERT INTO messages (id, channel_id, author_id, content, thread_id, mentions_everyone)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [replyId, channelId, userId, content, msgId, mentionsEveryone]
        );

        // Update parent metadata
        const parentUpdate = await db.query(
            `UPDATE messages SET reply_count = reply_count + 1, last_reply_at = NOW()
             WHERE id = $1
             RETURNING reply_count, last_reply_at`,
            [msgId]
        );

        // Resolve @mentions (shared helper)
        const { mentionedUsers } = await resolveMentions(db, replyId, channelId, serverId, userId, content);

        const userRow = await db.query(
            'SELECT username, bot, avatar_url FROM users WHERE id = $1',
            [userId]
        );

        const mentionedUserIds = mentionedUsers.map(u => u.id);

        // Fire bot mention events
        if (serverId) {
            const botMentions = mentionedUsers.filter(u => u.bot);
            if (botMentions.length > 0 && !isBot) {
                const senderPerms = await loadAndComputePermissions(db, userId, serverId);
                const hasUseBots = !!(senderPerms & Permissions.UseBots) || !!(senderPerms & Permissions.Administrator);
                if (hasUseBots) {
                    (request as any).pendingEvents ??= [];
                    const timestamp = new Date().toISOString();
                    for (const botMention of botMentions) {
                        (request as any).pendingEvents.push({
                            room: `user:${botMention.id}`,
                            event: 'MessageMention',
                            data: {
                                channelId: channelId.trim(),
                                messageId: replyId.trim(),
                                content,
                                author: { id: userId.trim(), username: userRow.rows[0].username },
                                timestamp,
                            },
                        });
                    }
                }
            }
        }

        const replyMessage = {
            id: replyId.trim(),
            content,
            authorId: userId.trim(),
            authorUsername: userRow.rows[0].username,
            authorBot: userRow.rows[0].bot || false,
            authorAvatarUrl: userRow.rows[0].avatar_url || null,
            channelId: channelId.trim(),
            createdAt: new Date().toISOString(),
            threadId: msgId.trim(),
            mentions: mentionedUserIds,
            mentionsEveryone,
        };

        (request as any).pendingEvents = (request as any).pendingEvents || [];
        (request as any).pendingEvents.push({
            room: `channel:${channelId.trim()}`,
            event: 'Message',
            data: replyMessage,
        });
        (request as any).pendingEvents.push({
            room: `channel:${channelId.trim()}`,
            event: 'ThreadMetadataUpdate',
            data: {
                channelId: channelId.trim(),
                messageId: msgId.trim(),
                replyCount: parentUpdate.rows[0].reply_count,
                lastReplyAt: parentUpdate.rows[0].last_reply_at,
                threadClosedAt: null,
            },
        });

        if ((request as any).idempotencyKey) {
            (request as any).idempotencyResponseBody = replyMessage;
        }

        return reply.status(201).send(replyMessage);
    });

    // GET /channels/:id/messages/:msgId/replies?limit&after → 200 [Message]
    app.get('/channels/:id/messages/:msgId/replies', async (request, reply) => {
        const { id: channelId, msgId } = request.params as any;
        const userId = (request as any).userId;
        const { limit: rawLimit, after } = request.query as any;
        const db = (request as any).dbClient;

        const isMember = await checkChannelMembership(db, channelId, userId, (request as any).isBot);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        // Verify parent exists in channel
        const parent = await db.query(
            'SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2',
            [msgId, channelId]
        );
        if (parent.rows.length === 0) {
            return reply.status(404).send({ error: 'Message not found' });
        }

        let limit = rawLimit ? parseInt(rawLimit, 10) : 50;
        if (isNaN(limit) || limit < 1) limit = 50;
        if (limit > 100) limit = 100;

        let query: string;
        let params: any[];

        if (after) {
            query = `SELECT m.id, m.content, m.author_id, m.channel_id, m.edited_at, m.deleted_at, m.created_at,
                            m.thread_id, u.username AS author_username, u.bot AS author_bot, u.avatar_url AS author_avatar_url,
                            m.system_event
                     FROM messages m
                     LEFT JOIN users u ON u.id = m.author_id
                     WHERE m.thread_id = $1 AND m.channel_id = $2 AND m.id > $3
                     ORDER BY m.id ASC
                     LIMIT $4`;
            params = [msgId, channelId, after, limit];
        } else {
            query = `SELECT m.id, m.content, m.author_id, m.channel_id, m.edited_at, m.deleted_at, m.created_at,
                            m.thread_id, u.username AS author_username, u.bot AS author_bot, u.avatar_url AS author_avatar_url,
                            m.system_event
                     FROM messages m
                     LEFT JOIN users u ON u.id = m.author_id
                     WHERE m.thread_id = $1 AND m.channel_id = $2
                     ORDER BY m.id ASC
                     LIMIT $3`;
            params = [msgId, channelId, limit];
        }

        const result = await db.query(query, params);

        // Batch-fetch reactions
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

        // Batch-fetch attachments
        let attachmentsMap: Record<string, any[]> = {};
        if (messageIds.length > 0) {
            const attachResult = await db.query(`
                SELECT id, message_id, filename, mime_type, content_type, size_bytes, width, height, deleted_at
                FROM files
                WHERE message_id = ANY($1)
                ORDER BY created_at ASC
            `, [messageIds]);

            for (const row of attachResult.rows) {
                const mid = row.message_id.trim();
                if (!attachmentsMap[mid]) attachmentsMap[mid] = [];
                attachmentsMap[mid].push({
                    id: row.id.trim(),
                    name: row.filename,
                    mime: row.mime_type || row.content_type,
                    size: row.size_bytes,
                    width: row.width,
                    height: row.height,
                    url: `/files/${row.id.trim()}`,
                    deletedAt: row.deleted_at,
                });
            }
        }

        const messages = result.rows.map((row: any) => ({
            id: row.id.trim(),
            content: row.content,
            authorId: row.author_id ? row.author_id.trim() : null,
            authorUsername: row.author_username ?? null,
            authorBot: row.author_bot || false,
            authorAvatarUrl: row.author_avatar_url || null,
            channelId: row.channel_id.trim(),
            editedAt: row.edited_at,
            deletedAt: row.deleted_at,
            createdAt: row.created_at,
            threadId: row.thread_id?.trim() || null,
            reactions: reactionsMap[row.id.trim()] || [],
            attachments: attachmentsMap[row.id.trim()] || [],
            ...(row.system_event ? { systemEvent: row.system_event } : {}),
        }));

        return reply.status(200).send(messages);
    });

    // GET /channels/:id/threads?limit&before → 200 [ThreadSummary]
    app.get('/channels/:id/threads', async (request, reply) => {
        const { id: channelId } = request.params as any;
        const userId = (request as any).userId;
        const { limit: rawLimit, before } = request.query as any;
        const db = (request as any).dbClient;

        const isMember = await checkChannelMembership(db, channelId, userId, (request as any).isBot);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        let limit = rawLimit ? parseInt(rawLimit, 10) : 5;
        if (isNaN(limit) || limit < 1) limit = 5;
        if (limit > 10) limit = 10;

        let query: string;
        let params: any[];

        if (before) {
            query = `SELECT p.id, p.content, p.author_id, p.channel_id, p.reply_count, p.last_reply_at,
                            p.created_at, p.edited_at, p.deleted_at,
                            u.username AS author_username, u.bot AS author_bot, u.avatar_url AS author_avatar_url,
                            previews.replies AS preview_replies
                     FROM messages p
                     LEFT JOIN users u ON u.id = p.author_id
                     LEFT JOIN LATERAL (
                         SELECT json_agg(sub ORDER BY sub.id ASC) AS replies
                         FROM (
                             SELECT r.id, r.content, r.author_id,
                                    ru.username AS author_username, ru.avatar_url AS author_avatar_url
                             FROM messages r
                             LEFT JOIN users ru ON ru.id = r.author_id
                             WHERE r.thread_id = p.id AND r.deleted_at IS NULL
                             ORDER BY r.id DESC
                             LIMIT 2
                         ) sub
                     ) previews ON true
                     WHERE p.channel_id = $1 AND p.reply_count > 0 AND p.deleted_at IS NULL
                       AND p.thread_closed_at IS NULL AND p.last_reply_at < $2
                     ORDER BY p.last_reply_at DESC
                     LIMIT $3`;
            params = [channelId, before, limit];
        } else {
            query = `SELECT p.id, p.content, p.author_id, p.channel_id, p.reply_count, p.last_reply_at,
                            p.created_at, p.edited_at, p.deleted_at,
                            u.username AS author_username, u.bot AS author_bot, u.avatar_url AS author_avatar_url,
                            previews.replies AS preview_replies
                     FROM messages p
                     LEFT JOIN users u ON u.id = p.author_id
                     LEFT JOIN LATERAL (
                         SELECT json_agg(sub ORDER BY sub.id ASC) AS replies
                         FROM (
                             SELECT r.id, r.content, r.author_id,
                                    ru.username AS author_username, ru.avatar_url AS author_avatar_url
                             FROM messages r
                             LEFT JOIN users ru ON ru.id = r.author_id
                             WHERE r.thread_id = p.id AND r.deleted_at IS NULL
                             ORDER BY r.id DESC
                             LIMIT 2
                         ) sub
                     ) previews ON true
                     WHERE p.channel_id = $1 AND p.reply_count > 0 AND p.deleted_at IS NULL
                       AND p.thread_closed_at IS NULL
                     ORDER BY p.last_reply_at DESC
                     LIMIT $2`;
            params = [channelId, limit];
        }

        const result = await db.query(query, params);

        // Compute canClose: author OR ManageMessages/Administrator
        const channelRow = await db.query('SELECT server_id FROM channels WHERE id = $1', [channelId]);
        const serverId = channelRow.rows[0]?.server_id?.trim() || null;
        let hasManagePerms = false;
        if (serverId) {
            const perms = await loadAndComputePermissions(db, userId, serverId);
            hasManagePerms = !!(perms & Permissions.ManageMessages) || !!(perms & Permissions.Administrator);
        } else {
            // DM channel: any participant can close
            hasManagePerms = true;
        }

        const threads = result.rows.map((row: any) => ({
            id: row.id.trim(),
            content: row.content,
            authorId: row.author_id ? row.author_id.trim() : null,
            authorUsername: row.author_username ?? null,
            authorBot: row.author_bot || false,
            authorAvatarUrl: row.author_avatar_url || null,
            channelId: row.channel_id.trim(),
            createdAt: row.created_at,
            editedAt: row.edited_at,
            replyCount: row.reply_count,
            lastReplyAt: row.last_reply_at,
            canClose: hasManagePerms || (row.author_id?.trim() === userId.trim()),
            previewReplies: (row.preview_replies || []).map((r: any) => ({
                id: r.id?.trim(),
                content: r.content,
                authorId: r.author_id?.trim() || null,
                authorUsername: r.author_username ?? null,
                authorAvatarUrl: r.author_avatar_url || null,
            })),
        }));

        return reply.status(200).send(threads);
    });

    // PATCH /channels/:id/messages/:msgId/thread → 200 { id, threadClosedAt }
    app.patch('/channels/:id/messages/:msgId/thread', {
        schema: {
            body: {
                type: 'object',
                required: ['closed'],
                properties: {
                    closed: { type: 'boolean' },
                },
            },
        },
    }, async (request, reply) => {
        const { id: channelId, msgId } = request.params as any;
        const userId = (request as any).userId;
        const { closed } = request.body as any;
        const db = (request as any).dbClient;

        const isMember = await checkChannelMembership(db, channelId, userId, (request as any).isBot);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        // Fetch parent message (thread_id IS NULL ensures only parents)
        const parent = await db.query(
            `SELECT id, author_id, reply_count, last_reply_at, thread_closed_at
             FROM messages WHERE id = $1 AND channel_id = $2 AND thread_id IS NULL`,
            [msgId, channelId]
        );
        if (parent.rows.length === 0) {
            return reply.status(404).send({ error: 'Thread parent not found' });
        }

        const parentRow = parent.rows[0];

        // Permission check
        const channelRow = await db.query('SELECT server_id FROM channels WHERE id = $1', [channelId]);
        const serverId = channelRow.rows[0]?.server_id?.trim() || null;

        if (serverId) {
            // Server channel: author OR ManageMessages OR Administrator
            const isAuthor = parentRow.author_id?.trim() === userId.trim();
            if (!isAuthor) {
                const perms = await loadAndComputePermissions(db, userId, serverId);
                const hasManagePerms = !!(perms & Permissions.ManageMessages) || !!(perms & Permissions.Administrator);
                if (!hasManagePerms) {
                    return reply.status(403).send({ error: 'Not authorized to close this thread' });
                }
            }
        }
        // DM channels: any participant (membership already verified above)

        // Idempotent: if already in desired state, return current state
        const alreadyClosed = parentRow.thread_closed_at !== null;
        if (closed === alreadyClosed) {
            return reply.status(200).send({
                id: parentRow.id.trim(),
                threadClosedAt: parentRow.thread_closed_at,
            });
        }

        // Update
        const result = await db.query(
            `UPDATE messages SET thread_closed_at = ${closed ? 'NOW()' : 'NULL'}
             WHERE id = $1
             RETURNING id, thread_closed_at`,
            [msgId]
        );

        const updated = result.rows[0];

        // Emit ThreadMetadataUpdate with threadClosedAt
        (request as any).pendingEvents = (request as any).pendingEvents || [];
        (request as any).pendingEvents.push({
            room: `channel:${channelId.trim()}`,
            event: 'ThreadMetadataUpdate',
            data: {
                channelId: channelId.trim(),
                messageId: updated.id.trim(),
                replyCount: parentRow.reply_count,
                lastReplyAt: parentRow.last_reply_at,
                threadClosedAt: updated.thread_closed_at,
            },
        });

        return reply.status(200).send({
            id: updated.id.trim(),
            threadClosedAt: updated.thread_closed_at,
        });
    });
}
