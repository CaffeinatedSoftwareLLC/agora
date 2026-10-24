import { describe, expect, it } from 'vitest';
import { handleKey, LAST_SERVER_KEY, parseServers, ServerStore, SERVERS_KEY } from '../src/lib/servers';
import { memoryKv } from './helpers';

describe('parseServers', () => {
    it('keeps valid entries and drops the rest', () => {
        const raw = JSON.stringify([
            { origin: 'https://a.example.com', name: 'A' },
            { origin: 'https://a.example.com', name: 'duplicate' },
            { origin: 'http://b.example.com', name: 'B' },
            { origin: 'https://c.example.com/path', name: 'C' },
            { origin: 'https://d.example.com' },
            null,
            'x',
        ]);
        expect(parseServers(raw)).toEqual([
            { origin: 'https://a.example.com', name: 'A' },
            { origin: 'https://d.example.com', name: 'd.example.com' },
        ]);
    });

    it('treats corrupt storage as empty', () => {
        expect(parseServers(null)).toEqual([]);
        expect(parseServers('{')).toEqual([]);
        expect(parseServers('{"origin":"https://a.example.com"}')).toEqual([]);
    });
});

describe('ServerStore', () => {
    it('adds, renames and removes servers', async () => {
        const kv = memoryKv();
        const store = new ServerStore(kv);
        await store.add({ origin: 'https://a.example.com', name: 'A' });
        await store.add({ origin: 'https://b.example.com', name: 'B' });
        await store.add({ origin: 'https://a.example.com', name: 'A renamed' });
        expect(await store.list()).toEqual([
            { origin: 'https://b.example.com', name: 'B' },
            { origin: 'https://a.example.com', name: 'A renamed' },
        ]);
        expect(JSON.parse(kv.data.get(SERVERS_KEY)!)).toHaveLength(2);

        await store.setLastUsed('https://a.example.com');
        await store.remove('https://a.example.com');
        expect(await store.origins()).toEqual(['https://b.example.com']);
        expect(kv.data.has(LAST_SERVER_KEY)).toBe(false);
    });

    it('refuses an origin that is not normalised', async () => {
        const store = new ServerStore(memoryKv());
        await expect(store.add({ origin: 'https://A.example.com/', name: 'A' })).rejects.toThrow('invalid_origin');
        await expect(store.add({ origin: 'http://a.example.com', name: 'A' })).rejects.toThrow('invalid_origin');
    });

    it('keys push handles by exact origin', () => {
        expect(handleKey('https://a.example.com')).toBe('agora.push.https://a.example.com');
    });
});
