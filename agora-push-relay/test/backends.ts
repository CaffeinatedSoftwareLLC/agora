import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { Keys } from '../src/crypto.js';
import { SqliteHandleStore, type HandleStore } from '../src/store.js';
import { PgHandleStore } from '../src/store-pg.js';

/**
 * Postgres for the store tests: TEST_DATABASE_URL, the repo's test database (.env.example;
 * the agora-test compose project locally, a service container in CI). The tests make
 * their own database next to it and drop it afterwards. Without the variable the Postgres
 * suite is skipped, except in CI, where a missing database is a failure, not a skip.
 */
export const PG_URL = process.env.TEST_DATABASE_URL?.trim() || '';
if (process.env.CI && !PG_URL) throw new Error('TEST_DATABASE_URL is not set: the Postgres store tests would be skipped in CI');

/** One database per test file, so a run never touches the test database's own tables. */
export interface Backend {
    name: string;
    setup(): Promise<void>;
    teardown(): Promise<void>;
    /** A store on an empty database. */
    fresh(keys: Keys): Promise<HandleStore>;
    /** Another store on the database of the last `fresh` (a restart, maybe with another key). */
    reopen(keys: Keys): Promise<HandleStore>;
    /** Every byte the database holds for the handles table, to search for leaked plaintext. */
    raw(): Promise<Buffer>;
    /** Closes every store this backend opened. */
    closeAll(): Promise<void>;
}

export function sqliteBackend(): Backend {
    let dir = '';
    let path = '';
    const open: HandleStore[] = [];
    const track = (s: HandleStore) => (open.push(s), s);
    return {
        name: 'sqlite',
        async setup() {},
        async teardown() {
            if (dir) rmSync(dir, { recursive: true, force: true });
        },
        async fresh(keys) {
            if (dir) rmSync(dir, { recursive: true, force: true });
            dir = mkdtempSync(join(tmpdir(), 'agora-push-relay-'));
            path = join(dir, 'relay.db');
            return track(new SqliteHandleStore(path, keys));
        },
        async reopen(keys) {
            return track(new SqliteHandleStore(path, keys));
        },
        async raw() {
            return Buffer.concat(
                [path, `${path}-wal`].flatMap((p) => {
                    try {
                        return [readFileSync(p)];
                    } catch {
                        return [];
                    }
                }),
            );
        },
        async closeAll() {
            await Promise.all(open.splice(0).map((s) => s.close()));
        },
    };
}

export function pgBackend(): Backend & { url(): string } {
    const name = `agora_relay_test_${randomBytes(6).toString('hex')}`;
    let admin: pg.Client | null = null;
    let db: pg.Client | null = null;
    let url = '';
    const open: HandleStore[] = [];
    const track = (s: HandleStore) => (open.push(s), s);
    return {
        name: 'postgres',
        url: () => url,
        async setup() {
            admin = new pg.Client({ connectionString: PG_URL });
            await admin.connect();
            await admin.query(`CREATE DATABASE ${name}`);
            const u = new URL(PG_URL);
            u.pathname = `/${name}`;
            url = u.toString();
            db = new pg.Client({ connectionString: url });
            await db.connect();
        },
        async teardown() {
            await db?.end();
            if (admin) {
                await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
                await admin.end();
            }
        },
        async fresh(keys) {
            const store = track(await PgHandleStore.open(url, keys, { ssl: false }));
            await db!.query('TRUNCATE handles');
            return store;
        },
        async reopen(keys) {
            return track(await PgHandleStore.open(url, keys, { ssl: false }));
        },
        async raw() {
            const res = await db!.query<{ b: Buffer }>(
                "SELECT convert_to(handle_hash || platform || created_at::text || seen_at::text, 'UTF8') || sealed AS b FROM handles",
            );
            return Buffer.concat(res.rows.map((r) => r.b));
        },
        async closeAll() {
            await Promise.all(open.splice(0).map((s) => s.close()));
        },
    };
}

/** The backends this run can reach: SQLite always, Postgres when TEST_DATABASE_URL is set. */
export function backends(): Backend[] {
    return PG_URL ? [sqliteBackend(), pgBackend()] : [sqliteBackend()];
}
