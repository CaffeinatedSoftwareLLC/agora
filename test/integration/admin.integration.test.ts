process.env.AGORA_SETUP_TOKEN = 'test-setup-token-that-is-at-least-32chars!';

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestApp, cleanDatabase, authedUser, createServer } from '../helpers';
import { hashPassword } from '../../src/auth/passwords';
import { generateToken } from '../../src/auth/tokens';
import { generateUlid } from '../../src/utils/ulid';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
});
afterAll(async () => { await ctx.close(); });

// ─── Helpers ───

async function insertUser(
    status: 'active' | 'pending' | 'suspended',
    username: string,
    isAdmin = false
) {
    const id = generateUlid();
    const passwordHash = await hashPassword('TestPass123!');
    await ctx.db.query(
        `INSERT INTO users (id, username, email, password_hash, account_status, is_instance_admin)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, username, `${username}@test.com`, passwordHash, status, isAdmin]
    );
    const token = generateToken({ userId: id }, 'test-secret-do-not-use-in-prod');
    return { userId: id, token, auth: { Authorization: `Bearer ${token}` } };
}

// ─── Tests ───

describe('Phase 2 — Admin Dashboard', () => {

    // ─── Permission guards ───
    describe('permission guards', () => {

        beforeEach(async () => { await cleanDatabase(ctx.db); });

        test('GET /admin/stats without auth returns 401', async () => {
            const res = await ctx.request.get('/admin/stats');
            expect(res.status).toBe(401);
        });

        test('GET /admin/stats with non-admin auth returns 403', async () => {
            const user = await authedUser(ctx.request, 'regularuser');
            const res = await ctx.request.get('/admin/stats').set(user.auth);
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('insufficient_permissions');
        });

        test('all admin routes reject non-admin users', async () => {
            const user = await authedUser(ctx.request, 'nonadmin');
            const fakeId = generateUlid();

            const results = await Promise.all([
                ctx.request.get('/admin/stats').set(user.auth),
                ctx.request.get('/admin/pending-users').set(user.auth),
                ctx.request.post(`/admin/approve-user/${fakeId}`).set(user.auth),
                ctx.request.post(`/admin/reject-user/${fakeId}`).set(user.auth),
                ctx.request.get('/admin/users').set(user.auth),
                ctx.request.post(`/admin/users/${fakeId}/ban`).set(user.auth),
                ctx.request.patch('/admin/instance').set(user.auth).send({ instanceName: 'X' }),
            ]);

            for (const res of results) {
                expect(res.status).toBe(403);
                expect(res.body.error).toBe('insufficient_permissions');
            }
        });
    });

    // ─── GET /admin/stats ───
    describe('GET /admin/stats', () => {

        beforeEach(async () => { await cleanDatabase(ctx.db); });

        test('returns correct counts', async () => {
            const admin = await insertUser('active', 'statsadmin', true);
            await insertUser('active', 'user1');
            await insertUser('pending', 'pending1');
            await insertUser('pending', 'pending2');

            const res = await ctx.request.get('/admin/stats').set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.totalUsers).toBe(4); // admin + user1 + pending1 + pending2
            expect(res.body.pendingCount).toBe(2);
            expect(res.body.serverCount).toBe(0);
        });

        test('counts update after creating users and servers', async () => {
            const admin = await insertUser('active', 'statsadmin2', true);

            // Initial state: just the admin
            let res = await ctx.request.get('/admin/stats').set(admin.auth);
            expect(res.body.totalUsers).toBe(1);
            expect(res.body.serverCount).toBe(0);

            // Add a user and a server
            await authedUser(ctx.request, 'newuser');
            await createServer(ctx.request, admin.auth, 'Test Server');

            res = await ctx.request.get('/admin/stats').set(admin.auth);
            expect(res.body.totalUsers).toBe(2);
            expect(res.body.serverCount).toBe(1);
        });
    });

    // ─── GET /admin/pending-users ───
    describe('GET /admin/pending-users', () => {

        beforeEach(async () => { await cleanDatabase(ctx.db); });

        test('returns pending users only', async () => {
            const admin = await insertUser('active', 'padmin', true);
            await insertUser('active', 'activeuser');
            const pending = await insertUser('pending', 'penduser');

            const res = await ctx.request.get('/admin/pending-users').set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.users).toHaveLength(1);
            expect(res.body.users[0].username).toBe('penduser');
            expect(res.body.users[0].id).toBe(pending.userId);
            expect(res.body.total).toBe(1);
        });

        test('respects pagination', async () => {
            const admin = await insertUser('active', 'pagadmin', true);
            // Create 3 pending users
            await insertUser('pending', 'pend_a');
            await insertUser('pending', 'pend_b');
            await insertUser('pending', 'pend_c');

            // Page 1, limit 2
            const page1 = await ctx.request
                .get('/admin/pending-users?page=1&limit=2')
                .set(admin.auth);
            expect(page1.status).toBe(200);
            expect(page1.body.users).toHaveLength(2);
            expect(page1.body.total).toBe(3);
            expect(page1.body.page).toBe(1);
            expect(page1.body.limit).toBe(2);

            // Page 2, limit 2
            const page2 = await ctx.request
                .get('/admin/pending-users?page=2&limit=2')
                .set(admin.auth);
            expect(page2.body.users).toHaveLength(1);
            expect(page2.body.total).toBe(3);
            expect(page2.body.page).toBe(2);
        });

        test('empty list when no pending users', async () => {
            const admin = await insertUser('active', 'emptyadmin', true);
            await insertUser('active', 'someuser');

            const res = await ctx.request.get('/admin/pending-users').set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.users).toHaveLength(0);
            expect(res.body.total).toBe(0);
        });
    });

    // ─── POST /admin/approve-user/:id ───
    describe('POST /admin/approve-user/:id', () => {

        beforeEach(async () => { await cleanDatabase(ctx.db); });

        test('approves a pending user', async () => {
            const admin = await insertUser('active', 'appradmin', true);
            const pending = await insertUser('pending', 'pendappr');

            const res = await ctx.request
                .post(`/admin/approve-user/${pending.userId}`)
                .set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.user.id).toBe(pending.userId);
            expect(res.body.user.username).toBe('pendappr');
            expect(res.body.user.accountStatus).toBe('active');
        });

        test('returns 404 for nonexistent user', async () => {
            const admin = await insertUser('active', 'appr404admin', true);
            const fakeId = generateUlid();

            const res = await ctx.request
                .post(`/admin/approve-user/${fakeId}`)
                .set(admin.auth);
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('user_not_found');
        });

        test('returns 409 for non-pending user', async () => {
            const admin = await insertUser('active', 'appr409admin', true);
            const active = await insertUser('active', 'alreadyactive');

            const res = await ctx.request
                .post(`/admin/approve-user/${active.userId}`)
                .set(admin.auth);
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('user_not_pending');
        });

        test('approved user can then login', async () => {
            const admin = await insertUser('active', 'apprloginadmin', true);
            const pending = await insertUser('pending', 'loginpend');

            // Approve the user
            await ctx.request
                .post(`/admin/approve-user/${pending.userId}`)
                .set(admin.auth);

            // Now the user can log in
            const loginRes = await ctx.request.post('/auth/login').send({
                email: 'loginpend@test.com',
                password: 'TestPass123!',
            });
            expect(loginRes.status).toBe(200);
            expect(loginRes.body.accessToken).toBeDefined();
        });
    });

    // ─── POST /admin/reject-user/:id ───
    describe('POST /admin/reject-user/:id', () => {

        beforeEach(async () => { await cleanDatabase(ctx.db); });

        test('rejects a pending user (deletes them)', async () => {
            const admin = await insertUser('active', 'rejadmin', true);
            const pending = await insertUser('pending', 'rejpend');

            const res = await ctx.request
                .post(`/admin/reject-user/${pending.userId}`)
                .set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            // Verify user is gone
            const check = await ctx.db.query(
                'SELECT 1 FROM users WHERE id = $1',
                [pending.userId]
            );
            expect(check.rows).toHaveLength(0);
        });

        test('returns 404 for nonexistent user', async () => {
            const admin = await insertUser('active', 'rej404admin', true);
            const fakeId = generateUlid();

            const res = await ctx.request
                .post(`/admin/reject-user/${fakeId}`)
                .set(admin.auth);
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('user_not_found');
        });

        test('returns 409 for non-pending user', async () => {
            const admin = await insertUser('active', 'rej409admin', true);
            const active = await insertUser('active', 'rejalready');

            const res = await ctx.request
                .post(`/admin/reject-user/${active.userId}`)
                .set(admin.auth);
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('user_not_pending');
        });
    });

    // ─── GET /admin/users ───
    describe('GET /admin/users', () => {

        beforeEach(async () => { await cleanDatabase(ctx.db); });

        test('returns all users with pagination', async () => {
            const admin = await insertUser('active', 'usradmin', true);
            await insertUser('active', 'usr1');
            await insertUser('pending', 'usr2');
            await insertUser('suspended', 'usr3');

            const res = await ctx.request.get('/admin/users').set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.users).toHaveLength(4);
            expect(res.body.total).toBe(4);
            expect(res.body.page).toBe(1);
            expect(res.body.limit).toBe(20);

            // Verify all expected fields are present
            const first = res.body.users[0];
            expect(first).toHaveProperty('id');
            expect(first).toHaveProperty('username');
            expect(first).toHaveProperty('email');
            expect(first).toHaveProperty('accountStatus');
            expect(first).toHaveProperty('isInstanceAdmin');
            expect(first).toHaveProperty('createdAt');
        });

        test('filters by status', async () => {
            const admin = await insertUser('active', 'filtadmin', true);
            await insertUser('active', 'filt1');
            await insertUser('pending', 'filt2');
            await insertUser('pending', 'filt3');

            const res = await ctx.request
                .get('/admin/users?status=pending')
                .set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.users).toHaveLength(2);
            expect(res.body.total).toBe(2);
            for (const user of res.body.users) {
                expect(user.accountStatus).toBe('pending');
            }
        });

        test('searches by username (ILIKE)', async () => {
            const admin = await insertUser('active', 'srchadmin', true);
            await insertUser('active', 'alice_test');
            await insertUser('active', 'bob_test');

            const res = await ctx.request
                .get('/admin/users?search=alice')
                .set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.users).toHaveLength(1);
            expect(res.body.users[0].username).toBe('alice_test');
        });

        test('searches by email (ILIKE)', async () => {
            const admin = await insertUser('active', 'emailadmin', true);
            await insertUser('active', 'findme');
            await insertUser('active', 'other');

            const res = await ctx.request
                .get('/admin/users?search=findme%40')
                .set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.users).toHaveLength(1);
            expect(res.body.users[0].email).toBe('findme@test.com');
        });

        test('combined status + search filters work', async () => {
            const admin = await insertUser('active', 'comboadmin', true);
            await insertUser('active', 'combo_alice');
            await insertUser('pending', 'combo_alice_pend');
            await insertUser('active', 'combo_bob');

            const res = await ctx.request
                .get('/admin/users?status=active&search=alice')
                .set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.users).toHaveLength(1);
            expect(res.body.users[0].username).toBe('combo_alice');
            expect(res.body.users[0].accountStatus).toBe('active');
        });
    });

    // ─── POST /admin/users/:id/ban ───
    describe('POST /admin/users/:id/ban', () => {

        beforeEach(async () => { await cleanDatabase(ctx.db); });

        test('suspends an active user', async () => {
            const admin = await insertUser('active', 'suspadmin', true);
            const target = await insertUser('active', 'susptarget');

            const res = await ctx.request
                .post(`/admin/users/${target.userId}/ban`)
                .set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.user.id).toBe(target.userId);
            expect(res.body.user.accountStatus).toBe('suspended');
        });

        test('returns 400 cannot_suspend_self', async () => {
            const admin = await insertUser('active', 'selfsusp', true);

            const res = await ctx.request
                .post(`/admin/users/${admin.userId}/ban`)
                .set(admin.auth);
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('cannot_suspend_self');
        });

        test('returns 400 cannot_suspend_admin', async () => {
            const admin = await insertUser('active', 'suspadmin2', true);
            const otherAdmin = await insertUser('active', 'otheradmin', true);

            const res = await ctx.request
                .post(`/admin/users/${otherAdmin.userId}/ban`)
                .set(admin.auth);
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('cannot_suspend_admin');
        });

        test('returns 404 for nonexistent user', async () => {
            const admin = await insertUser('active', 'susp404admin', true);
            const fakeId = generateUlid();

            const res = await ctx.request
                .post(`/admin/users/${fakeId}/ban`)
                .set(admin.auth);
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('user_not_found');
        });

        test('returns 409 user_not_active for already suspended user', async () => {
            const admin = await insertUser('active', 'susp409admin', true);
            const suspended = await insertUser('suspended', 'alreadysusp');

            const res = await ctx.request
                .post(`/admin/users/${suspended.userId}/ban`)
                .set(admin.auth);
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('user_not_active');
        });

        test('suspended user auth request fails with account_suspended', async () => {
            const admin = await insertUser('active', 'suspauthadmin', true);
            const target = await insertUser('active', 'suspauthuser');

            // Suspend the user
            await ctx.request
                .post(`/admin/users/${target.userId}/ban`)
                .set(admin.auth);

            // Suspended user tries to access a protected route
            const res = await ctx.request
                .post('/servers')
                .set(target.auth)
                .send({ name: 'Should Fail' });
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('account_suspended');
        });

        test('/suspend alias still works', async () => {
            const admin = await insertUser('active', 'aliasadmin', true);
            const target = await insertUser('active', 'aliastarget');

            const res = await ctx.request
                .post(`/admin/users/${target.userId}/suspend`)
                .set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.user.accountStatus).toBe('suspended');
        });
    });

    // ─── POST /admin/users/:id/ip-ban ───
    describe('POST /admin/users/:id/ip-ban', () => {

        beforeEach(async () => { await cleanDatabase(ctx.db); });

        test('IP ban creates ip_bans row and suspends active user', async () => {
            const admin = await insertUser('active', 'ipbanadmin', true);
            const target = await insertUser('active', 'ipbantarget');

            // Give target a recorded IP
            await ctx.db.query(
                "UPDATE users SET last_ip_hmac = 'testhash', last_ip_encrypted = 'testenc' WHERE id = $1",
                [target.userId]
            );

            const res = await ctx.request
                .post(`/admin/users/${target.userId}/ip-ban`)
                .set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.accountBanned).toBe(true);
            expect(res.body.ipBanned).toBe(true);
            expect(res.body.user.accountStatus).toBe('suspended');

            // Verify ip_bans row
            const bans = await ctx.db.query('SELECT * FROM ip_bans WHERE ip_hmac = $1', ['testhash']);
            expect(bans.rows).toHaveLength(1);
        });

        test('IP ban with no recorded IP returns 400', async () => {
            const admin = await insertUser('active', 'ipban400admin', true);
            const target = await insertUser('active', 'ipban400target');

            const res = await ctx.request
                .post(`/admin/users/${target.userId}/ip-ban`)
                .set(admin.auth);
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('no_ip_recorded');
        });

        test('IP ban on pending user does not change account status', async () => {
            const admin = await insertUser('active', 'ipbanpendadmin', true);
            const target = await insertUser('pending', 'ipbanpendtarget');

            await ctx.db.query(
                "UPDATE users SET last_ip_hmac = 'pendhash', last_ip_encrypted = 'pendenc' WHERE id = $1",
                [target.userId]
            );

            const res = await ctx.request
                .post(`/admin/users/${target.userId}/ip-ban`)
                .set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.accountBanned).toBe(false);
            expect(res.body.ipBanned).toBe(true);
            expect(res.body.user.accountStatus).toBe('pending');
        });

        test('re-banning an IP after expiration makes ban active again', async () => {
            const admin = await insertUser('active', 'rebanadmin', true);
            const target = await insertUser('active', 'rebantarget');

            // Give target a recorded IP
            await ctx.db.query(
                "UPDATE users SET last_ip_hmac = 'rebanhash', last_ip_encrypted = 'rebanenc' WHERE id = $1",
                [target.userId]
            );

            // Insert an expired IP ban directly
            const { generateUlid: genId } = await import('../../src/utils/ulid');
            await ctx.db.query(
                `INSERT INTO ip_bans (id, ip_hmac, ip_encrypted, banned_by, expires_at)
                 VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour')`,
                [genId(), 'rebanhash', 'rebanenc', admin.userId]
            );

            // Re-ban via admin endpoint — should upsert and clear expires_at
            const res = await ctx.request
                .post(`/admin/users/${target.userId}/ip-ban`)
                .set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.ipBanned).toBe(true);

            // Verify the ban is now active (expires_at cleared)
            const ban = await ctx.db.query(
                "SELECT expires_at FROM ip_bans WHERE ip_hmac = 'rebanhash'"
            );
            expect(ban.rows).toHaveLength(1);
            expect(ban.rows[0].expires_at).toBeNull();
        });
    });

    // ─── GET /admin/ip-bans ───
    describe('GET /admin/ip-bans', () => {

        beforeEach(async () => { await cleanDatabase(ctx.db); });

        test('lists IP bans', async () => {
            const admin = await insertUser('active', 'listipbanadmin', true);

            // Insert an IP ban directly
            const { generateUlid: genId } = await import('../../src/utils/ulid');
            await ctx.db.query(
                `INSERT INTO ip_bans (id, ip_hmac, ip_encrypted, reason, banned_by)
                 VALUES ($1, $2, $3, $4, $5)`,
                [genId(), 'somehash', 'someenc', 'test reason', admin.userId]
            );

            const res = await ctx.request
                .get('/admin/ip-bans')
                .set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.bans).toHaveLength(1);
            expect(res.body.bans[0].reason).toBe('test reason');
            expect(res.body.total).toBe(1);
        });
    });

    // ─── DELETE /admin/ip-bans/:id ───
    describe('DELETE /admin/ip-bans/:id', () => {

        beforeEach(async () => { await cleanDatabase(ctx.db); });

        test('removes an IP ban', async () => {
            const admin = await insertUser('active', 'delipbanadmin', true);

            const { generateUlid: genId } = await import('../../src/utils/ulid');
            const banId = genId();
            await ctx.db.query(
                `INSERT INTO ip_bans (id, ip_hmac, ip_encrypted, banned_by)
                 VALUES ($1, $2, $3, $4)`,
                [banId, 'delhash', 'delenc', admin.userId]
            );

            const res = await ctx.request
                .delete(`/admin/ip-bans/${banId}`)
                .set(admin.auth);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            // Verify removed
            const check = await ctx.db.query('SELECT 1 FROM ip_bans WHERE id = $1', [banId]);
            expect(check.rows).toHaveLength(0);

            // Check audit log
            const log = await ctx.db.query(
                "SELECT * FROM audit_log WHERE action = 'ip_ban_remove'"
            );
            expect(log.rows).toHaveLength(1);
        });

        test('returns 404 for nonexistent IP ban', async () => {
            const admin = await insertUser('active', 'del404ipbanadmin', true);
            const { generateUlid: genId } = await import('../../src/utils/ulid');

            const res = await ctx.request
                .delete(`/admin/ip-bans/${genId()}`)
                .set(admin.auth);
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('ip_ban_not_found');
        });
    });

    // ─── PATCH /admin/instance ───
    describe('PATCH /admin/instance', () => {

        beforeEach(async () => { await cleanDatabase(ctx.db); });

        test('updates instanceName only', async () => {
            const admin = await insertUser('active', 'instadmin', true);

            const res = await ctx.request
                .patch('/admin/instance')
                .set(admin.auth)
                .send({ instanceName: 'New Name' });
            expect(res.status).toBe(200);
            expect(res.body.instanceName).toBe('New Name');
            expect(res.body.registrationPolicy).toBe('open'); // unchanged default
        });

        test('updates registrationPolicy only', async () => {
            const admin = await insertUser('active', 'poladmin', true);

            const res = await ctx.request
                .patch('/admin/instance')
                .set(admin.auth)
                .send({ registrationPolicy: 'approval' });
            expect(res.status).toBe(200);
            expect(res.body.registrationPolicy).toBe('approval');
            expect(res.body.instanceName).toBe('Agora'); // unchanged default
        });

        test('updates both fields', async () => {
            const admin = await insertUser('active', 'bothadmin', true);

            const res = await ctx.request
                .patch('/admin/instance')
                .set(admin.auth)
                .send({ instanceName: 'Updated', registrationPolicy: 'invite_only' });
            expect(res.status).toBe(200);
            expect(res.body.instanceName).toBe('Updated');
            expect(res.body.registrationPolicy).toBe('invite_only');
        });

        test('returns current config after update', async () => {
            const admin = await insertUser('active', 'cfgadmin', true);

            // First update
            await ctx.request
                .patch('/admin/instance')
                .set(admin.auth)
                .send({ instanceName: 'Step One' });

            // Second update only changes policy
            const res = await ctx.request
                .patch('/admin/instance')
                .set(admin.auth)
                .send({ registrationPolicy: 'approval' });

            // Both fields reflect cumulative state
            expect(res.body.instanceName).toBe('Step One');
            expect(res.body.registrationPolicy).toBe('approval');
        });

        test('policy change affects next registration', async () => {
            const admin = await insertUser('active', 'polchgadmin', true);

            // Switch to approval policy
            await ctx.request
                .patch('/admin/instance')
                .set(admin.auth)
                .send({ registrationPolicy: 'approval' });

            // Register a user under approval policy
            const regRes = await ctx.request.post('/auth/register').send({
                username: 'newpending',
                email: 'newpending@test.com',
                password: 'TestPass123!',
            });
            expect(regRes.status).toBe(201);
            expect(regRes.body.status).toBe('pending');
            expect(regRes.body).not.toHaveProperty('accessToken');
        });

        test('rejects with no partial write when a config key is missing', async () => {
            const admin = await insertUser('active', 'partialadmin', true);

            // Delete one config key to simulate missing row
            await ctx.db.query("DELETE FROM instance_config WHERE key = 'registration_policy'");

            // Send both fields — should fail before any writes
            const res = await ctx.request
                .patch('/admin/instance')
                .set(admin.auth)
                .send({ instanceName: 'Should Not Persist', registrationPolicy: 'approval' });
            expect(res.status).toBe(500);
            expect(res.body.error).toBe('config_key_missing');
            expect(res.body.key).toBe('registration_policy');

            // Verify instance_name was NOT changed (no partial write)
            const check = await ctx.db.query(
                "SELECT value FROM instance_config WHERE key = 'instance_name'"
            );
            expect(check.rows[0].value).toBe('Agora'); // original default, untouched
        });

        test('validates registrationPolicy enum', async () => {
            const admin = await insertUser('active', 'enumadmin', true);

            const res = await ctx.request
                .patch('/admin/instance')
                .set(admin.auth)
                .send({ registrationPolicy: 'invalid_value' });
            expect(res.status).toBe(400);
        });
    });

    // ─── Audit logging ───
    describe('audit logging', () => {

        beforeEach(async () => { await cleanDatabase(ctx.db); });

        test('approve writes audit_log entry', async () => {
            const admin = await insertUser('active', 'auditappadmin', true);
            const pending = await insertUser('pending', 'auditapppend');

            await ctx.request
                .post(`/admin/approve-user/${pending.userId}`)
                .set(admin.auth);

            const log = await ctx.db.query(
                "SELECT * FROM audit_log WHERE action = 'user_approve' AND target_id = $1",
                [pending.userId]
            );
            expect(log.rows).toHaveLength(1);
            expect(log.rows[0].actor_id.trim()).toBe(admin.userId);
            expect(log.rows[0].target_type).toBe('user');
            const changes = typeof log.rows[0].changes === 'string'
                ? JSON.parse(log.rows[0].changes)
                : log.rows[0].changes;
            expect(changes.before.accountStatus).toBe('pending');
            expect(changes.after.accountStatus).toBe('active');
        });

        test('reject writes audit_log entry', async () => {
            const admin = await insertUser('active', 'auditrejadmin', true);
            const pending = await insertUser('pending', 'auditrejpend');

            await ctx.request
                .post(`/admin/reject-user/${pending.userId}`)
                .set(admin.auth);

            const log = await ctx.db.query(
                "SELECT * FROM audit_log WHERE action = 'user_reject' AND target_id = $1",
                [pending.userId]
            );
            expect(log.rows).toHaveLength(1);
            expect(log.rows[0].actor_id.trim()).toBe(admin.userId);
            const changes = typeof log.rows[0].changes === 'string'
                ? JSON.parse(log.rows[0].changes)
                : log.rows[0].changes;
            expect(changes.username).toBe('auditrejpend');
        });

        test('suspend writes audit_log entry', async () => {
            const admin = await insertUser('active', 'auditsuspadmin', true);
            const target = await insertUser('active', 'auditsusptarget');

            await ctx.request
                .post(`/admin/users/${target.userId}/ban`)
                .set(admin.auth);

            const log = await ctx.db.query(
                "SELECT * FROM audit_log WHERE action = 'user_ban' AND target_id = $1",
                [target.userId]
            );
            expect(log.rows).toHaveLength(1);
            expect(log.rows[0].actor_id.trim()).toBe(admin.userId);
            const changes = typeof log.rows[0].changes === 'string'
                ? JSON.parse(log.rows[0].changes)
                : log.rows[0].changes;
            expect(changes.before.accountStatus).toBe('active');
            expect(changes.after.accountStatus).toBe('suspended');
        });

        test('instance update writes audit_log entry', async () => {
            const admin = await insertUser('active', 'auditinstadmin', true);

            const patchRes = await ctx.request
                .patch('/admin/instance')
                .set(admin.auth)
                .send({ instanceName: 'Audit Test', registrationPolicy: 'approval' });
            expect(patchRes.status).toBe(200);

            const log = await ctx.db.query(
                "SELECT * FROM audit_log WHERE action = 'instance_update'"
            );
            expect(log.rows).toHaveLength(1);
            expect(log.rows[0].actor_id.trim()).toBe(admin.userId);
            expect(log.rows[0].target_type).toBe('instance');
            const changes = typeof log.rows[0].changes === 'string'
                ? JSON.parse(log.rows[0].changes)
                : log.rows[0].changes;
            expect(changes.instanceName).toBe('Audit Test');
            expect(changes.registrationPolicy).toBe('approval');
        });
    });

    // ─── Auth IP ban integration ───
    describe('auth IP ban checks', () => {

        beforeEach(async () => { await cleanDatabase(ctx.db); });

        test('IP-banned IP is rejected on register', async () => {
            const admin = await insertUser('active', 'authipbanadmin', true);

            // Register a user first (to record their IP), then IP-ban them
            const regRes = await ctx.request.post('/auth/register').send({
                username: 'ipbanned',
                email: 'ipbanned@test.com',
                password: 'TestPass123!',
            });
            expect(regRes.status).toBe(201);

            // Get the user's IP HMAC
            const userRow = await ctx.db.query(
                'SELECT last_ip_hmac, last_ip_encrypted FROM users WHERE id = $1',
                [regRes.body.user.id]
            );

            // Insert IP ban with that HMAC
            const { generateUlid: genId } = await import('../../src/utils/ulid');
            await ctx.db.query(
                `INSERT INTO ip_bans (id, ip_hmac, ip_encrypted, banned_by)
                 VALUES ($1, $2, $3, $4)`,
                [genId(), userRow.rows[0].last_ip_hmac, userRow.rows[0].last_ip_encrypted, admin.userId]
            );

            // Try to register from same IP — should be blocked
            const res = await ctx.request.post('/auth/register').send({
                username: 'newuser',
                email: 'newuser@test.com',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('ip_banned');
        });

        test('IP-banned IP is rejected on login', async () => {
            const admin = await insertUser('active', 'authipbanadmin2', true);

            // Register a user and login to record IP
            const regRes = await ctx.request.post('/auth/register').send({
                username: 'loginipbanned',
                email: 'loginipbanned@test.com',
                password: 'TestPass123!',
            });
            expect(regRes.status).toBe(201);

            // Get IP HMAC
            const userRow = await ctx.db.query(
                'SELECT last_ip_hmac, last_ip_encrypted FROM users WHERE id = $1',
                [regRes.body.user.id]
            );

            // Insert IP ban
            const { generateUlid: genId } = await import('../../src/utils/ulid');
            await ctx.db.query(
                `INSERT INTO ip_bans (id, ip_hmac, ip_encrypted, banned_by)
                 VALUES ($1, $2, $3, $4)`,
                [genId(), userRow.rows[0].last_ip_hmac, userRow.rows[0].last_ip_encrypted, admin.userId]
            );

            // Try to login — should be blocked
            const res = await ctx.request.post('/auth/login').send({
                email: 'loginipbanned@test.com',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('ip_banned');
        });

        test('successful register records IP', async () => {
            const res = await ctx.request.post('/auth/register').send({
                username: 'iprecord',
                email: 'iprecord@test.com',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(201);

            const user = await ctx.db.query(
                'SELECT last_ip_hmac, last_ip_encrypted FROM users WHERE id = $1',
                [res.body.user.id]
            );
            expect(user.rows[0].last_ip_hmac).toBeTruthy();
            expect(user.rows[0].last_ip_encrypted).toBeTruthy();
        });

        test('successful login records IP', async () => {
            await insertUser('active', 'loginiprecord');

            const res = await ctx.request.post('/auth/login').send({
                email: 'loginiprecord@test.com',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(200);

            const user = await ctx.db.query(
                'SELECT last_ip_hmac, last_ip_encrypted FROM users WHERE username = $1',
                ['loginiprecord']
            );
            expect(user.rows[0].last_ip_hmac).toBeTruthy();
            expect(user.rows[0].last_ip_encrypted).toBeTruthy();
        });

        test('expired IP ban is ignored', async () => {
            const admin = await insertUser('active', 'expipbanadmin', true);

            // Register a user to get their IP
            const regRes = await ctx.request.post('/auth/register').send({
                username: 'expiptest',
                email: 'expiptest@test.com',
                password: 'TestPass123!',
            });

            const userRow = await ctx.db.query(
                'SELECT last_ip_hmac, last_ip_encrypted FROM users WHERE id = $1',
                [regRes.body.user.id]
            );

            // Insert EXPIRED IP ban
            const { generateUlid: genId } = await import('../../src/utils/ulid');
            await ctx.db.query(
                `INSERT INTO ip_bans (id, ip_hmac, ip_encrypted, banned_by, expires_at)
                 VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour')`,
                [genId(), userRow.rows[0].last_ip_hmac, userRow.rows[0].last_ip_encrypted, admin.userId]
            );

            // Register should succeed (ban is expired)
            const res = await ctx.request.post('/auth/register').send({
                username: 'afterexpiry',
                email: 'afterexpiry@test.com',
                password: 'TestPass123!',
            });
            expect(res.status).toBe(201);
        });
    });
});
