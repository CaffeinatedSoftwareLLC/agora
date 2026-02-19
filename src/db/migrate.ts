import 'dotenv/config';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

export async function runMigrations(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version     VARCHAR(255) PRIMARY KEY,
            applied_at  TIMESTAMPTZ DEFAULT NOW()
        );
    `);

    const result = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    const applied = new Set(result.rows.map((r: { version: string }) => r.version));

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    for (const file of files) {
        const version = file.replace('.sql', '');
        if (applied.has(version)) continue;

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
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}

// Allow running directly: tsx src/db/migrate.ts
if (require.main === module) {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL ?? 'postgres://accord:accord@localhost:5432/accord_test',
    });

    runMigrations(pool)
        .then(() => {
            console.log('Migrations complete.');
            return pool.end();
        })
        .catch((err) => {
            console.error('Migration runner failed:', err);
            process.exit(1);
        });
}
