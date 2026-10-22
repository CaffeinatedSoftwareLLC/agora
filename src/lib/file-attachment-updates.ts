import type { Pool } from 'pg';
import { addTaggingToAttachments } from './file-tags';

export interface FileAttachmentUpdate {
    channelId: string;
    messageId: string;
    threadId?: string;
    fileId: string;
    tags: string[];
    tagging?: string;
    partial: boolean;
    injectionWarning: boolean;
}

/** Read a committed file result, serialized with message attachment binding. */
export async function readFileAttachmentUpdate(db: Pool, fileId: string): Promise<FileAttachmentUpdate | null> {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        // Wait for any posting transaction before deciding whether the file is shared.
        // Never broadcast an uploader's still-unposted file to other channel members.
        const file = (await client.query(`SELECT id, channel_id, message_id FROM files
            WHERE id = $1 AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) FOR SHARE`, [fileId])).rows[0];
        if (!file?.message_id) { await client.query('COMMIT'); return null; }
        const message = (await client.query('SELECT thread_id FROM messages WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL', [file.message_id, file.channel_id])).rows[0];
        if (!message) { await client.query('COMMIT'); return null; }
        const attachment: { id: string; tags?: string[]; tagging?: string; partial?: boolean; injectionWarning?: boolean } = { id: fileId };
        await addTaggingToAttachments(client, [attachment]);
        await client.query('COMMIT');
        return { channelId: file.channel_id.trim(), messageId: file.message_id.trim(), fileId,
            ...(message.thread_id ? { threadId: message.thread_id.trim() } : {}), tags: attachment.tags ?? [],
            tagging: attachment.tagging, partial: !!attachment.partial, injectionWarning: !!attachment.injectionWarning };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { client.release(); }
}
