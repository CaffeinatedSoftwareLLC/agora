import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Minimal Word, Excel and PowerPoint files for tests, built as real zips with no
 * dependencies: just the parts a reader needs, laid out the way Office writes them
 * ([Content_Types].xml first). `makeZip` builds any zip, including broken ones.
 */

export interface ZipEntry {
    name: string;
    data: string | Buffer;
    /** Store instead of deflate. */
    store?: boolean;
    /** Claim this uncompressed size in the headers instead of the real one. */
    claimedSize?: number;
    /** Use these bytes as the compressed data (to build bombs without allocating them twice). */
    raw?: Buffer;
    /** Sizes and CRC in a data descriptor after the data, zero in the local header (as Google Docs writes). */
    descriptor?: boolean;
}

export function makeZip(entries: ZipEntry[]): Buffer {
    const locals: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const plain = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data;
        const method = e.store ? 0 : 8;
        const body = e.raw ?? (e.store ? plain : deflateRawSync(plain));
        const name = Buffer.from(e.name, 'utf8');
        const size = e.claimedSize ?? plain.length;
        const crc = crc32(plain);

        const flags = 0x0800 | (e.descriptor ? 0x0008 : 0); // UTF-8 names
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        if (!e.descriptor) {
            local.writeUInt32LE(crc, 14);
            local.writeUInt32LE(body.length, 18);
            local.writeUInt32LE(size, 22);
        }
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, body);
        let descriptorLength = 0;
        if (e.descriptor) {
            const d = Buffer.alloc(16);
            d.writeUInt32LE(0x08074b50, 0);
            d.writeUInt32LE(crc, 4);
            d.writeUInt32LE(body.length, 8);
            d.writeUInt32LE(size, 12);
            locals.push(d);
            descriptorLength = d.length;
        }

        const dir = Buffer.alloc(46);
        dir.writeUInt32LE(0x02014b50, 0);
        dir.writeUInt16LE(20, 4);
        dir.writeUInt16LE(20, 6);
        dir.writeUInt16LE(flags, 8);
        dir.writeUInt16LE(method, 10);
        dir.writeUInt32LE(crc, 16);
        dir.writeUInt32LE(body.length, 20);
        dir.writeUInt32LE(size, 24);
        dir.writeUInt16LE(name.length, 28);
        dir.writeUInt32LE(offset, 42);
        central.push(dir, name);

        offset += 30 + name.length + body.length + descriptorLength;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function contentTypes(main: string, mainType: string, overrides: [string, string][] = []): string {
    return XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + `<Override PartName="/${main}" ContentType="${mainType}"/>`
        + overrides.map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join('')
        + '</Types>';
}
const rootRels = (main: string) => XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="${main}"/></Relationships>`;
const partRels = (rels: [string, string, string][]) => XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('') + '</Relationships>';

/**
 * A .docx with one paragraph per entry, or `bodyXml` as the body. `googleDocs` lays it
 * out as a Google Docs export does: word/ parts first, [Content_Types].xml last, and
 * sizes in data descriptors.
 */
export function makeDocx(paragraphs: string[], opts: { bodyXml?: string; parts?: ZipEntry[]; googleDocs?: boolean } = {}): Buffer {
    const body = opts.bodyXml ?? paragraphs.map(p => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('');
    const types: ZipEntry = { name: '[Content_Types].xml', data: contentTypes('word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') };
    const rest: ZipEntry[] = [
        { name: 'word/document.xml', data: XML + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${body}</w:body></w:document>` },
        ...(opts.parts ?? []),
        { name: '_rels/.rels', data: rootRels('word/document.xml') },
    ];
    if (!opts.googleDocs) return makeZip([types, ...rest]);
    return makeZip([...rest, types].map(e => ({ ...e, descriptor: true })));
}

/** A .xlsx: each sheet a name and rows of cells. Strings go to the shared string table. */
export function makeXlsx(sheets: { name: string; rows: (string | number | boolean | null)[][] }[]): Buffer {
    const shared: string[] = [];
    const col = (i: number) => String.fromCharCode(65 + i);
    const sheetXml = sheets.map(sheet => XML + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
        + sheet.rows.map((row, r) => `<row r="${r + 1}">` + row.map((v, c) => {
            const ref = `${col(c)}${r + 1}`;
            if (v === null) return `<c r="${ref}"/>`;
            if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
            if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
            shared.push(v);
            return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
        }).join('') + '</row>').join('')
        + '</sheetData></worksheet>');
    return makeZip([
        { name: '[Content_Types].xml', data: contentTypes('xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
            sheets.map((_, i) => [`xl/worksheets/sheet${i + 1}.xml`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'])) },
        { name: '_rels/.rels', data: rootRels('xl/workbook.xml') },
        { name: 'xl/workbook.xml', data: XML + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>`
            + sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>' },
        { name: 'xl/_rels/workbook.xml.rels', data: partRels([
            ...sheets.map((_, i): [string, string, string] => [`rId${i + 1}`, 'worksheet', `worksheets/sheet${i + 1}.xml`]),
            [`rId${sheets.length + 1}`, 'sharedStrings', 'sharedStrings.xml'],
        ]) },
        ...sheetXml.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
        { name: 'xl/sharedStrings.xml', data: XML + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">`
            + shared.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('') + '</sst>' },
    ]);
}

/**
 * A .pptx: each slide a list of paragraphs. Slide parts are numbered in reverse of the
 * presentation order, so a reader that sorts by file name instead of following
 * presentation.xml gets the order wrong.
 */
export function makePptx(slides: string[][]): Buffer {
    const n = slides.length;
    const part = (i: number) => `slide${n - i}.xml`;
    return makeZip([
        { name: '[Content_Types].xml', data: contentTypes('ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
            slides.map((_, i) => [`ppt/slides/${part(i)}`, 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'])) },
        { name: '_rels/.rels', data: rootRels('ppt/presentation.xml') },
        { name: 'ppt/presentation.xml', data: XML + `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>`
            + slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('') + '</p:sldIdLst></p:presentation>' },
        { name: 'ppt/_rels/presentation.xml.rels', data: partRels(slides.map((_, i): [string, string, string] => [`rId${i + 1}`, 'slide', `slides/${part(i)}`])) },
        ...slides.map((paras, i) => ({
            name: `ppt/slides/${part(i)}`,
            data: XML + '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>'
                + paras.map(t => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${esc(t)}</a:t></a:r></a:p>`).join('')
                + '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
        })),
    ]);
}
