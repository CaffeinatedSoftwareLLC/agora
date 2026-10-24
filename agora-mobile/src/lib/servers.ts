import { normalizeOrigin } from './origin';

/**
 * Storage keys shared with the native code. The native AgoraShell plugins read
 * SERVERS_KEY straight from Capacitor Preferences storage (Android
 * SharedPreferences "CapacitorStorage", iOS UserDefaults "CapacitorStorage.<key>"),
 * and only let instance pages touch `HANDLE_KEY_PREFIX + <their own origin>`.
 * Change them in both places or not at all.
 */
export const SERVERS_KEY = 'agora.servers';
export const LAST_SERVER_KEY = 'agora.lastServer';
export const HANDLE_KEY_PREFIX = 'agora.push.';

export function handleKey(origin: string): string {
    return HANDLE_KEY_PREFIX + origin;
}

/** The subset of @capacitor/preferences the shell uses. */
export interface KeyValueStore {
    get(options: { key: string }): Promise<{ value: string | null }>;
    set(options: { key: string; value: string }): Promise<void>;
    remove(options: { key: string }): Promise<void>;
}

export interface SavedServer {
    origin: string;
    name: string;
}

/** Parse the stored list, dropping anything that is not a valid saved server. */
export function parseServers(raw: string | null): SavedServer[] {
    if (!raw) return [];
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const servers: SavedServer[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const { origin, name } = entry as Record<string, unknown>;
        if (typeof origin !== 'string' || normalizeOrigin(origin) !== origin || seen.has(origin)) continue;
        seen.add(origin);
        servers.push({ origin, name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : new URL(origin).host });
    }
    return servers;
}

export class ServerStore {
    constructor(private readonly kv: KeyValueStore) {}

    async list(): Promise<SavedServer[]> {
        return parseServers((await this.kv.get({ key: SERVERS_KEY })).value);
    }

    async origins(): Promise<string[]> {
        return (await this.list()).map((s) => s.origin);
    }

    /** Add or rename a server. `origin` must already be normalised. */
    async add(server: SavedServer): Promise<SavedServer[]> {
        if (normalizeOrigin(server.origin) !== server.origin) throw new Error('invalid_origin');
        const servers = (await this.list()).filter((s) => s.origin !== server.origin);
        servers.push({ origin: server.origin, name: server.name.trim().slice(0, 80) || new URL(server.origin).host });
        await this.save(servers);
        return servers;
    }

    async remove(origin: string): Promise<SavedServer[]> {
        const servers = (await this.list()).filter((s) => s.origin !== origin);
        await this.save(servers);
        if ((await this.lastUsed()) === origin) await this.kv.remove({ key: LAST_SERVER_KEY });
        return servers;
    }

    async lastUsed(): Promise<string | null> {
        return (await this.kv.get({ key: LAST_SERVER_KEY })).value;
    }

    async setLastUsed(origin: string): Promise<void> {
        await this.kv.set({ key: LAST_SERVER_KEY, value: origin });
    }

    private async save(servers: SavedServer[]): Promise<void> {
        await this.kv.set({ key: SERVERS_KEY, value: JSON.stringify(servers) });
    }
}
