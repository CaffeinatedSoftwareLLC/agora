import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { OOXML_MIME_BY_EXTENSION, TEXT_MIME_BY_EXTENSION } from './file-validation';

/**
 * Text out of an uploaded file, for the decision model to read
 * (docs/planning/jev-wbs.md, C.2). Plain-text types are decoded directly; HTML loses
 * its tags and a Jupyter notebook keeps only its cell sources. PDFs go through `unpdf`
 * (MIT; a build of Mozilla's pdf.js) and Word, Excel and PowerPoint files through a
 * small zip and XML reader of our own, each in a worker thread with a time and memory
 * limit, because these files are untrusted input and parsing one can be slow.
 *
 * Everything is bounded: bytes parsed, PDF pages, zip entries and bytes unpacked,
 * characters returned. A file past a reading limit is read up to it and reported as
 * `truncated`, so callers can mark their results as partial instead of pretending the
 * whole file was read. A zip that unpacks past its limit (a zip bomb) is refused.
 *
 * Images, audio, video and archives are `unsupported`. `setImageDescriber` is where
 * a description step for images can be plugged in later; nothing sets it today.
 */

export interface ExtractLimits {
    /** Files larger than this are not parsed at all. */
    maxBytes: number;
    maxPdfPages: number;
    /** Characters of text returned at most. */
    maxChars: number;
    pdfTimeoutMs: number;
    /** Office files: entries in the zip at most. */
    maxZipEntries: number;
    /** Office files: bytes unpacked from the parts read, at most. Past it the file is refused as a likely zip bomb. */
    maxUnzippedBytes: number;
    officeTimeoutMs: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
    maxBytes: 20 * 1024 * 1024,
    maxPdfPages: 50,
    maxChars: 192_000,
    pdfTimeoutMs: 20_000,
    maxZipEntries: 2_000,
    maxUnzippedBytes: 64 * 1024 * 1024,
    officeTimeoutMs: 20_000,
};

export type Extracted =
    | { ok: true; text: string; /** The file continued past what was read. */ truncated: boolean }
    | { ok: false; reason: 'unsupported' | 'empty' | 'too_large' | 'failed'; detail: string };

const TEXT_MIMES = new Set(Object.values(TEXT_MIME_BY_EXTENSION));
const NOTEBOOK_MIME = 'application/x-ipynb+json';
const OFFICE = new Map<string, { kind: 'docx' | 'xlsx' | 'pptx'; label: string }>([
    [OOXML_MIME_BY_EXTENSION.docx, { kind: 'docx', label: 'Word document' }],
    [OOXML_MIME_BY_EXTENSION.xlsx, { kind: 'xlsx', label: 'spreadsheet' }],
    [OOXML_MIME_BY_EXTENSION.pptx, { kind: 'pptx', label: 'presentation' }],
]);

/** Turns an image into a text description (a vision model, later). Null: no description available. */
export type ImageDescriber = (buffer: Buffer, mime: string) => Promise<string | null>;
let imageDescriber: ImageDescriber | null = null;
export function setImageDescriber(fn: ImageDescriber | null) { imageDescriber = fn; }

export function isExtractable(mime: string): boolean {
    return TEXT_MIMES.has(mime) || OFFICE.has(mime) || mime === 'application/pdf' || (mime.startsWith('image/') && imageDescriber !== null);
}

const NOT_UTF8: Extracted = { ok: false, reason: 'failed', detail: 'The file is not readable as UTF-8 text' };
const EMPTY: Extracted = { ok: false, reason: 'empty', detail: 'The file has no text' };

/** UTF-8 bytes as text, or null when they are mostly not UTF-8. Drops a byte-order mark and NUL characters. */
function decodeUtf8(bytes: Buffer): string | null {
    const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
    // Mostly replacement characters means this is not UTF-8 text
    const bad = (text.match(/�/g) ?? []).length;
    if (text.length > 0 && bad / text.length > 0.1) return null;
    return text.replace(/\u0000/g, '');
}

/** Cut to the character limit; `more` says the input was already cut before this. */
function bounded(text: string, more: boolean, limits: ExtractLimits): Extracted {
    const truncated = more || text.length > limits.maxChars;
    text = text.slice(0, limits.maxChars);
    if (!text.trim()) return EMPTY;
    return { ok: true, text, truncated };
}

