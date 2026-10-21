import { setupTestApp, authedUser, cleanDatabase, createServer, joinViaInvite } from '../helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;

async function joinSearchServer(user: Awaited<ReturnType<typeof authedUser>>) {
    await joinViaInvite(ctx.request, owner.auth, user.auth, serverId);
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'searchowner');
    serverId = (await createServer(ctx.request, owner.auth, 'Search peers')).serverId;
});
afterAll(async () => { await ctx.close(); });

describe('GET /users/search', () => {
    test('returns matching users by prefix', async () => {
        const alice = await authedUser(ctx.request, 'alice');
        const alicia = await authedUser(ctx.request, 'alicia');
        await authedUser(ctx.request, 'bob');
        await joinSearchServer(alice); await joinSearchServer(alicia);

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
        const camel = await authedUser(ctx.request, 'CamelUser');
        await joinSearchServer(user); await joinSearchServer(camel);

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
        await joinSearchServer(searcher);

        // Create 25 users with same prefix
        for (let i = 0; i < 25; i++) {
            const user = await authedUser(ctx.request, `bulkuser${String(i).padStart(2, '0')}`);
            await joinSearchServer(user);
        }

        const res = await ctx.request
            .get('/users/search?q=bulkuser')
            .set(searcher.auth);

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(20);
    });
});

describe('GET /users/search: shared servers and literal prefixes (#141)', () => {
    test('a user with no shared server is hidden, including from an instance admin', async () => {
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
        expect(byPrefix.body).toEqual([]);

        await ctx.db.query('UPDATE users SET is_instance_admin = true WHERE id = $1', [a.userId]);
        const asAdmin = await ctx.request.get('/users/search?q=scopeb').set(a.auth);
        expect(asAdmin.status).toBe(200);
        expect(asAdmin.body).toEqual([]);

        for (const q of ['%', '_', '%bob', 's_o_e']) {
            const res = await ctx.request.get(`/users/search?q=${encodeURIComponent(q)}`).set(a.auth);
            expect(res.status, q).toBe(200);
            expect(res.body, q).toEqual([]);
        }
    });

    test('wildcards cannot enumerate even shared-server members', async () => {
        for (const q of ['%', '_', '%bob', 's_o_e']) {
            const res = await ctx.request.get(`/users/search?q=${encodeURIComponent(q)}`).set(owner.auth);
            expect(res.status, q).toBe(200);
            expect(res.body, q).toEqual([]);
        }
    });

    test.each([
        { seed: 'literalpercent', username: 'literal%peer', q: 'literal%' },
        { seed: 'literalunderscore', username: 'literal_peer', q: 'literal_' },
        { seed: 'literalbackslash', username: 'literal\\peer', q: 'literal\\' },
    ])('finds literal $q prefixes without widening the match', async ({ seed, username, q }) => {
        const literal = await authedUser(ctx.request, seed);
        await ctx.db.query('UPDATE users SET username = $1 WHERE id = $2', [username, literal.userId]);
        await joinSearchServer(literal);
        const decoy = await authedUser(ctx.request, `${seed}decoy`);
        await joinSearchServer(decoy);
        const res = await ctx.request.get(`/users/search?q=${encodeURIComponent(q)}`).set(owner.auth);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([{ id: literal.userId, username }]);
    });

    test('sharing multiple servers returns a person once', async () => {
        const peer = await authedUser(ctx.request, 'duplicatepeer');
        await joinSearchServer(peer);
        const other = await createServer(ctx.request, owner.auth, 'Second shared server');
        await joinViaInvite(ctx.request, owner.auth, peer.auth, other.serverId);
        const res = await ctx.request.get('/users/search?q=duplicatepeer').set(owner.auth);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([{ id: peer.userId, username: 'duplicatepeer' }]);
    });
});
