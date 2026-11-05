import path from 'path';
import type { Pool } from 'pg';
import { generateUlid } from '../utils/ulid';
import { storage, BUCKET_NAME } from './storage';
import { BLOB_LEAF } from './storage-maintenance';
import { encryptFile } from './encryption';
import { sanitizeFilename, validateFileType, FileValidationError, IMAGE_MIMES, AVIF_MIME } from './file-validation';
import { enqueueFileTagging } from './file-tagging-queue';
import { config } from '../config';

/**
 * Validate, process, encrypt, and store a file (metadata in Postgres, blob in the file store).
 * Shared by user uploads (POST /files/upload) and sandbox artifacts (cap-gateway),
 * so both go through the same limits: size, extension allowlist, magic bytes, EXIF
 * stripping, storage quota. Callers do their own authorization first.
 */

interface Queryable {
    query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface StoredFile {
    id: string;
    name: string;
    mime: string;
    size: number;
    width: number | null;
    height: number | null;
    url: string;
}

export type StoreResult = { ok: true; file: StoredFile } | { ok: false; status: number; error: string; details?: unknown };

/** The refusal for a file over files.max_size_bytes. Upload routes that stop reading early give the same one. */
export const FILE_TOO_LARGE = { status: 413, error: 'File exceeds maximum allowed size' } as const;

/**
 * The most an upload route reads when files.max_size_bytes has no usable value: the largest
 * value PATCH /admin/settings/files accepts for it. Not a cap of its own; storeFile decides.
 */
export const MAX_FILE_SIZE_SETTING = 104857600;

/**
 * Reads a multipart file part in full, or returns null when the parser cut it off at the size limit.
 *
 * @fastify/multipart's toBuffer() only looks at `file.truncated` between chunks, and busboy sets it
 * as the stream ends, so an over-limit upload can come back cut to exactly `fileSize` bytes with no
 * error. A 54 MB video was stored as its first 25 MB this way (2026-10-23). Callers answer null with
 * FILE_TOO_LARGE.
 */
export async function readUploadPart(part: { toBuffer(): Promise<Buffer>; file: { truncated?: boolean } }): Promise<Buffer | null> {
    const buffer = await part.toBuffer();
    return part.file.truncated ? null : buffer;
}

/**
 * How many bytes an upload route should let multipart read: the admin setting (#157), plus one.
 * The extra byte means a file the parser cuts off at this limit is always over the setting, so
 * storeFile's own size check refuses it even if `truncated` is missed (#206).
 */
export async function uploadByteLimit(db: Queryable): Promise<number> {
    return readLimitFor(Number(await getFileSetting(db, 'files.max_size_bytes')));
}

/** The multipart read limit for a files.max_size_bytes value: one byte over it (see uploadByteLimit). */
export function readLimitFor(maxSizeBytes: number): number {
    return (Number.isSafeInteger(maxSizeBytes) && maxSizeBytes > 0 ? maxSizeBytes : MAX_FILE_SIZE_SETTING) + 1;
}

const DEFAULT_ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'txt', 'md', 'csv', 'json', 'zip', 'mp3', 'mp4', 'mov'];

export async function getFileSetting(db: Queryable, key: string): Promise<any> {
    const res = await db.query('SELECT value FROM instance_settings WHERE key = $1', [key]);
    return res.rows[0]?.value;
}

/**
 * Reads an AVIF's size and, when EXIF stripping is on and the file carries EXIF, XMP or IPTC
 * metadata (a phone photo's location, say), re-encodes it without. One without metadata is kept
 * byte for byte: AV1 encoding is slow. An animated AVIF is kept as is, like an animated GIF.
 * Throws when sharp cannot read the file, so a fake AVIF that only has the right ftyp box is refused.
 */
export async function prepareAvif(buffer: Buffer, stripMetadata: boolean): Promise<{ buffer: Buffer; width?: number; height?: number }> {
    const sharp = (await import('sharp')).default;
    const image = sharp(buffer);
    const metadata = await image.metadata();
    if (metadata.format !== 'heif') throw new Error('not an AVIF image');
    const hasMetadata = !!(metadata.exif || metadata.xmp || metadata.iptc);
    const out = stripMetadata && hasMetadata && (metadata.pages ?? 1) === 1 ? await image.avif({ quality: 90 }).toBuffer() : buffer;
    return { buffer: out, width: metadata.width, height: metadata.height };
}

