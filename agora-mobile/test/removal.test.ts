// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { removeServer } from '../src/lib/removal';
import { handleKey, LAST_SERVER_KEY, ServerStore, type SavedServer } from '../src/lib/servers';
import { memoryKv } from './helpers';

const A = { origin: 'https://a.example.com', name: 'A' };
const B = { origin: 'https://b.example.com', name: 'B' };

function setup(withHandle: boolean) {
    const kv = memoryKv(withHandle ? { [handleKey(A.origin)]: 'h'.repeat(43) } : {});
    const store = new ServerStore(kv);
    const list = document.createElement('ul');
    const status = document.createElement('p');
    const events: string[] = [];
    const render = (servers: SavedServer[]) =>
        list.replaceChildren(...servers.map((s) => Object.assign(document.createElement('li'), { textContent: s.name })));
    const deps = {
        store,
        kv,
        deleteRelayHandle: vi.fn(async (_handle: string) => { events.push(`relay:${list.children.length}`); }),
        serversChanged: vi.fn(async () => { events.push(`serversChanged:${list.children.length}`); }),
        shown: (servers: SavedServer[], text: string) => {
            render(servers);
            status.textContent = text;
            events.push(`shown:${text}`);
        },
    };
    return { kv, store, list, status, events, deps, render };
}

describe('removeServer', () => {
    it('drops the row and says so before the relay call and serversChanged', async () => {
        const t = setup(true);
        await t.store.add(A);
        await t.store.add(B);
        t.render(await t.store.list());
        expect(t.list.children).toHaveLength(2);

        await removeServer(A, t.deps);

        expect(t.events).toEqual(['shown:Removed A.', 'relay:1', 'serversChanged:1']);
        expect(t.list.textContent).toBe('B');
        expect(t.status.textContent).toBe('Removed A.');
        expect(await t.store.origins()).toEqual([B.origin]);
        expect(t.kv.data.has(handleKey(A.origin))).toBe(false);
    });

    it('still forgets the handle and re-scopes when the relay is unreachable', async () => {
        const t = setup(true);
        await t.store.add(A);
        t.deps.deleteRelayHandle.mockRejectedValueOnce(new Error('failed to connect'));
        await removeServer(A, t.deps);
        expect(t.kv.data.has(handleKey(A.origin))).toBe(false);
        expect(t.deps.serversChanged).toHaveBeenCalledOnce();
    });

    it('skips the relay without a handle', async () => {
        const t = setup(false);
        await t.store.add(A);
        await removeServer(A, t.deps);
        expect(t.deps.deleteRelayHandle).not.toHaveBeenCalled();
        expect(t.events).toEqual(['shown:Removed A.', 'serversChanged:0']);
    });

    // Codex review: once the saved list has changed, native must always re-read it.
    it.each([
        ['reading the handle fails', (t: ReturnType<typeof setup>) => { const get = t.kv.get; t.kv.get = async (o) => { if (o.key === handleKey(A.origin)) throw new Error('get failed'); return get(o); }; }],
        ['clearing the handle fails', (t: ReturnType<typeof setup>) => { const remove = t.kv.remove; t.kv.remove = async (o) => { if (o.key === handleKey(A.origin)) throw new Error('remove failed'); return remove(o); }; }],
    ])('still calls serversChanged when %s, and says it failed', async (_name, breakKv) => {
        const t = setup(true);
        await t.store.add(A);
        await t.store.add(B);
        breakKv(t);
        await expect(removeServer(A, t.deps)).rejects.toThrow();
        expect((await t.store.list()).map((s) => s.name)).toEqual(['B']);
        expect(t.deps.serversChanged).toHaveBeenCalledOnce();
        expect(t.status.textContent).toBe("Couldn't finish removing A. Try again.");
    });

    it('still calls serversChanged when ServerStore.remove rejects after saving the list', async () => {
        const t = setup(false);
        await t.store.add(A);
        await t.store.add(B);
        t.kv.data.set(LAST_SERVER_KEY, A.origin);
        const remove = t.kv.remove;
        t.kv.remove = async (o) => { if (o.key === LAST_SERVER_KEY) throw new Error('remove failed'); return remove(o); };
        await expect(removeServer(A, t.deps)).rejects.toThrow('remove failed');
        expect((await t.store.list()).map((s) => s.name)).toEqual(['B']);
        expect(t.deps.serversChanged).toHaveBeenCalledOnce();
        expect(t.list.children).toHaveLength(1);
        expect(t.status.textContent).toBe("Couldn't finish removing A. Try again.");
    });
});
