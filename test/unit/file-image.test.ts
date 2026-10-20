import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { fitImage, IMAGE_MAX_SOURCE_BYTES } from '../../src/lib/file-image';

/** Scaling and capping images for a model (issue #117). */

const solid = (width: number, height: number, format: 'png' | 'jpeg' | 'webp' | 'gif' = 'png') =>
    sharp({ create: { width, height, channels: 3, background: '#4a8' } })[format]().toBuffer();
/** Random pixels, so the image does not compress well. */
const noise = (width: number, height: number) => {
    const raw = randomBytes(width * height * 3);
    return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
};

describe('fitImage', () => {
    test('passes a small image through untouched', async () => {
        const png = await solid(100, 50);
        const out = await fitImage(png, 'image/png');
        expect(out).toMatchObject({ ok: true, resized: false, mime: 'image/png', width: 100, height: 50 });
        if (out.ok) expect(out.buffer).toBe(png);
    });

    test('scales the longest side down to the limit, keeping the format', async () => {
        for (const [format, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']] as const) {
            const out = await fitImage(await solid(1000, 4000, format), mime, { maxSide: 500 });
            expect(out).toMatchObject({ ok: true, resized: true, mime, width: 125, height: 500, originalWidth: 1000, originalHeight: 4000 });
            if (out.ok) expect((await sharp(out.buffer).metadata()).height).toBe(500);
        }
    });

    test('a resized GIF becomes a PNG of its first frame', async () => {
        const out = await fitImage(await solid(800, 600, 'gif'), 'image/gif', { maxSide: 400 });
        expect(out).toMatchObject({ ok: true, mime: 'image/png', width: 400, height: 300 });
    });

    test('an image over the byte cap is re-encoded and shrunk until it fits', async () => {
        const png = await noise(600, 600);
        const maxBytes = 40_000;
        expect(png.length).toBeGreaterThan(maxBytes);
        const out = await fitImage(png, 'image/png', { maxBytes });
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.buffer.length).toBeLessThanOrEqual(maxBytes);
            expect(out.mime).toBe('image/jpeg');
            expect(out.resized).toBe(true);
        }
    });

    test('refuses when even the smallest size does not fit', async () => {
        const out = await fitImage(await noise(600, 600), 'image/png', { maxBytes: 100 });
        expect(out).toMatchObject({ ok: false, status: 413 });
    });

    test('refuses images with too many pixels from the header, before decoding', async () => {
        const png = await solid(2000, 2000);
        const spy = vi.spyOn(sharp.prototype, 'toBuffer');
        const out = await fitImage(png, 'image/png', { maxPixels: 1_000_000 });
        expect(out).toMatchObject({ ok: false, status: 413 });
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    test('refuses oversized source files and garbage', async () => {
        expect(await fitImage(Buffer.alloc(IMAGE_MAX_SOURCE_BYTES + 1), 'image/png')).toMatchObject({ ok: false, status: 413 });
        expect(await fitImage(Buffer.from('not an image'), 'image/png')).toMatchObject({ ok: false, status: 422 });
    });
});
