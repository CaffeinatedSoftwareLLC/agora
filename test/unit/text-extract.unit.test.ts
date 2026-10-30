import { describe, it, expect, afterEach } from 'vitest';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { chunkText, extractText, htmlToText, isExtractable, setImageDescriber, DEFAULT_EXTRACT_LIMITS } from '../../src/lib/text-extract';
import { OOXML_MIME_BY_EXTENSION, TEXT_MIME_BY_EXTENSION } from '../../src/lib/file-validation';
import { makePdf } from '../pdf-helper';
import { makeDocx, makePptx, makeXlsx, makeZip } from '../ooxml-helper';

const limits = (over: Partial<typeof DEFAULT_EXTRACT_LIMITS>) => ({ ...DEFAULT_EXTRACT_LIMITS, ...over });

afterEach(() => { setImageDescriber(null); });

describe('extractText: plain text types', () => {
    it.each(['text/plain', 'text/markdown', 'text/csv', 'application/json'])('reads %s as UTF-8', async (mime) => {
        const res = await extractText(Buffer.from('# Protocol\n\nAgents take turns. Ünïcödé ✓'), mime);
        expect(res).toEqual({ ok: true, text: '# Protocol\n\nAgents take turns. Ünïcödé ✓', truncated: false });
    });

    it('strips a byte-order mark and NUL characters', async () => {
        const res = await extractText(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('a\u0000b')]), 'text/plain');
        expect(res).toEqual({ ok: true, text: 'ab', truncated: false });
    });

    it('cuts at the character limit and says so', async () => {
        const res = await extractText(Buffer.from('x'.repeat(5000)), 'text/plain', limits({ maxChars: 1000 }));
        expect(res.ok && res.text.length).toBe(1000);
        expect(res.ok && res.truncated).toBe(true);
    });

    it('reports an empty file, a non-text file and an oversized file', async () => {
        expect(await extractText(Buffer.from('   \n  '), 'text/plain')).toMatchObject({ ok: false, reason: 'empty' });
        expect(await extractText(Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8]), 'text/plain')).toMatchObject({ ok: false, reason: 'failed' });
        expect(await extractText(Buffer.alloc(2048, 0x61), 'text/plain', limits({ maxBytes: 1024 }))).toMatchObject({ ok: false, reason: 'too_large' });
    });
});

describe('extractText: PDF', () => {
    it('reads the text layer of every page', async () => {
        const pdf = makePdf([['Agora turn-taking protocol', 'START, ACK, TURN, DECIDE, DONE'], ['Page two: closing a thread']]);
        const res = await extractText(pdf, 'application/pdf');
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.text).toContain('Agora turn-taking protocol');
        expect(res.text).toContain('START, ACK, TURN, DECIDE, DONE');
        expect(res.text).toContain('Page two: closing a thread');
        expect(res.truncated).toBe(false);
    });

    it('stops at the page limit and says so', async () => {
        const pdf = makePdf([['first page'], ['second page'], ['third page']]);
        const res = await extractText(pdf, 'application/pdf', limits({ maxPdfPages: 2 }));
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.text).toContain('second page');
        expect(res.text).not.toContain('third page');
        expect(res.truncated).toBe(true);
    });

    it('a corrupt PDF fails cleanly', async () => {
        const res = await extractText(Buffer.from('%PDF-1.4\nthis is not really a pdf\n%%EOF'), 'application/pdf');
        expect(res).toMatchObject({ ok: false, reason: 'failed' });
        expect((res as any).detail).toContain('The PDF could not be read');
    });

    it('a PDF with no text layer is empty, not an error', async () => {
        const res = await extractText(makePdf([[]]), 'application/pdf');
        expect(res).toMatchObject({ ok: false, reason: 'empty' });
    });

    it('gives up at the time limit instead of hanging', async () => {
        const pdf = makePdf(Array.from({ length: 40 }, (_, i) => [`page ${i}`]));
        const started = Date.now();
        const res = await extractText(pdf, 'application/pdf', limits({ pdfTimeoutMs: 1 }));
        expect(res).toMatchObject({ ok: false, reason: 'failed' });
        expect(Date.now() - started).toBeLessThan(5000);
    });
});

const DOCX = OOXML_MIME_BY_EXTENSION.docx;
const XLSX = OOXML_MIME_BY_EXTENSION.xlsx;
const PPTX = OOXML_MIME_BY_EXTENSION.pptx;
const W = (inner: string) => `<w:p><w:r>${inner}</w:r></w:p>`;

