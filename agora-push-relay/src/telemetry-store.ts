import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

/**
 * Install reports and setup problem reports (docs/telemetry.md). Only the listed fields and
 * the UTC date are kept: no time of day, no address, no user agent, nothing that links two
 * reports. Problem reports have a random id (quoted by the user in an issue) and are
 * deleted after RELAY_PROBLEM_DAYS (90).
 */
export interface InstallReport {
    result: 'ok' | 'failed';
    step: string | null;
    version: string;
    os: string;
    osVersion: string;
}

export interface ProblemReport {
    id: string;
    day: string;
    version: string | null;
    os: string | null;
    report: string;
}

export interface ProblemSummary {
    id: string;
    day: string;
    version: string | null;
    os: string | null;
    bytes: number;
}

export interface InstallCount {
    day: string;
    result: string;
    step: string | null;
    version: string;
    os: string;
    osVersion: string;
    count: number;
}

export interface TelemetryStore {
    recordInstall(r: InstallReport, day: string): Promise<void>;
    recordProblem(p: ProblemReport): Promise<void>;
    /** Stored problem reports: how many and their total size, to keep the database bounded. */
    problemUsage(): Promise<{ count: number; bytes: number }>;
    listProblems(limit: number): Promise<ProblemSummary[]>;
    getProblem(id: string): Promise<ProblemReport | null>;
    installCounts(sinceDay: string): Promise<InstallCount[]>;
    /** Deletes problem reports from before `day`. Returns how many. */
    pruneProblemsBefore(day: string): Promise<number>;
    close(): Promise<void>;
}

