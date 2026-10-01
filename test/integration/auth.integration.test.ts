import { setupTestApp, cleanDatabase, authedUser, createServer } from '../helpers';

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

    test('accepts the username in place of the email', async () => {
        const res = await ctx.request.post('/auth/login').send({ login: 'loginuser', password: 'SecurePass123!' });
        expect(res.status).toBe(200);
        expect(res.body.user.username).toBe('loginuser');
        expect(res.body).toHaveProperty('accessToken');
    });

    test('accepts the email in the `login` field, and either one whatever the case', async () => {
        for (const login of ['login@test.com', 'LOGIN@Test.com', 'LoginUser', '  loginuser  ']) {
            const res = await ctx.request.post('/auth/login').send({ login, password: 'SecurePass123!' });
            expect(res.status, login).toBe(200);
            expect(res.body.user.username, login).toBe('loginuser');
        }
    });

    test('a username with the wrong password is 401, the same as an unknown one', async () => {
        const wrong = await ctx.request.post('/auth/login').send({ login: 'loginuser', password: 'WrongPassword!' });
        const ghost = await ctx.request.post('/auth/login').send({ login: 'nobodyhere', password: 'Whatever!' });
        expect(wrong.status).toBe(401);
        expect(ghost.status).toBe(401);
        expect(wrong.body).toEqual(ghost.body);
    });

    test('a username that is somebody else\'s email cannot get in the way of that person', async () => {
        // The squatter registers a username equal to the victim's email address
        await ctx.request.post('/auth/register').send({ username: 'victim', email: 'victim@test.com', password: 'VictimPass123!' });
        await ctx.request.post('/auth/register').send({ username: 'victim@test.com', email: 'squatter@test.com', password: 'SquatterPass123!' });

        const victim = await ctx.request.post('/auth/login').send({ login: 'victim@test.com', password: 'VictimPass123!' });
        expect(victim.status).toBe(200);
        expect(victim.body.user.username).toBe('victim');

        // The same identifier with the squatter's password is the squatter's own account, never the victim's
        const squatter = await ctx.request.post('/auth/login').send({ login: 'victim@test.com', password: 'SquatterPass123!' });
        expect(squatter.status).toBe(200);
        expect(squatter.body.user.username).toBe('victim@test.com');
    });

    test('a bot cannot log in by username', async () => {
        const owner = await authedUser(ctx.request, 'botloginowner');
        const { serverId } = await createServer(ctx.request, owner.auth, 'Bot Login');
        const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'loginbot' });
        expect(bot.status).toBe(201);

        for (const password of ['', ' ', 'anything']) {
            const res = await ctx.request.post('/auth/login').send({ login: 'loginbot', password });
            expect([400, 401], JSON.stringify(password)).toContain(res.status);
        }
    });

    test('a missing identifier or password is a 400, not a server error', async () => {
        expect((await ctx.request.post('/auth/login').send({ password: 'x' })).status).toBe(400);
        expect((await ctx.request.post('/auth/login').send({ login: 'loginuser' })).status).toBe(400);
        expect((await ctx.request.post('/auth/login').send({})).status).toBe(400);
    });
});