function decodeText(buffer: Buffer, limits: ExtractLimits): Extracted {
    // UTF-8 is at most 4 bytes per character: no need to decode past this
    const slice = buffer.subarray(0, limits.maxChars * 4);
    const text = decodeUtf8(slice);
    if (text === null) return NOT_UTF8;
    return bounded(text, slice.length < buffer.length, limits);
}

const ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
    ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', hellip: '…', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™',
    deg: '°', times: '×', divide: '÷', plusmn: '±', euro: '€', pound: '£', cent: '¢', sect: '§', para: '¶',
};
function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, key: string) => {
        if (key[0] !== '#') return Object.hasOwn(ENTITIES, key.toLowerCase()) ? ENTITIES[key.toLowerCase()] : all;
        const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    });
}

const HTML_SKIPPED = /^(script|style|noscript|template|svg|math|iframe|object)$/;
const HTML_BLOCK = /^(p|div|br|hr|h[1-6]|li|ul|ol|dl|dt|dd|tr|table|thead|tbody|section|article|main|header|footer|nav|aside|blockquote|pre|figure|figcaption|title|form|fieldset|address|details|summary)$/;

/**
 * The visible text of an HTML page: tags, comments, scripts and styles dropped, block
 * elements on their own lines, entities decoded. A linear scan with indexOf, so a
 * malformed page cannot make it backtrack; nothing in the page is run.
 */