/** The entries of a zip built by makeZip without descriptors. */
function listEntries(zip: Buffer): { name: string; data: Buffer }[] {
    const out: { name: string; data: Buffer }[] = [];
    let p = 0;
    while (zip.readUInt32LE(p) === 0x04034b50) {
        const method = zip.readUInt16LE(p + 8);
        const size = zip.readUInt32LE(p + 18);
        const nameLength = zip.readUInt16LE(p + 26);
        const name = zip.toString('utf8', p + 30, p + 30 + nameLength);
        const body = zip.subarray(p + 30 + nameLength, p + 30 + nameLength + size);
        out.push({ name, data: method === 8 ? inflateRawSync(body) : body });
        p += 30 + nameLength + size;
    }
    return out;
}

describe('extractText: Word', () => {
    it('reads paragraphs in order, with entities decoded', async () => {
        const res = await extractText(makeDocx(['Agora turn-taking protocol', 'Rules & <roles>: “START”, then TURN']), DOCX);
        expect(res).toEqual({ ok: true, text: 'Agora turn-taking protocol\nRules & <roles>: “START”, then TURN\n', truncated: false });
    });

    it('keeps tabs, line breaks and table cells; skips tab stops, deleted text and the duplicate copy of a text box', async () => {
        const body = '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>'
            + '<w:r><w:t>Name</w:t><w:tab/><w:t>Score</w:t><w:br/><w:t>second line</w:t></w:r>'
            + '<w:del><w:r><w:delText>deleted words</w:delText></w:r></w:del></w:p>'
            + '<w:tbl><w:tr><w:tc>' + W('<w:t>A1</w:t>') + '</w:tc><w:tc>' + W('<w:t>B1</w:t>') + '</w:tc></w:tr></w:tbl>'
            + '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:txbxContent>' + W('<w:t>Box text</w:t>')
            + '</w:txbxContent></mc:Choice><mc:Fallback><w:txbxContent>' + W('<w:t>Box text</w:t>') + '</w:txbxContent></mc:Fallback></mc:AlternateContent></w:r></w:p>';
        const res = await extractText(makeDocx([], { bodyXml: body }), DOCX);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.text).toBe('Name\tScore\nsecond line\nA1\tB1\t\nBox text\n\n');
        expect(res.text).not.toContain('deleted words');
    });

    it('reads footnotes after the body', async () => {
        const footnotes = '<?xml version="1.0"?><w:footnotes xmlns:w="w"><w:footnote w:id="1">' + W('<w:t>Source: NC State Extension</w:t>') + '</w:footnote></w:footnotes>';
        const res = await extractText(makeDocx(['Body text'], { parts: [{ name: 'word/footnotes.xml', data: footnotes }] }), DOCX);
        expect(res.ok && res.text).toBe('Body text\n\nSource: NC State Extension\n');
    });

    it('reads a Google Docs export: parts first, [Content_Types].xml last, sizes in data descriptors', async () => {
        const res = await extractText(makeDocx(['Exported from Google Docs'], { googleDocs: true }), DOCX);
        expect(res).toEqual({ ok: true, text: 'Exported from Google Docs\n', truncated: false });
    });

    it('stops at the character limit and says so', async () => {
        const docx = makeDocx(Array.from({ length: 200 }, (_, i) => `Paragraph ${i} of a long essay.`));
        const res = await extractText(docx, DOCX, { ...DEFAULT_EXTRACT_LIMITS, maxChars: 500 });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.text.length).toBe(500);
        expect(res.text.startsWith('Paragraph 0 of a long essay.\n')).toBe(true);
        expect(res.truncated).toBe(true);
    });

    it('a document with no text is empty, not an error', async () => {
        expect(await extractText(makeDocx([]), DOCX)).toMatchObject({ ok: false, reason: 'empty' });
    });
});

