import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';

/** Per-account UI preferences (the theme), shared by every device the person signs in on. */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
});

afterAll(async () => {
    await ctx.close();
});

describe('GET/PATCH /users/@me/preferences', () => {
    it('starts empty, saves the palette, and keeps it per person', async () => {
        const a = await authedUser(ctx.request, 'prefa');
        const b = await authedUser(ctx.request, 'prefb');
        expect((await ctx.request.get('/users/@me/preferences').set(a.auth)).body).toEqual({});

        const saved = await ctx.request.patch('/users/@me/preferences').set(a.auth).send({ palette: 'terracotta' });
        expect(saved.status).toBe(200);
        expect(saved.body).toEqual({ palette: 'terracotta' });
        expect((await ctx.request.get('/users/@me/preferences').set(a.auth)).body).toEqual({ palette: 'terracotta' });
        expect((await ctx.request.get('/users/@me/preferences').set(b.auth)).body).toEqual({});
    });

    it('accepts known keys and values only', async () => {
        const a = await authedUser(ctx.request, 'prefc');
        expect((await ctx.request.patch('/users/@me/preferences').set(a.auth).send({ palette: 'neon' })).status).toBe(400);
        expect((await ctx.request.patch('/users/@me/preferences').set(a.auth).send({ isAdmin: true })).status).toBe(400);
        expect((await ctx.request.patch('/users/@me/preferences').set(a.auth).send({})).status).toBe(400);
    });

    it('is not available to bots', async () => {
        const owner = await authedUser(ctx.request, 'prefowner');
        const { serverId } = await createServer(ctx.request, owner.auth, 'Prefs Server');
        const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'prefbot' });
        const token = await ctx.request.post(`/servers/${serverId}/bots/${bot.body.id}/tokens`).set(owner.auth).send({});
        const res = await ctx.request.get('/users/@me/preferences').set({ Authorization: `Bot ${token.body.token}` });
        expect(res.status).toBe(403);
    });
});
