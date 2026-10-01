import path from 'path';
import type { Pool } from 'pg';
import { generateUlid } from '../utils/ulid';
import { storage, BUCKET_NAME } from './storage';
import { BLOB_LEAF } from './storage-maintenance';
import { encryptFile } from './encryption';
import { sanitizeFilename, validateFileType, FileValidationError, IMAGE_MIMES } from './file-validation';
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

const DEFAULT_ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'txt', 'md', 'csv', 'json', 'zip', 'mp3', 'mp4', 'mov'];

export async function getFileSetting(db: Queryable, key: string): Promise<any> {
    const res = await db.query('SELECT value FROM instance_settings WHERE key = $1', [key]);
    return res.rows[0]?.value;
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
        return { ok: false, status: 413, error: 'File exceeds maximum allowed size' };
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
