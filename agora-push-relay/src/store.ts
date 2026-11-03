import { DatabaseSync } from 'node:sqlite';
import { hashHandle, newHandle, open, sameSecret, seal, type Keys } from './crypto.js';

export type Platform = 'android' | 'ios';

export interface Registration {
    handleHash: string;
    platform: Platform;
    instance: string;
    token: string;
}

export interface Row {
    handle_hash: string;
    platform: Platform;
    sealed: Uint8Array;
}

/** What app.ts and index.ts use. SqliteHandleStore (here) and PgHandleStore (store-pg.ts) implement it. */
export interface HandleStore {
    register(platform: Platform, instance: string, token: string, now?: number): Promise<string>;
    renew(handle: string, platform: Platform, instance: string, token: string, now?: number): Promise<boolean>;
    lookup(handle: string): Promise<Registration | null>;
    /** Refreshes seen_at. False when the row is gone. */
    touch(handleHash: string, now?: number): Promise<boolean>;
    deleteByHash(handleHash: string): Promise<boolean>;
    /** Removes handles neither registered nor pushed to since `cutoff` (ms). Returns how many. */
    pruneSeenBefore(cutoff: number): Promise<number>;
    count(): Promise<number>;
    close(): Promise<void>;
}

/**
 * One row per handle. The key is SHA-256(handle); the raw handle is never stored.
 * The device token and the instance origin are sealed together with AES-256-GCM, the
 * row's key as associated data. Only the platform is in the clear.
 *
 * Every registration gets a new random handle, even for a token and instance that are
 * already registered, and the existing handles stay valid. Nothing in a row links it to
 * the other handles for the same token, so the relay cannot hand an existing handle to
 * whoever registers next, and registering cannot revoke someone else's handle.
 *
 * The one exception is `renew`: a caller that already holds a handle can name it when it
 * registers again, and gets the same handle back if it still matches. That tells the
 * caller nothing it did not know, and lets the app notice when a handle it cached is gone.
 *
 * These rules live here, shared by both databases. A subclass only stores and fetches
 * rows of the same table (handle_hash, platform, sealed, created_at, seen_at in ms).
 */
export abstract class SealedHandleStore implements HandleStore {
    constructor(private readonly keys: Keys) {}

    protected abstract insert(handleHash: string, platform: Platform, sealed: Buffer, now: number): Promise<void>;
    protected abstract row(handleHash: string): Promise<Row | undefined>;
    abstract touch(handleHash: string, now?: number): Promise<boolean>;
    abstract deleteByHash(handleHash: string): Promise<boolean>;
    abstract pruneSeenBefore(cutoff: number): Promise<number>;
    abstract count(): Promise<number>;
    abstract close(): Promise<void>;

    /** Stores a new registration under a new random handle and returns the handle. */
    async register(platform: Platform, instance: string, token: string, now = Date.now()): Promise<string> {
        const handle = newHandle();
        const handleHash = hashHandle(handle);
        const sealed = seal(this.keys.sealKey, JSON.stringify({ t: token, i: instance }), handleHash);
        await this.insert(handleHash, platform, sealed, now);
        return handle;
    }

    /**
     * Re-registration naming a handle the caller already holds. True, and seen_at refreshed,
     * only if the handle's row exists, opens under the current key, and holds this platform,
     * instance and token. Otherwise false and nothing changes: the caller gets a new handle,
     * and a handle for another token or instance stays exactly as it was.
     */
    async renew(handle: string, platform: Platform, instance: string, token: string, now = Date.now()): Promise<boolean> {
        const reg = await this.lookup(handle);
        if (!reg || reg.platform !== platform) return false;
        if (!sameSecret(reg.instance, instance) || !sameSecret(reg.token, token)) return false;
        // A TTL sweep or DELETE can remove the row between the lookup and here. Handing the
        // handle back then would answer 200 for a handle that gets 401 on its first push.
        return this.touch(reg.handleHash, now);
    }

    async lookup(handle: string): Promise<Registration | null> {
        const handleHash = hashHandle(handle);
        const row = await this.row(handleHash);
        if (!row) return null;
        let plain: string;
        try {
            plain = open(this.keys.sealKey, row.sealed, handleHash);
        } catch {
            // Sealed under another RELAY_SECRET_KEY (or damaged): the handle is unusable.
            return null;
        }
        const { t, i } = JSON.parse(plain) as { t: string; i: string };
        return { handleHash, platform: row.platform, instance: i, token: t };
    }
}

/** SQLite through node:sqlite, the default: one file on a volume (docker-compose.relay.yml). */
export class SqliteHandleStore extends SealedHandleStore {
    private readonly db: DatabaseSync;
    private closed = false;

    constructor(path: string, keys: Keys) {
        super(keys);
        this.db = new DatabaseSync(path);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA busy_timeout = 5000');
        this.db.exec(`CREATE TABLE IF NOT EXISTS handles (
            handle_hash TEXT PRIMARY KEY,
            platform    TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
            sealed      BLOB NOT NULL,
            created_at  INTEGER NOT NULL,
            seen_at     INTEGER NOT NULL
        ) STRICT`);
        this.db.exec('CREATE INDEX IF NOT EXISTS handles_seen_at ON handles (seen_at)');
    }

    protected async insert(handleHash: string, platform: Platform, sealed: Buffer, now: number): Promise<void> {
        this.db
            .prepare('INSERT INTO handles (handle_hash, platform, sealed, created_at, seen_at) VALUES (?, ?, ?, ?, ?)')
            .run(handleHash, platform, sealed, now, now);
    }

    protected async row(handleHash: string): Promise<Row | undefined> {
        return this.db.prepare('SELECT handle_hash, platform, sealed FROM handles WHERE handle_hash = ?').get(handleHash) as Row | undefined;
    }

    async touch(handleHash: string, now = Date.now()): Promise<boolean> {
        return Number(this.db.prepare('UPDATE handles SET seen_at = ? WHERE handle_hash = ?').run(now, handleHash).changes) > 0;
    }

    async deleteByHash(handleHash: string): Promise<boolean> {
        return Number(this.db.prepare('DELETE FROM handles WHERE handle_hash = ?').run(handleHash).changes) > 0;
    }

    async pruneSeenBefore(cutoff: number): Promise<number> {
        return Number(this.db.prepare('DELETE FROM handles WHERE seen_at < ?').run(cutoff).changes);
    }

    async count(): Promise<number> {
        return Number((this.db.prepare('SELECT count(*) AS n FROM handles').get() as { n: number }).n);
    }

    /** Safe to call twice. */
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.db.close();
    }
}
