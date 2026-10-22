import { FastifyInstance } from 'fastify';
import { addTaggingToAttachments } from '../lib/file-tags';
import { messageAttachmentsSchema, prepareMessageAttachments, bindMessageAttachments } from '../lib/message-attachments';
import { generateUlid } from '../utils/ulid';
import { resolveMentions, mentionsEveryoneIn } from './shared';
import { canPostInChannel, canViewChannel } from '../lib/channel-access';
import { loadAndComputePermissions } from './bots';
import { Permissions } from '../permissions';
import { getRedis } from '../auth/token-blacklist';
import { parseProtocol } from '../lib/protocol';
import { cannotDirect, readAuthorities, stampAuthority } from '../lib/direct-agents';
import { findClientKey, insertWithClientKey } from '../lib/client-key';
import { routeMessage } from '../lib/agent-sessions';
import { sanitizeMessageText } from '../lib/sanitize-text';
import { artifactBodySchema, artifactsForMessages, attachArtifact, checkArtifact, removeArtifactVersion } from '../lib/artifacts';

export async function messageRoutes(app: FastifyInstance) {


    // POST /channels/:id/messages → 201 { id, content, authorId, authorUsername, channelId, createdAt, attachments }
    app.post('/channels/:id/messages', {
        schema: {
            body: {
                type: 'object',
                properties: {
                    content: { type: 'string', maxLength: 4000 },
                    client_key: { type: 'string', minLength: 1, maxLength: 100 },
                    // Set by agora-mcp session_wake: refuse the post (403 cannot_direct) when the
                    // author can't direct here, since it would wake no one (#75).
                    require_direct: { type: 'boolean' },
                    attachments: messageAttachmentsSchema,
                    // A rendered document for the canvas pane (src/lib/artifacts.ts)
                    artifact: artifactBodySchema,
                },
                anyOf: [
                    { required: ['content'] },
                    { required: ['attachments'] },
                    { required: ['artifact'] },
                ],
            },
        },
    }, async (request, reply) => {
        const { id: channelId } = request.params as any;
        const userId = request.userId;
        const isBot = request.isBot;
        const { content: rawContent, attachments: attachmentIds, client_key: clientKey, require_direct: requireDirect, artifact } = request.body as any;
        // Terminal escapes and private keys never reach the database (#88)
        const content = rawContent ? sanitizeMessageText(rawContent) || null : null;
        const db = request.dbClient!;

        const access = await canPostInChannel(db, channelId, userId, !!isBot);
        if (!access.allowed) {
            return reply.status(403).send({ error: access.error });
        }
        // Nothing left after cleaning (only escape codes)
        if (!content && !attachmentIds?.length && !artifact) return reply.status(400).send({ error: 'empty_content' });
        // Before the insert: a request that fails later still commits what it wrote
        if (artifact) {
            const bad = await checkArtifact(db, channelId, artifact);
            if (bad) return reply.status(bad.status).send({ error: bad.error });
        }

        // A repeat of an earlier post (same author and client_key) returns that post.
        // Checked before rate limits and the loop guard, so a retry doesn't count twice.
        const keyTarget = { channelId, threadId: null, content };
        if (clientKey) {
            const earlier = await findClientKey(db, userId, clientKey, keyTarget);
            if (earlier.kind === 'replay') return reply.status(200).send(earlier.message);
            if (earlier.kind === 'conflict') return reply.status(409).send({ error: 'client_key_conflict' });
        }

        // A wake from someone who can't direct would post but wake no one: say so instead.
        // Checked before rate limits so a refused wake doesn't count against the bot.
        if (requireDirect && !await stampAuthority(db, channelId, userId, !!isBot)) {
            return reply.status(403).send(await cannotDirect(db, channelId, userId));
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

        const prepared = await prepareMessageAttachments(db, userId, channelId, attachmentIds);
        if (!prepared.ok) {
            // A concurrent keyed retry may have waited for the winner's file locks.
            if (clientKey) {
                const winner = await findClientKey(db, userId, clientKey, keyTarget);
                if (winner.kind === 'replay') return reply.status(200).send(winner.message);
                if (winner.kind === 'conflict') return reply.status(409).send({ error: 'client_key_conflict' });
            }
            return reply.status(400).send({ error: prepared.error });
        }
        const resolvedAttachments = prepared.attachments;
        const messageId = generateUlid();

        // Parse and resolve @mentions (shared helper). @everyone without MentionEveryone stays plain text.
        const mentionsEveryone = access.mentionEveryone && mentionsEveryoneIn(content);
        const protocol = parseProtocol(content);

        const couldDirect = await stampAuthority(db, channelId, userId, !!request.isBot);
        const insert = () => db.query(
            `INSERT INTO messages (id, channel_id, author_id, content, mentions_everyone, protocol, author_could_direct, client_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [messageId, channelId, userId, content, mentionsEveryone, protocol, couldDirect, clientKey ?? null]
        );
        if (clientKey) {
            // A concurrent post with the same key may have committed since the check above
            if (await insertWithClientKey(db, insert) === 'duplicate') {
                const winner = await findClientKey(db, userId, clientKey, keyTarget);
                if (winner.kind === 'replay') return reply.status(200).send(winner.message);
                return reply.status(409).send({ error: 'client_key_conflict' });
            }
        } else {
            await insert();
        }

        const { mentionedUsers } = await resolveMentions(db, messageId, channelId, serverId, userId, content, access.mentionEveryone);

        await bindMessageAttachments(db, messageId, resolvedAttachments);

        const artifactRef = artifact ? await attachArtifact(db, { channelId, messageId, authorId: userId, input: artifact }) : null;

        // Wake agents this post is addressed to, in the message's transaction. Placed after
        // every validation gate: a rejected post must not wake anyone.
        const termsNotices = await routeMessage(db, {
            channelId, messageId, threadId: null, authorId: userId, couldDirect, protocol,
            mentionedUserIds: mentionedUsers.map(u => u.id),
        });

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
            authorAuthority: couldDirect
                ? (await readAuthorities(db, channelId, [{ id: messageId, author_id: userId, author_bot: !!request.isBot, author_could_direct: true }])).get(messageId.trim()) ?? null
                : null,
            channelId: channelId.trim(),
            createdAt: new Date().toISOString(),
            mentions: mentionedUserIds,
            mentionsEveryone,
            attachments: resolvedAttachments,
            ...(artifactRef ? { artifact: artifactRef } : {}),
            ...(protocol ? { protocol } : {}),
        };

        // Stash for post-commit broadcast (emitted in onResponse after COMMIT)
        request.pendingEvents = request.pendingEvents || [];
        request.pendingEvents.push({
            room: `channel:${channelId.trim()}`,
            event: 'Message',
            data: message,
        });
        // Wakes the subscription rule refused (src/lib/provider-terms.ts), after the message itself
        for (const n of termsNotices) request.pendingEvents.push({ room: `channel:${n.channelId}`, event: 'Message', data: n.event });

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

        const access = await canViewChannel(db, channelId, userId, !!request.isBot);
        if (!access.allowed) {
            return reply.status(403).send({ error: 'Channel access denied' });
        }

        let limit = rawLimit ? parseInt(rawLimit, 10) : 50;
        if (isNaN(limit) || limit < 1) limit = 50;
        if (limit > 100) limit = 100;

        let query: string;
        let params: any[];

        if (before) {
            query = `SELECT m.id, m.content, m.author_id, m.channel_id, m.edited_at, m.deleted_at, m.created_at,
                            u.username AS author_username, u.bot AS author_bot, u.avatar_url AS author_avatar_url,
                            m.system_event, m.system_data, m.reply_count, m.last_reply_at, m.thread_closed_at, m.protocol, m.author_could_direct
                     FROM messages m
                     LEFT JOIN users u ON u.id = m.author_id
                     WHERE m.channel_id = $1 AND m.id < $2 AND m.thread_id IS NULL
                     ORDER BY m.id DESC
                     LIMIT $3`;
            params = [channelId, before, limit];
        } else {
            query = `SELECT m.id, m.content, m.author_id, m.channel_id, m.edited_at, m.deleted_at, m.created_at,
                            u.username AS author_username, u.bot AS author_bot, u.avatar_url AS author_avatar_url,
                            m.system_event, m.system_data, m.reply_count, m.last_reply_at, m.thread_closed_at, m.protocol, m.author_could_direct
                     FROM messages m
                     LEFT JOIN users u ON u.id = m.author_id
                     WHERE m.channel_id = $1 AND m.thread_id IS NULL
                     ORDER BY m.id DESC
                     LIMIT $2`;
            params = [channelId, limit];
        }

        const result = await db.query(query, params);

        const messageIds = result.rows.map((r: any) => r.id);

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
                    size: Number(row.size_bytes),
                    width: row.width,
                    height: row.height,
                    url: `/files/${row.id.trim()}`,
                    deletedAt: row.deleted_at,
                });
            }
            // Tags, tagging state and injection warnings, for files a server has tagged
            await addTaggingToAttachments(db, Object.values(attachmentsMap).flat());
        }

        const authorities = await readAuthorities(db, channelId, result.rows);
        const artifacts = await artifactsForMessages(db, messageIds);
        const messages = result.rows.map((row: any) => ({
            id: row.id.trim(),
            content: row.content,
            authorId: row.author_id ? row.author_id.trim() : null,
            authorUsername: row.author_username ?? null,
            authorBot: row.author_bot || false,
            authorAvatarUrl: row.author_avatar_url || null,
            authorAuthority: authorities.get(row.id.trim()) ?? null,
            channelId: row.channel_id.trim(),
            editedAt: row.edited_at,
            deletedAt: row.deleted_at,
            createdAt: row.created_at,
            attachments: attachmentsMap[row.id.trim()] || [],
            ...(artifacts.has(row.id.trim()) ? { artifact: artifacts.get(row.id.trim()) } : {}),
            ...(row.system_event ? { systemEvent: row.system_event } : {}),
            ...(row.system_data ? { systemData: row.system_data } : {}),
            ...(row.protocol && !row.deleted_at ? { protocol: row.protocol } : {}),
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
        const content = sanitizeMessageText((request.body as any).content);
        const db = request.dbClient!;

        // An edit says something new, so it needs SendMessages as a post does
        const access = await canPostInChannel(db, channelId, userId, !!request.isBot);
        if (!access.allowed) {
            return reply.status(403).send({ error: access.error });
        }
        // Nothing left after cleaning (only escape codes)
        if (!content) return reply.status(400).send({ error: 'empty_content' });

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

        // An edit is a new statement: authority is stamped again, so a revoked director
        // can't edit an old authorized message into a new instruction
        const couldDirect = await stampAuthority(db, channelId, userId, !!request.isBot);
        const result = await db.query(
            `UPDATE messages SET content = $1, edited_at = NOW(), protocol = $3, author_could_direct = $4
             WHERE id = $2
             RETURNING id, content, edited_at, protocol`,
            [content, msgId, parseProtocol(content), couldDirect]
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
                protocol: updated.protocol ?? null,
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

        const access = await canViewChannel(db, channelId, userId, !!request.isBot);
        if (!access.allowed) {
            return reply.status(403).send({ error: 'Channel access denied' });
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
            `UPDATE messages SET content = NULL, deleted_at = NOW(), protocol = NULL
             WHERE id = $1
             RETURNING id, deleted_at`,
            [msgId]
        );

        const deleted = result.rows[0];
        const threadId = msg.rows[0].thread_id?.trim() || undefined;
        // The artifact version this post carried goes with it
        await removeArtifactVersion(db, msgId);

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
