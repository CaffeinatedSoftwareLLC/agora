/**
 * Minimal migration runner for self-hosted Docker deployments
 * Runs as a one-shot service in docker-compose before the API starts
 * 
 * Uses a simple `schema_migrations` table to track what's been applied
 * All migrations are raw SQL files — no ORM magic, full Postgres feature access
 */

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

async function ensureMigrationsTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version     VARCHAR(255) PRIMARY KEY,
            applied_at  TIMESTAMPTZ DEFAULT NOW()
        );
    `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
    const result = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    return new Set(result.rows.map(r => r.version));
}

async function runMigrations() {
    await ensureMigrationsTable();
    const applied = await getAppliedMigrations();

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort(); // lexicographic = chronological with NNN_ prefix

    for (const file of files) {
        const version = file.replace('.sql', '');
        if (applied.has(version)) {
            console.log(`  ✓ ${version} (already applied)`);
            continue;
        }

        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
        const client = await pool.connect();

        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query(
                'INSERT INTO schema_migrations (version) VALUES ($1)',
                [version]
            );
            await client.query('COMMIT');
            console.log(`  ✅ ${version} applied`);
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(`  ❌ ${version} FAILED:`, err);
            process.exit(1);
        } finally {
            client.release();
        }
    }

    console.log('\nMigrations complete.');
    await pool.end();
}

runMigrations().catch(err => {
    console.error('Migration runner failed:', err);
    process.exit(1);
});
