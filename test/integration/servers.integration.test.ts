import { setupTestApp, authedUser, createServer } from '../helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('Server Lifecycle', () => {
    test('creating a server produces @everyone role, #general, creator as member', async () => {
        const user = await authedUser(ctx.request, 'servermaker');

        const res = await ctx.request
            .post('/servers')
            .set(user.auth)
            .send({ name: 'Test Server' });

        expect(res.status).toBe(201);
        expect(res.body.ownerId).toBe(user.userId);
        expect(res.body.everyoneRoleId).toBeDefined();

        const channels = await ctx.request
            .get(`/servers/${res.body.id}/channels`)
            .set(user.auth);

        const general = channels.body.find((c: any) => c.name === 'general');
        expect(general).toBeDefined();
        expect(general.channelType).toBe(3); // server_text
    });

    test('unauthenticated server creation returns 401', async () => {
        const res = await ctx.request
            .post('/servers')
            .send({ name: 'No Auth Server' });

        expect(res.status).toBe(401);
    });

    test('invite create + join', async () => {
        const owner = await authedUser(ctx.request, 'inviteowner');
        const joiner = await authedUser(ctx.request, 'invitejoiner');
        const { serverId } = await createServer(ctx.request, owner.auth, 'Invite Server');

        // Owner creates invite
        const invite = await ctx.request
            .post(`/servers/${serverId}/invites`)
            .set(owner.auth)
            .send({});

        expect(invite.status).toBe(201);
        expect(typeof invite.body.code).toBe('string');
        expect(invite.body.code.length).toBeLessThanOrEqual(12);

        // Joiner uses invite
        const join = await ctx.request
            .post(`/invites/${invite.body.code}`)
            .set(joiner.auth);

        expect(join.status).toBe(200);
        expect(join.body.serverId).toBe(serverId);
        expect(join.body.userId).toBe(joiner.userId);
    });

    test('create channel and list it', async () => {
        const user = await authedUser(ctx.request, 'channelmaker');
        const { serverId } = await createServer(ctx.request, user.auth, 'Channel Server');

        const create = await ctx.request
            .post(`/servers/${serverId}/channels`)
            .set(user.auth)
            .send({ name: 'dev-chat', channelType: 3 });

        expect(create.status).toBe(201);

        const list = await ctx.request
            .get(`/servers/${serverId}/channels`)
            .set(user.auth);

        expect(list.body.some((c: any) => c.name === 'dev-chat')).toBe(true);
    });
});
