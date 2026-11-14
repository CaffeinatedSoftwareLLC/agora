import supertest from 'supertest';
import { buildApp } from '../../src/app';
import { authedUser, cleanDatabase } from '../helpers';

/**
 * The box terminal's read and close routes are rate limited like the ticket route (any signed-in
 * account can call them, and a refusal costs a database row's worth of work). The shared test app
 * runs with rate limiting off, so this file builds one with it on.
 */

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let db: Awaited<ReturnType<typeof buildApp>>['db'];
let req: supertest.Agent;

beforeAll(async () => {
    ({ app, db } = await buildApp({
        logger: false,
        jwtSecret: 'test-secret-do-not-use-in-prod',
        dbUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://accord:accord@localhost:5432/accord_test',
        rateLimit: true,
    }));
    await app.ready();
    req = supertest(app.server);
    await cleanDatabase(db);
});
afterAll(async () => { await app.close(); await db.end(); });

const NO_BOX = 'N'.repeat(26);

describe('rate limits on the terminal routes', () => {
    test.each([
        ['get', '', 60],
        ['get', '/sessions', 60],
        ['delete', '', 30],
    ] as const)('%s /boxes/:id/terminal%s is limited to %i a minute', async (method, suffix, max) => {
        const user = await authedUser(req, `limit${method}${suffix.length}`);
        let limited = 0;
        let last = 0;
        for (let i = 0; i < max + 3; i++) {
            const r = await (req as any)[method](`/boxes/${NO_BOX}/terminal${suffix}`).set(user.auth);
            last = r.status;
            if (r.status === 429) limited++;
            else expect(r.status).toBe(404);
        }
        expect(limited).toBeGreaterThanOrEqual(1);
        expect(last).toBe(429);
    });
});
