import { describe, it, expect, afterEach } from 'vitest';
import { chunkText, extractText, isExtractable, setImageDescriber, DEFAULT_EXTRACT_LIMITS } from '../../src/lib/text-extract';
import { makePdf } from '../pdf-helper';

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
