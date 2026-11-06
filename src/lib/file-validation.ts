import path from 'path';
import { openCompoundFile } from './cfb';

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

export const AVIF_MIME = 'image/avif';

/**
 * Opens a compound file once and reads the first bytes of the named streams under its root
 * (null for one that is missing or not a stream). Null when the file is not a readable compound file.
 */
function cfbStreams<K extends string>(buf: Buffer, wanted: Record<K, number>): Record<K, Buffer | null> | null {
    const cfb = openCompoundFile(buf);
    if (!cfb) return null;
    const out = {} as Record<K, Buffer | null>;
    for (const name of Object.keys(wanted) as K[]) {
        const entry = cfb.root.get(name.toUpperCase());
        out[name] = entry && entry.type === 2 ? cfb.head(entry, wanted[name]) : null;
    }
    return out;
}

/** An Excel 5-2003 workbook: a Workbook (BIFF8) or Book (BIFF5) stream that opens with a BOF record. */
function isXls(buf: Buffer): boolean {
    const s = cfbStreams(buf, { Workbook: 4, Book: 4 });
    const head = s?.Workbook ?? s?.Book;
    return !!head && head.length === 4 && head.readUInt16LE(0) === 0x0809;
}

/** A Word 6-2003 document: a WordDocument stream that opens with the FIB's wIdent. */
function isDoc(buf: Buffer): boolean {
    const head = cfbStreams(buf, { WordDocument: 2 })?.WordDocument;
    return !!head && head.length === 2 && [0xa5ec, 0xa5dc].includes(head.readUInt16LE(0));
}

/** A PowerPoint 97-2003 deck: a Current User stream holding a CurrentUserAtom, and a PowerPoint Document stream with at least one record header. */
function isPpt(buf: Buffer): boolean {
    const s = cfbStreams(buf, { 'Current User': 4, 'PowerPoint Document': 8 });
    const user = s?.['Current User'];
    return !!user && user.length === 4 && user.readUInt16LE(2) === 0x0ff6 && s?.['PowerPoint Document']?.length === 8;
}

/** A Microsoft Project plan: its CompObj stream names the format, MSProject.MPP8 to MSProject.MPP14 (MPXJ reads it the same way). */
function isMpp(buf: Buffer): boolean {
    const compObj = cfbStreams(buf, { '\u0001CompObj': 4096 })?.['\u0001CompObj'];
    return !!compObj && /MSProject\.MPP\d+\0/.test(compObj.toString('latin1'));
}

/** An Access 2007+ database: "Standard ACE DB" in its first page, and a format version from 2 (Access 2007) up. */
function isAccdb(buf: Buffer): boolean {
    if (buf.length < 4096 || buf.readUInt32LE(0) !== 0x100) return false;
    const version = buf.readUInt32LE(0x14);
    return buf.toString('latin1', 4, 20) === 'Standard ACE DB\0' && version >= 2 && version <= 0xff;
}

/**
 * A JMP data table: ff ff 00 00, then format version words (JMPReader.jl reads 7 and 4 from
 * current JMP). Any small version is taken, so an older or newer JMP table still uploads.
 */
function isJmp(buf: Buffer): boolean {
    if (buf.length < 64 || buf.readUInt32LE(0) !== 0x0000ffff) return false;
    const major = buf.readUInt32LE(4), minor = buf.readUInt32LE(8);
    return major >= 1 && major <= 0xff && minor >= 1 && minor <= 0xff;
}

/**
 * An AVIF image: an ISO-BMFF file whose leading ftyp box lists the avif (still) or avis
 * (sequence) brand, as major or compatible brand. A HEIC photo lists heic/mif1 and fails.
 * storeFile also has sharp read it (prepareAvif), which refuses a non-AV1 HEIF.
 */
function isAvif(buf: Buffer): boolean {
    if (buf.length < 16 || buf.toString('latin1', 4, 8) !== 'ftyp') return false;
    const size = buf.readUInt32BE(0);
    if (size < 16 || size > 4096 || size > buf.length || size % 4 !== 0) return false;
    const brands = [buf.toString('latin1', 8, 12)];
    for (let p = 16; p + 4 <= size; p += 4) brands.push(buf.toString('latin1', p, p + 4));
    return brands.includes('avif') || brands.includes('avis');
}

/** How far into a .drawio file its root element may start (after the BOM, declaration and comments). */
const DRAWIO_PROLOG_CHARS = 64 * 1024;

/**
 * A draw.io diagram: UTF-8 text with no NUL bytes, whose root element is <mxfile> or
 * <mxGraphModel>, after an optional BOM, XML declaration and comments within the first 64 KB.
 * A compressed diagram is still this XML; its <diagram> holds base64 deflated text.
 */
function isDrawio(buf: Buffer): boolean {
    if (buf.includes(0x00)) return false;
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf); // drops a leading BOM
    } catch {
        return false; // not UTF-8 text
    }
    const head = text.slice(0, DRAWIO_PROLOG_CHARS);
    let i = 0;
    for (;;) {
        while (i < head.length && /\s/.test(head[i])) i++;
        const close = head.startsWith('<?xml', i) ? '?>' : head.startsWith('<!--', i) ? '-->' : null;
        if (!close) break;
        const end = head.indexOf(close, i + 4);
        if (end < 0) return false;
        i = end + close.length;
    }
    return /^<(mxfile|mxGraphModel)[\s/>]/.test(head.slice(i, i + 14));
}

/**
 * Formats that file-type cannot name, or names only as their container: each extension's
 * own content check, and the type its files are stored under. A file with one of these
 * extensions is stored only when its content passes the check; the extension alone is never enough.
 */
export const SIGNATURE_FORMATS: Readonly<Record<string, { mime: string; matches: (buf: Buffer) => boolean }>> = {
    xls: { mime: 'application/vnd.ms-excel', matches: isXls },
    doc: { mime: 'application/msword', matches: isDoc },
    ppt: { mime: 'application/vnd.ms-powerpoint', matches: isPpt },
    mpp: { mime: 'application/vnd.ms-project', matches: isMpp },
    accdb: { mime: 'application/x-msaccess', matches: isAccdb },
    jmp: { mime: 'application/x-jmp', matches: isJmp },
    avif: { mime: AVIF_MIME, matches: isAvif },
    drawio: { mime: 'application/xml', matches: isDrawio },
};

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

    // Formats with their own content check: it alone decides, whatever file-type made of the bytes
    const signature = Object.hasOwn(SIGNATURE_FORMATS, declaredExtension) ? SIGNATURE_FORMATS[declaredExtension] : undefined;
    if (signature) {
        if (!signature.matches(buffer)) {
            throw new FileValidationError(415, 'File content does not match its extension', { detected: detected?.mime ?? null, expected: signature.mime });
        }
        return { mime: signature.mime, ext: declaredExtension };
    }

    const ooxmlMime = Object.hasOwn(OOXML_MIME_BY_EXTENSION, declaredExtension) ? OOXML_MIME_BY_EXTENSION[declaredExtension] : undefined;
    // An Office file is a zip. file-type names the format only when [Content_Types].xml is
    // near the start; Google Docs exports put it last. Then the zip's own directory decides.
    if (ooxmlMime && detected?.mime === 'application/zip') {
        const kind = ooxmlKind(buffer);
        if (kind) detected = { mime: OOXML_MIME_BY_EXTENSION[kind], ext: kind } as typeof detected;
    }

    const textMime = Object.hasOwn(TEXT_MIME_BY_EXTENSION, declaredExtension) ? TEXT_MIME_BY_EXTENSION[declaredExtension] : undefined;
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
