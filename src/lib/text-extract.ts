import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

/**
 * Text out of an uploaded file, for the decision model to read
 * (docs/planning/jev-wbs.md, C.2). Plain-text types are decoded directly; PDFs go
 * through `unpdf` (MIT; a build of Mozilla's pdf.js) in a worker thread with a time
 * and memory limit, because a PDF is untrusted input and parsing one can be slow.
 *
 * Everything is bounded: bytes parsed, PDF pages, characters returned. A file past a
 * limit is read up to it and reported as `truncated`, so callers can mark their
 * results as partial instead of pretending the whole file was read.
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
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
    maxBytes: 20 * 1024 * 1024,
    maxPdfPages: 50,
    maxChars: 192_000,
    pdfTimeoutMs: 20_000,
};

export type Extracted =
    | { ok: true; text: string; /** The file continued past what was read. */ truncated: boolean }
    | { ok: false; reason: 'unsupported' | 'empty' | 'too_large' | 'failed'; detail: string };

const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

/** Turns an image into a text description (a vision model, later). Null: no description available. */
export type ImageDescriber = (buffer: Buffer, mime: string) => Promise<string | null>;
let imageDescriber: ImageDescriber | null = null;
export function setImageDescriber(fn: ImageDescriber | null) { imageDescriber = fn; }

export function isExtractable(mime: string): boolean {
    return TEXT_MIMES.has(mime) || mime === 'application/pdf' || (mime.startsWith('image/') && imageDescriber !== null);
}

function decodeText(buffer: Buffer, limits: ExtractLimits): Extracted {
    // UTF-8 is at most 4 bytes per character: no need to decode past this
    const slice = buffer.subarray(0, limits.maxChars * 4);
    let text = new TextDecoder('utf-8').decode(slice).replace(/^﻿/, '');
    // Mostly replacement characters means this is not UTF-8 text
    const bad = (text.match(/�/g) ?? []).length;
    if (text.length > 0 && bad / text.length > 0.1) return { ok: false, reason: 'failed', detail: 'The file is not readable as UTF-8 text' };
    text = text.replace(/\u0000/g, '');
    const truncated = slice.length < buffer.length || text.length > limits.maxChars;
    text = text.slice(0, limits.maxChars);
    if (!text.trim()) return { ok: false, reason: 'empty', detail: 'The file has no text' };
    return { ok: true, text, truncated };
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
        const failed = (detail: string): Extracted => ({ ok: false, reason: 'failed', detail: `The PDF could not be read: ${detail}`.slice(0, 300) });
        const timer = setTimeout(() => finish(failed(`it took longer than ${limits.pdfTimeoutMs} ms`)), limits.pdfTimeoutMs);

        try {
            const unpdfUrl = pathToFileURL(createRequire(__filename).resolve('unpdf')).href;
            // A copy of the bytes: the worker gets its own, and ours stays usable
            const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
            worker = new Worker(PDF_WORKER, {
                eval: true,
                workerData: { unpdfUrl, data, maxPages: limits.maxPdfPages, maxChars: limits.maxChars },
                resourceLimits: { maxOldGenerationSizeMb: 384 },
            });
        } catch (err) {
            return finish(failed(err instanceof Error ? err.message : String(err)));
        }
        if (!worker) return;
        worker.once('message', (msg: { ok: boolean; text?: string; truncated?: boolean; error?: string }) => {
            if (!msg.ok) return finish(failed(msg.error ?? 'unknown error'));
            const text = (msg.text ?? '').replace(/\u0000/g, '');
            if (!text.trim()) return finish({ ok: false, reason: 'empty', detail: 'The PDF has no text layer (a scan, or images only)' });
            finish({ ok: true, text, truncated: !!msg.truncated });
        });
        worker.once('error', (err) => finish(failed(err.message)));
        worker.once('exit', (code) => finish(failed(`the reader stopped (exit ${code})`)));
    });
}

/** Extract text from a file by its (already validated) MIME type. Never throws. */
export async function extractText(buffer: Buffer, mime: string, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<Extracted> {
    if (buffer.length > limits.maxBytes) {
        return { ok: false, reason: 'too_large', detail: `The file is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB` };
    }
    try {
        if (TEXT_MIMES.has(mime)) return decodeText(buffer, limits);
        if (mime === 'application/pdf') return await extractPdf(buffer, limits);
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
