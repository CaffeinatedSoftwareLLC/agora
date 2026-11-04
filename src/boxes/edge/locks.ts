import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/**
 * Broker writes to one repo and ref are serialized (docs/agent-boxes.md §5.3): pushes and PR
 * creation take the same Postgres advisory lock per (repo, ref), held on one session for the
 * whole operation. A PR's lock is its head ref, `refs/heads/<head>`.
 */

/** A signed 64-bit key for pg_advisory_lock, the same for any spelling of the repo's case. */
export function refLockKey(owner: string, repo: string, ref: string): string {
    const digest = createHash('sha256').update(`agora-box-ref\n${owner.toLowerCase()}/${repo.toLowerCase()}\n${ref}`).digest();
    return digest.readBigInt64BE(0).toString();
}

export class RefLockTimeout extends Error {
    constructor() { super('ref_lock_timeout'); }
}

/**
 * Run `fn` holding the locks for `refs` (sorted, so two writers never deadlock). The client is
 * the one holding the locks; `fn` may use it for its own short transactions.
 */
export async function withRefLocks<T>(pool: Pool, owner: string, repo: string, refs: string[], fn: (client: PoolClient) => Promise<T>, waitMs = 60_000): Promise<T> {
    const keys = [...new Set(refs.map(r => refLockKey(owner, repo, r)))].sort();
    const client = await pool.connect();
    try {
        await client.query(`SET lock_timeout = ${Math.max(1, Math.floor(waitMs))}`);
        try {
            for (const key of keys) await client.query('SELECT pg_advisory_lock($1::bigint)', [key]);
        } catch (err: any) {
            if (err?.code === '55P03') throw new RefLockTimeout();
            throw err;
        } finally {
            await client.query('RESET lock_timeout');
        }
        return await fn(client);
    } finally {
        // Unlock and return the session; if that fails, dropping it releases its locks too
        try {
            await client.query('ROLLBACK').catch(() => undefined);
            await client.query('SELECT pg_advisory_unlock_all()');
            client.release();
        } catch {
            client.release(true);
        }
    }
}

/** A short transaction on `client`, rolled back on any error. */
export async function inTransaction<T>(client: PoolClient, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try {
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    }
}
