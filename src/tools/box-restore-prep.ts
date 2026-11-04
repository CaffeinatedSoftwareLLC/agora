import { Pool } from 'pg';
import { config } from '../config';
import { prepareBoxRestore } from '../lib/boxes/tokens';

/**
 * Run by install/restore.sh after the database is restored and before anything starts
 * (docs/agent-boxes.md §9.4): bumps every box's generation, kills every box host secret and
 * box bot token, and expires every edge request that was pending, allowed or in flight.
 * boxd then rebuilds each box with fresh tokens.
 *
 *   node dist/src/tools/box-restore-prep.js
 */
async function main() {
    const db = new Pool({ connectionString: config.dbUrl, max: 1 });
    try {
        const r = await prepareBoxRestore(db);
        console.log(`Box restore prep: ${r.boxes} box(es) moved to a new generation, ${r.hosts} box host secret(s) and `
            + `${r.tokens} box bot token(s) revoked, ${r.requests} edge request(s) and ${r.logins} login(s) expired.`);
    } finally {
        await db.end();
    }
}

main().catch((err) => {
    console.error('Box restore prep failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
