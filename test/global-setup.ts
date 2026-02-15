import { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate';

export async function setup() {
    const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL
            ?? process.env.DATABASE_URL
            ?? 'postgres://accord:accord@localhost:5432/accord_test',
    });

    await runMigrations(pool);
    await pool.end();
}
