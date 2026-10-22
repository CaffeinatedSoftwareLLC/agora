import type { PoolClient } from 'pg';
import { addTaggingToAttachments } from './file-tags';

export const messageAttachmentsSchema = {
    type: 'array', items: { type: 'string', minLength: 26, maxLength: 26 }, maxItems: 10,
};

export interface MessageAttachment {
    id: string; name: string; mime: string; size: number;
    width: number | null; height: number | null; url: string;
    tags?: string[]; tagging?: string; partial?: boolean; injectionWarning?: boolean;
    trustedByOwner?: boolean; trustedBy?: string; trustedAt?: string;
}

/** Validate and lock before creating a message. Locks stay held until the request commits. */
export async function prepareMessageAttachments(db: PoolClient, userId: string, channelId: string, ids?: string[]): Promise<
    { ok: true; attachments: MessageAttachment[] } | { ok: false; error: string }
> {
    if (!ids?.length) return { ok: true, attachments: [] };
    const uniqueIds = [...new Set(ids)];
    if (ids.length !== uniqueIds.length) return { ok: false, error: 'Duplicate attachment IDs' };
    if (uniqueIds.length > 10) return { ok: false, error: 'Too many attachments (max 10)' };
    const files = await db.query(`
        SELECT id, uploader_id, channel_id, message_id, filename, mime_type, content_type, size_bytes, width, height, deleted_at
        FROM files WHERE id = ANY($1) FOR UPDATE
    `, [uniqueIds]);
    if (files.rows.length !== uniqueIds.length) return { ok: false, error: 'One or more attachment IDs are invalid or deleted' };
    for (const file of files.rows) {
        if (file.deleted_at) return { ok: false, error: 'One or more attachments are deleted' };
        if (file.uploader_id?.trim() !== userId.trim()) return { ok: false, error: 'Attachment does not belong to you' };
        if (file.channel_id?.trim() !== channelId.trim()) return { ok: false, error: 'Attachment channel mismatch' };
        if (file.message_id) return { ok: false, error: 'Attachment already bound to a message' };
    }
    const attachments = files.rows.map(f => ({
        id: f.id.trim(), name: f.filename, mime: f.mime_type || f.content_type,
        size: Number(f.size_bytes), width: f.width, height: f.height, url: `/files/${f.id.trim()}`,
    }));
    await addTaggingToAttachments(db, attachments);
    return { ok: true, attachments };
}

/** Bind only the files validated and locked by prepareMessageAttachments in this transaction. */
export async function bindMessageAttachments(db: PoolClient, messageId: string, attachments: MessageAttachment[]) {
    if (attachments.length) {
        await db.query('UPDATE files SET message_id = $1 WHERE id = ANY($2)', [messageId, attachments.map(a => a.id)]);
    }
}

/** A durable client-key replay must return the same attachment envelope as a new post. */
export async function replayMessageAttachments(db: PoolClient, messageId: string): Promise<MessageAttachment[]> {
    const files = await db.query(`SELECT id, filename, mime_type, content_type, size_bytes, width, height
        FROM files WHERE message_id = $1 AND deleted_at IS NULL ORDER BY id`, [messageId]);
    const attachments = files.rows.map(f => ({ id: f.id.trim(), name: f.filename, mime: f.mime_type || f.content_type,
        size: Number(f.size_bytes), width: f.width, height: f.height, url: `/files/${f.id.trim()}` }));
    await addTaggingToAttachments(db, attachments);
    return attachments;
}