describe('extractText: Excel', () => {
    it('lists the sheet names, then each sheet row by row', async () => {
        const xlsx = makeXlsx([
            { name: 'Grades', rows: [['Student', 'Score', 'Passed'], ['Ann', 91.5, true], ['Bo', 19445.310000000001, false], [null, 'tab\tand\nnewline', null]] },
            { name: 'Notes & sources', rows: [['Missouri Botanical Garden']] },
        ]);
        expect(await extractText(xlsx, XLSX)).toEqual({
            ok: true,
            truncated: false,
            text: 'Sheets: Grades, Notes & sources\n\nSheet: Grades\nStudent\tScore\tPassed\nAnn\t91.5\tTRUE\nBo\t19445.31\tFALSE\ntab and newline\n'
                + '\nSheet: Notes & sources\nMissouri Botanical Garden\n',
        });
    });

    it('reads inline strings and formula results, and skips phonetic runs in shared strings', async () => {
        const parts: Record<string, string> = {
            'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>inline text</t></is></c>'
                + '<c r="B1" t="s"><v>0</v></c><c r="C1" t="str"><f>A1</f><v>formula result</v></c></row></sheetData></worksheet>',
            'xl/sharedStrings.xml': '<sst><si><r><t>rich </t></r><r><t>text</t></r><rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si></sst>',
        };
        const base = makeXlsx([{ name: 'S', rows: [['x']] }]);
        const xlsx = makeZip(listEntries(base).map(e => ({ name: e.name, data: parts[e.name] ?? e.data })));
        const res = await extractText(xlsx, XLSX);
        expect(res.ok && res.text).toBe('Sheets: S\n\nSheet: S\ninline text\trich text\tformula result\n');
    });

    it('stops reading sheets at the character limit and says so', async () => {
        const rows = Array.from({ length: 500 }, (_, i) => [`row ${i}`, i]);
        const xlsx = makeXlsx([{ name: 'Big', rows }, { name: 'Never read', rows: [['unread']] }]);
        const res = await extractText(xlsx, XLSX, { ...DEFAULT_EXTRACT_LIMITS, maxChars: 300 });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.text).toContain('Sheets: Big, Never read');
        expect(res.text).not.toContain('unread');
        expect(res.truncated).toBe(true);
    });
});

describe('extractText: PowerPoint', () => {
    it('reads slides in presentation order, not file-name order', async () => {
        const res = await extractText(makePptx([['Diversifying', 'against a changing market'], ['Agenda'], ['Final tips']]), PPTX);
        expect(res).toEqual({
            ok: true,
            truncated: false,
            text: '--- Slide 1 ---\nDiversifying\nagainst a changing market\n\n--- Slide 2 ---\nAgenda\n\n--- Slide 3 ---\nFinal tips\n',
        });
    });
});

