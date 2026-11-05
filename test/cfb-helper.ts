/**
 * Builds small Microsoft compound files (OLE2 / CFB version 3, [MS-CFB]) for tests: the
 * container of legacy .xls, .doc, .ppt and .mpp files. Streams under 4096 bytes go into the
 * mini stream, as real writers do; larger ones get regular sectors.
 *
 * Layout: sector 0 is the FAT, then the directory, the mini FAT, the mini stream, then the
 * large streams. Tests that corrupt a file rely on sector 0 (FAT) and 1 (directory).
 */

const SECTOR = 512;
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;
const FAT_SECTOR = 0xfffffffd;
const NO_STREAM = 0xffffffff;

export interface CfbStream { name: string; data: Buffer }

export function makeCfb(streams: CfbStream[]): Buffer {
    const sectorsFor = (n: number) => Math.ceil(n / SECTOR);
    const small = streams.filter(s => s.data.length < 4096);
    const large = streams.filter(s => s.data.length >= 4096);

    // Mini stream: each small stream padded to 64-byte mini sectors
    const miniStarts: number[] = [];
    const miniParts: Buffer[] = [];
    const miniFat: number[] = [];
    for (const s of small) {
        const count = Math.max(1, Math.ceil(s.data.length / 64));
        miniStarts.push(miniFat.length);
        for (let i = 0; i < count; i++) miniFat.push(i === count - 1 ? END_OF_CHAIN : miniFat.length + 1);
        const padded = Buffer.alloc(count * 64);
        s.data.copy(padded);
        miniParts.push(padded);
    }
    const miniStream = Buffer.concat(miniParts);

    const dirEntries = 1 + streams.length;
    const dirSectors = sectorsFor(dirEntries * 128);
    const miniFatSectors = small.length ? sectorsFor(miniFat.length * 4) : 0;
    const miniStreamSectors = sectorsFor(miniStream.length);
    let next = 1;
    const dirStart = next; next += dirSectors;
    const miniFatStart = miniFatSectors ? next : END_OF_CHAIN; next += miniFatSectors;
    const miniStreamStart = miniStreamSectors ? next : END_OF_CHAIN; next += miniStreamSectors;
    const largeStarts = large.map(s => { const at = next; next += sectorsFor(s.data.length); return at; });
    const total = next;
    if (total > SECTOR / 4) throw new Error('makeCfb: file too large for one FAT sector');

    const fat = new Array<number>(SECTOR / 4).fill(FREE);
    fat[0] = FAT_SECTOR;
    const link = (start: number, count: number) => {
        for (let i = 0; i < count; i++) fat[start + i] = i === count - 1 ? END_OF_CHAIN : start + i + 1;
    };
    link(dirStart, dirSectors);
    if (miniFatSectors) link(miniFatStart, miniFatSectors);
    if (miniStreamSectors) link(miniStreamStart, miniStreamSectors);
    large.forEach((s, i) => link(largeStarts[i], sectorsFor(s.data.length)));

    const header = Buffer.alloc(SECTOR);
    Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header, 0);
    header.writeUInt16LE(0x3e, 0x18);
    header.writeUInt16LE(3, 0x1a);
    header.writeUInt16LE(0xfffe, 0x1c);
    header.writeUInt16LE(9, 0x1e);
    header.writeUInt16LE(6, 0x20);
    header.writeUInt32LE(1, 0x2c); // one FAT sector
    header.writeUInt32LE(dirStart, 0x30);
    header.writeUInt32LE(4096, 0x38);
    header.writeUInt32LE(miniFatStart, 0x3c);
    header.writeUInt32LE(miniFatSectors, 0x40);
    header.writeUInt32LE(END_OF_CHAIN, 0x44);
    for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : FREE, 0x4c + i * 4);

    const entry = (name: string, type: number, start: number, size: number, right: number, child: number) => {
        const e = Buffer.alloc(128);
        e.write(name, 0, 'utf16le');
        e.writeUInt16LE(name ? (name.length + 1) * 2 : 0, 0x40);
        e.writeUInt8(type, 0x42);
        e.writeUInt8(1, 0x43); // black
        e.writeUInt32LE(NO_STREAM, 0x44);
        e.writeUInt32LE(right, 0x48);
        e.writeUInt32LE(child, 0x4c);
        e.writeUInt32LE(start, 0x74);
        e.writeUInt32LE(size, 0x78);
        return e;
    };
    const dir: Buffer[] = [entry('Root Entry', 5, miniStreamStart, miniStream.length, NO_STREAM, streams.length ? 1 : NO_STREAM)];
    streams.forEach((s, i) => {
        const start = s.data.length < 4096 ? miniStarts[small.indexOf(s)] : largeStarts[large.indexOf(s)];
        dir.push(entry(s.name, 2, start, s.data.length, i + 1 < streams.length ? i + 2 : NO_STREAM, NO_STREAM));
    });
    while (dir.length < dirSectors * 4) dir.push(entry('', 0, 0, 0, NO_STREAM, NO_STREAM));

    const pad = (b: Buffer, sectors: number) => { const out = Buffer.alloc(sectors * SECTOR); b.copy(out); return out; };
    const fatBuf = Buffer.alloc(SECTOR);
    fat.forEach((v, i) => fatBuf.writeUInt32LE(v >>> 0, i * 4));
    const miniFatBuf = Buffer.alloc(miniFatSectors * SECTOR, 0xff);
    miniFat.forEach((v, i) => miniFatBuf.writeUInt32LE(v >>> 0, i * 4));
    return Buffer.concat([
        header, fatBuf, Buffer.concat(dir), miniFatBuf, pad(miniStream, miniStreamSectors),
        ...large.map(s => pad(s.data, sectorsFor(s.data.length))),
    ]);
}
