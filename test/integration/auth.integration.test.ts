import { setupTestApp, cleanDatabase } from '../helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
    ctx = await setupTestApp();
    // Clean slate: remove users seeded by prior runs to prevent dirty-DB false passes
    await cleanDatabase(ctx.db);
});
afterAll(async () => { await ctx.close(); });

describe('POST /auth/register', () => {
    test('creates user, returns token, no password_hash leaked', async () => {
        const res = await ctx.request.post('/auth/register').send({
            username: 'newuser',
            email: 'new@test.com',
            password: 'SecurePass123!',
        });
        expect(res.status).toBe(201);
        expect(res.body).toHaveProperty('accessToken');
        expect(res.body.user.username).toBe('newuser');
        expect(res.body.user).not.toHaveProperty('password_hash');
        expect(res.body.user).not.toHaveProperty('passwordHash');
    });

    test('rejects duplicate username or email', async () => {
        const seed = await ctx.request.post('/auth/register').send({
            username: 'taken', email: 'taken@test.com', password: 'SecurePass123!',
        });
        expect(seed.status).toBe(201);

        // Same username
        const dupeUser = await ctx.request.post('/auth/register').send({
            username: 'taken', email: 'different@test.com', password: 'SecurePass123!',
        });
        expect(dupeUser.status).toBe(409);

        // Same email
        const dupeEmail = await ctx.request.post('/auth/register').send({
            username: 'different', email: 'taken@test.com', password: 'SecurePass123!',
        });
        expect(dupeEmail.status).toBe(409);
    });

    test('rejects missing required fields', async () => {
        const res = await ctx.request.post('/auth/register').send({
            username: 'incomplete',
        });
        expect(res.status).toBe(400);
    });
});

describe('POST /auth/login', () => {
    beforeAll(async () => {
        await ctx.request.post('/auth/register').send({
            username: 'loginuser', email: 'login@test.com', password: 'SecurePass123!',
        });
    });

    test('returns token for valid credentials', async () => {
        const res = await ctx.request.post('/auth/login').send({
            email: 'login@test.com', password: 'SecurePass123!',
        });
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('accessToken');
        expect(res.body.user).toBeDefined();
        expect(res.body.user.id).toBeDefined();
        expect(res.body.user.username).toBe('loginuser');
    });

    test('401 for wrong password (same shape as nonexistent email)', async () => {
        const wrong = await ctx.request.post('/auth/login').send({
            email: 'login@test.com', password: 'WrongPassword!',
        });
        expect(wrong.status).toBe(401);

        const ghost = await ctx.request.post('/auth/login').send({
            email: 'ghost@test.com', password: 'Whatever!',
        });
        expect(ghost.status).toBe(401);

        // Same error shape — don't leak which emails exist
        expect(wrong.body.error).toBe(ghost.body.error);
        // Full body shape must be identical to prevent enumeration via other fields
        expect(Object.keys(wrong.body).sort()).toEqual(Object.keys(ghost.body).sort());
    });
});
