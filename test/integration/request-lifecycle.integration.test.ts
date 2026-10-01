import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../../src/app';
import { cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';

/**
 * The request transaction commits before the reply is sent (src/app.ts, onSend).
 * These tests use their own app so they can add a route whose COMMIT fails.
 */

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let db: Awaited<ReturnType<typeof buildApp>>['db'];
let request: ReturnType<typeof supertest>;

beforeAll(async () => {
    ({ app, db } = await buildApp({
        logger: false,
        jwtSecret: 'test-secret-do-not-use-in-prod',
        dbUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
        rateLimit: false,
    }));

    // Under /instance/ so it needs no auth. The insert succeeds; the deferred foreign
    // key to `servers` is only checked at COMMIT, which therefore fails.
    app.post('/instance/test-commit-failure', async (req, reply) => {
        const { roleId } = req.body as { roleId: string };
        await req.dbClient!.query(
            'INSERT INTO roles (id, server_id, name) VALUES ($1, $2, $3)',
            [roleId, generateUlid(), 'orphan']
        );
        return reply.status(201).send({ created: roleId });
    });

    await app.ready();
    request = supertest(app.server);
    await cleanDatabase(db);
});

afterAll(async () => {
    await app.close();
    await db.end();
});

describe('request transaction lifecycle', () => {

    test('a failed COMMIT becomes a 500, not the success the handler sent', async () => {
        const roleId = generateUlid();
        const res = await request.post('/instance/test-commit-failure').send({ roleId });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'commit_failed' });

        const row = await db.query('SELECT 1 FROM roles WHERE id = $1', [roleId]);
        expect(row.rows).toHaveLength(0);
    });

    test('the pool is not leaked by failed commits', async () => {
        for (let i = 0; i < 15; i++) {
            const res = await request.post('/instance/test-commit-failure').send({ roleId: generateUlid() });
            expect(res.status).toBe(500);
        }
        // pg's default pool size is 10: this would hang if clients were not released
        const health = await request.get('/health');
        expect(health.status).toBe(200);
        expect(db.idleCount).toBe(db.totalCount);
    });

    test('what a request wrote is visible as soon as its response arrives', async () => {
        for (let i = 0; i < 25; i++) {
            const name = `lifecycle${i}`;
            const res = await request.post('/auth/register').send({
                username: name,
                email: `${name}@test.com`,
                password: 'TestPass123!',
            });
            expect(res.status).toBe(201);

            // No polling: the row must already be there
            const row = await db.query('SELECT 1 FROM users WHERE id = $1', [res.body.user.id]);
            expect(row.rows, `user ${i} missing right after register`).toHaveLength(1);

            // And the token it was just issued must work on the very next request
            const server = await request.post('/servers')
                .set({ Authorization: `Bearer ${res.body.accessToken}` })
                .send({ name: `Server ${i}` });
            expect(server.status, `token ${i} rejected right after register`).toBe(201);
        }
    });
});