export function htmlToText(html: string): string {
    const out: string[] = [];
    let i = 0;
    while (i < html.length) {
        const lt = html.indexOf('<', i);
        out.push(html.slice(i, lt < 0 ? html.length : lt));
        if (lt < 0) break;
        if (html.startsWith('<!--', lt)) {
            const close = html.indexOf('-->', lt + 4);
            i = close < 0 ? html.length : close + 3;
            continue;
        }
        const gt = html.indexOf('>', lt + 1);
        if (gt < 0) {
            out.push(html.slice(lt));
            break;
        }
        i = gt + 1;
        const tag = /^<(\/?)([a-zA-Z][\w:-]*)/.exec(html.slice(lt, Math.min(gt + 1, lt + 64)));
        if (!tag) {
            // <!DOCTYPE>, <?xml?>, CDATA: markup, not text. A bare "<" in text stays.
            if (!/^<[!?]/.test(html.slice(lt, lt + 2))) out.push(html.slice(lt, gt + 1));
            continue;
        }
        const name = tag[2].toLowerCase();
        if (!tag[1] && HTML_SKIPPED.test(name) && html[gt - 1] !== '/') {
            // Script and style bodies are not markup ("x<y" in a script): jump to the closing tag
            const close = new RegExp(`</${name}[\\s/>]`, 'gi');
            close.lastIndex = i;
            const m = close.exec(html);
            if (!m) break;
            const end = html.indexOf('>', m.index);
            i = end < 0 ? html.length : end + 1;
            continue;
        }
        if (HTML_BLOCK.test(name)) out.push('\n');
        else if (name === 'td' || name === 'th') out.push('\t');
    }
    return decodeEntities(out.join(''))
        .split('\n')
        .map(line => line.replace(/[ \t\f\v \r]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function extractHtml(buffer: Buffer, limits: ExtractLimits): Extracted {
    // Markup can be most of a page, so the whole file is decoded (it is under maxBytes) and the text cut after
    const html = decodeUtf8(buffer);
    if (html === null) return NOT_UTF8;
    return bounded(htmlToText(html), false, limits);
}

/**
 * A Jupyter notebook as the sources of its cells, in order: markdown as written, code in
 * fences. Outputs are left out (they hold base64 images and long logs), and so are
 * images embedded in markdown as data: URLs.
 */
function extractNotebook(buffer: Buffer, limits: ExtractLimits): Extracted {
    const json = decodeUtf8(buffer);
    if (json === null) return NOT_UTF8;
    let nb: any;
    try {
        nb = JSON.parse(json);
    } catch {
        return { ok: false, reason: 'failed', detail: 'The notebook is not valid JSON' };
    }
    // nbformat 4 keeps cells at the top; nbformat 3 inside worksheets
    const cells: any[] = Array.isArray(nb?.cells) ? nb.cells
        : Array.isArray(nb?.worksheets) ? nb.worksheets.flatMap((w: any) => (Array.isArray(w?.cells) ? w.cells : []))
        : [];
    if (!cells.length && !Array.isArray(nb?.cells)) return { ok: false, reason: 'failed', detail: 'The file is not a Jupyter notebook' };
    const language = String(nb?.metadata?.kernelspec?.language ?? nb?.metadata?.language_info?.name ?? '').replace(/[^\w+#-]/g, '');
    const parts: string[] = [];
    let length = 0;
    for (const cell of cells) {
        if (length > limits.maxChars) break;
        const raw = cell?.source ?? cell?.input; // nbformat 3 code cells use `input`
        let source = (Array.isArray(raw) ? raw.join('') : typeof raw === 'string' ? raw : '').replace(/\u0000/g, '');
        source = source.replace(/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]+/g, '[embedded file]').trim();
        if (!source) continue;
        const part = cell?.cell_type === 'code' ? '```' + language + '\n' + source + '\n```' : source;
        parts.push(part);
        length += part.length + 2;
    }
    return bounded(parts.join('\n\n'), false, limits);
}

/** Runs `source` in a worker thread with a time and memory limit; the worker posts one result. */
function runWorker(source: string, workerData: Record<string, unknown>, timeoutMs: number, failed: (detail: string) => Extracted): Promise<Extracted> {
    return new Promise((resolve) => {
        let settled = false;
        let worker: Worker | undefined;
        const finish = (result: Extracted) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            void worker?.terminate();
            resolve(result);
        };
        const timer = setTimeout(() => finish(failed(`it took longer than ${timeoutMs} ms`)), timeoutMs);

        try {
            worker = new Worker(source, { eval: true, workerData, resourceLimits: { maxOldGenerationSizeMb: 384 } });
        } catch (err) {
            return finish(failed(err instanceof Error ? err.message : String(err)));
        }
        if (!worker) return;
        worker.once('message', (msg: { ok: boolean; text?: string; truncated?: boolean; error?: string }) => {
            if (!msg.ok) return finish(failed(msg.error ?? 'unknown error'));
            const text = (msg.text ?? '').replace(/\u0000/g, '');
            if (!text.trim()) return finish(EMPTY);
            finish({ ok: true, text, truncated: !!msg.truncated });
        });
        worker.once('error', (err) => finish(failed(err.message)));
        worker.once('exit', (code) => finish(failed(`the reader stopped (exit ${code})`)));
    });
}

/** A copy of the bytes: the worker gets its own, and ours stays usable. */
function copyBytes(buffer: Buffer): ArrayBuffer {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

/** Runs inside the worker thread. Kept as source so it works the same compiled and under tsx/vitest. */
const PDF_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
    const { getDocumentProxy } = await import(workerData.unpdfUrl);
    const pdf = await getDocumentProxy(new Uint8Array(workerData.data), { verbosity: 0 });
    const total = pdf.numPages;
    const pages = Math.min(total, workerData.maxPages);
    let text = '';
    let read = 0;
    for (let i = 1; i <= pages && text.length <= workerData.maxChars; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(it => (it.str || '') + (it.hasEOL ? '\\n' : '')).join(' ') + '\\n\\n';
        read = i;
    }
    parentPort.postMessage({ ok: true, text: text.slice(0, workerData.maxChars), truncated: read < total || text.length > workerData.maxChars });
})().catch(err => parentPort.postMessage({ ok: false, error: String((err && err.message) || err) }));
`;

function extractPdf(buffer: Buffer, limits: ExtractLimits): Promise<Extracted> {
    const failed = (detail: string): Extracted => ({ ok: false, reason: 'failed', detail: `The PDF could not be read: ${detail}`.slice(0, 300) });
    let unpdfUrl: string;
    try {
        unpdfUrl = pathToFileURL(createRequire(__filename).resolve('unpdf')).href;
    } catch (err) {
        return Promise.resolve(failed(err instanceof Error ? err.message : String(err)));
    }
    return runWorker(PDF_WORKER, { unpdfUrl, data: copyBytes(buffer), maxPages: limits.maxPdfPages, maxChars: limits.maxChars }, limits.pdfTimeoutMs, failed);
}

/**
 * Runs inside the worker thread: reads a .docx, .xlsx or .pptx. A minimal zip reader
 * (central directory, stored and deflated entries, no zip64) that unpacks only the parts
 * it needs, each with zlib's maxOutputLength set to what is left of the budget, so a
 * zip bomb stops at the budget instead of filling memory. XML is read by one linear
 * tokenizer with namespace prefixes dropped; there is no DTD or entity expansion.
 *
 * Plain JavaScript in a String.raw: no backticks or dollar-brace in here.
 */
const OFFICE_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const zlib = require('node:zlib');

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

function openZip(buf, maxEntries, maxUnzipped) {
    let eocd = -1;
    for (let i = buf.length - 22, min = Math.max(0, buf.length - 65557); i >= min; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) refuse('it is not a complete zip file (it may be cut off)');
    const count = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) refuse('it is a zip64 archive, which is not supported');
    if (count > maxEntries) refuse('it has more than ' + maxEntries + ' zip entries');
    const entries = new Map();
    let p = cdOffset;
    for (let n = 0; n < count; n++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) refuse('its zip directory is damaged');
        const nameLength = buf.readUInt16LE(p + 28);
        entries.set(buf.toString('utf8', p + 46, p + 46 + nameLength), {
            flags: buf.readUInt16LE(p + 8),
            method: buf.readUInt16LE(p + 10),
            compressed: buf.readUInt32LE(p + 20),
            size: buf.readUInt32LE(p + 24),
            offset: buf.readUInt32LE(p + 42),
        });
        p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    let budget = maxUnzipped;
    const bomb = () => refuse('it unpacks to more than ' + Math.round(maxUnzipped / 1024 / 1024) + ' MB (a zip bomb?)');
    return {
        names: () => [...entries.keys()],
        /** The entry as text, or null when there is no such entry. */
        read(name) {
            const e = entries.get(name);
            if (!e) return null;
            if (e.flags & 1) refuse('it is encrypted');
            if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) refuse('its zip entry ' + name + ' is damaged');
            const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
            if (start + e.compressed > buf.length) refuse('it is cut off');
            if (e.size > budget) bomb();
            const data = buf.subarray(start, start + e.compressed);
            let out;
            if (e.method === 0) out = data;
            else if (e.method === 8) {
                try {
                    out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, budget) });
                } catch (err) {
                    if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError)) bomb();
                    refuse('its zip entry ' + name + ' is damaged');
                }
            } else refuse('it uses an unsupported zip compression method (' + e.method + ')');
            budget -= out.length;
            if (budget < 0) bomb();
            return out.toString('utf8');
        },
    };
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (all, k) => {
        if (k[0] !== '#') return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : all;
        const n = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    });
}
function attrs(s) {
    const out = {};
    const re = /([^\s=\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = decode(m[2] !== undefined ? m[2] : m[3]);
    return out;
}
/** The relationship id attribute (r:id under whatever prefix the file uses). */
function relId(at) { for (const k in at) if (k.endsWith(':id')) return at[k]; return undefined; }

/** Calls onTag(kind, name, attributes) with kind open, close or empty, and onText(raw) for character data. */
function walk(xml, onTag, onText, out) {
    const re = /<(\/?)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)([^<>]*?)(\/?)>|([^<]+)/g;
    let m;
    while ((!out || !out.full) && (m = re.exec(xml))) {
        if (m[5] !== undefined) { if (onText) onText(m[5]); }
        else onTag(m[1] ? 'close' : m[4] ? 'empty' : 'open', m[2], m[3]);
    }
}

class Out {
    constructor(max) { this.parts = []; this.length = 0; this.max = max; this.full = false; }
    add(s) {
        if (this.full || !s) return;
        const room = this.max - this.length;
        if (s.length > room) { s = s.slice(0, room); this.full = true; }
        this.parts.push(s);
        this.length += s.length;
    }
    /** A cell separator: replaces a paragraph end just before it. */
    cell() {
        if (this.parts.length && this.parts[this.parts.length - 1] === '\n') { this.parts[this.parts.length - 1] = '\t'; return; }
        this.add('\t');
    }
    text() { return this.parts.join('').replace(/\n{3,}/g, '\n\n'); }
}

/** Word and PowerPoint text: runs in <t>, paragraphs, line breaks, tabs, table cells. */
function runText(xml, out) {
    let inText = false;
    let fallback = 0; // mc:Fallback repeats the content of mc:Choice (text boxes): read it once
    walk(xml, (kind, name, a) => {
        if (name === 'Fallback') { if (kind === 'open') fallback++; else if (kind === 'close') fallback = Math.max(0, fallback - 1); return; }
        if (fallback) return;
        if (name === 't') { inText = kind === 'open'; return; }
        if (kind === 'close') {
            if (name === 'p' || name === 'tr') out.add('\n');
            else if (name === 'tc') out.cell();
        } else if (kind === 'empty') {
            if (name === 'br' || name === 'cr') out.add('\n');
            else if (name === 'tab' && !a.trim()) out.add('\t'); // <w:tab w:val=.. w:pos=..> is a tab stop, not a tab
        }
    }, (s) => { if (inText && !fallback) out.add(decode(s)); }, out);
}

/** Relationships of a part, id to resolved part name. */
function rels(zip, part) {
    const dir = part.slice(0, part.lastIndexOf('/') + 1);
    const xml = zip.read(dir + '_rels/' + part.slice(dir.length) + '.rels');
    const map = {};
    if (xml) walk(xml, (kind, name, a) => {
        if (name !== 'Relationship' || kind === 'close') return;
        const at = attrs(a);
        if (at.Id && at.Target && at.TargetMode !== 'External') map[at.Id] = resolve(dir, at.Target);
    });
    return map;
}
function resolve(dir, target) {
    const parts = [];
    for (const p of (target[0] === '/' ? target.slice(1) : dir + target).split('/')) {
        if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p);
    }
    return parts.join('/');
}
function numbered(zip, re) {
    const n = (s) => Number((/(\d+)\.xml$/.exec(s) || [0, 0])[1]);
    return zip.names().filter((s) => re.test(s)).sort((a, b) => n(a) - n(b));
}

function docx(zip, out) {
    const body = zip.read('word/document.xml');
    if (body === null) refuse('it has no word/document.xml, so it is not a Word document');
    runText(body, out);
    for (const part of ['word/footnotes.xml', 'word/endnotes.xml']) {
        if (out.full) break;
        const xml = zip.read(part);
        if (xml) { out.add('\n'); runText(xml, out); }
    }
}

function pptx(zip, out) {
    const pres = zip.read('ppt/presentation.xml');
    if (pres === null) refuse('it has no ppt/presentation.xml, so it is not a PowerPoint presentation');
    const map = rels(zip, 'ppt/presentation.xml');
    let slides = [];
    walk(pres, (kind, name, a) => {
        if (name !== 'sldId' || kind === 'close') return;
        const part = map[relId(attrs(a))];
        if (part) slides.push(part);
    });
    if (!slides.length) slides = numbered(zip, /^ppt\/slides\/slide\d+\.xml$/);
    for (let i = 0; i < slides.length && !out.full; i++) {
        out.add((i ? '\n' : '') + '--- Slide ' + (i + 1) + ' ---\n');
        const xml = zip.read(slides[i]);
        if (xml) runText(xml, out);
    }
}

function sharedStrings(xml) {
    const list = [];
    let current = null, inText = false, phonetic = false;
    walk(xml, (kind, name) => {
        if (name === 'si') {
            if (kind === 'open') current = '';
            else if (kind === 'close') { list.push(current || ''); current = null; }
            else list.push('');
        } else if (name === 'rPh') phonetic = kind === 'open';
        else if (name === 't') inText = kind === 'open';
    }, (s) => { if (inText && !phonetic && current !== null) current += decode(s); });
    return list;
}

function cellValue(cell, shared) {
    const v = decode(cell.v).trim();
    let text;
    switch (cell.type) {
        case 's': { const i = Number(v); text = Number.isInteger(i) && shared[i] !== undefined ? shared[i] : ''; break; }
        case 'inlineStr': text = decode(cell.inline); break;
        case 'b': text = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : v; break;
        case 'n': {
            // Stored as binary floats (19445.310000000001); Excel shows 15 significant digits
            const n = Number(v);
            text = v !== '' && Number.isFinite(n) ? String(Number(n.toPrecision(15))) : v;
            break;
        }
        default: text = v; // formula strings, errors, dates
    }
    return text.replace(/\s+/g, ' ').trim();
}

/** One line per row, cells separated by tabs, empty cells left out. */
function sheetRows(xml, shared, out) {
    let row = null, cell = null, inValue = false, inText = false;
    walk(xml, (kind, name, a) => {
        if (name === 'row') {
            if (kind === 'open') row = [];
            else if (kind === 'close' && row) { if (row.length) out.add(row.join('\t') + '\n'); row = null; }
        } else if (name === 'c') {
            if (kind === 'open') { const t = /(?:^|\s)t\s*=\s*["']([^"']*)/.exec(a); cell = { type: t ? t[1] : 'n', v: '', inline: '' }; }
            else if (kind === 'close' && cell) { const v = cellValue(cell, shared); if (v && row) row.push(v); cell = null; }
        } else if (name === 'v') inValue = kind === 'open';
        else if (name === 't') inText = kind === 'open';
    }, (s) => { if (!cell) return; if (inValue) cell.v += s; else if (inText) cell.inline += s; }, out);
}

function xlsx(zip, out) {
    const book = zip.read('xl/workbook.xml');
    if (book === null) refuse('it has no xl/workbook.xml, so it is not an Excel workbook');
    const map = rels(zip, 'xl/workbook.xml');
    const sheets = [];
    walk(book, (kind, name, a) => {
        if (name !== 'sheet' || kind === 'close') return;
        const at = attrs(a);
        sheets.push({ name: at.name || 'Sheet ' + (sheets.length + 1), part: map[relId(at)] });
    });
    if (!sheets.length) numbered(zip, /^xl\/worksheets\/sheet\d+\.xml$/).forEach((part, i) => sheets.push({ name: 'Sheet ' + (i + 1), part }));
    out.add('Sheets: ' + sheets.map((s) => s.name).join(', ') + '\n');
    const sst = zip.read('xl/sharedStrings.xml');
    const shared = sst ? sharedStrings(sst) : [];
    for (const sheet of sheets) {
        if (out.full) break;
        out.add('\nSheet: ' + sheet.name + '\n');
        const xml = sheet.part ? zip.read(sheet.part) : null; // a chart sheet has no cells
        if (xml) sheetRows(xml, shared, out);
    }
}

try {
    const buf = Buffer.from(workerData.data);
    const zip = openZip(buf, workerData.maxEntries, workerData.maxUnzipped);
    const out = new Out(workerData.maxChars);
    ({ docx, xlsx, pptx })[workerData.kind](zip, out);
    parentPort.postMessage({ ok: true, text: out.text(), truncated: out.full });
} catch (err) {
    parentPort.postMessage({ ok: false, error: err instanceof Refusal ? err.message : 'it is damaged (' + String((err && err.message) || err) + ')' });
}
`;

function extractOffice(buffer: Buffer, { kind, label }: { kind: string; label: string }, limits: ExtractLimits): Promise<Extracted> {
    const failed = (detail: string): Extracted => ({ ok: false, reason: 'failed', detail: `The ${label} could not be read: ${detail}`.slice(0, 300) });
    return runWorker(OFFICE_WORKER, {
        kind, data: copyBytes(buffer), maxChars: limits.maxChars, maxEntries: limits.maxZipEntries, maxUnzipped: limits.maxUnzippedBytes,
    }, limits.officeTimeoutMs, failed);
}

/** Extract text from a file by its (already validated) MIME type. Never throws. */
export async function extractText(buffer: Buffer, mime: string, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<Extracted> {
    if (buffer.length > limits.maxBytes) {
        return { ok: false, reason: 'too_large', detail: `The file is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB` };
    }
    try {
        if (mime === 'text/html') return extractHtml(buffer, limits);
        if (mime === NOTEBOOK_MIME) return extractNotebook(buffer, limits);
        if (TEXT_MIMES.has(mime)) return decodeText(buffer, limits);
        if (mime === 'application/pdf') return await extractPdf(buffer, limits);
        const office = OFFICE.get(mime);
        if (office) return await extractOffice(buffer, office, limits);
        if (mime.startsWith('image/') && imageDescriber) {
            const description = await imageDescriber(buffer, mime);
            if (!description?.trim()) return { ok: false, reason: 'empty', detail: 'No description was produced for this image' };
            return { ok: true, text: description.slice(0, limits.maxChars), truncated: description.length > limits.maxChars };
        }
    } catch (err) {
        return { ok: false, reason: 'failed', detail: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
    return { ok: false, reason: 'unsupported', detail: `Text cannot be read from ${mime} files` };
}

/**
 * Split text into chunks of at most `chunkChars`, breaking at a paragraph, line or
 * sentence end where one is near. At most `maxChunks`; `truncated` says text was left over.
 */
export function chunkText(text: string, chunkChars: number, maxChunks: number): { chunks: string[]; truncated: boolean } {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length && chunks.length < maxChunks) {
        let end = Math.min(start + chunkChars, text.length);
        if (end < text.length) {
            const window = text.slice(start, end);
            // Prefer a break in the last fifth of the chunk
            const floor = Math.floor(chunkChars * 0.8);
            const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('. ') + 1);
            if (cut > floor) end = start + cut;
        }
        const chunk = text.slice(start, end).trim();
        if (chunk) chunks.push(chunk);
        start = end;
    }
    return { chunks, truncated: start < text.length };
}