describe('extractText: untrusted Office files fail cleanly', () => {
    it('a truncated file', async () => {
        const docx = makeDocx(['Some text that will be cut off']);
        for (const cut of [docx.length - 10, Math.floor(docx.length / 2), 40]) {
            const res = await extractText(docx.subarray(0, cut), DOCX);
            expect(res, `cut at ${cut}`).toMatchObject({ ok: false, reason: 'failed' });
            expect((res as any).detail).toMatch(/^The Word document could not be read: it /);
        }
    });

    it('a zip bomb: a part that unpacks past the limit is refused, quickly', async () => {
        // 80 MB of spaces inside a <w:t>, about 80 KB deflated; the default limit is 64 MB
        const xml = Buffer.alloc(80 * 1024 * 1024, 0x20);
        xml.write('<w:document><w:body><w:p><w:r><w:t>', 0);
        const bomb = makeZip([
            { name: '[Content_Types].xml', data: '<Types/>' },
            { name: 'word/document.xml', data: Buffer.alloc(0), raw: deflateRawSync(xml), claimedSize: xml.length },
        ]);
        expect(bomb.length).toBeLessThan(200 * 1024);
        const started = Date.now();
        const res = await extractText(bomb, DOCX);
        expect(res).toEqual({ ok: false, reason: 'failed', detail: 'The Word document could not be read: it unpacks to more than 64 MB (a zip bomb?)' });
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    it('a zip bomb that lies about its size in the headers is still stopped at the limit', async () => {
        const xml = Buffer.alloc(4 * 1024 * 1024, 0x20);
        const bomb = makeZip([{ name: 'word/document.xml', data: Buffer.alloc(0), raw: deflateRawSync(xml), claimedSize: 100 }]);
        const res = await extractText(bomb, DOCX, { ...DEFAULT_EXTRACT_LIMITS, maxUnzippedBytes: 1024 * 1024 });
        expect(res).toMatchObject({ ok: false, reason: 'failed', detail: expect.stringContaining('unpacks to more than 1 MB') });
    });

    it('a zip with too many entries is refused before anything is unpacked', async () => {
        const entries = Array.from({ length: 30 }, (_, i) => ({ name: `word/media/image${i}.png`, data: 'x' }));
        const zip = makeZip([...entries, { name: 'word/document.xml', data: W('<w:t>hi</w:t>') }]);
        const res = await extractText(zip, DOCX, { ...DEFAULT_EXTRACT_LIMITS, maxZipEntries: 20 });
        expect(res).toMatchObject({ ok: false, reason: 'failed', detail: expect.stringContaining('more than 20 zip entries') });
    });

    it('a zip under the wrong Office type: each reader wants its own main part', async () => {
        const plainZip = makeZip([{ name: 'notes.txt', data: 'just a zip' }]);
        expect(await extractText(plainZip, DOCX)).toMatchObject({ ok: false, reason: 'failed', detail: expect.stringContaining('not a Word document') });
        expect(await extractText(makeDocx(['text']), XLSX)).toMatchObject({ ok: false, reason: 'failed', detail: expect.stringContaining('not an Excel workbook') });
        expect(await extractText(makeXlsx([{ name: 'S', rows: [['x']] }]), PPTX)).toMatchObject({ ok: false, reason: 'failed', detail: expect.stringContaining('not a PowerPoint presentation') });
        // Not a zip at all
        expect(await extractText(makePdf([['a pdf']]), DOCX)).toMatchObject({ ok: false, reason: 'failed', detail: expect.stringContaining('not a complete zip file') });
    });

    it('a damaged part fails cleanly', async () => {
        const zip = makeZip([{ name: 'word/document.xml', data: Buffer.alloc(0), raw: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), claimedSize: 50 }]);
        expect(await extractText(zip, DOCX)).toMatchObject({ ok: false, reason: 'failed', detail: expect.stringContaining('is damaged') });
    });

    it('gives up at the time limit instead of hanging', async () => {
        const started = Date.now();
        const res = await extractText(makeDocx(['a']), DOCX, { ...DEFAULT_EXTRACT_LIMITS, officeTimeoutMs: 1 });
        expect(res).toMatchObject({ ok: false, reason: 'failed', detail: expect.stringContaining('took longer than 1 ms') });
        expect(Date.now() - started).toBeLessThan(5000);
    });
});

describe('extractText: text-like formats', () => {
    it('a notebook gives its markdown and code cell sources, never outputs or embedded base64', async () => {
        const nb = {
            nbformat: 4,
            metadata: { kernelspec: { language: 'python' } },
            cells: [
                {
                    cell_type: 'markdown',
                    source: ['# Logistic regression\n', 'Predicting churn. ![plot](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA==)'],
                    attachments: { 'a.png': { 'image/png': 'iVBORw0KGgoAAAA' } },
                },
                {
                    cell_type: 'code',
                    source: 'import pandas as pd\nmodel.fit(X, y)',
                    outputs: [
                        { output_type: 'stream', text: ['SECRET OUTPUT LOG\n'] },
                        { output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'text/plain': ['<Figure>'] } },
                    ],
                },
                { cell_type: 'code', source: [], outputs: [] },
            ],
        };
        expect(await extractText(Buffer.from(JSON.stringify(nb)), 'application/x-ipynb+json')).toEqual({
            ok: true,
            truncated: false,
            text: '# Logistic regression\nPredicting churn. ![plot]([embedded file])\n\n```python\nimport pandas as pd\nmodel.fit(X, y)\n```',
        });
    });

    it('a notebook in the old nbformat 3 layout; a broken notebook fails', async () => {
        const v3 = { nbformat: 3, worksheets: [{ cells: [{ cell_type: 'code', input: 'print(1)', outputs: [{ text: 'NO' }] }, { cell_type: 'markdown', source: 'Notes' }] }] };
        expect(await extractText(Buffer.from(JSON.stringify(v3)), 'application/x-ipynb+json')).toEqual({ ok: true, text: '```\nprint(1)\n```\n\nNotes', truncated: false });
        expect(await extractText(Buffer.from('{"cells": [ broken'), 'application/x-ipynb+json')).toMatchObject({ ok: false, reason: 'failed', detail: 'The notebook is not valid JSON' });
        expect(await extractText(Buffer.from('{"something": "else"}'), 'application/x-ipynb+json')).toMatchObject({ ok: false, reason: 'failed' });
    });

    it('HTML loses its tags, scripts, styles and comments', async () => {
        const html = '<!DOCTYPE html><html><head><title>Week 3</title><style>p { color: red }</style><script>alert("x<y")</script></head>'
            + '<body><!-- hidden note --><h1>Decision&nbsp;trees</h1><p>Gini &amp; entropy, 5 &lt; 7.</p>'
            + '<table><tr><td>depth</td><td>3</td></tr></table><p>if a < b and c > d</p></body></html>';
        expect(await extractText(Buffer.from(html), 'text/html')).toEqual({
            ok: true, truncated: false, text: 'Week 3\n\nDecision trees\n\nGini & entropy, 5 < 7.\n\ndepth 3\n\nif a < b and c > d',
        });
    });

    it('HTML scanning stays linear on hostile input', () => {
        const started = Date.now();
        htmlToText('<'.repeat(500_000) + '<!--'.repeat(100_000) + '<script>'.repeat(10_000));
        htmlToText('<a'.repeat(300_000));
        expect(Date.now() - started).toBeLessThan(2000);
        expect(htmlToText('a &constructor; &toString; b')).toBe('a &constructor; &toString; b');
    });

    it.each([
        ['text/x-python', 'def fit(X, y):\n    return X @ y\n'],
        ['application/xml', '<?xml version="1.0"?>\n<plants><plant>Monstera</plant></plants>'],
        ['application/toml', '[project]\nname = "plantbeat"\n'],
    ])('reads %s as UTF-8 text', async (mime, text) => {
        expect(await extractText(Buffer.from(text), mime)).toEqual({ ok: true, text, truncated: false });
    });

    it('text-like types still refuse bytes that are not UTF-8', async () => {
        const junk = Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8]);
        for (const mime of ['text/x-python', 'text/html', 'application/x-ipynb+json', 'application/toml']) {
            expect(await extractText(junk, mime), mime).toMatchObject({ ok: false, reason: 'failed', detail: 'The file is not readable as UTF-8 text' });
        }
    });

    it('every type an upload can be stored under as text is extractable', () => {
        for (const mime of [...Object.values(TEXT_MIME_BY_EXTENSION), ...Object.values(OOXML_MIME_BY_EXTENSION)]) expect(isExtractable(mime), mime).toBe(true);
        expect(isExtractable('constructor')).toBe(false);
    });
});

