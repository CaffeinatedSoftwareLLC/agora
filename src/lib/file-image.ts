import type { Pool } from 'pg';
import { canViewChannel } from './channel-access';
import { decryptFile } from './encryption';
import type { ObjectStore } from './storage';

/**
 * An image shared in a channel, for an agent that wants to look at it (agora-mcp's
 * file_read turns it into MCP image content). The same files and the same access as
 * reading a file's text (file-read.ts): files attached to a live message, in a channel
 * the caller can see, checked before anything is decrypted. Paused bots are refused,
 * as they are for downloads.
 *
 * Large images are scaled down so the longest side is at most IMAGE_MAX_SIDE, and the
 * result is kept under IMAGE_MAX_BYTES (about 3.5 MB once base64-encoded). An image
 * already small enough is passed through untouched. Image content is untrusted data:
 * text drawn into a picture is no more an instruction than text in a file.
 */

export interface FileImageDeps {
    db: Pool;
    store: ObjectStore;
    encryptionKey: Buffer;
}

export interface FileImageInput {
    fileId: string;
    userId: string;
    isBot: boolean;
}

export interface FileImageResponse {
    id: string;
    name: string;
    /** The type of `data`, which may differ from the stored file's (a resized GIF becomes a PNG). */
    mime: string;
    originalMime: string;
    uploader: { id: string; username: string | null; displayName: string | null };
    width: number | null;
    height: number | null;
    originalWidth: number | null;
    originalHeight: number | null;
    /** True when the image was scaled down or re-encoded to fit the limits. */
    resized: boolean;
    /** Bytes of the decoded image in `data`. */
    bytes: number;
    /** The image, base64-encoded. */
    data: string;
}

export type FileImageOutcome =
    | { ok: true; body: FileImageResponse }
    | { ok: false; status: number; error: string };

export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const IMAGE_MAX_SIDE = 1568;
/** 3.5 MB of base64 is this many bytes of image. */
export const IMAGE_MAX_BYTES = Math.floor((3.5 * 1024 * 1024 * 3) / 4);
/** Refuse to decode a stored file bigger than this. */
export const IMAGE_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** Refuse to decode images with more pixels than this (decompression bombs): checked from the header, before decoding. */
export const IMAGE_MAX_INPUT_PIXELS = 40_000_000;
const MIN_SIDE = 256;

export async function readFileImage(deps: FileImageDeps, input: FileImageInput): Promise<FileImageOutcome> {
    const { db } = deps;
    const notFound: FileImageOutcome = { ok: false, status: 404, error: 'File not found' };

    const res = await db.query(
        `SELECT f.id, f.channel_id, f.filename, f.mime_type, f.content_type, f.storage_key, f.encryption_iv, f.encryption_tag,
                f.uploader_id, u.username, u.display_name
         FROM files f
         JOIN messages m ON m.id = f.message_id AND m.deleted_at IS NULL
         LEFT JOIN users u ON u.id = f.uploader_id
         WHERE f.id = $1 AND f.deleted_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > NOW())`,
        [input.fileId]
    );
    const file = res.rows[0];
    if (!file) return notFound;

    // Access first: a caller who cannot see the channel learns nothing about the file
    const access = await canViewChannel(db, file.channel_id.trim(), input.userId, input.isBot);
    if (!access.allowed) return notFound;
    if (input.isBot && await isBotPaused(db, input.userId)) return { ok: false, status: 403, error: 'bot_paused' };

    const originalMime = (file.mime_type || file.content_type || '').trim();
    if (!IMAGE_MIMES.has(originalMime)) {
        return { ok: false, status: 415, error: `Only PNG, JPEG, GIF and WebP images can be viewed, not ${originalMime || 'this type of file'}` };
    }

    const blob = file.storage_key ? await deps.store.get(file.storage_key.trim()) : null;
    if (!blob) return notFound;
    // Size limits come before decrypting or decoding anything
    if (blob.length > IMAGE_MAX_SOURCE_BYTES) return { ok: false, status: 413, error: 'The image file is too large to view' };
    let plain: Buffer;
    try {
        plain = decryptFile(blob, deps.encryptionKey, file.encryption_iv, file.encryption_tag);
    } catch {
        return { ok: false, status: 500, error: 'The stored file could not be decrypted' };
    }

    const fitted = await fitImage(plain, originalMime);
    if (!fitted.ok) return fitted;

    return {
        ok: true,
        body: {
            id: file.id.trim(),
            name: file.filename,
            mime: fitted.mime,
            originalMime,
            uploader: { id: file.uploader_id.trim(), username: file.username ?? null, displayName: file.display_name ?? null },
            width: fitted.width,
            height: fitted.height,
            originalWidth: fitted.originalWidth,
            originalHeight: fitted.originalHeight,
            resized: fitted.resized,
            bytes: fitted.buffer.length,
            data: fitted.buffer.toString('base64'),
        },
    };
}

