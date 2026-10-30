import path from 'path';

/**
 * Text formats have no magic bytes: a file with one of these extensions is stored under
 * this type once it passes a binary check. `extractText` can read every type here.
 */
export const TEXT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    ipynb: 'application/x-ipynb+json',
    html: 'text/html',
    htm: 'text/html',
    xml: 'application/xml',
    toml: 'application/toml',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    log: 'text/plain',
    // Source code
    py: 'text/x-python',
    r: 'text/x-r',
    sql: 'application/sql',
    js: 'text/javascript',
    mjs: 'text/javascript',
    ts: 'text/x-typescript',
    java: 'text/x-java',
    c: 'text/x-c',
    h: 'text/x-c',
    cpp: 'text/x-c++',
    hpp: 'text/x-c++',
    cs: 'text/x-csharp',
    go: 'text/x-go',
    rs: 'text/x-rust',
    rb: 'text/x-ruby',
    sh: 'text/x-shellscript',
    css: 'text/css',
    tex: 'text/x-tex',
};

export const PLAIN_TEXT_EXTENSIONS = Object.keys(TEXT_MIME_BY_EXTENSION);

/** Word, Excel and PowerPoint files. They are zips; the parts inside say which format. */
export const OOXML_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export const INLINE_SAFE_MIMES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'audio/mpeg', 'audio/ogg', 'audio/wav',
    'video/mp4', 'video/webm',
    'application/pdf',
]);

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

    let detected = await fileTypeFromBuffer(buffer.subarray(0, 4100));
    const ooxmlMime = OOXML_MIME_BY_EXTENSION[declaredExtension];
    // An Office file is a zip. file-type names the format only when [Content_Types].xml is
    // near the start; Google Docs exports put it last. Then the zip's own directory decides.
    if (ooxmlMime && detected?.mime === 'application/zip') {
        const kind = ooxmlKind(buffer);
        if (kind) detected = { mime: OOXML_MIME_BY_EXTENSION[kind], ext: kind } as typeof detected;
    }

    const textMime = TEXT_MIME_BY_EXTENSION[declaredExtension];
    // Plain text formats have no magic bytes. The one text signature file-type knows is an
    // XML declaration, which an .xml, .html or .txt file may well start with.
    if (textMime && (!detected || detected.mime === 'application/xml')) {
        // Verify content is actually text: check first 8KB for null bytes
        const sample = buffer.subarray(0, 8192);
        if (sample.includes(0x00)) {
            throw new FileValidationError(415, 'File appears to be binary, not text');
        }
        return { mime: textMime, ext: declaredExtension };
    }
    if (!detected) {
        throw new FileValidationError(415, 'Unable to determine file type');
    }

    // A .docx, .xlsx or .pptx must be that format, not another zip under its name
    if (ooxmlMime && detected.mime !== ooxmlMime) {
        throw new FileValidationError(415, 'File content does not match its extension', { detected: detected.mime, expected: ooxmlMime });
    }

    // Cross-check: detected MIME must match a type we allow
    const allowedMimes = extensionsToMimes(allowedExtensions);
    if (!allowedMimes.includes(detected.mime)) {
        throw new FileValidationError(415, 'File content does not match allowed types', { detected: detected.mime });
    }

    return { mime: detected.mime, ext: detected.ext };
}

const OOXML_MAIN_PART: Record<string, string> = { 'word/document.xml': 'docx', 'xl/workbook.xml': 'xlsx', 'ppt/presentation.xml': 'pptx' };

/**
 * Which Office format a zip is, from the entry names in its central directory (the
 * directory at the end of the file; nothing is unpacked): [Content_Types].xml plus the
 * format's main part. Null for any other zip, or one whose directory cannot be read.
 */
export function ooxmlKind(buf: Buffer): 'docx' | 'xlsx' | 'pptx' | null {
    let eocd = -1;
    for (let i = buf.length - 22, min = Math.max(0, buf.length - 65557); i >= min; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    let contentTypes = false;
    let kind: string | null = null;
    for (let n = 0; n < Math.min(count, 5000); n++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
        const nameLength = buf.readUInt16LE(p + 28);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
        if (name === '[Content_Types].xml') contentTypes = true;
        else kind ??= OOXML_MAIN_PART[name] ?? null;
        p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    return contentTypes ? (kind as 'docx' | 'xlsx' | 'pptx' | null) : null;
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
        ...OOXML_MIME_BY_EXTENSION,
    };
    return extensions.map(ext => map[ext]).filter(Boolean);
}
