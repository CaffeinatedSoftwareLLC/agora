process.env.AGORA_SETUP_TOKEN = 'test-setup-token-that-is-at-least-32chars!';

import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

        test('concurrent setup calls — exactly one succeeds', async () => {
            await setUninitialized();

            const payload = (suffix: string) => ({
                setupToken: 'test-setup-token-that-is-at-least-32chars!',
                username: `admin${suffix}`,
                email: `admin${suffix}@test.com`,
                password: 'TestPass123!',
            });

            // Fire two setup requests in parallel
            const [a, b] = await Promise.all([
                ctx.request.post('/instance/setup').send(payload('1')),
                ctx.request.post('/instance/setup').send(payload('2')),
            ]);

            const statuses = [a.status, b.status].sort();
            // Exactly one 201 and one 409
            expect(statuses).toEqual([201, 409]);

            // The 409 response has the correct error code
            const rejected = a.status === 409 ? a : b;
            expect(rejected.body.error).toBe('instance_already_initialized');
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

    describe('setup token resilience', () => {

        test('getSetupToken returns ephemeral token when data dir is unwritable', async () => {
            // Temporarily unset env var so the module tries to read/write file
            const saved = process.env.AGORA_SETUP_TOKEN;
            delete process.env.AGORA_SETUP_TOKEN;
            // Point to a path that cannot be written (non-existent drive on Windows, /proc on Linux)
            process.env.AGORA_DATA_DIR = process.platform === 'win32'
                ? 'Z:\\nonexistent\\readonly'
                : '/proc/nonexistent/readonly';

            // Re-import to bypass any module caching
            const { getSetupToken } = await import('../../src/instance/setup-token');
            const token = await getSetupToken();

            // Should still return a valid 64-hex-char token
            expect(token).toMatch(/^[0-9a-f]{64}$/);

            // Restore env
            process.env.AGORA_SETUP_TOKEN = saved;
            delete process.env.AGORA_DATA_DIR;
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
