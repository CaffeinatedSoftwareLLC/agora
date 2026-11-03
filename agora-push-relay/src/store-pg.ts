import pg from 'pg';
import type { Keys } from './crypto.js';
import { SealedHandleStore, type Platform, type Row } from './store.js';

export interface PgStoreOptions {
    /**
     * TLS without certificate checks. Heroku Postgres requires TLS but serves certificates
     * that do not chain to a public CA pg trusts, so verifying them would refuse every
     * connection (Heroku's own guidance is rejectUnauthorized: false). The traffic is still
     * encrypted; it stays inside Heroku's network.
     */
    ssl: boolean;
    /** An idle pooled connection failed (database restart, maintenance). pg drops it and reconnects. */
    onError?: (err: Error & { code?: string }) => void;
    /** Per-query bound (QUERY_TIMEOUT_MS); tests shorten it. */
    queryTimeoutMs?: number;
}

/** Arbitrary constant for pg_advisory_xact_lock, so two relays starting at once create the table once. */
const SCHEMA_LOCK = 0x61677270; // "agrp"
/** Longest any one query may take. The writes after a send have a shorter bound in app.ts. */
export const QUERY_TIMEOUT_MS = 10_000;

/**
 * Postgres, chosen when DATABASE_URL is set: for hosts without a lasting disk (Heroku
 * dynos lose their filesystem at least daily). Same table and semantics as SQLite.
 */
export class PgHandleStore extends SealedHandleStore {
    private constructor(private readonly pool: pg.Pool, keys: Keys) {
        super(keys);
    }

    /** Connects and creates the table if it is missing. */
    static async open(url: string, keys: Keys, opts: PgStoreOptions): Promise<PgHandleStore> {
        const pool = new pg.Pool({
            connectionString: url,
            ssl: opts.ssl ? { rejectUnauthorized: false } : false,
            // Heroku Essential-0 allows 20 connections; one relay process needs few.
            max: 5,
            idleTimeoutMillis: 30_000,
            // A database that does not answer turns into a 500, not a hung request: getting a
            // client, and each query on an open one (pg gives up client-side; Postgres cancels
            // the statement server-side), both end well inside Heroku's 30 s router timeout.
            connectionTimeoutMillis: 10_000,
            query_timeout: opts.queryTimeoutMs ?? QUERY_TIMEOUT_MS,
            statement_timeout: opts.queryTimeoutMs ?? QUERY_TIMEOUT_MS,
        });
        // Without a listener, an error on an idle client crashes the process.
        pool.on('error', (err) => opts.onError?.(err));
        const store = new PgHandleStore(pool, keys);
        try {
            await store.migrate();
        } catch (err) {
            await pool.end();
            throw err;
        }
        return store;
    }

    private async migrate(): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK]);
            await client.query(`CREATE TABLE IF NOT EXISTS handles (
                handle_hash TEXT PRIMARY KEY,
                platform    TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
                sealed      BYTEA NOT NULL,
                created_at  BIGINT NOT NULL,
                seen_at     BIGINT NOT NULL
            )`);
            await client.query('CREATE INDEX IF NOT EXISTS handles_seen_at ON handles (seen_at)');
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    protected async insert(handleHash: string, platform: Platform, sealed: Buffer, now: number): Promise<void> {
        await this.pool.query('INSERT INTO handles (handle_hash, platform, sealed, created_at, seen_at) VALUES ($1, $2, $3, $4, $4)', [
            handleHash,
            platform,
            sealed,
            now,
        ]);
    }

    protected async row(handleHash: string): Promise<Row | undefined> {
        const res = await this.pool.query<Row>('SELECT handle_hash, platform, sealed FROM handles WHERE handle_hash = $1', [handleHash]);
        return res.rows[0];
    }

    async touch(handleHash: string, now = Date.now()): Promise<boolean> {
        return ((await this.pool.query('UPDATE handles SET seen_at = $1 WHERE handle_hash = $2', [now, handleHash])).rowCount ?? 0) > 0;
    }

    async deleteByHash(handleHash: string): Promise<boolean> {
        return ((await this.pool.query('DELETE FROM handles WHERE handle_hash = $1', [handleHash])).rowCount ?? 0) > 0;
    }

    async pruneSeenBefore(cutoff: number): Promise<number> {
        return (await this.pool.query('DELETE FROM handles WHERE seen_at < $1', [cutoff])).rowCount ?? 0;
    }

    async count(): Promise<number> {
        // count(*) is a bigint, which pg returns as a string.
        return Number((await this.pool.query<{ n: string }>('SELECT count(*) AS n FROM handles')).rows[0].n);
    }

    /** Safe to call twice. */
    async close(): Promise<void> {
        if (this.pool.ended) return;
        await this.pool.end();
    }
}
