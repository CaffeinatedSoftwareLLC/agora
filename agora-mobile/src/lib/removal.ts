import { handleKey, type KeyValueStore, type SavedServer, type ServerStore } from './servers';

export interface RemoveDeps {
    store: Pick<ServerStore, 'remove' | 'list'>;
    kv: KeyValueStore;
    /** Best-effort DELETE of the push handle at the relay. */
    deleteRelayHandle(handle: string): Promise<void>;
    /** AgoraShell.serversChanged: on Android the picker reloads after it. */
    serversChanged(): Promise<void>;
    /** Show the new list and status line now (and keep the line for after the reload). */
    shown(servers: SavedServer[], status: string): void;
}

/**
 * Remove a saved server. The list is written and shown first, so the row disappears
 * at once; the relay call and the native re-scope (blank page, picker reload) follow.
 * The relay call still comes before serversChanged, which unloads this page on Android.
 *
 * serversChanged runs even when a step fails: the saved list may already have changed
 * (ServerStore.remove can reject after saving), and native must never keep trusting an
 * origin the list no longer has. The failure is then shown instead of "Removed …".
 */
export async function removeServer(server: SavedServer, deps: RemoveDeps): Promise<void> {
    let failure: unknown = null;
    let servers: SavedServer[] | null = null;
    try {
        servers = await deps.store.remove(server.origin);
        deps.shown(servers, `Removed ${server.name}.`);
        const key = handleKey(server.origin);
        const handle = (await deps.kv.get({ key })).value;
        if (handle) {
            // Best effort: stop the relay forwarding this server's pushes to the phone.
            await deps.deleteRelayHandle(handle).catch(() => undefined);
            await deps.kv.remove({ key });
        }
    } catch (err) {
        failure = err;
        const current = servers ?? (await deps.store.list().catch(() => null));
        if (current) deps.shown(current, `Couldn't finish removing ${server.name}. Try again.`);
    }
    await deps.serversChanged();
    if (failure) throw failure;
}