describe('extractText: everything else', () => {
    it('images, audio, video and archives are unsupported', async () => {
        for (const mime of ['image/png', 'image/jpeg', 'audio/mpeg', 'video/mp4', 'application/zip']) {
            expect(await extractText(Buffer.from('x'), mime)).toMatchObject({ ok: false, reason: 'unsupported' });
            expect(isExtractable(mime)).toBe(false);
        }
        expect(isExtractable('application/pdf')).toBe(true);
        expect(isExtractable('text/markdown')).toBe(true);
    });

    it('an image describer, when one is registered, supplies the text', async () => {
        setImageDescriber(async (_buf, mime) => `A diagram (${mime}) of the turn-taking protocol.`);
        expect(isExtractable('image/png')).toBe(true);
        expect(await extractText(Buffer.from('x'), 'image/png')).toEqual({ ok: true, text: 'A diagram (image/png) of the turn-taking protocol.', truncated: false });
        setImageDescriber(async () => null);
        expect(await extractText(Buffer.from('x'), 'image/png')).toMatchObject({ ok: false, reason: 'empty' });
        setImageDescriber(async () => { throw new Error('vision model down'); });
        expect(await extractText(Buffer.from('x'), 'image/png')).toMatchObject({ ok: false, reason: 'failed', detail: 'vision model down' });
    });
});

describe('chunkText', () => {
    it('returns one chunk for short text', () => {
        expect(chunkText('short', 100, 8)).toEqual({ chunks: ['short'], truncated: false });
    });

    it('breaks at paragraph ends near the limit and loses nothing', () => {
        const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40)}`.trim());
        const text = paragraphs.join('\n\n');
        const { chunks, truncated } = chunkText(text, 1000, 100);
        expect(truncated).toBe(false);
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every(c => c.length <= 1000)).toBe(true);
        // Every paragraph survives whole in some chunk
        for (const p of paragraphs) expect(chunks.some(c => c.includes(p))).toBe(true);
    });

    it('splits text with no breaks at the limit', () => {
        const { chunks, truncated } = chunkText('a'.repeat(2500), 1000, 8);
        expect(chunks.map(c => c.length)).toEqual([1000, 1000, 500]);
        expect(truncated).toBe(false);
    });

    it('stops at the chunk limit and says text was left over', () => {
        const { chunks, truncated } = chunkText('a'.repeat(5000), 1000, 3);
        expect(chunks).toHaveLength(3);
        expect(truncated).toBe(true);
    });
});
