import { FastifyInstance } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { checkChannelMembership, resolveMentions } from './shared';
import { loadAndComputePermissions } from './bots';
import { Permissions } from '../permissions';
import { getRedis } from '../auth/token-blacklist';

export async function messageRoutes(app: FastifyInstance) {

    // POST /channels/:id/messages → 201 { id, content, authorId, authorUsername, channelId, createdAt, attachments }
    app.post('/channels/:id/messages', {
        schema: {
            body: {
                type: 'object',
                properties: {
                    content: { type: 'string', minLength: 1, maxLength: 4000 },
                    attachments: {
                        type: 'array',
                        items: { type: 'string', minLength: 26, maxLength: 26 },
                        maxItems: 10,
                    },
                },
                anyOf: [
                    { required: ['content'] },
                    { required: ['attachments'] },
                ],
            },
        },
    }, async (request, reply) => {
        const { id: channelId } = request.params as any;
        const userId = request.userId;
        const isBot = request.isBot;
        const { content: rawContent, attachments: attachmentIds } = request.body as any;
        const content = rawContent || null;
        const db = request.dbClient!;

        const isMember = await checkChannelMembership(db, channelId, userId, isBot);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        // Fetch channel details (needed for mention resolution, loop guard, rate limiting)
        const channelRow = await db.query(
            'SELECT server_id, max_bot_hops, bot_rate_limit FROM channels WHERE id = $1',
            [channelId]
        );
        const serverId = channelRow.rows[0]?.server_id?.trim() || null;
        const maxBotHops = channelRow.rows[0]?.max_bot_hops ?? 4;
        const botRateLimit = channelRow.rows[0]?.bot_rate_limit ?? 10;

        // ─── Bot rate limiting (per-bot, per-channel, Redis sliding window) ───
        if (isBot) {
            try {
                const redis = getRedis();
                const rateKey = `botrate:${userId}:${channelId}`;
                const count = await redis.incr(rateKey);
                if (count === 1) await redis.expire(rateKey, 60);

                if (count > botRateLimit) {
                    const retryAfter = await redis.ttl(rateKey);
                    return reply.code(429).send({
                        error: 'Rate limited',
                        retryAfter,
                    });
                }
            } catch { /* Redis failure is non-fatal */ }
        }

        // ─── Loop guard (per-channel, consecutive bot messages) ───
        // maxBotHops === 0 means loop guard is disabled
        if (isBot && maxBotHops > 0) {
            try {
                const redis = getRedis();
                const guardKey = `loopguard:${channelId}`;
                const count = await redis.incr(guardKey);
                if (count === 1) await redis.expire(guardKey, 300);

                if (count > maxBotHops) {
                    await redis.del(guardKey);

                    // Create system message
                    const sysId = generateUlid();
                    await db.query(
                        `INSERT INTO messages (id, channel_id, author_id, content, system_event)
                         VALUES ($1, $2, NULL, $3, 'loop_guard')`,
                        [sysId, channelId,
                         `Loop guard: ${maxBotHops} consecutive bot messages. Human input required to continue.`]
                    );

                    request.pendingEvents ??= [];
                    request.pendingEvents.push({
                        room: `channel:${channelId.trim()}`,
                        event: 'Message',
                        data: {
                            id: sysId.trim(),
                            content: `Loop guard: ${maxBotHops} consecutive bot messages. Human input required to continue.`,
                            authorId: null,
                            authorUsername: null,
                            channelId: channelId.trim(),
                            createdAt: new Date().toISOString(),
                            systemEvent: 'loop_guard',
                        },
                    });
                    request.pendingEvents.push({
                        room: `channel:${channelId.trim()}`,
                        event: 'ChannelLoopGuard',
                        data: { channelId: channelId.trim(), paused: true },
                    });

                    return reply.status(429).send({ error: 'Loop guard triggered' });
                }
            } catch { /* Redis failure is non-fatal */ }
        } else if (!isBot) {
            // Human message resets loop guard counter
            try {
                await getRedis().del(`loopguard:${channelId}`);
            } catch { /* non-fatal */ }
        }

        const messageId = generateUlid();

        // Parse and resolve @mentions (shared helper)
        const mentionContent = content || '';
        const mentionMatches: string[] = mentionContent.match(/@(\w+)/g) || [];
        const mentionedUsernames = [...new Set(mentionMatches.map((m: string) => m.slice(1)))];
        const mentionsEveryone = mentionedUsernames.includes('everyone');

        await db.query(
            `INSERT INTO messages (id, channel_id, author_id, content, mentions_everyone)
             VALUES ($1, $2, $3, $4, $5)`,
            [messageId, channelId, userId, content, mentionsEveryone]
        );

        const { mentionedUsers } = await resolveMentions(db, messageId, channelId, serverId, userId, content);

        // Validate and bind attachments
        let resolvedAttachments: any[] = [];

        if (attachmentIds && attachmentIds.length > 0) {
            // Reject duplicates
            const uniqueIds = [...new Set(attachmentIds)] as string[];
            if (attachmentIds.length !== uniqueIds.length) {
                return reply.status(400).send({ error: 'Duplicate attachment IDs' });
            }

            if (uniqueIds.length > 10) {
                return reply.status(400).send({ error: 'Too many attachments (max 10)' });
            }

            // Validate all attachments (lock rows with FOR UPDATE)
            const filesResult = await db.query(`
                SELECT id, uploader_id, channel_id, message_id, filename, mime_type, content_type, size_bytes, width, height, deleted_at
                FROM files WHERE id = ANY($1) FOR UPDATE
            `, [uniqueIds]);

            // Cardinality check
            if (filesResult.rows.length !== uniqueIds.length) {
                return reply.status(400).send({ error: 'One or more attachment IDs are invalid or deleted' });
            }

            for (const file of filesResult.rows) {
                if (file.deleted_at) {
                    return reply.status(400).send({ error: 'One or more attachments are deleted' });
                }
                if (file.uploader_id.trim() !== userId.trim()) {
                    return reply.status(400).send({ error: 'Attachment does not belong to you' });
                }
                if (file.channel_id?.trim() !== channelId.trim()) {
                    return reply.status(400).send({ error: 'Attachment channel mismatch' });
                }
                if (file.message_id) {
                    return reply.status(400).send({ error: 'Attachment already bound to a message' });
                }
            }

            // Bind files to message
            await db.query('UPDATE files SET message_id = $1 WHERE id = ANY($2)', [messageId, uniqueIds]);

            // Resolve attachment metadata for response
            resolvedAttachments = filesResult.rows.map((f: any) => ({
                id: f.id.trim(),
                name: f.filename,
                mime: f.mime_type || f.content_type,
                size: f.size_bytes,
                width: f.width,
                height: f.height,
                url: `/files/${f.id.trim()}`,
            }));
        }

        const userRow = await db.query(
            'SELECT username, bot, avatar_url FROM users WHERE id = $1',
            [userId]
        );

        const mentionedUserIds = mentionedUsers.map(u => u.id);

        // Phase 2: Fire MessageMention events for bot mentions (post-commit via pendingEvents).
        // Placed after all validation gates so events are only queued for successful creates.
        if (serverId) {
            const botMentions = mentionedUsers.filter(u => u.bot);
            if (botMentions.length > 0 && !isBot) {
                // Only human senders can trigger bot mentions; check UseBots permission
                const senderPerms = await loadAndComputePermissions(db, userId, serverId);
                const hasUseBots = !!(senderPerms & Permissions.UseBots) || !!(senderPerms & Permissions.Administrator);

                if (hasUseBots) {
                    request.pendingEvents ??= [];
                    const timestamp = new Date().toISOString();
                    for (const botMention of botMentions) {
                        request.pendingEvents.push({
                            room: `user:${botMention.id}`,
                            event: 'MessageMention',
                            data: {
                                channelId: channelId.trim(),
                                messageId: messageId.trim(),
                                content,
                                author: { id: userId.trim(), username: userRow.rows[0].username },
                                timestamp,
                            },
                        });
                    }
                }
            }
        }

        const message = {
            id: messageId.trim(),
            content,
            authorId: userId.trim(),
            authorUsername: userRow.rows[0].username,
            authorBot: userRow.rows[0].bot || false,
            authorAvatarUrl: userRow.rows[0].avatar_url || null,
            channelId: channelId.trim(),
            createdAt: new Date().toISOString(),
            mentions: mentionedUserIds,
            mentionsEveryone,
            attachments: resolvedAttachments,
        };

        // Stash for post-commit broadcast (emitted in onResponse after COMMIT)
        request.pendingEvents = request.pendingEvents || [];
        request.pendingEvents.push({
            room: `channel:${channelId.trim()}`,
            event: 'Message',
            data: message,
        });

        // Stash for idempotency cache (written in onResponse after COMMIT)
        if (request.idempotencyKey) {
            request.idempotencyResponseBody = message;
        }

        return reply.status(201).send(message);
    });

    // GET /channels/:id/messages?limit&before → 200 [{ id, content, authorId, authorUsername, channelId, editedAt, deletedAt, createdAt }]
    app.get('/channels/:id/messages', async (request, reply) => {
        const { id: channelId } = request.params as any;
        const userId = request.userId;
        const { limit: rawLimit, before } = request.query as any;
        const db = request.dbClient!;

        const isMember = await checkChannelMembership(db, channelId, userId, request.isBot);
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
                            u.username AS author_username, u.bot AS author_bot, u.avatar_url AS author_avatar_url,
                            m.system_event, m.reply_count, m.last_reply_at, m.thread_closed_at
                     FROM messages m
                     LEFT JOIN users u ON u.id = m.author_id
                     WHERE m.channel_id = $1 AND m.id < $2 AND m.thread_id IS NULL
                     ORDER BY m.id DESC
                     LIMIT $3`;
            params = [channelId, before, limit];
        } else {
            query = `SELECT m.id, m.content, m.author_id, m.channel_id, m.edited_at, m.deleted_at, m.created_at,
                            u.username AS author_username, u.bot AS author_bot, u.avatar_url AS author_avatar_url,
                            m.system_event, m.reply_count, m.last_reply_at, m.thread_closed_at
                     FROM messages m
                     LEFT JOIN users u ON u.id = m.author_id
                     WHERE m.channel_id = $1 AND m.thread_id IS NULL
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

        // Fetch attachments for all returned messages
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
            reactions: reactionsMap[row.id.trim()] || [],
            attachments: attachmentsMap[row.id.trim()] || [],
            ...(row.system_event ? { systemEvent: row.system_event } : {}),
            ...(row.reply_count > 0 ? { replyCount: row.reply_count, lastReplyAt: row.last_reply_at, ...(row.thread_closed_at ? { threadClosedAt: row.thread_closed_at } : {}) } : {}),
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
        const userId = request.userId;
        const { content } = request.body as any;
        const db = request.dbClient!;

        const isMember = await checkChannelMembership(db, channelId, userId, request.isBot);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        // Find the message
        const msg = await db.query(
            'SELECT id, author_id, thread_id FROM messages WHERE id = $1 AND channel_id = $2',
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
        const threadId = msg.rows[0].thread_id?.trim() || undefined;

        // Stash for post-commit broadcast (emitted in onResponse after COMMIT)
        request.pendingEvents = request.pendingEvents || [];
        request.pendingEvents.push({
            room: `channel:${channelId.trim()}`,
            event: 'MessageUpdate',
            data: {
                id: updated.id.trim(),
                channelId: channelId.trim(),
                content: updated.content,
                editedAt: updated.edited_at,
                ...(threadId ? { threadId } : {}),
            },
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
        const userId = request.userId;
        const db = request.dbClient!;

        const isMember = await checkChannelMembership(db, channelId, userId, request.isBot);
        if (!isMember) {
            return reply.status(403).send({ error: 'Not a member of this channel' });
        }

        // Find the message
        const msg = await db.query(
            'SELECT id, author_id, thread_id FROM messages WHERE id = $1 AND channel_id = $2',
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
        const threadId = msg.rows[0].thread_id?.trim() || undefined;

        // If this was a thread reply, update the parent's metadata
        if (threadId) {
            const parentUpdate = await db.query(
                `UPDATE messages SET
                    reply_count = GREATEST(reply_count - 1, 0),
                    last_reply_at = (SELECT m2.created_at FROM messages m2 WHERE m2.thread_id = $1 AND m2.deleted_at IS NULL AND m2.id != $2 ORDER BY m2.id DESC LIMIT 1)
                 WHERE id = $1
                 RETURNING reply_count, last_reply_at, thread_closed_at`,
                [threadId, msgId]
            );

            if (parentUpdate.rows.length > 0) {
                request.pendingEvents = request.pendingEvents || [];
                request.pendingEvents.push({
                    room: `channel:${channelId.trim()}`,
                    event: 'ThreadMetadataUpdate',
                    data: {
                        channelId: channelId.trim(),
                        messageId: threadId,
                        replyCount: parentUpdate.rows[0].reply_count,
                        lastReplyAt: parentUpdate.rows[0].last_reply_at,
                        threadClosedAt: parentUpdate.rows[0].thread_closed_at ?? null,
                    },
                });
            }
        }

        // Stash for post-commit broadcast (emitted in onResponse after COMMIT)
        request.pendingEvents = request.pendingEvents || [];
        request.pendingEvents.push({
            room: `channel:${channelId.trim()}`,
            event: 'MessageDelete',
            data: {
                id: deleted.id.trim(),
                channelId: channelId.trim(),
                deletedAt: deleted.deleted_at,
                ...(threadId ? { threadId } : {}),
            },
        });

        return reply.status(200).send({
            id: deleted.id.trim(),
            deletedAt: deleted.deleted_at,
        });
    });
}
