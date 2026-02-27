import path from 'path';

export const PLAIN_TEXT_EXTENSIONS = ['txt', 'md', 'csv', 'json'];

export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export const INLINE_SAFE_MIMES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'audio/mpeg', 'audio/ogg', 'audio/wav',
    'video/mp4', 'video/webm',
    'application/pdf',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
};

export function sanitizeFilename(name: string): string {
    // 1. Extract basename (strip any path separators)
    let clean = name.replace(/^.*[\\\/]/, '');
    // 2. Remove control characters and null bytes
    clean = clean.replace(/[\x00-\x1f\x7f]/g, '');
    // 3. Remove characters unsafe in Content-Disposition headers
    clean = clean.replace(/[<>:"|?*]/g, '_');
    // 4. Collapse multiple dots/spaces
    clean = clean.replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').trim();
    // 5. Enforce max length (255 chars matches VARCHAR(255))
    if (clean.length > 255) {
        const ext = path.extname(clean);
        clean = clean.slice(0, 255 - ext.length) + ext;
    }
    // 6. Fallback for empty result
    return clean || 'unnamed';
}

export interface FileTypeResult {
    mime: string;
    ext: string;
}

/**
 * Validate file type using magic bytes (file-type) with plain text fallback.
 * file-type is ESM-only, so we use dynamic import.
 */
export async function validateFileType(
    buffer: Buffer,
    declaredExtension: string,
    allowedExtensions: string[]
): Promise<FileTypeResult> {
    // Check extension against whitelist first
    if (!allowedExtensions.includes(declaredExtension)) {
        throw new FileValidationError(415, 'File type not allowed', { allowed: allowedExtensions });
    }

    // Dynamic import for ESM-only file-type package
    const { fileTypeFromBuffer } = await import('file-type');

    const head = buffer.subarray(0, 4100);
    const detected = await fileTypeFromBuffer(head);

    if (!detected) {
        // Plain text formats have no magic bytes
        if (PLAIN_TEXT_EXTENSIONS.includes(declaredExtension)) {
            // Verify content is actually text: check first 8KB for null bytes
            const sample = buffer.subarray(0, 8192);
            if (sample.includes(0x00)) {
                throw new FileValidationError(415, 'File appears to be binary, not text');
            }
            return { mime: MIME_BY_EXTENSION[declaredExtension]!, ext: declaredExtension };
        }
        throw new FileValidationError(415, 'Unable to determine file type');
    }

    // Cross-check: detected MIME must match a type we allow
    const allowedMimes = extensionsToMimes(allowedExtensions);
    if (!allowedMimes.includes(detected.mime)) {
        throw new FileValidationError(415, 'File content does not match allowed types', { detected: detected.mime });
    }

    return { mime: detected.mime, ext: detected.ext };
}

export class FileValidationError extends Error {
    status: number;
    details?: Record<string, unknown>;

    constructor(status: number, message: string, details?: Record<string, unknown>) {
        super(message);
        this.name = 'FileValidationError';
        this.status = status;
        this.details = details;
    }
}

// Map extensions to their expected MIME types
function extensionsToMimes(extensions: string[]): string[] {
    const map: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        pdf: 'application/pdf',
        txt: 'text/plain',
        md: 'text/markdown',
        zip: 'application/zip',
        mp3: 'audio/mpeg',
        mp4: 'video/mp4',
        mov: 'video/quicktime',
        csv: 'text/csv',
        json: 'application/json',
    };
    return extensions.map(ext => map[ext]).filter(Boolean);
}
