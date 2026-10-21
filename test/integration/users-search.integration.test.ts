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

/**
 * Extra check (beta security pass). This pins what the route does TODAY, as a finding, not
 * as the wanted behaviour: `users` has no RLS policy, the query is instance-wide, and `q` goes
 * into ILIKE unescaped, so `%` and `_` act as wildcards. If the route is changed to escape them
 * or to scope results to shared servers, these assertions flip.
 */
describe('GET /users/search: scope and wildcards (current behaviour)', () => {
    test('a user with no shared server is found, and % / _ list everyone', async () => {
        await cleanDatabase(ctx.db);
        const a = await authedUser(ctx.request, 'scopealice');
        const b = await authedUser(ctx.request, 'scopebob');
        await ctx.request.post('/servers').set(a.auth).send({ name: 'A only' });
        await ctx.request.post('/servers').set(b.auth).send({ name: 'B only' });
        const shared = await ctx.db.query(
            `SELECT count(*)::int AS n FROM server_members x JOIN server_members y ON x.server_id = y.server_id WHERE x.user_id = $1 AND y.user_id = $2`,
            [a.userId, b.userId]);
        expect(shared.rows[0].n).toBe(0);

        const byPrefix = await ctx.request.get('/users/search?q=scopeb').set(a.auth);
        expect(byPrefix.status).toBe(200);
        expect(byPrefix.body.map((u: any) => u.username)).toEqual(['scopebob']);

        for (const q of ['%', '_', '%bob', 's_o_e']) {
            const res = await ctx.request.get(`/users/search?q=${encodeURIComponent(q)}`).set(a.auth);
            expect(res.status, q).toBe(200);
            expect(res.body.map((u: any) => u.username), q).toEqual(['scopebob']);
        }
    });
});
