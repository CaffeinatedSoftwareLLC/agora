import { setupTestApp, authedUser, cleanDatabase } from '../helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
});
afterAll(async () => { await ctx.close(); });

describe('GET /users/search', () => {
    test('returns matching users by prefix', async () => {
        const alice = await authedUser(ctx.request, 'alice');
        await authedUser(ctx.request, 'alicia');
        await authedUser(ctx.request, 'bob');

        const res = await ctx.request
            .get('/users/search?q=ali')
            .set(alice.auth);

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1); // alice is excluded (self), only alicia
        expect(res.body[0].username).toBe('alicia');
        expect(res.body[0].id).toBeDefined();
    });

    test('excludes the requesting user from results', async () => {
        const self = await authedUser(ctx.request, 'searchself');

        const res = await ctx.request
            .get('/users/search?q=searchself')
            .set(self.auth);

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(0);
    });

    test('returns empty array when no match', async () => {
        const user = await authedUser(ctx.request, 'nomatch_searcher');

        const res = await ctx.request
            .get('/users/search?q=zzzznoexist')
            .set(user.auth);

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    test('returns 400 when q is missing', async () => {
        const user = await authedUser(ctx.request, 'badquery');

        const res = await ctx.request
            .get('/users/search')
            .set(user.auth);

        expect(res.status).toBe(400);
    });

    test('search is case-insensitive', async () => {
        const user = await authedUser(ctx.request, 'casesearcher');
        await authedUser(ctx.request, 'CamelUser');

        const res = await ctx.request
            .get('/users/search?q=camelus')
            .set(user.auth);

        expect(res.status).toBe(200);
        expect(res.body.length).toBeGreaterThanOrEqual(1);
        expect(res.body.some((u: any) => u.username === 'CamelUser')).toBe(true);
    });

    test('returns 401 when unauthenticated', async () => {
        const res = await ctx.request
            .get('/users/search?q=test');

        expect(res.status).toBe(401);
    });

    test('limits results to 20', async () => {
        const searcher = await authedUser(ctx.request, 'limitsearcher');

        // Create 25 users with same prefix
        for (let i = 0; i < 25; i++) {
            await authedUser(ctx.request, `bulkuser${String(i).padStart(2, '0')}`);
        }

        const res = await ctx.request
            .get('/users/search?q=bulkuser')
            .set(searcher.auth);

        expect(res.status).toBe(200);
        expect(res.body.length).toBeLessThanOrEqual(20);
    });
});
