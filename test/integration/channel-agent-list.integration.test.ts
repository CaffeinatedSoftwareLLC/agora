import { afterAll, beforeAll, expect, test } from 'vitest';
import { setupTestApp, authedUser, createServer, cleanDatabase, joinViaInvite } from '../helpers';
import { Permissions } from '../../src/permissions';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>, member: typeof owner, outsider: typeof owner;
let channelId: string, serverId: string, roleId: string, assigned: string, botAuth: { Authorization: string };
beforeAll(async () => {
    ctx = await setupTestApp(); await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'agentsowner'); member = await authedUser(ctx.request, 'agentsmember'); outsider = await authedUser(ctx.request, 'agentsoutsider');
    const server = await createServer(ctx.request, owner.auth, 'Agent listing');
    channelId = server.generalChannelId; serverId = server.serverId; roleId = server.everyoneRoleId;
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    for (const username of ['assigned-agent', 'available-agent', 'search-needle']) {
        const created = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username });
        expect(created.status).toBe(201);
        if (username === 'assigned-agent') assigned = created.body.id;
    }
    expect((await ctx.request.post(`/channels/${channelId}/bots/${assigned}`).set(owner.auth)).status).toBe(201);
    const token = await ctx.request.post(`/servers/${serverId}/bots/${assigned}/tokens`).set(owner.auth).send({ name: 'list-tests' });
    expect(token.status).toBe(201); botAuth = { Authorization: `Bot ${token.body.token}` };
    const other = await createServer(ctx.request, outsider.auth, 'Other agents');
    expect((await ctx.request.post(`/servers/${other.serverId}/bots`).set(outsider.auth).send({ username: 'other-server-agent' })).status).toBe(201);
});
afterAll(async () => { await ctx.close(); });

const url = () => `/channels/${channelId}/bots`;
test('closed-control membership is one channel-scoped list with only assigned agents', async () => {
    const response = await ctx.request.get(url()).set(owner.auth);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({ bots: [{ id: assigned, username: 'assigned-agent', inChannel: true }], hasMore: false, nextCursor: null });
});

test('addable agents are server-scoped, searchable and cursor paginated without detail requests', async () => {
    const first = await ctx.request.get(`${url()}?all=true&limit=2`).set(owner.auth);
    expect(first.status).toBe(200); expect(first.body.bots).toHaveLength(2);
    expect(first.body.hasMore).toBe(true); expect(first.body.nextCursor).toBe(first.body.bots[1].id);
    const second = await ctx.request.get(`${url()}?all=true&limit=2&after=${first.body.nextCursor}`).set(owner.auth);
    expect(second.status).toBe(200); expect(second.body.bots).toHaveLength(1); expect(second.body.hasMore).toBe(false);
    const bots = [...first.body.bots, ...second.body.bots];
    expect(new Set(bots.map(bot => bot.id)).size).toBe(3);
    expect(bots.some(bot => bot.username === 'other-server-agent')).toBe(false);
    expect(bots.find(bot => bot.id === assigned).inChannel).toBe(true);
    expect(bots.filter(bot => bot.id !== assigned).every(bot => !bot.inChannel)).toBe(true);
    const search = await ctx.request.get(`${url()}?all=true&q=needle&limit=1`).set(owner.auth);
    expect(search.status).toBe(200); expect(search.body.bots.map((bot: { username: string }) => bot.username)).toEqual(['search-needle']);
});

test('anonymous users, ordinary members, bots and cross-server owners cannot list management data', async () => {
    expect((await ctx.request.get(url())).status).toBe(401);
    expect((await ctx.request.get(url()).set(member.auth)).status).toBe(403);
    expect((await ctx.request.get(`${url()}?all=true`).set(botAuth)).status).toBe(403);
    expect([403, 404]).toContain((await ctx.request.get(`${url()}?all=true`).set(outsider.auth)).status);
});

test('an explicit manager may read but ViewChannel denial is enforced', async () => {
    const previous = (await ctx.db.query('SELECT permissions FROM roles WHERE id = $1', [roleId])).rows[0].permissions;
    await ctx.db.query('UPDATE roles SET permissions = permissions | $2::bigint WHERE id = $1', [roleId, Permissions.ManageBots.toString()]);
    try {
        expect((await ctx.request.get(url()).set(member.auth)).status).toBe(200);
        await ctx.db.query('INSERT INTO channel_role_overrides (channel_id, role_id, allow, deny) VALUES ($1, $2, 0, $3)', [channelId, roleId, Permissions.ViewChannel.toString()]);
        expect((await ctx.request.get(url()).set(member.auth)).status).toBe(403);
    } finally {
        await ctx.db.query('UPDATE roles SET permissions = $2 WHERE id = $1', [roleId, previous]);
        await ctx.db.query('UPDATE channel_role_overrides SET deny = 0 WHERE channel_id = $1 AND role_id = $2', [channelId, roleId]);
    }
});

test.each(['limit=0', 'limit=101', 'after=not-an-id', `q=${'a'.repeat(101)}`, 'all=maybe'])('validates bounded listing query: %s', async query => {
    expect((await ctx.request.get(`${url()}?${query}`).set(owner.auth)).status).toBe(400);
});
