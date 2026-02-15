import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';

describe('GET /servers/:id/members', () => {
    let ctx: Awaited<ReturnType<typeof setupTestApp>>;
    beforeAll(async () => { ctx = await setupTestApp(); await cleanDatabase(ctx.db); });
    afterAll(async () => { await ctx.close(); });

    it('returns 403 for non-member', async () => {
        const owner = await authedUser(ctx.request, 'owner');
        const outsider = await authedUser(ctx.request, 'outsider');
        const { serverId } = await createServer(ctx.request, owner.auth, 'TestServer');

        const res = await ctx.request.get(`/servers/${serverId}/members`).set(outsider.auth);
        expect(res.status).toBe(403);
    });

    it('returns owner as member with empty roles array', async () => {
        const owner = await authedUser(ctx.request, 'owner2');
        const { serverId } = await createServer(ctx.request, owner.auth, 'TestServer2');

        const res = await ctx.request.get(`/servers/${serverId}/members`).set(owner.auth);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].id).toBe(owner.userId);
        expect(res.body[0].username).toBe('owner2');
        expect(res.body[0].roles).toEqual([]);
        expect(res.body[0].joinedAt).toBeDefined();
    });

    it('includes joined members after invite', async () => {
        const owner = await authedUser(ctx.request, 'owner3');
        const joiner = await authedUser(ctx.request, 'joiner3');
        const { serverId } = await createServer(ctx.request, owner.auth, 'TestServer3');
        await joinViaInvite(ctx.request, owner.auth, joiner.auth, serverId);

        const res = await ctx.request.get(`/servers/${serverId}/members`).set(owner.auth);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
        const usernames = res.body.map((m: any) => m.username);
        expect(usernames).toContain('owner3');
        expect(usernames).toContain('joiner3');
    });
});
