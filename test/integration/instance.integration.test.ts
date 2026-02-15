process.env.AGORA_SETUP_TOKEN = 'test-setup-token-that-is-at-least-32chars!';

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestApp, cleanDatabase } from '../helpers';
import { resetInitializedCache } from '../../src/instance/check-initialized';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
    ctx = await setupTestApp();
});
afterAll(async () => { await ctx.close(); });

/** Put the instance into uninitialized state. */
async function setUninitialized() {
    await cleanDatabase(ctx.db);
    await ctx.db.query("UPDATE instance_config SET value = 'false' WHERE key = 'setup_complete'");
    resetInitializedCache();
}

describe('Phase 0 — Instance Bootstrap', () => {

    describe('GET /instance/status', () => {

        test('returns initialized: false for fresh instance', async () => {
            await setUninitialized();

            const res = await ctx.request.get('/instance/status');
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                initialized: false,
                registrationPolicy: 'open',
                instanceName: 'Agora',
            });
        });

        test('returns initialized: true after setup', async () => {
            await cleanDatabase(ctx.db); // seeds setup_complete = 'true'

            const res = await ctx.request.get('/instance/status');
            expect(res.status).toBe(200);
            expect(res.body.initialized).toBe(true);
        });
    });

    describe('POST /instance/setup', () => {

        test('setup with valid token creates admin + server + config', async () => {
            await setUninitialized();

            const res = await ctx.request.post('/instance/setup').send({
                setupToken: 'test-setup-token-that-is-at-least-32chars!',
                username: 'admin',
                email: 'admin@test.com',
                password: 'TestPass123!',
            });

            expect(res.status).toBe(201);
            expect(res.body.user.isInstanceAdmin).toBe(true);
            expect(res.body.user.username).toBe('admin');
            expect(res.body.user.id).toBeDefined();
            expect(res.body.accessToken).toBeDefined();

            // Verify instance is now initialized
            const status = await ctx.request.get('/instance/status');
            expect(status.body.initialized).toBe(true);

            // Verify the admin can access an authenticated endpoint
            // POST /servers is a known route — create a second server to prove auth works
            const servers = await ctx.request
                .post('/servers')
                .set('Authorization', `Bearer ${res.body.accessToken}`)
                .send({ name: 'Auth Test Server' });
            expect(servers.status).toBe(201);
        });

        test('setup without valid token returns 403', async () => {
            await setUninitialized();

            const res = await ctx.request.post('/instance/setup').send({
                setupToken: 'wrong-token-that-is-definitely-not-valid',
                username: 'admin',
                email: 'admin@test.com',
                password: 'TestPass123!',
            });

            expect(res.status).toBe(403);
            expect(res.body.error).toBe('invalid_setup_token');
        });

        test('second setup call returns 409', async () => {
            await setUninitialized();

            // First setup succeeds
            const first = await ctx.request.post('/instance/setup').send({
                setupToken: 'test-setup-token-that-is-at-least-32chars!',
                username: 'admin',
                email: 'admin@test.com',
                password: 'TestPass123!',
            });
            expect(first.status).toBe(201);

            // Second setup is rejected
            const second = await ctx.request.post('/instance/setup').send({
                setupToken: 'test-setup-token-that-is-at-least-32chars!',
                username: 'admin2',
                email: 'admin2@test.com',
                password: 'TestPass123!',
            });
            expect(second.status).toBe(409);
            expect(second.body.error).toBe('instance_already_initialized');
        });

        test('setup with registrationPolicy sets it correctly', async () => {
            await setUninitialized();

            const res = await ctx.request.post('/instance/setup').send({
                setupToken: 'test-setup-token-that-is-at-least-32chars!',
                username: 'admin',
                email: 'admin@test.com',
                password: 'TestPass123!',
                instanceName: 'My Community',
                registrationPolicy: 'invite_only',
            });
            expect(res.status).toBe(201);

            const status = await ctx.request.get('/instance/status');
            expect(status.body.registrationPolicy).toBe('invite_only');
            expect(status.body.instanceName).toBe('My Community');
        });
    });

    describe('auth lock before setup', () => {

        test('POST /auth/register returns 503 when not initialized', async () => {
            await setUninitialized();

            const res = await ctx.request.post('/auth/register').send({
                username: 'blocked',
                email: 'blocked@test.com',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(503);
            expect(res.body.error).toBe('instance_not_initialized');
        });

        test('POST /auth/login returns 503 when not initialized', async () => {
            await setUninitialized();

            const res = await ctx.request.post('/auth/login').send({
                email: 'blocked@test.com',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(503);
            expect(res.body.error).toBe('instance_not_initialized');
        });
    });

    describe('auth works after setup', () => {

        test('POST /auth/register works after setup', async () => {
            await setUninitialized();

            // Setup the instance first
            await ctx.request.post('/instance/setup').send({
                setupToken: 'test-setup-token-that-is-at-least-32chars!',
                username: 'admin',
                email: 'admin@test.com',
                password: 'TestPass123!',
            });

            // Now registration should work
            const res = await ctx.request.post('/auth/register').send({
                username: 'newuser',
                email: 'newuser@test.com',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(201);
            expect(res.body.user.username).toBe('newuser');
            expect(res.body.accessToken).toBeDefined();
        });

        test('POST /auth/login works after setup with admin creds', async () => {
            await setUninitialized();

            // Setup the instance
            await ctx.request.post('/instance/setup').send({
                setupToken: 'test-setup-token-that-is-at-least-32chars!',
                username: 'admin',
                email: 'admin@test.com',
                password: 'TestPass123!',
            });

            // Login with the admin credentials
            const res = await ctx.request.post('/auth/login').send({
                email: 'admin@test.com',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(200);
            expect(res.body.user.username).toBe('admin');
            expect(res.body.accessToken).toBeDefined();
        });
    });
});
