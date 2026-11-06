import { describe, expect, test } from 'vitest';
import { readUploadPart, readLimitFor, MAX_FILE_SIZE_SETTING } from '../../src/lib/file-store';

// @fastify/multipart's toBuffer() can return a file cut to exactly the size limit without
// throwing (it checks `truncated` only between chunks). readUploadPart must refuse those.
describe('readUploadPart', () => {
    const part = (bytes: number, truncated: boolean) => ({
        toBuffer: async () => Buffer.alloc(bytes, 'x'),
        file: { truncated },
    });

    test('returns the buffer for a complete file', async () => {
        const buf = await readUploadPart(part(1024, false));
        expect(buf?.length).toBe(1024);
    });

    test('returns null when the parser cut the file off at the limit', async () => {
        expect(await readUploadPart(part(26214400, true))).toBeNull();
    });

    test('a missing truncated flag counts as complete', async () => {
        const buf = await readUploadPart({ toBuffer: async () => Buffer.from('ok'), file: {} });
        expect(buf?.toString()).toBe('ok');
    });

    test('errors from toBuffer still propagate (e.g. RequestFileTooLargeError)', async () => {
        const failing = { toBuffer: async () => { throw new Error('too large'); }, file: { truncated: true } };
        await expect(readUploadPart(failing)).rejects.toThrow('too large');
    });
});

// #206: a 4 MB upload got 201 under a 3 MB setting. Multipart read exactly 3 MB and the size
// check (`length > setting`) let it through. Reading one byte past the setting means a file cut
// off at the read limit is always over the setting, whether or not `truncated` is seen.
describe('readLimitFor', () => {
    test('one byte past the setting', () => {
        expect(readLimitFor(3 * 1024 * 1024)).toBe(3 * 1024 * 1024 + 1);
        expect(readLimitFor(1024)).toBe(1025);
    });

    test('no usable setting: one byte past the largest value the settings API accepts', () => {
        for (const bad of [NaN, 0, -5, 1.5, Number.MAX_SAFE_INTEGER + 2]) expect(readLimitFor(bad)).toBe(MAX_FILE_SIZE_SETTING + 1);
    });
});
