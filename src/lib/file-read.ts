import type { Pool } from 'pg';
import { canViewChannel } from './channel-access';
import { decryptFile } from './encryption';
import type { ObjectStore } from './storage';
import { extractText, isExtractable } from './text-extract';

/**
 * The text of a shared file, for an agent (or a person) that found it with file
 * search. Text files and PDFs only; the same extraction the tagger uses.
 *
 * Access is the same as for seeing the file in its channel, checked before anything
 * is decrypted. The text is returned in bounded pages, and comes with what Agora
 * knows about it: whether it was cut short, and whether it looked like it tries to
 * give instructions to an AI. File text is untrusted data whatever that flag says.
 */

export interface FileReadDeps {
    db: Pool;
    store: ObjectStore;
    encryptionKey: Buffer;
}

export interface FileReadInput {
    fileId: string;
    userId: string;
    isBot: boolean;
    /** Characters to skip, for reading a long file in pages. */
    offset?: number;
    /** Characters to return (default 20,000, at most 50,000). */
    limit?: number;
    /** When set (sandboxed runs), the file must be in this channel. */
    channelId?: string;
}

export interface FileReadResponse {
    id: string;
    name: string;
    mime: string;
    text: string;
    offset: number;
    /** Characters of readable text in the file, as far as it was read. */
    totalChars: number;
    /** There is more text after this page: ask again with `offset` = `offset + text.length`. */
    hasMore: boolean;
    /** The file was longer than the reading limits; `totalChars` is not the whole file. */
    truncated: boolean;
    /** A decision model judged that the text tries to give instructions to an AI reader. */
    injectionWarning: boolean;
    /** False when no such check has been made (tagging off, or not done yet). */
    injectionChecked: boolean;
}

export type FileReadOutcome =
    | { ok: true; body: FileReadResponse }
    | { ok: false; status: number; error: string };

export const READ_DEFAULT_CHARS = 20_000;
export const READ_MAX_CHARS = 50_000;

export async function readFileText(deps: FileReadDeps, input: FileReadInput): Promise<FileReadOutcome> {
    const { db } = deps;
    const notFound: FileReadOutcome = { ok: false, status: 404, error: 'File not found' };

    // Only files attached to a message that still exists: the same set file search lists
    const res = await db.query(
        `SELECT f.id, f.channel_id, f.filename, f.mime_type, f.content_type, f.storage_key, f.encryption_iv, f.encryption_tag,
                j.injection_probability, COALESCE(s.screening_flag_threshold, 0.7) AS flag_threshold
         FROM files f
         JOIN messages m ON m.id = f.message_id AND m.deleted_at IS NULL
         JOIN channels c ON c.id = f.channel_id
         LEFT JOIN file_tag_jobs j ON j.file_id = f.id
         LEFT JOIN ai_decision_settings s ON s.server_id = c.server_id
         WHERE f.id = $1 AND f.deleted_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > NOW())`,
        [input.fileId]
    );
    const file = res.rows[0];
    if (!file) return notFound;
    const channelId = file.channel_id.trim();

    // Access first. A caller who cannot see the channel learns nothing about the file, not even that it exists
    if (input.channelId && input.channelId.trim() !== channelId) return notFound;
    const access = await canViewChannel(db, channelId, input.userId, input.isBot);
    if (!access.allowed) return notFound;

    const mime = (file.mime_type || file.content_type || '').trim();
    if (!isExtractable(mime)) return { ok: false, status: 415, error: `Text cannot be read from ${mime || 'this type of'} files` };

    const blob = file.storage_key ? await deps.store.get(file.storage_key.trim()) : null;
    if (!blob) return notFound;
    let plain: Buffer;
    try {
        plain = decryptFile(blob, deps.encryptionKey, file.encryption_iv, file.encryption_tag);
    } catch {
        return { ok: false, status: 500, error: 'The stored file could not be decrypted' };
    }

    const extracted = await extractText(plain, mime);
    if (!extracted.ok) {
        const status = extracted.reason === 'too_large' ? 413 : extracted.reason === 'failed' ? 422 : 415;
        return { ok: false, status, error: extracted.detail };
    }

    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.max(1, Math.min(READ_MAX_CHARS, input.limit ?? READ_DEFAULT_CHARS));
    const text = extracted.text.slice(offset, offset + limit);
    const checked = file.injection_probability !== null && file.injection_probability !== undefined;

    return {
        ok: true,
        body: {
            id: file.id.trim(),
            name: file.filename,
            mime,
            text,
            offset,
            totalChars: extracted.text.length,
            hasMore: offset + text.length < extracted.text.length,
            truncated: extracted.truncated,
            injectionWarning: checked && Number(file.injection_probability) >= Number(file.flag_threshold),
            injectionChecked: checked,
        },
    };
}
