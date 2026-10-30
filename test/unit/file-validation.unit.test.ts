import { describe, it, expect } from 'vitest';
import { validateFileType, ooxmlKind, OOXML_MIME_BY_EXTENSION, FileValidationError } from '../../src/lib/file-validation';
import { makeDocx, makePptx, makeXlsx, makeZip } from '../ooxml-helper';

/** Fixed filler bytes (stored, not deflated, so they need not be random). */
const filler = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff));

/** Office and text uploads (#291): what type a file is stored under, and what is refused. */

const ALL = ['docx', 'xlsx', 'pptx', 'zip', 'ipynb', 'py', 'html', 'xml', 'toml', 'txt', 'json'];

async function refusal(promise: Promise<unknown>): Promise<FileValidationError> {
    try {
        await promise;
    } catch (err) {
        if (err instanceof FileValidationError) return err;
        throw err;
    }
    throw new Error('expected a FileValidationError');
}

describe('Office files are stored under their own type, not application/zip', () => {
    it.each([
        ['docx', makeDocx(['essay'])],
        ['xlsx', makeXlsx([{ name: 'S', rows: [['x']] }])],
        ['pptx', makePptx([['slide']])],
    ])('%s', async (ext, buffer) => {
        expect(await validateFileType(buffer, ext, ALL)).toEqual({ mime: OOXML_MIME_BY_EXTENSION[ext], ext });
    });

    it('a Google Docs export, where file-type alone says application/zip', async () => {
        // Upload validation shows file-type the first 4 KB; a large first part keeps
        // [Content_Types].xml out of it. (Real exports with over 1 MB of parts before it
        // defeat file-type even on the whole file.)
        const docx = makeDocx(['Exported'], { googleDocs: true, parts: [{ name: 'word/media/image1.png', data: filler(8192), store: true }] });
        const { fileTypeFromBuffer } = await import('file-type');
        expect((await fileTypeFromBuffer(docx.subarray(0, 4100)))?.mime).toBe('application/zip');
        expect(ooxmlKind(docx)).toBe('docx');
        expect(await validateFileType(docx, 'docx', ALL)).toEqual({ mime: OOXML_MIME_BY_EXTENSION.docx, ext: 'docx' });
    });

    it('the extension has to be in the allowed list', async () => {
        const err = await refusal(validateFileType(makeDocx(['essay']), 'docx', ['pdf', 'txt', 'zip']));
        expect(err.status).toBe(415);
        expect(err.message).toBe('File type not allowed');
    });
});

describe('a zip with the wrong type is refused', () => {
    it('a plain zip named .docx, even when zip uploads are allowed', async () => {
        const err = await refusal(validateFileType(makeZip([{ name: 'notes.txt', data: 'hello' }]), 'docx', ALL));
        expect(err.status).toBe(415);
        expect(err.message).toBe('File content does not match its extension');
        expect(err.details).toEqual({ detected: 'application/zip', expected: OOXML_MIME_BY_EXTENSION.docx });
    });

    it('a spreadsheet named .docx', async () => {
        const err = await refusal(validateFileType(makeXlsx([{ name: 'S', rows: [['x']] }]), 'docx', ALL));
        expect(err.details).toEqual({ detected: OOXML_MIME_BY_EXTENSION.xlsx, expected: OOXML_MIME_BY_EXTENSION.docx });
    });

    it('a zip that only looks like Office: Word parts but no [Content_Types].xml', async () => {
        const zip = makeZip([{ name: 'filler.bin', data: filler(8192), store: true }, { name: 'word/document.xml', data: '<w:document/>' }]);
        expect(ooxmlKind(zip)).toBeNull();
        expect((await refusal(validateFileType(zip, 'docx', ALL))).message).toBe('File content does not match its extension');
    });

    it('a Word document uploaded as .zip stays a zip question: only allowed if docx is', async () => {
        const docx = makeDocx(['essay']);
        expect((await refusal(validateFileType(docx, 'zip', ['zip']))).message).toBe('File content does not match allowed types');
        expect(await validateFileType(docx, 'zip', ['zip', 'docx'])).toEqual({ mime: OOXML_MIME_BY_EXTENSION.docx, ext: 'docx' });
    });

    it('a cut-off or garbage file named .docx', async () => {
        const docx = makeDocx(['essay']);
        expect(ooxmlKind(docx.subarray(0, docx.length - 30))).toBeNull();
        expect((await refusal(validateFileType(filler(64), 'docx', ALL))).status).toBe(415);
    });
});

describe('text-like types', () => {
    it.each([
        ['ipynb', '{"cells": [], "nbformat": 4}', 'application/x-ipynb+json'],
        ['py', 'import numpy as np\n', 'text/x-python'],
        ['html', '<!doctype html><p>hi</p>', 'text/html'],
        ['xml', '<?xml version="1.0" encoding="UTF-8"?>\n<a/>', 'application/xml'],
        ['toml', '[tool.poetry]\nname = "x"\n', 'application/toml'],
        ['txt', '<?xml version="1.0"?> notes that start like XML', 'text/plain'],
    ])('.%s is stored as its text type', async (ext, content, mime) => {
        expect(await validateFileType(Buffer.from(content), ext, ALL)).toEqual({ mime, ext });
    });

    it('binary content under a text extension is refused', async () => {
        const err = await refusal(validateFileType(Buffer.from([0x70, 0x72, 0x00, 0x01, 0x02]), 'py', ALL));
        expect(err.message).toBe('File appears to be binary, not text');
    });
});