export async function isBotPaused(db: Pick<Pool, 'query'>, botId: string): Promise<boolean> {
    const r = await db.query('SELECT bot_paused_at FROM users WHERE id = $1', [botId]);
    return !!r.rows[0]?.bot_paused_at;
}

type Fitted =
    | { ok: true; buffer: Buffer; mime: string; width: number | null; height: number | null; originalWidth: number | null; originalHeight: number | null; resized: boolean }
    | { ok: false; status: number; error: string };

/**
 * Scale an image down to IMAGE_MAX_SIDE on its longest side and under maxBytes,
 * keeping its format where that can be done (a GIF becomes a PNG of its first frame).
 * If it still does not fit, it is re-encoded as JPEG at falling quality, then made smaller.
 */
export async function fitImage(input: Buffer, mime: string, opts: { maxSide?: number; maxBytes?: number; maxPixels?: number } = {}): Promise<Fitted> {
    const maxSide = opts.maxSide ?? IMAGE_MAX_SIDE;
    const maxBytes = opts.maxBytes ?? IMAGE_MAX_BYTES;
    const maxPixels = opts.maxPixels ?? IMAGE_MAX_INPUT_PIXELS;
    if (input.length > IMAGE_MAX_SOURCE_BYTES) return { ok: false, status: 413, error: 'The image file is too large to view' };
    const sharp = (await import('sharp')).default;

    let meta;
    try {
        meta = await sharp(input, { limitInputPixels: false }).metadata();   // header only; the pixel cap is checked below
    } catch {
        return { ok: false, status: 422, error: 'The image could not be decoded' };
    }
    const w = meta.width ?? null, h = meta.height ?? null;
    // metadata() reads the header only; refuse huge images before any pixel is decoded
    if (!w || !h) return { ok: false, status: 422, error: 'The image could not be decoded' };
    if (w * h > maxPixels) return { ok: false, status: 413, error: `The image is too large to view (${w}x${h})` };
    // EXIF orientations 5-8 swap the sides once the image is rotated upright
    const swapped = (meta.orientation ?? 1) >= 5;
    const originalWidth = swapped ? h : w, originalHeight = swapped ? w : h;
    const longest = Math.max(w ?? 0, h ?? 0);

    if (longest <= maxSide && input.length <= maxBytes) {
        return { ok: true, buffer: input, mime, width: originalWidth, height: originalHeight, originalWidth, originalHeight, resized: false };
    }

    const encode = async (side: number, format: 'keep' | 'jpeg', quality: number) => {
        let p = sharp(input, { limitInputPixels: maxPixels }).rotate()
            .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true });
        let outMime: string;
        if (format === 'jpeg' || mime === 'image/jpeg') {
            p = p.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true });
            outMime = 'image/jpeg';
        } else if (mime === 'image/webp') {
            p = p.webp({ quality });
            outMime = 'image/webp';
        } else {
            p = p.png({ compressionLevel: 9 });
            outMime = 'image/png';
        }
        const { data, info } = await p.toBuffer({ resolveWithObject: true });
        return { data, info, outMime };
    };

    try {
        let side = Math.min(maxSide, longest || maxSide);
        let out = await encode(side, 'keep', 85);
        for (const quality of [80, 70, 60]) {
            if (out.data.length <= maxBytes) break;
            out = await encode(side, 'jpeg', quality);
        }
        while (out.data.length > maxBytes && side > MIN_SIDE) {
            side = Math.max(MIN_SIDE, Math.floor(side * 0.75));
            out = await encode(side, 'jpeg', 60);
        }
        if (out.data.length > maxBytes) return { ok: false, status: 413, error: 'The image is too large to view, even scaled down' };
        return { ok: true, buffer: out.data, mime: out.outMime, width: out.info.width, height: out.info.height, originalWidth, originalHeight, resized: true };
    } catch {
        return { ok: false, status: 422, error: 'The image could not be decoded' };
    }
}
