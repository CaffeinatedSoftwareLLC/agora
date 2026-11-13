import { FastifyInstance } from 'fastify';
import { collabOutcome, notifyCollab, notifyMentions } from '../lib/notifications';
import { addTaggingToAttachments } from '../lib/file-tags';
import { generateUlid } from '../utils/ulid';
import { resolveMentions, mentionsEveryoneIn } from './shared';
import { canPostInChannel, canViewChannel } from '../lib/channel-access';
import { loadAndComputePermissions } from './bots';
import { Permissions } from '../permissions';
import { getRedis } from '../auth/token-blacklist';
import { parseProtocol, refuseSelfYield, threadWaiting } from '../lib/protocol';
import { ulidTime } from '../utils/ulid';
import { readAuthorities, stampAuthority } from '../lib/direct-agents';
import { findClientKey, insertWithClientKey } from '../lib/client-key';
import { routeMessage } from '../lib/agent-sessions';
import { sanitizeMessageText } from '../lib/sanitize-text';
import { hopLimitOf, loopGuardNotice } from '../lib/agent-budget-notice';
import { artifactBodySchema, artifactsForMessages, attachArtifact, checkArtifact } from '../lib/artifacts';
import { messageAttachmentsSchema, prepareMessageAttachments, bindMessageAttachments } from '../lib/message-attachments';

/** The thread list's `waiting` field: null, or who the thread waits on, for what, since when. */
function waitingJson(protocol: any, messageId: string | null, authorUsername: string | null) {
    const waiting = messageId ? threadWaiting(protocol, authorUsername ?? null) : null;
    return waiting && messageId ? { ...waiting, since: ulidTime(messageId), messageId: messageId.trim() } : null;
}