/** YYYY-MM-DD in UTC. */
export function utcDay(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

const SQLITE_TABLES = [
    `CREATE TABLE IF NOT EXISTS telemetry_installs (
        day        TEXT NOT NULL,
        result     TEXT NOT NULL CHECK (result IN ('ok', 'failed')),
        step       TEXT,
        version    TEXT NOT NULL,
        os         TEXT NOT NULL,
        os_version TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS telemetry_problems (
        id      TEXT PRIMARY KEY,
        day     TEXT NOT NULL,
        version TEXT,
        os      TEXT,
        report  TEXT NOT NULL
    ) STRICT`,
    'CREATE INDEX IF NOT EXISTS telemetry_problems_day ON telemetry_problems (day)',
];

export class SqliteTelemetryStore implements TelemetryStore {
    private readonly db: DatabaseSync;
    private closed = false;

    constructor(path: string) {
        this.db = new DatabaseSync(path);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA busy_timeout = 5000');
        for (const sql of SQLITE_TABLES) this.db.exec(sql);
    }

    async recordInstall(r: InstallReport, day: string): Promise<void> {
        this.db
            .prepare('INSERT INTO telemetry_installs (day, result, step, version, os, os_version) VALUES (?, ?, ?, ?, ?, ?)')
            .run(day, r.result, r.step, r.version, r.os, r.osVersion);
    }

    async recordProblem(p: ProblemReport): Promise<void> {
        this.db.prepare('INSERT INTO telemetry_problems (id, day, version, os, report) VALUES (?, ?, ?, ?, ?)').run(p.id, p.day, p.version, p.os, p.report);
    }

    async problemUsage(): Promise<{ count: number; bytes: number }> {
        const row = this.db.prepare('SELECT count(*) AS n, coalesce(sum(length(CAST(report AS BLOB))), 0) AS b FROM telemetry_problems').get() as { n: number; b: number };
        return { count: Number(row.n), bytes: Number(row.b) };
    }

    async listProblems(limit: number): Promise<ProblemSummary[]> {
        const rows = this.db
            .prepare('SELECT id, day, version, os, length(CAST(report AS BLOB)) AS bytes FROM telemetry_problems ORDER BY day DESC, id LIMIT ?')
            .all(limit) as unknown as ProblemSummary[];
        return rows.map((r) => ({ ...r, bytes: Number(r.bytes) }));
    }

    async getProblem(id: string): Promise<ProblemReport | null> {
        return (this.db.prepare('SELECT id, day, version, os, report FROM telemetry_problems WHERE id = ?').get(id) as ProblemReport | undefined) ?? null;
    }

    async installCounts(sinceDay: string): Promise<InstallCount[]> {
        const rows = this.db
            .prepare(
                `SELECT day, result, step, version, os, os_version AS osVersion, count(*) AS count FROM telemetry_installs
                 WHERE day >= ? GROUP BY day, result, step, version, os, os_version ORDER BY day DESC, count DESC`,
            )
            .all(sinceDay) as unknown as InstallCount[];
        return rows.map((r) => ({ ...r, count: Number(r.count) }));
    }

    async pruneProblemsBefore(day: string): Promise<number> {
        return Number(this.db.prepare('DELETE FROM telemetry_problems WHERE day < ?').run(day).changes);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.db.close();
    }
}

/** Arbitrary constant for pg_advisory_xact_lock while creating the tables. */
const SCHEMA_LOCK = 0x61677274; // "agrt"

export class PgTelemetryStore implements TelemetryStore {
    private constructor(private readonly pool: pg.Pool) {}

    static async open(url: string, opts: { ssl: boolean; onError?: (err: Error & { code?: string }) => void }): Promise<PgTelemetryStore> {
        const pool = new pg.Pool({
            connectionString: url,
            ssl: opts.ssl ? { rejectUnauthorized: false } : false,
            max: 2,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 10_000,
            query_timeout: 10_000,
            statement_timeout: 10_000,
        });
        pool.on('error', (err) => opts.onError?.(err));
        const store = new PgTelemetryStore(pool);
        const client = await pool.connect().catch(async (err) => {
            await pool.end();
            throw err;
        });
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK]);
            await client.query(`CREATE TABLE IF NOT EXISTS telemetry_installs (
                day        DATE NOT NULL,
                result     TEXT NOT NULL CHECK (result IN ('ok', 'failed')),
                step       TEXT,
                version    TEXT NOT NULL,
                os         TEXT NOT NULL,
                os_version TEXT NOT NULL
            )`);
            await client.query(`CREATE TABLE IF NOT EXISTS telemetry_problems (
                id      TEXT PRIMARY KEY,
                day     DATE NOT NULL,
                version TEXT,
                os      TEXT,
                report  TEXT NOT NULL
            )`);
            await client.query('CREATE INDEX IF NOT EXISTS telemetry_problems_day ON telemetry_problems (day)');
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
            await pool.end();
            throw err;
        }
        client.release();
        return store;
    }

    async recordInstall(r: InstallReport, day: string): Promise<void> {
        await this.pool.query('INSERT INTO telemetry_installs (day, result, step, version, os, os_version) VALUES ($1, $2, $3, $4, $5, $6)', [
            day, r.result, r.step, r.version, r.os, r.osVersion,
        ]);
    }

    async recordProblem(p: ProblemReport): Promise<void> {
        await this.pool.query('INSERT INTO telemetry_problems (id, day, version, os, report) VALUES ($1, $2, $3, $4, $5)', [p.id, p.day, p.version, p.os, p.report]);
    }

    async problemUsage(): Promise<{ count: number; bytes: number }> {
        const row = (await this.pool.query<{ n: string; b: string }>('SELECT count(*) AS n, coalesce(sum(octet_length(report)), 0) AS b FROM telemetry_problems')).rows[0];
        return { count: Number(row.n), bytes: Number(row.b) };
    }

    async listProblems(limit: number): Promise<ProblemSummary[]> {
        const res = await this.pool.query(
            `SELECT id, to_char(day, 'YYYY-MM-DD') AS day, version, os, octet_length(report) AS bytes
             FROM telemetry_problems ORDER BY day DESC, id LIMIT $1`,
            [limit],
        );
        return res.rows.map((r) => ({ id: r.id, day: r.day, version: r.version, os: r.os, bytes: Number(r.bytes) }));
    }

    async getProblem(id: string): Promise<ProblemReport | null> {
        const res = await this.pool.query<ProblemReport>(
            `SELECT id, to_char(day, 'YYYY-MM-DD') AS day, version, os, report FROM telemetry_problems WHERE id = $1`,
            [id],
        );
        return res.rows[0] ?? null;
    }

    async installCounts(sinceDay: string): Promise<InstallCount[]> {
        const res = await this.pool.query(
            `SELECT to_char(day, 'YYYY-MM-DD') AS day, result, step, version, os, os_version, count(*) AS count FROM telemetry_installs
             WHERE day >= $1 GROUP BY day, result, step, version, os, os_version ORDER BY day DESC, count DESC`,
            [sinceDay],
        );
        return res.rows.map((r) => ({ day: r.day, result: r.result, step: r.step, version: r.version, os: r.os, osVersion: r.os_version, count: Number(r.count) }));
    }

    async pruneProblemsBefore(day: string): Promise<number> {
        return (await this.pool.query('DELETE FROM telemetry_problems WHERE day < $1', [day])).rowCount ?? 0;
    }

    async close(): Promise<void> {
        if (this.pool.ended) return;
        await this.pool.end();
    }
}
