/**
 * A small read-only reader for Microsoft compound files (OLE2 / CFB, [MS-CFB]), the container
 * behind legacy .xls, .doc, .ppt and .mpp files. Upload validation uses it to see which streams
 * a compound file holds and to read the first bytes of one, so an .xls must really be a
 * workbook and not any compound file (or anything else) under that name.
 *
 * It reads only what it needs and treats every number in the file as untrusted: every sector
 * number is bounds-checked, every chain is cut off at the file's sector count (a loop in the
 * allocation table ends there), and any inconsistency makes the whole file unreadable (null).
 */

const MAGIC = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;
const NO_STREAM = 0xffffffff;
const HEADER_DIFAT_ENTRIES = 109;
const DIR_ENTRY_SIZE = 128;

const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;

export interface CfbEntry {
    name: string;
    type: number;
    start: number;
    size: number;
}

export interface CompoundFile {
    /** Streams and storages directly under the root, keyed by upper-cased name (CFB names compare case-insensitively). */
    root: Map<string, CfbEntry>;
    /** Up to `max` bytes from the start of a stream, or null when its sectors cannot be followed. */
    head(entry: CfbEntry, max: number): Buffer | null;
}

export function isCompoundFile(buf: Buffer): boolean {
    return buf.length >= 512 && buf.subarray(0, 8).equals(MAGIC);
}

/** Opens a compound file, or returns null when `buf` is not one or its structure is broken. */
export function openCompoundFile(buf: Buffer): CompoundFile | null {
    try {
        return open(buf);
    } catch {
        // A read past the end of a malformed file (RangeError) is a broken file, nothing more
        return null;
    }
}