export async function threadRoutes(app: FastifyInstance) {


    // POST /channels/:id/messages/:msgId/replies → 201
    app.post('/channels/:id/messages/:msgId/replies', {
        schema: {
            body: {
                type: 'object',
                properties: {
                    content: { type: 'string', maxLength: 4000 },
                    client_key: { type: 'string', minLength: 1, maxLength: 100 },
                    attachments: messageAttachmentsSchema,
                    // A rendered document for the canvas pane (src/lib/artifacts.ts)
                    artifact: artifactBodySchema,
                },
                anyOf: [{ required: ['content'] }, { required: ['artifact'] }, { required: ['attachments'] }],
            },
        },
    }, async (request, reply) => {
        const { id: channelId, msgId } = request.params as any;
        const userId = request.userId;
        const isBot = request.isBot;
        const { client_key: clientKey, artifact, attachments: attachmentIds } = request.body as any;
        // Terminal escapes and private keys never reach the database (#88)
        const rawContent = (request.body as any).content;
        const content = rawContent ? sanitizeMessageText(rawContent) || null : null;
        const db = request.dbClient!;

        const access = await canPostInChannel(db, channelId, userId, !!isBot);
        if (!access.allowed) {
            return reply.status(403).send({ error: access.error });
        }
        // Nothing left after cleaning (only escape codes)
        if (!content && !artifact && !attachmentIds?.length) return reply.status(400).send({ error: 'empty_content' });

        // A YIELD to oneself leaves the peer waiting on a turn nobody takes (#327)
        const selfYield = await refuseSelfYield(db, userId, content);
        if (selfYield) return reply.status(400).send({ error: 'yield_to_self', message: selfYield });

        // Fetch parent message
        const parent = await db.query(
            'SELECT id, channel_id, thread_id, thread_closed_at, thread_successor_id, author_id FROM messages WHERE id = $1 AND channel_id = $2',
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
            // Where the work went, so the agent moves there instead of resuming it here (#132)
            const successorId = parent.rows[0].thread_successor_id?.trim() || null;
            return reply.status(409).send({
                error: 'Thread is closed',
                ...(successorId ? { successorId, message: `This thread is closed; the work continues in thread ${successorId}.` } : {}),
            });
        }

        // Before the insert: a request that fails later still commits what it wrote
        if (artifact) {
            const bad = await checkArtifact(db, channelId, artifact);
            if (bad) return reply.status(bad.status).send({ error: bad.error });
        }

        // A repeat of an earlier reply (same author and client_key) returns that reply.
        // Checked after the access and parent checks, before rate limits and the loop guard.
        const keyTarget = { channelId, threadId: msgId, content };
        if (clientKey) {
            const earlier = await findClientKey(db, userId, clientKey, keyTarget);
            if (earlier.kind === 'replay') return reply.status(200).send(earlier.message);
            if (earlier.kind === 'conflict') return reply.status(409).send({ error: 'client_key_conflict' });
        }

        // Fetch channel details for mention resolution, rate limiting, loop guard
        const channelRow = await db.query(
            'SELECT server_id, max_thread_bot_hops, bot_rate_limit FROM channels WHERE id = $1',
            [channelId]
        );
        const serverId = channelRow.rows[0]?.server_id?.trim() || null;
        // NULL: no loop guard, the default (docs/agent-limits.md)
        const maxThreadBotHops = hopLimitOf(channelRow.rows[0]?.max_thread_bot_hops);
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

        // Loop guard — per thread, independent of the channel guard
        const guardKey = `loopguard:${channelId.trim()}:${msgId.trim()}`;
        if (isBot && maxThreadBotHops !== null) {
            try {
                const redis = getRedis();
                const count = await redis.incr(guardKey);
                if (count === 1) await redis.expire(guardKey, 300);

                if (count > maxThreadBotHops) {
                    await redis.del(guardKey);
                    const sysId = generateUlid();
                    const sysContent = loopGuardNotice('thread', maxThreadBotHops);
                    // The notice's Continue / Raise limit / Turn off controls read the scope and limit
                    const guardData = { scope: 'thread', threadId: msgId.trim(), limit: maxThreadBotHops };
                    await db.query(
                        `INSERT INTO messages (id, channel_id, author_id, content, system_event, thread_id, system_data)
                         VALUES ($1, $2, NULL, $3, 'loop_guard', $4, $5)`,
                        [sysId, channelId, sysContent, msgId, JSON.stringify(guardData)]
                    );
                    const guardParent = await db.query(
                        `UPDATE messages SET reply_count = reply_count + 1, last_reply_at = NOW()
                         WHERE id = $1
                         RETURNING reply_count, last_reply_at`,
                        [msgId]
                    );
                    request.pendingEvents ??= [];
                    request.pendingEvents.push({
                        room: `channel:${channelId.trim()}`,
                        event: 'Message',
                        data: {
                            id: sysId.trim(),
                            content: sysContent,
                            authorId: null, authorUsername: null,
                            channelId: channelId.trim(),
                            createdAt: new Date().toISOString(),
                            threadId: msgId.trim(),
                            systemEvent: 'loop_guard',
                            systemData: guardData,
                        },
                    });
                    request.pendingEvents.push({
                        room: `channel:${channelId.trim()}`,
                        event: 'ThreadMetadataUpdate',
                        data: {
                            channelId: channelId.trim(),
                            messageId: msgId.trim(),
                            replyCount: guardParent.rows[0].reply_count,
                            lastReplyAt: guardParent.rows[0].last_reply_at,
                            threadClosedAt: null,
                        },
                    });
                    request.pendingEvents.push({
                        room: `channel:${channelId.trim()}`,
                        event: 'ChannelLoopGuard',
                        data: { channelId: channelId.trim(), threadId: msgId.trim(), paused: true },
                    });
                    return reply.status(429).send({ error: 'Loop guard triggered' });
                }
            } catch { /* Redis failure is non-fatal */ }
        } else if (!isBot) {
            try { await getRedis().del(guardKey); } catch { /* non-fatal */ }
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
        const replyId = generateUlid();

        // Parse mentionsEveryone for INSERT column. @everyone without MentionEveryone stays plain text.
        const mentionsEveryone = access.mentionEveryone && mentionsEveryoneIn(content);

        const protocol = parseProtocol(content);
        const couldDirect = await stampAuthority(db, channelId, userId, !!request.isBot);
        const insert = () => db.query(
            `INSERT INTO messages (id, channel_id, author_id, content, thread_id, mentions_everyone, protocol, author_could_direct, client_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [replyId, channelId, userId, content, msgId, mentionsEveryone, protocol, couldDirect, clientKey ?? null]
        );
        if (clientKey) {
            // A concurrent reply with the same key may have committed since the check above
            if (await insertWithClientKey(db, insert) === 'duplicate') {
                const winner = await findClientKey(db, userId, clientKey, keyTarget);
                if (winner.kind === 'replay') return reply.status(200).send(winner.message);
                return reply.status(409).send({ error: 'client_key_conflict' });
            }
        } else {
            await insert();
        }

        await bindMessageAttachments(db, replyId, resolvedAttachments);

        // Update parent metadata
        const parentUpdate = await db.query(
            `UPDATE messages SET reply_count = reply_count + 1, last_reply_at = NOW()
             WHERE id = $1
             RETURNING reply_count, last_reply_at`,
            [msgId]
        );

        // Resolve @mentions (shared helper)
        const { mentionedUsers } = await resolveMentions(db, replyId, channelId, serverId, userId, content, access.mentionEveryone);
        const artifactRef = artifact ? await attachArtifact(db, { channelId, messageId: replyId, authorId: userId, input: artifact }) : null;

        // Wake agents this reply is addressed to (same transaction as the reply)
        const termsNotices = await routeMessage(db, {
            channelId, messageId: replyId, threadId: msgId, authorId: userId, couldDirect, protocol,
            mentionedUserIds: mentionedUsers.map(u => u.id), authorTokenId: request.isBot ? request.botTokenId ?? null : null,
        });

        const userRow = await db.query(
            'SELECT username, bot, avatar_url FROM users WHERE id = $1',
            [userId]
        );

        const mentionedUserIds = mentionedUsers.map(u => u.id);
        await notifyMentions(db, { channelId, threadId: msgId, authorId: userId, userIds: mentionedUsers.filter(u => !u.bot).map(u => u.id) });
        // An agora-collab DONE or BLOCK tells the person who started the thread
        const outcome = collabOutcome(protocol);
        if (outcome) {
            await notifyCollab(db, { channelId, threadId: msgId, starterId: parent.rows[0].author_id?.trim() ?? null, authorId: userId, outcome });
        }

        // Fire bot mention events
        if (serverId) {
            const botMentions = mentionedUsers.filter(u => u.bot);
            if (botMentions.length > 0 && !isBot) {
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
                                messageId: replyId.trim(),
                                threadId: msgId.trim(),
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
            authorAuthority: couldDirect
                ? (await readAuthorities(db, channelId, [{ id: replyId, author_id: userId, author_bot: !!request.isBot, author_could_direct: true }])).get(replyId.trim()) ?? null
                : null,
            channelId: channelId.trim(),
            createdAt: new Date().toISOString(),
            threadId: msgId.trim(),
            mentions: mentionedUserIds,
            mentionsEveryone,
            attachments: resolvedAttachments,
            ...(artifactRef ? { artifact: artifactRef } : {}),
            ...(protocol ? { protocol } : {}),
        };

        request.pendingEvents = request.pendingEvents || [];
        request.pendingEvents.push({
            room: `channel:${channelId.trim()}`,
            event: 'Message',
            data: replyMessage,
        });
        // Wakes the subscription rule refused (src/lib/provider-terms.ts), after the message itself
        for (const n of termsNotices) request.pendingEvents.push({ room: `channel:${n.channelId}`, event: 'Message', data: n.event });
        request.pendingEvents.push({
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

        if (request.idempotencyKey) {
            request.idempotencyResponseBody = replyMessage;
        }

        return reply.status(201).send(replyMessage);
    });

    // GET /channels/:id/messages/:msgId/replies?limit&after&before&order → 200 [Message]
    app.get('/channels/:id/messages/:msgId/replies', {
        schema: { querystring: { type: 'object', additionalProperties: false, properties: {
            limit: { type: 'integer' },
            after: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
            before: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
            order: { type: 'string', enum: ['asc', 'desc'] },
        } } },
    }, async (request, reply) => {
        const { id: channelId, msgId } = request.params as any;
        const userId = request.userId;
        const { limit: rawLimit, after, before, order = 'asc' } = request.query as any;
        if ((order !== 'asc' && order !== 'desc') || (after && before)) {
            return reply.status(400).send({ error: 'Use order=asc|desc and only one of before or after' });
        }
        const db = request.dbClient!;

        const access = await canViewChannel(db, channelId, userId, !!request.isBot);
        if (!access.allowed) {
            return reply.status(403).send({ error: 'Channel access denied' });
        }

        // Verify parent exists in channel
        const parent = await db.query(
            'SELECT thread_closed_at, thread_close_reason, thread_successor_id FROM messages WHERE id = $1 AND channel_id = $2',
            [msgId, channelId]
        );
        if (parent.rows.length === 0) {
            return reply.status(404).send({ error: 'Message not found' });
        }
        // Open or closed, also for a thread with no replies yet (agora-mcp's Stop hook reads it;
        // the body stays the reply list every caller expects)
        reply.header('X-Agora-Thread-State', parent.rows[0].thread_closed_at ? 'closed' : 'open');
        // How a closed thread ended and where its work went (#132)
        if (parent.rows[0].thread_close_reason) reply.header('X-Agora-Thread-Close-Reason', parent.rows[0].thread_close_reason);
        if (parent.rows[0].thread_successor_id) reply.header('X-Agora-Thread-Successor', parent.rows[0].thread_successor_id.trim());

        let limit = rawLimit ? parseInt(rawLimit, 10) : 50;
        if (isNaN(limit) || limit < 1) limit = 50;
        if (limit > 100) limit = 100;

        const cursor = before || after;
        const params = cursor ? [msgId, channelId, cursor, limit] : [msgId, channelId, limit];
        // Only fixed SQL fragments enter the query; cursor values stay parameterized.
        const cursorClause = cursor ? `AND m.id ${before ? '<' : '>'} $3` : '';
        const query = `SELECT m.id, m.content, m.author_id, m.channel_id, m.edited_at, m.deleted_at, m.created_at,
                             m.thread_id, u.username AS author_username, u.bot AS author_bot, u.avatar_url AS author_avatar_url,
                             m.system_event, m.system_data, m.protocol, m.author_could_direct
                      FROM messages m
                      LEFT JOIN users u ON u.id = m.author_id
                      WHERE m.thread_id = $1 AND m.channel_id = $2 ${cursorClause}
                      ORDER BY m.id ${order === 'desc' ? 'DESC' : 'ASC'}
                      LIMIT $${params.length}`;

        const result = await db.query(query, params);

        const messageIds = result.rows.map((r: any) => r.id);

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
            threadId: row.thread_id?.trim() || null,
            attachments: attachmentsMap[row.id.trim()] || [],
            ...(artifacts.has(row.id.trim()) ? { artifact: artifacts.get(row.id.trim()) } : {}),
            ...(row.system_event ? { systemEvent: row.system_event } : {}),
            ...(row.system_data ? { systemData: row.system_data } : {}),
            ...(row.protocol && !row.deleted_at ? { protocol: row.protocol } : {}),
        }));

        return reply.status(200).send(messages);
    });

    // GET /channels/:id/threads?limit&before&state → 200 [ThreadSummary], X-Total-Count: every match
    // state=open (default): threads with replies that are not closed, most recently active first.
    // state=closed: closed threads, most recently closed first, with why and where the work went (#132).
    app.get('/channels/:id/threads', {
        schema: { querystring: { type: 'object', properties: {
            limit: { type: 'integer' },
            before: { type: 'string', minLength: 1, maxLength: 64 },
            state: { type: 'string', enum: ['open', 'closed'] },
        } } },
    }, async (request, reply) => {
        const { id: channelId } = request.params as any;
        const userId = request.userId;
        const { limit: rawLimit, before, state = 'open' } = request.query as any;
        const db = request.dbClient!;

        const access = await canViewChannel(db, channelId, userId, !!request.isBot);
        if (!access.allowed) {
            return reply.status(403).send({ error: 'Channel access denied' });
        }
        if (before !== undefined && Number.isNaN(Date.parse(before))) {
            return reply.status(400).send({ error: 'before must be a timestamp' });
        }

        let limit = rawLimit ? parseInt(rawLimit, 10) : 5;
        if (isNaN(limit) || limit < 1) limit = 5;
        if (limit > 10) limit = 10;

        const closed = state === 'closed';
        // Only fixed SQL fragments enter the query; values stay parameterized.
        const where = closed
            ? 'p.channel_id = $1 AND p.thread_id IS NULL AND p.deleted_at IS NULL AND p.thread_closed_at IS NOT NULL'
            : 'p.channel_id = $1 AND p.reply_count > 0 AND p.deleted_at IS NULL AND p.thread_closed_at IS NULL';
        const sortColumn = closed ? 'p.thread_closed_at' : 'p.last_reply_at';
        const params: any[] = [channelId, userId];
        if (before) params.push(before);
        params.push(limit);

        const query = `SELECT p.id, p.content, p.author_id, p.channel_id, p.reply_count, p.last_reply_at,
                            p.created_at, p.edited_at, p.deleted_at, p.author_could_direct, p.system_event,
                            p.thread_closed_at, p.thread_close_reason, p.thread_successor_id, cb.username AS closed_by_username,
                            u.username AS author_username, u.bot AS author_bot, u.avatar_url AS author_avatar_url,
                            previews.replies AS preview_replies, latest.protocol AS latest_protocol,
                            latest.id AS protocol_message_id, latest.author_username AS protocol_author_username,
                            starter.started_here
                     FROM messages p
                     LEFT JOIN users u ON u.id = p.author_id
                     LEFT JOIN users cb ON cb.id = p.thread_closed_by
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
                     LEFT JOIN LATERAL (
                         -- Newest protocol reply via idx_messages_thread_replies, else the parent's own.
                         SELECT c.id, c.protocol, cu.username AS author_username
                         FROM (
                             (SELECT r.id, r.protocol, r.author_id FROM messages r
                              WHERE r.thread_id = p.id AND r.protocol IS NOT NULL AND r.deleted_at IS NULL
                              ORDER BY r.id DESC LIMIT 1)
                             UNION ALL
                             SELECT p.id, p.protocol, p.author_id WHERE p.protocol IS NOT NULL
                         ) c LEFT JOIN users cu ON cu.id = c.author_id
                         ORDER BY c.id DESC LIMIT 1
                     ) latest ON true
                     LEFT JOIN LATERAL (
                         -- The caller posted the collaboration's START in this thread (#132), see collabStarter
                         SELECT (s.author_id = $2 AND s.edited_at IS NULL AND s.deleted_at IS NULL
                                 AND (su.bot OR s.author_could_direct)) AS started_here
                         FROM messages s JOIN users su ON su.id = s.author_id
                         WHERE s.thread_id = p.id AND s.protocol->>'state' = 'START'
                         ORDER BY s.id ASC LIMIT 1
                     ) starter ON true
                     WHERE ${where}${before ? ` AND ${sortColumn} < $3` : ''}
                     ORDER BY ${sortColumn} DESC
                     LIMIT $${params.length}`;

        const result = await db.query(query, params);
        // The count shows every match, not the page loaded so far (#14)
        const total = (await db.query(`SELECT COUNT(*)::int AS n FROM messages p WHERE ${where}`, [channelId])).rows[0].n;
        reply.header('X-Total-Count', String(total));
        // The newest request for the caller at the top of the channel; an open thread that went
        // quiet before it is probably not the caller's current work (#132)
        const newer = closed ? null : await newestRequest(db, channelId, userId);

        // canClose: the author, whoever STARTed a collaboration in it, or ManageMessages/Administrator
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

        const authorities = await readAuthorities(db, channelId, result.rows);
        const threads = result.rows.map((row: any) => ({
            id: row.id.trim(),
            content: row.content,
            authorId: row.author_id ? row.author_id.trim() : null,
            authorUsername: row.author_username ?? null,
            authorBot: row.author_bot || false,
            authorAvatarUrl: row.author_avatar_url || null,
            authorAuthority: authorities.get(row.id.trim()) ?? null,
            channelId: row.channel_id.trim(),
            createdAt: row.created_at,
            editedAt: row.edited_at,
            replyCount: row.reply_count,
            lastReplyAt: row.last_reply_at,
            // Tells a system line (task card, subtask) from a deleted account's post: both have no author
            ...(row.system_event ? { systemEvent: row.system_event } : {}),
            canClose: hasManagePerms || (row.author_id?.trim() === userId.trim()) || !!row.started_here,
            threadClosedAt: row.thread_closed_at ?? null,
            // Why it ended and where the work went (#132); null on open threads
            closeReason: row.thread_close_reason ?? null,
            successorId: row.thread_successor_id?.trim() || null,
            closedByUsername: row.closed_by_username ?? null,
            // A newer request for the caller at the top of the channel: check it before resuming this one
            newerRequestId: newer && newer.at > new Date(row.last_reply_at).getTime() ? newer.id : null,
            latestProtocol: row.latest_protocol ? {
                ...row.latest_protocol, messageId: row.protocol_message_id.trim(),
                authorUsername: row.protocol_author_username ?? null,
            } : null,
            // Who the thread waits on since its latest protocol message, and for what (#327)
            waiting: closed ? null : waitingJson(row.latest_protocol, row.protocol_message_id, row.protocol_author_username),
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

    // PATCH /channels/:id/messages/:msgId/thread { closed, reason?, successor? } → 200 { id, threadClosedAt, closeReason, successorId }
    // Who may close: the thread's author, an agent that posted the collaboration's START in it
    // (it may run a protocol under someone else's message, #132), or Manage Messages/Administrator.
    // `reason` says how it ended; `successor` names the thread the work moved to (reason defaults
    // to superseded). Closing with either posts a notice in the thread, so its history says so.
    app.patch('/channels/:id/messages/:msgId/thread', {
        schema: {
            body: {
                type: 'object',
                required: ['closed'],
                additionalProperties: false,
                properties: {
                    closed: { type: 'boolean' },
                    reason: { type: 'string', enum: ['done', 'blocked', 'cancelled', 'superseded'] },
                    successor: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
                },
            },
        },
    }, async (request, reply) => {
        const { id: channelId, msgId } = request.params as any;
        const userId = request.userId;
        const { closed, successor } = request.body as any;
        let { reason } = request.body as any;
        const db = request.dbClient!;

        const access = await canViewChannel(db, channelId, userId, !!request.isBot);
        if (!access.allowed) {
            return reply.status(403).send({ error: 'Channel access denied' });
        }
        if (!closed && (reason || successor)) {
            return reply.status(400).send({ error: 'reason and successor apply only when closing' });
        }
        if (successor && reason && reason !== 'superseded') {
            return reply.status(400).send({ error: 'A thread with a successor was superseded' });
        }
        if (successor) reason = 'superseded';

        // Fetch parent message (thread_id IS NULL ensures only parents). Locked until the request
        // commits: the starter's right to close depends on who closed it, so a closure committed
        // between this read and the UPDATE below must not be overwritten by a decision made on the
        // older row. A concurrent close waits here and then sees the newer closure. NO KEY UPDATE is
        // the lock the UPDATE takes anyway, so replies (whose FK takes KEY SHARE) are not held up.
        const parent = await db.query(
            `SELECT id, author_id, reply_count, last_reply_at, thread_closed_at, thread_close_reason, thread_successor_id, thread_closed_by
             FROM messages WHERE id = $1 AND channel_id = $2 AND thread_id IS NULL FOR NO KEY UPDATE`,
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
            // Server channel: author, ManageMessages or Administrator; or the collaboration's starter,
            // who may close it and say why, but not reopen it or rewrite someone else's closure
            const isAuthor = parentRow.author_id?.trim() === userId.trim();
            const perms = isAuthor ? 0n : await loadAndComputePermissions(db, userId, serverId);
            const hasManagePerms = !!(perms & Permissions.ManageMessages) || !!(perms & Permissions.Administrator);
            if (!isAuthor && !hasManagePerms) {
                const starter = await collabStarter(db, msgId);
                const closedBy = parentRow.thread_closed_by?.trim() ?? null;
                const allowed = starter === userId.trim() && closed && (!parentRow.thread_closed_at || closedBy === userId.trim());
                if (!allowed) {
                    return reply.status(403).send({
                        error: 'Not authorized to close this thread',
                        message: 'Only the thread\'s author, the agent that posted its START, or someone with Manage Messages can close it. '
                            + 'Only the author or Manage Messages can reopen it.',
                    });
                }
            }
        }
        // DM channels: any participant (membership already verified above)

        let successorChannelId: string | null = null;
        if (successor) {
            if (successor === msgId.trim()) return reply.status(400).send({ error: 'A thread cannot succeed itself' });
            // The successor is a top-level message in the same channel: everyone who sees this thread's
            // pointer can open it, and no other channel's IDs reach this channel's members
            const next = await db.query(
                'SELECT channel_id FROM messages WHERE id = $1 AND channel_id = $2 AND thread_id IS NULL AND deleted_at IS NULL',
                [successor, channelId]
            );
            if (!next.rows[0]) return reply.status(400).send({ error: 'successor_not_found', message: 'The successor must be a thread in this channel.' });
            successorChannelId = next.rows[0].channel_id.trim();
        }

        const state = (row: any) => ({
            id: row.id.trim(),
            threadClosedAt: row.thread_closed_at,
            closeReason: row.thread_close_reason ?? null,
            successorId: row.thread_successor_id?.trim() || null,
        });

        // Idempotent: already in the desired state with nothing new to record
        const alreadyClosed = parentRow.thread_closed_at !== null;
        // A reason or successor not recorded yet (a repeat of the same close changes nothing)
        const describes = closed && (
            (!!reason && reason !== parentRow.thread_close_reason)
            || (!!successor && successor !== parentRow.thread_successor_id?.trim()));
        if (closed === alreadyClosed && !describes) {
            return reply.status(200).send(state(parentRow));
        }

        // Close (or record why on an already closed thread), or reopen and forget why it closed
        const result = closed
            ? await db.query(
                `UPDATE messages SET thread_closed_at = COALESCE(thread_closed_at, NOW()), thread_closed_by = $2,
                     thread_close_reason = COALESCE($3, thread_close_reason),
                     -- A reason other than superseded means the work did not move: drop an old successor
                     thread_successor_id = CASE WHEN $3::text IS NOT NULL AND $3::text <> 'superseded' THEN NULL
                                                ELSE COALESCE($4, thread_successor_id) END
                 WHERE id = $1
                 RETURNING id, thread_closed_at, thread_close_reason, thread_successor_id`,
                [msgId, userId, reason ?? null, successor ?? null])
            : await db.query(
                `UPDATE messages SET thread_closed_at = NULL, thread_closed_by = NULL, thread_close_reason = NULL, thread_successor_id = NULL
                 WHERE id = $1
                 RETURNING id, thread_closed_at, thread_close_reason, thread_successor_id`,
                [msgId]);

        const updated = result.rows[0];
        let replyCount = parentRow.reply_count;
        let lastReplyAt = parentRow.last_reply_at;
        request.pendingEvents = request.pendingEvents || [];

        if (describes) {
            // The thread's own history says how it ended and where the work went
            const closer = (await db.query('SELECT username FROM users WHERE id = $1', [userId])).rows[0]?.username ?? 'someone';
            const content = closedNotice(closer, updated.thread_close_reason, updated.thread_successor_id?.trim() || null);
            const successorId = updated.thread_successor_id?.trim() || null;
            if (successorId && !successorChannelId) {
                successorChannelId = (await db.query('SELECT channel_id FROM messages WHERE id = $1', [successorId])).rows[0]?.channel_id?.trim() ?? null;
            }
            const systemData = { closedBy: userId.trim(), reason: updated.thread_close_reason, successorId, successorChannelId: successorId ? successorChannelId : null };
            const noticeId = generateUlid();
            const inserted = await db.query(
                `INSERT INTO messages (id, channel_id, author_id, content, system_event, system_data, thread_id)
                 VALUES ($1, $2, NULL, $3, 'thread_closed', $4, $5) RETURNING created_at`,
                [noticeId, channelId, content, JSON.stringify(systemData), msgId]
            );
            const counts = await db.query(
                `UPDATE messages SET reply_count = reply_count + 1, last_reply_at = NOW() WHERE id = $1
                 RETURNING reply_count, last_reply_at`,
                [msgId]
            );
            replyCount = counts.rows[0].reply_count;
            lastReplyAt = counts.rows[0].last_reply_at;
            request.pendingEvents.push({
                room: `channel:${channelId.trim()}`,
                event: 'Message',
                data: {
                    id: noticeId, content, authorId: null, authorUsername: null, authorBot: false,
                    channelId: channelId.trim(), threadId: msgId.trim(), createdAt: inserted.rows[0].created_at,
                    systemEvent: 'thread_closed', systemData, mentions: [], mentionsEveryone: false, attachments: [],
                },
            });
        }

        // Emit ThreadMetadataUpdate with threadClosedAt
        request.pendingEvents.push({
            room: `channel:${channelId.trim()}`,
            event: 'ThreadMetadataUpdate',
            data: {
                channelId: channelId.trim(),
                messageId: updated.id.trim(),
                replyCount,
                lastReplyAt,
                threadClosedAt: updated.thread_closed_at,
                closeReason: updated.thread_close_reason ?? null,
                successorId: updated.thread_successor_id?.trim() || null,
            },
        });

        return reply.status(200).send(state(updated));
    });
}

/**
 * Who posted the collaboration's START in this thread, when it may close the thread (#132): the
 * thread's first START reply, unedited and not deleted, by a bot or by someone who could direct
 * agents. A later or edited START, or an ordinary member's, gives no right to close it.
 */
async function collabStarter(db: any, threadId: string): Promise<string | null> {
    const row = (await db.query(
        `SELECT s.author_id, s.edited_at, s.deleted_at, s.author_could_direct, su.bot
         FROM messages s LEFT JOIN users su ON su.id = s.author_id
         WHERE s.thread_id = $1 AND s.protocol->>'state' = 'START'
         ORDER BY s.id ASC LIMIT 1`,
        [threadId]
    )).rows[0];
    if (!row?.author_id || row.edited_at || row.deleted_at || !(row.bot || row.author_could_direct)) return null;
    return row.author_id.trim();
}

/**
 * The newest top-level message in the channel addressed to the caller (an @mention, or a YIELD to
 * its username or a profile name it runs under), not written by the caller. Two indexed lookups
 * per list request instead of a scan per listed thread.
 */
async function newestRequest(db: any, channelId: string, userId: string): Promise<{ id: string; at: number } | null> {
    const names = (await db.query(
        `SELECT lower(u.username) AS name FROM users u WHERE u.id = $1
         UNION SELECT lower(p.name) FROM agent_sessions s JOIN agent_profiles p ON p.id = s.profile_id
         WHERE s.bot_id = $1 AND s.channel_id = $2`,
        [userId, channelId]
    )).rows.map((r: any) => r.name);
    const rows = (await db.query(
        `(SELECT m.id, m.created_at FROM message_mentions mm JOIN messages m ON m.id = mm.message_id
          WHERE mm.user_id = $2 AND m.channel_id = $1 AND m.thread_id IS NULL AND m.deleted_at IS NULL
            AND m.author_id IS DISTINCT FROM $2
          ORDER BY m.id DESC LIMIT 1)
         UNION ALL
         (SELECT m.id, m.created_at FROM messages m
          WHERE m.channel_id = $1 AND lower(m.protocol->>'yieldTo') = ANY($3::text[]) AND m.thread_id IS NULL
            AND m.deleted_at IS NULL AND m.author_id IS DISTINCT FROM $2
          ORDER BY m.id DESC LIMIT 1)`,
        [channelId, userId, names]
    )).rows;
    const newest = rows.sort((a: any, b: any) => String(b.id).localeCompare(String(a.id)))[0];
    return newest ? { id: newest.id.trim(), at: new Date(newest.created_at).getTime() } : null;
}

const CLOSE_WORDS: Record<string, string> = {
    done: 'as done', blocked: 'as blocked', cancelled: 'as cancelled', superseded: 'as superseded',
};

/** "Closed by codex as superseded. The work continues in thread 01H…; don't resume it here." */
export function closedNotice(closer: string, reason: string | null, successorId: string | null): string {
    const how = reason ? ` ${CLOSE_WORDS[reason]}` : '';
    const next = successorId ? ` The work continues in thread ${successorId}; don't resume it here.` : '';
    return `Closed by ${closer}${how}.${next}`;
}
