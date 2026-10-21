import zlib from 'node:zlib';

/**
 * A valid all-black 8-bit grayscale PNG of any size, built in memory. Large dimensions stay
 * tiny on disk (a 41 MP image deflates to tens of KB), so the oversized-image fixture is
 * generated at runtime instead of committed.
 */
export function blankPng(width: number, height: number): Buffer {
    const row = width + 1;                       // filter byte + one byte per pixel
    const raw = Buffer.alloc(row * height);      // all zero: filter 0, black pixels
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 0;   // grayscale
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** 5x7 glyphs (rows top to bottom, 5 bits each) for the characters textPng() can draw. */
const GLYPHS: Record<string, number[]> = {
    '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
    '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
    '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
    '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
    '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
    'E': [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
    ' ': [0, 0, 0, 0, 0, 0, 0],
};

/**
 * A PNG with `text` drawn in black on white (5x7 pixel font, each pixel `scale` px), built in
 * memory so an image-reading test needs no committed fixture. Digits, E, - and space only.
 */
export function textPng(text: string, scale = 16): Buffer {
    const pad = 2, cols = text.length * 6 - 1 + pad * 2, rows = 7 + pad * 2;
    const width = cols * scale, height = rows * scale;
    const row = width + 1;
    const raw = Buffer.alloc(row * height, 0xff);
    for (let y = 0; y < height; y++) raw[y * row] = 0;  // filter byte
    [...text].forEach((ch, i) => {
        const g = GLYPHS[ch];
        if (!g) throw new Error(`textPng: no glyph for ${JSON.stringify(ch)}`);
        for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) {
            if (!(g[gy] & (0x10 >> gx))) continue;
            const x0 = (pad + i * 6 + gx) * scale, y0 = (pad + gy) * scale;
            for (let y = y0; y < y0 + scale; y++) raw.fill(0, y * row + 1 + x0, y * row + 1 + x0 + scale);
        }
    });
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 0;   // grayscale
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
