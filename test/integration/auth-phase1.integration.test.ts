import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestApp, cleanDatabase } from '../helpers';
import { resetInitializedCache } from '../../src/instance/check-initialized';
import { generateToken } from '../../src/auth/tokens';
import { hashPassword } from '../../src/auth/passwords';
import { generateUlid } from '../../src/utils/ulid';
import crypto from 'crypto';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
    ctx = await setupTestApp();
});
afterAll(async () => { await ctx.close(); });

// ─── Helpers ───

/** Reset DB with a specific registration policy */
async function setPolicy(policy: 'open' | 'invite_only' | 'approval') {
    await cleanDatabase(ctx.db);
    await ctx.db.query(
        "UPDATE instance_config SET value = $1 WHERE key = 'registration_policy'",
        [policy]
    );
}

/** Insert a user directly with a specific account_status, return { userId, token } */
async function insertUserWithStatus(
    username: string,
    status: 'active' | 'pending' | 'suspended'
) {
    const userId = generateUlid();
    const passwordHash = await hashPassword('TestPass123!');
    await ctx.db.query(
        `INSERT INTO users (id, username, email, password_hash, account_status)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, username, `${username}@test.com`, passwordHash, status]
    );
    // Generate a valid JWT for this user
    const token = generateToken({ userId }, 'test-secret-do-not-use-in-prod');
    return { userId, token, auth: { Authorization: `Bearer ${token}` } };
}

/** Create a server + invite code using a transaction (deferred FKs need single txn) */
async function createServerWithInvite(ownerUserId: string) {
    const serverId = generateUlid();
    const roleId = generateUlid();
    const channelId = generateUlid();
    const inviteCode = crypto.randomBytes(4).toString('hex');

    const client = await ctx.db.connect();
    try {
        await client.query('BEGIN');

        // Create @everyone role (deferred FK allows this before server exists within txn)
        await client.query(
            `INSERT INTO roles (id, server_id, name, is_everyone, permissions, position)
             VALUES ($1, $2, '@everyone', true, 0, 0)`,
            [roleId, serverId]
        );
        // Create server
        await client.query(
            `INSERT INTO servers (id, name, owner_id, everyone_role_id)
             VALUES ($1, 'Test Server', $2, $3)`,
            [serverId, ownerUserId, roleId]
        );
        // Add owner as member
        await client.query(
            `INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)`,
            [serverId, ownerUserId]
        );
        // Create #general channel
        await client.query(
            `INSERT INTO channels (id, channel_type, server_id, name, position)
             VALUES ($1, 3, $2, 'general', 0)`,
            [channelId, serverId]
        );
        // Create invite
        await client.query(
            `INSERT INTO server_invites (code, server_id, creator_id)
             VALUES ($1, $2, $3)`,
            [inviteCode, serverId, ownerUserId]
        );

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    return { serverId, inviteCode };
}

// ─── Tests ───

describe('Phase 1 — Auth & Registration Policies', () => {

    // ─── Open policy ───
    describe('open policy', () => {

        beforeEach(async () => { await setPolicy('open'); });

        test('register returns 201 with token', async () => {
            const res = await ctx.request.post('/auth/register').send({
                username: 'openuser',
                email: 'open@test.com',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(201);
            expect(res.body.accessToken).toBeDefined();
            expect(res.body.user.id).toBeDefined();
            expect(res.body.user.username).toBe('openuser');
        });

        test('register with inviteCode still works (ignored in open mode)', async () => {
            const res = await ctx.request.post('/auth/register').send({
                username: 'openuser2',
                email: 'open2@test.com',
                password: 'TestPass123!',
                inviteCode: 'some-code',
            });
            expect(res.status).toBe(201);
            expect(res.body.accessToken).toBeDefined();
        });
    });

    // ─── Invite-only policy ───
    describe('invite_only policy', () => {

        let ownerUserId: string;
        let inviteCode: string;
        let serverId: string;

        beforeEach(async () => {
            await setPolicy('invite_only');
            // Create an owner user + server + invite for invite_only tests
            const owner = await insertUserWithStatus('inviteowner', 'active');
            ownerUserId = owner.userId;
            const serverData = await createServerWithInvite(ownerUserId);
            inviteCode = serverData.inviteCode;
            serverId = serverData.serverId;
        });

        test('register without inviteCode returns 400', async () => {
            const res = await ctx.request.post('/auth/register').send({
                username: 'noinvite',
                email: 'noinvite@test.com',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Invite code is required');
        });

        test('register with invalid inviteCode returns 404', async () => {
            const res = await ctx.request.post('/auth/register').send({
                username: 'badinvite',
                email: 'badinvite@test.com',
                password: 'TestPass123!',
                inviteCode: 'nonexistent',
            });
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('Invalid invite code');
        });

        test('register with valid inviteCode returns 201, user added to server', async () => {
            const res = await ctx.request.post('/auth/register').send({
                username: 'invited',
                email: 'invited@test.com',
                password: 'TestPass123!',
                inviteCode,
            });
            expect(res.status).toBe(201);
            expect(res.body.accessToken).toBeDefined();
            expect(res.body.user.username).toBe('invited');

            // Verify user is a member of the server
            const memberCheck = await ctx.db.query(
                'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
                [serverId, res.body.user.id]
            );
            expect(memberCheck.rows.length).toBe(1);

            // Verify invite use_count was incremented
            const inviteCheck = await ctx.db.query(
                'SELECT use_count FROM server_invites WHERE code = $1',
                [inviteCode]
            );
            expect(inviteCheck.rows[0].use_count).toBe(1);
        });

        test('register with expired invite returns 404', async () => {
            // Set invite to be expired
            await ctx.db.query(
                "UPDATE server_invites SET expires_at = NOW() - INTERVAL '1 hour' WHERE code = $1",
                [inviteCode]
            );

            const res = await ctx.request.post('/auth/register').send({
                username: 'expiredinvite',
                email: 'expired@test.com',
                password: 'TestPass123!',
                inviteCode,
            });
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('Invalid invite code');
        });

        test('register with maxed-out invite returns 404', async () => {
            // Set invite to max_uses=1, use_count=1
            await ctx.db.query(
                'UPDATE server_invites SET max_uses = 1, use_count = 1 WHERE code = $1',
                [inviteCode]
            );

            const res = await ctx.request.post('/auth/register').send({
                username: 'maxedinvite',
                email: 'maxed@test.com',
                password: 'TestPass123!',
                inviteCode,
            });
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('Invalid invite code');
        });
    });

    // ─── Approval policy ───
    describe('approval policy', () => {

        beforeEach(async () => { await setPolicy('approval'); });

        test('register returns 201 with pending status and NO token', async () => {
            const res = await ctx.request.post('/auth/register').send({
                username: 'pendinguser',
                email: 'pending@test.com',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(201);
            expect(res.body.status).toBe('pending');
            expect(res.body.user.username).toBe('pendinguser');
            expect(res.body).not.toHaveProperty('accessToken');
        });

        test('pending user login returns 403 account_pending', async () => {
            // Register under approval policy
            await ctx.request.post('/auth/register').send({
                username: 'pendinglogin',
                email: 'pendinglogin@test.com',
                password: 'TestPass123!',
            });

            // Attempt login
            const res = await ctx.request.post('/auth/login').send({
                email: 'pendinglogin@test.com',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('account_pending');
        });
    });

    // ─── Login account status checks ───
    describe('login account status checks', () => {

        beforeEach(async () => { await setPolicy('open'); });

        test('suspended user login returns 403 account_suspended', async () => {
            await insertUserWithStatus('suspended', 'suspended');

            const res = await ctx.request.post('/auth/login').send({
                email: 'suspended@test.com',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('account_suspended');
        });

        test('active user login succeeds', async () => {
            await insertUserWithStatus('activeuser', 'active');

            const res = await ctx.request.post('/auth/login').send({
                email: 'activeuser@test.com',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(200);
            expect(res.body.accessToken).toBeDefined();
        });
    });

    // ─── Middleware rejects non-active users ───
    describe('requireAuth middleware rejects non-active users', () => {

        beforeEach(async () => { await setPolicy('open'); });

        test('pending user JWT on protected route returns 403', async () => {
            const { auth } = await insertUserWithStatus('pendingmw', 'pending');

            // Try to access a protected route (POST /servers)
            const res = await ctx.request
                .post('/servers')
                .set(auth)
                .send({ name: 'Should Fail' });
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('account_pending');
        });

        test('suspended user JWT on protected route returns 403', async () => {
            const { auth } = await insertUserWithStatus('suspendedmw', 'suspended');

            const res = await ctx.request
                .post('/servers')
                .set(auth)
                .send({ name: 'Should Fail' });
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('account_suspended');
        });

        test('active user JWT on protected route succeeds', async () => {
            const { auth } = await insertUserWithStatus('activemw', 'active');

            const res = await ctx.request
                .post('/servers')
                .set(auth)
                .send({ name: 'Should Succeed' });
            expect(res.status).toBe(201);
        });
    });

    // ─── Schema validation ───
    describe('schema validation', () => {

        beforeEach(async () => { await setPolicy('open'); });

        test('register rejects missing required fields', async () => {
            const res = await ctx.request.post('/auth/register').send({
                username: 'incomplete',
            });
            expect(res.status).toBe(400);
        });

        test('register rejects short password', async () => {
            const res = await ctx.request.post('/auth/register').send({
                username: 'shortpw',
                email: 'short@test.com',
                password: 'short',
            });
            expect(res.status).toBe(400);
        });

        test('register rejects invalid email format', async () => {
            const res = await ctx.request.post('/auth/register').send({
                username: 'bademail',
                email: 'not-an-email',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(400);
        });
    });
});
