import type { PoolClient } from 'pg';

/** Match the database index and mention resolution, across humans and bots. */
export async function usernameTaken(db: Pick<PoolClient, 'query'>, username: string, exceptId?: string): Promise<boolean> {
    const result = await db.query(
        `SELECT 1 FROM users WHERE lower(username) = lower($1)
         ${exceptId ? 'AND id <> $2' : ''} LIMIT 1`,
        exceptId ? [username, exceptId] : [username],
    );
    return result.rows.length > 0;
}