export async function storeFile(
    /** Reads instance settings (a request client or the pool). */
    db: Queryable,
    /** Used for the quota transaction and compensating cleanup. */
    pool: Pool,
    input: { buffer: Buffer; filename: string; uploaderId: string; channelId: string },
): Promise<StoreResult> {
    const { buffer, uploaderId, channelId } = input;
    const sanitizedName = sanitizeFilename(input.filename);
    const ext = path.extname(sanitizedName).slice(1).toLowerCase();

    const maxSizeBytes = await getFileSetting(db, 'files.max_size_bytes');
    if (maxSizeBytes && buffer.length > maxSizeBytes) {
        return { ok: false, ...FILE_TOO_LARGE };
    }

    const allowedExtensions: string[] = (await getFileSetting(db, 'files.allowed_extensions')) ?? DEFAULT_ALLOWED_EXTENSIONS;

    let detectedMime: string;
    try {
        detectedMime = (await validateFileType(buffer, ext, allowedExtensions)).mime;
    } catch (err) {
        if (err instanceof FileValidationError) return { ok: false, status: err.status, error: err.message, details: err.details };
        throw err;
    }

    // EXIF strip for images
    let processedBuffer = buffer;
    let width: number | undefined;
    let height: number | undefined;
    const exifStripEnabled = await getFileSetting(db, 'files.exif_strip');
    if (IMAGE_MIMES.includes(detectedMime)) {
        // A file with an image's magic bytes but a broken body is a bad upload, not a server error
        try {
            const sharp = (await import('sharp')).default;
            const image = sharp(buffer);
            const metadata = await image.metadata();
            width = metadata.width;
            height = metadata.height;

            if (exifStripEnabled !== false) {
                if (detectedMime === 'image/jpeg') {
                    processedBuffer = await image.jpeg({ quality: 95 }).toBuffer();
                } else if (detectedMime === 'image/png') {
                    processedBuffer = await image.png().toBuffer();
                } else if (detectedMime === 'image/webp') {
                    processedBuffer = await image.webp({ quality: 95 }).toBuffer();
                } else if (detectedMime === 'image/gif') {
                    const pages = metadata.pages ?? 1;
                    processedBuffer = pages > 1 ? buffer : await image.gif().toBuffer(); // keep animated GIFs as-is
                }
            }
        } catch {
            return { ok: false, status: 415, error: 'Image could not be read; it may be corrupt' };
        }
    } else if (detectedMime === AVIF_MIME) {
        try {
            ({ buffer: processedBuffer, width, height } = await prepareAvif(buffer, exifStripEnabled !== false));
        } catch {
            return { ok: false, status: 415, error: 'Image could not be read; it may be corrupt' };
        }
    }

    const { encrypted, iv, authTag } = encryptFile(processedBuffer, config.encryptionKey);
    const fileId = generateUlid();
    // No file name in the key: the name lives only in the database row
    const storageKey = `${channelId}/${fileId}/${BLOB_LEAF}`;
    const retentionDays = await getFileSetting(db, 'files.retention_days');
    const expiresAt = retentionDays ? new Date(Date.now() + retentionDays * 86400000) : null;

    // Quota check + metadata insert, serialized instance-wide
    const quotaClient = await pool.connect();
    try {
        await quotaClient.query('BEGIN');
        await quotaClient.query("SELECT pg_advisory_xact_lock(hashtext('storage_quota'))");

        const quota = await getFileSetting(db, 'files.storage_quota_bytes');
        if (quota) {
            const totalRes = await quotaClient.query('SELECT COALESCE(SUM(size_bytes), 0) as total FROM files WHERE deleted_at IS NULL');
            if ((Number(totalRes.rows[0].total) + processedBuffer.length) > quota) {
                await quotaClient.query('ROLLBACK');
                return { ok: false, status: 507, error: 'Instance storage quota exceeded' };
            }
        }

        await quotaClient.query(
            `INSERT INTO files (id, uploader_id, channel_id, filename, content_type, mime_type, size_bytes, bucket, path, storage_key, encryption_iv, encryption_tag, width, height, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [fileId, uploaderId, channelId, sanitizedName, detectedMime, detectedMime, processedBuffer.length, BUCKET_NAME, storageKey, storageKey, iv, authTag, width ?? null, height ?? null, expiresAt]
        );
        await quotaClient.query('COMMIT');
    } catch (err) {
        await quotaClient.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        quotaClient.release();
    }

    try {
        await storage.put(storageKey, encrypted);
    } catch {
        // Compensating cleanup: the blob never landed, so drop the metadata row
        await pool.query('DELETE FROM files WHERE id = $1', [fileId]);
        return { ok: false, status: 502, error: 'Failed to store file' };
    }

    // Queue the file for tagging when its server has that switched on. Only now, with
    // the blob in place; it never fails or delays the upload (the sweep catches misses).
    await enqueueFileTagging(pool, fileId, channelId);

    return {
        ok: true,
        file: {
            id: fileId,
            name: sanitizedName,
            mime: detectedMime,
            size: processedBuffer.length,
            width: width ?? null,
            height: height ?? null,
            url: `/files/${fileId}`,
        },
    };
}
