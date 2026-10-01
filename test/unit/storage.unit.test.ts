import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { diskStore } from '../../src/lib/storage';

let root: string;

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'agora-storage-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('diskStore', () => {
    const key = '01CHANNEL/01FILE/report final.pdf';

    it('puts, gets, and removes blobs by key', async () => {
        const store = diskStore(root);
        await store.init();
        await store.put(key, Buffer.from('encrypted-bytes'));

        expect((await store.get(key))?.toString()).toBe('encrypted-bytes');
        expect(await fs.readFile(path.join(root, '01CHANNEL', '01FILE', 'report final.pdf'), 'utf8')).toBe('encrypted-bytes');

        await store.remove(key);
        expect(await store.get(key)).toBeNull();
        // Empty per-file and per-channel directories are cleaned up, the root stays
        expect(await fs.readdir(root)).toEqual([]);
    });

    it('a missing blob reads as null and removing it is not an error', async () => {
        const store = diskStore(root);
        expect(await store.get('nope/nope/x')).toBeNull();
        await expect(store.remove('nope/nope/x')).resolves.toBeUndefined();
    });

    it('overwrites atomically and leaves no temp files', async () => {
        const store = diskStore(root);
        await store.put(key, Buffer.from('one'));
        await store.put(key, Buffer.from('two'));
        expect((await store.get(key))?.toString()).toBe('two');
        expect(await fs.readdir(path.join(root, '01CHANNEL', '01FILE'))).toEqual(['report final.pdf']);
    });

    it('keeps sibling files when one is removed', async () => {
        const store = diskStore(root);
        await store.put('c/f1/a.txt', Buffer.from('a'));
        await store.put('c/f2/b.txt', Buffer.from('b'));
        await store.remove('c/f1/a.txt');
        expect((await store.get('c/f2/b.txt'))?.toString()).toBe('b');
        expect(await fs.readdir(path.join(root, 'c'))).toEqual(['f2']);
    });

    it('rejects keys that could escape the root', async () => {
        const store = diskStore(root);
        for (const bad of ['../x', 'a/../../x', '/abs', 'a//b', 'a/./b', 'a\\..\\b', '', 'a/b\0c']) {
            await expect(store.put(bad, Buffer.from('x')), bad).rejects.toThrow('Invalid storage key');
            await expect(store.get(bad), bad).rejects.toThrow('Invalid storage key');
        }
    });
});
