import { DatabaseSync } from 'node:sqlite';
import { deriveHandle, hashHandle, open, seal, type Keys } from './crypto.js';

export type Platform = 'android' | 'ios';

export interface Registration {
    handleHash: string;
    platform: Platform;
    instance: string;
    token: string;
}

interface Row {
    handle_hash: string;
    platform: Platform;
    sealed: Uint8Array;
}

/**
 * One row per handle. The key is SHA-256(handle); the raw handle is never stored.
 * The device token and the instance origin are sealed together with AES-256-GCM, the
 * row's key as associated data. Only the platform is in the clear.
 */
export class HandleStore {
    private readonly db: DatabaseSync;

    constructor(path: string, private readonly keys: Keys) {
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

    /** Stores (or refreshes) the registration and returns its handle. Same token + instance -> same handle. */
    register(platform: Platform, instance: string, token: string, now = Date.now()): string {
        const handle = deriveHandle(this.keys.handleKey, instance, token);
        const handleHash = hashHandle(handle);
        const sealed = seal(this.keys.sealKey, JSON.stringify({ t: token, i: instance }), handleHash);
        this.db
            .prepare(`INSERT INTO handles (handle_hash, platform, sealed, created_at, seen_at) VALUES (?, ?, ?, ?, ?)
                      ON CONFLICT (handle_hash) DO UPDATE SET platform = excluded.platform, sealed = excluded.sealed, seen_at = excluded.seen_at`)
            .run(handleHash, platform, sealed, now, now);
        return handle;
    }

    lookup(handle: string): Registration | null {
        const handleHash = hashHandle(handle);
        const row = this.db.prepare('SELECT handle_hash, platform, sealed FROM handles WHERE handle_hash = ?').get(handleHash) as Row | undefined;
        if (!row) return null;
        const { t, i } = JSON.parse(open(this.keys.sealKey, row.sealed, handleHash)) as { t: string; i: string };
        return { handleHash, platform: row.platform, instance: i, token: t };
    }

    touch(handleHash: string, now = Date.now()): void {
        this.db.prepare('UPDATE handles SET seen_at = ? WHERE handle_hash = ?').run(now, handleHash);
    }

    deleteByHash(handleHash: string): boolean {
        return Number(this.db.prepare('DELETE FROM handles WHERE handle_hash = ?').run(handleHash).changes) > 0;
    }

    /** Removes handles neither registered nor pushed to since `cutoff` (ms). Returns how many. */
    pruneSeenBefore(cutoff: number): number {
        return Number(this.db.prepare('DELETE FROM handles WHERE seen_at < ?').run(cutoff).changes);
    }

    count(): number {
        return Number((this.db.prepare('SELECT count(*) AS n FROM handles').get() as { n: number }).n);
    }

    close(): void {
        this.db.close();
    }
}
