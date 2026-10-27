import { handleKey, type KeyValueStore, type SavedServer, type ServerStore } from './servers';

export interface RemoveDeps {
    store: Pick<ServerStore, 'remove'>;
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
 */
export async function removeServer(server: SavedServer, deps: RemoveDeps): Promise<void> {
    const servers = await deps.store.remove(server.origin);
    deps.shown(servers, `Removed ${server.name}.`);
    const key = handleKey(server.origin);
    const handle = (await deps.kv.get({ key })).value;
    if (handle) {
        // Best effort: stop the relay forwarding this server's pushes to the phone.
        await deps.deleteRelayHandle(handle).catch(() => undefined);
        await deps.kv.remove({ key });
    }
    await deps.serversChanged();
}
