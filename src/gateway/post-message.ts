import type { Pool } from 'pg';
import { generateUlid } from '../utils/ulid';
import type { BridgedEvent } from '../lib/event-bridge';

/**
 * Post a message as the bot that submitted a run, into the run's thread (or channel),
 * optionally attaching already-stored files. Returns the Socket.IO events to publish.
 */

export class PostError extends Error {
    constructor(message: string, readonly status: number, readonly code: string) {
        super(message);
    }
}

export async function postBotMessage(db: Pool, input: {
    channelId: string;
    threadId: string | null;
    authorId: string;
    content: string;
    fileIds?: string[];
}): Promise<{ messageId: string; events: BridgedEvent[] }> {
    const channelId = input.channelId.trim();
    const threadId = input.threadId?.trim() || null;
    const authorId = input.authorId.trim();

    const access = await db.query('SELECT 1 FROM bot_channel_access WHERE bot_id = $1 AND channel_id = $2', [authorId, channelId]);
    if (access.rows.length === 0) throw new PostError('The submitting bot no longer has access to this channel', 403, 'no_channel_access');

    if (threadId) {
        const parent = await db.query(
            'SELECT thread_closed_at FROM messages WHERE id = $1 AND channel_id = $2 AND thread_id IS NULL',
            [threadId, channelId]
        );
        if (parent.rows.length === 0) throw new PostError('The run\'s thread no longer exists', 404, 'thread_missing');
        if (parent.rows[0].thread_closed_at) throw new PostError('The run\'s thread is closed', 409, 'thread_closed');
    }

    const messageId = generateUlid();
    const client = await db.connect();
    let parentMeta: { reply_count: number; last_reply_at: string } | undefined;
    let attachments: any[] = [];
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO messages (id, channel_id, author_id, content, thread_id) VALUES ($1, $2, $3, $4, $5)`,
            [messageId, channelId, authorId, input.content, threadId]
        );
        if (input.fileIds?.length) {
            const bound = await client.query(
                `UPDATE files SET message_id = $1 WHERE id = ANY($2) AND message_id IS NULL AND uploader_id = $3
                 RETURNING id, filename, mime_type, content_type, size_bytes, width, height`,
                [messageId, input.fileIds, authorId]
            );
            attachments = bound.rows.map((f: any) => ({
                id: f.id.trim(), name: f.filename, mime: f.mime_type || f.content_type,
                size: f.size_bytes, width: f.width, height: f.height, url: `/files/${f.id.trim()}`,
            }));
        }
        if (threadId) {
            const updated = await client.query(
                `UPDATE messages SET reply_count = reply_count + 1, last_reply_at = NOW() WHERE id = $1
                 RETURNING reply_count, last_reply_at`,
                [threadId]
            );
            parentMeta = updated.rows[0];
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    const author = (await db.query('SELECT username, bot, avatar_url FROM users WHERE id = $1', [authorId])).rows[0];
    const room = `channel:${channelId}`;
    const events: BridgedEvent[] = [{
        room,
        event: 'Message',
        data: {
            id: messageId,
            content: input.content,
            authorId,
            authorUsername: author?.username ?? null,
            authorBot: author?.bot ?? true,
            authorAvatarUrl: author?.avatar_url ?? null,
            channelId,
            createdAt: new Date().toISOString(),
            attachments,
            ...(threadId ? { threadId } : {}),
        },
    }];
    if (threadId && parentMeta) {
        events.push({
            room,
            event: 'ThreadMetadataUpdate',
            data: { channelId, messageId: threadId, replyCount: parentMeta.reply_count, lastReplyAt: parentMeta.last_reply_at, threadClosedAt: null },
        });
    }
    return { messageId, events };
}