function open(buf: Buffer): CompoundFile | null {
    if (!isCompoundFile(buf)) return null;
    if (buf.readUInt16LE(0x1c) !== 0xfffe) return null; // byte order mark
    const major = buf.readUInt16LE(0x1a);
    const shift = buf.readUInt16LE(0x1e);
    if (!((major === 3 && shift === 9) || (major === 4 && shift === 12))) return null;
    if (buf.readUInt16LE(0x20) !== 6) return null; // 64-byte mini sectors
    const sectorSize = 1 << shift;
    const perSector = sectorSize / 4;
    // Sector n starts at (n + 1) * sectorSize: the header fills sector -1. A last sector may be short.
    const sectorCount = Math.ceil((buf.length - sectorSize) / sectorSize);
    if (sectorCount <= 0) return null;
    const sector = (n: number): Buffer | null => (n < sectorCount ? buf.subarray((n + 1) * sectorSize, (n + 2) * sectorSize) : null);

    // The allocation table (FAT) lives in the sectors the DIFAT lists: 109 in the header, the rest in a chain
    const fatSectorCount = buf.readUInt32LE(0x2c);
    if (fatSectorCount > sectorCount) return null;
    const fatSectors: number[] = [];
    for (let i = 0; i < HEADER_DIFAT_ENTRIES && fatSectors.length < fatSectorCount; i++) {
        fatSectors.push(buf.readUInt32LE(0x4c + i * 4));
    }
    let difat = buf.readUInt32LE(0x44);
    for (let hops = 0; fatSectors.length < fatSectorCount; hops++) {
        if (hops >= sectorCount) return null;
        const s = sector(difat);
        if (!s || s.length < sectorSize) return null;
        for (let i = 0; i < perSector - 1 && fatSectors.length < fatSectorCount; i++) fatSectors.push(s.readUInt32LE(i * 4));
        difat = s.readUInt32LE((perSector - 1) * 4);
    }
    const fat = new Uint32Array(fatSectors.length * perSector);
    fatSectors.forEach((n, i) => {
        const s = sector(n);
        if (!s || s.length < sectorSize) throw new RangeError('FAT sector out of range');
        for (let j = 0; j < perSector; j++) fat[i * perSector + j] = s.readUInt32LE(j * 4);
    });

    /** The sector numbers of a chain, or null for a chain that leaves the file or loops. */
    const chain = (table: Uint32Array, start: number, limit: number): number[] | null => {
        const out: number[] = [];
        for (let n = start; n !== END_OF_CHAIN; n = table[n]) {
            if (n >= table.length || n >= limit || out.length >= limit) return null;
            out.push(n);
        }
        return out;
    };

    const dirChain = chain(fat, buf.readUInt32LE(0x30), sectorCount);
    if (!dirChain || !dirChain.length) return null;
    const entriesPerSector = sectorSize / DIR_ENTRY_SIZE;
    const entryCount = dirChain.length * entriesPerSector;
    const entryAt = (id: number): Buffer | null => {
        if (id >= entryCount) return null;
        const s = sector(dirChain[Math.floor(id / entriesPerSector)]);
        const off = (id % entriesPerSector) * DIR_ENTRY_SIZE;
        return s && s.length >= off + DIR_ENTRY_SIZE ? s.subarray(off, off + DIR_ENTRY_SIZE) : null;
    };
    const parse = (e: Buffer): CfbEntry => {
        const nameLength = e.readUInt16LE(0x40);
        const name = nameLength >= 2 && nameLength <= 64 ? e.toString('utf16le', 0, nameLength - 2) : '';
        // Version 3 files may leave garbage in the high half of the size
        const size = major === 3 ? e.readUInt32LE(0x78) : e.readUInt32LE(0x78) + e.readUInt32LE(0x7c) * 2 ** 32;
        return { name, type: e.readUInt8(0x42), start: e.readUInt32LE(0x74), size };
    };

    const rootRaw = entryAt(0);
    if (!rootRaw) return null;
    const rootEntry = parse(rootRaw);
    if (rootEntry.type !== TYPE_ROOT) return null;

    // The root's children form a tree through left/right sibling links; visit each entry at most once
    const root = new Map<string, CfbEntry>();
    const seen = new Set<number>();
    const stack = [rootRaw.readUInt32LE(0x4c)];
    while (stack.length) {
        const id = stack.pop()!;
        if (id === NO_STREAM || seen.has(id)) continue;
        seen.add(id);
        if (seen.size > entryCount) return null;
        const raw = entryAt(id);
        if (!raw) return null;
        const entry = parse(raw);
        if (entry.type === TYPE_STREAM || entry.type === TYPE_STORAGE) root.set(entry.name.toUpperCase(), entry);
        stack.push(raw.readUInt32LE(0x44), raw.readUInt32LE(0x48));
    }

    const miniCutoff = buf.readUInt32LE(0x38);
    let mini: { table: Uint32Array; streamSectors: number[] } | null | undefined;
    const loadMini = () => {
        const miniFatChain = chain(fat, buf.readUInt32LE(0x3c), sectorCount);
        const streamSectors = chain(fat, rootEntry.start, sectorCount);
        if (!miniFatChain || !streamSectors) return null;
        const table = new Uint32Array(miniFatChain.length * perSector);
        for (let i = 0; i < miniFatChain.length; i++) {
            const s = sector(miniFatChain[i]);
            if (!s || s.length < sectorSize) return null;
            for (let j = 0; j < perSector; j++) table[i * perSector + j] = s.readUInt32LE(j * 4);
        }
        return { table, streamSectors };
    };

    const head = (entry: CfbEntry, max: number): Buffer | null => {
        const want = Math.min(entry.size, max);
        const parts: Buffer[] = [];
        let got = 0;
        if (entry.size < miniCutoff) {
            if (mini === undefined) mini = loadMini();
            if (!mini) return null;
            const miniPerSector = sectorSize / 64;
            const limit = mini.streamSectors.length * miniPerSector;
            for (let n = entry.start, hops = 0; got < want; n = mini.table[n], hops++) {
                if (n === END_OF_CHAIN || n >= mini.table.length || n >= limit || hops >= limit) return null;
                const s = sector(mini.streamSectors[Math.floor(n / miniPerSector)]);
                const off = (n % miniPerSector) * 64;
                if (!s || s.length < off + 64) return null;
                parts.push(s.subarray(off, off + 64));
                got += 64;
            }
        } else {
            for (let n = entry.start, hops = 0; got < want; n = fat[n], hops++) {
                if (n === END_OF_CHAIN || n === FREE_SECTOR || n >= fat.length || hops >= sectorCount) return null;
                const s = sector(n);
                if (!s) return null;
                parts.push(s);
                got += s.length;
            }
        }
        return Buffer.concat(parts).subarray(0, want);
    };

    return { root, head };
}
