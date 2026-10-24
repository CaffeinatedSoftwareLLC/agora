import { describe, expect, test } from 'vitest';
import { readUploadPart } from '../../src/lib/file-store';

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
