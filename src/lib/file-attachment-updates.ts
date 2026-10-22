import type { Pool, PoolClient } from 'pg';
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
    trustedByOwner: boolean;
    trustedBy: string | null;
    trustedAt: string | null;
}

/** Read a committed file result, serialized with message attachment binding. */
export async function readFileAttachmentUpdate(db: Pool, fileId: string): Promise<FileAttachmentUpdate | null> {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const update = await fileAttachmentUpdateInTransaction(client, fileId);
        await client.query('COMMIT');
        return update;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { client.release(); }
}

/** Request handlers queue this snapshot in pendingEvents, then commit before delivery. */
export async function fileAttachmentUpdateInTransaction(client: PoolClient, fileId: string): Promise<FileAttachmentUpdate | null> {
    // Wait for any posting transaction before deciding whether the file is shared.
    // Never broadcast an uploader's still-unposted file to other channel members.
    const file = (await client.query(`SELECT id, channel_id, message_id FROM files
        WHERE id = $1 AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) FOR SHARE`, [fileId])).rows[0];
    if (!file?.message_id) return null;
    const message = (await client.query('SELECT thread_id FROM messages WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL', [file.message_id, file.channel_id])).rows[0];
    if (!message) return null;
    const attachment: { id: string; tags?: string[]; tagging?: string; partial?: boolean; injectionWarning?: boolean;
        trustedByOwner?: boolean; trustedBy?: string; trustedAt?: string } = { id: fileId };
    await addTaggingToAttachments(client, [attachment]);
    return { channelId: file.channel_id.trim(), messageId: file.message_id.trim(), fileId,
        ...(message.thread_id ? { threadId: message.thread_id.trim() } : {}), tags: attachment.tags ?? [],
        tagging: attachment.tagging, partial: !!attachment.partial, injectionWarning: !!attachment.injectionWarning,
        trustedByOwner: !!attachment.trustedByOwner, trustedBy: attachment.trustedBy ?? null, trustedAt: attachment.trustedAt ?? null };
}
