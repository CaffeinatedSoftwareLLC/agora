import { Pool } from 'pg';
import { config } from '../config';
import { closeRedis, getRedis } from '../auth/token-blacklist';
import { failureKey } from '../auth/login-limit';

/**
 * Lift the login lock on one account after repeated failed logins, without
 * touching anyone else's. Takes a username or an email; case is ignored.
 *
 *   npm run login:unlock -- <username or email>
 *   Docker: docker compose -f docker-compose.prod.yml --env-file .env.prod exec api \
 *             node dist/src/tools/unlock-login.js <username or email>
 */
async function main() {
    const identifier = (process.argv[2] ?? '').trim();
    if (!identifier) {
        throw new Error('Give the username or email of the account to unlock.');
    }

    const db = new Pool({ connectionString: config.dbUrl });
    try {
        const result = await db.query(
            `SELECT id, username FROM users
             WHERE bot = false AND (lower(email) = lower($1) OR lower(username) = lower($1))`,
            [identifier]
        );
        if (result.rows.length === 0) {
            console.log(`No account matches "${identifier}". Nothing to do.`);
            return;
        }
        for (const row of result.rows) {
            const removed = await getRedis().del(failureKey(row.id));
            console.log(removed ? `Unlocked ${row.username}.` : `${row.username} was not locked.`);
        }
    } finally {
        await db.end();
        await closeRedis();
    }
}

main().catch((err) => {
    console.error('Unlock failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
