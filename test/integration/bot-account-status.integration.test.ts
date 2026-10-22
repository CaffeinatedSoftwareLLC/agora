import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';

// Bot tokens follow the same account rules as the gateway (socketAccountError):
// the bot and its owner must both be active.

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let admin: Awaited<ReturnType<typeof authedUser>>;
let server: Awaited<ReturnType<typeof createServer>>;

async function bot(name: string, ownerAuth = owner.auth, srv = server) {
    const created = await ctx.request.post(`/servers/${srv.serverId}/bots`).set(ownerAuth).send({ username: name });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const token = await ctx.request.post(`/servers/${srv.serverId}/bots/${id}/tokens`).set(ownerAuth).send({});
    expect(token.status).toBe(201);
    expect((await ctx.request.post(`/channels/${srv.generalChannelId}/bots/${id}`).set(ownerAuth)).status).toBe(201);
    return { id, token: token.body.token as string, channelId: srv.generalChannelId };
}

const read = (b: { token: string; channelId: string }) =>
    ctx.request.get(`/channels/${b.channelId}/messages`).set({ Authorization: `Bot ${b.token}` });

async function liveTokens(botId: string): Promise<number> {
    const res = await ctx.db.query('SELECT COUNT(*)::int AS n FROM bot_tokens WHERE bot_id = $1 AND revoked_at IS NULL', [botId]);
    return res.rows[0].n;
}

beforeAll(async () => { ctx = await setupTestApp(); });
beforeEach(async () => {
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'statusowner');
    admin = await authedUser(ctx.request, 'statusadmin');
    await ctx.db.query('UPDATE users SET is_instance_admin = true WHERE id = $1', [admin.userId]);
    server = await createServer(ctx.request, owner.auth, 'Bot Status');
});
afterAll(async () => { await ctx.close(); });

test('an active bot with an active owner can use its token', async () => {
    const b = await bot('activebot');
    expect((await read(b)).status).toBe(200);
});

test.each(['suspended', 'pending'])('a %s bot is refused', async status => {
    const b = await bot(`${status}bot`);
    await ctx.db.query('UPDATE users SET account_status = $2 WHERE id = $1', [b.id, status]);
    const res = await read(b);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(`account_${status}`);
});

test.each(['suspended', 'pending'])('a bot whose owner is %s is refused', async status => {
    const b = await bot(`owner${status}bot`);
    await ctx.db.query('UPDATE users SET account_status = $2 WHERE id = $1', [owner.userId, status]);
    const res = await read(b);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('bot_owner_inactive');
});

test('a bot without an owner is refused', async () => {
    const b = await bot('orphanbot');
    await ctx.db.query('UPDATE users SET bot_owner_id = NULL WHERE id = $1', [b.id]);
    const res = await read(b);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('bot_owner_inactive');
});

test('banning an owner revokes the tokens of every bot it owns, and only those', async () => {
    const first = await bot('ownedone');
    const second = await bot('ownedtwo');
    const extra = await ctx.request.post(`/servers/${server.serverId}/bots/${first.id}/tokens`).set(owner.auth).send({});
    expect(extra.status).toBe(201);

    const other = await authedUser(ctx.request, 'otherowner');
    const otherServer = await createServer(ctx.request, other.auth, 'Other');
    const unrelated = await bot('unrelatedbot', other.auth, otherServer);

    expect(await liveTokens(first.id)).toBe(2);
    expect((await ctx.request.post(`/admin/users/${owner.userId}/ban`).set(admin.auth)).status).toBe(200);

    const rows = await ctx.db.query(
        'SELECT bot_id, revoked_at FROM bot_tokens WHERE bot_id = ANY($1)', [[first.id, second.id]]);
    expect(rows.rows).toHaveLength(3);
    for (const row of rows.rows) expect(row.revoked_at).not.toBeNull();

    expect((await read(first)).status).toBe(401);
    expect((await read(second)).status).toBe(401);
    expect(await liveTokens(unrelated.id)).toBe(1);
    expect((await read(unrelated)).status).toBe(200);
});

test('banning a bot revokes its own tokens', async () => {
    const b = await bot('bannedbot');
    expect((await ctx.request.post(`/admin/users/${b.id}/ban`).set(admin.auth)).status).toBe(200);
    expect(await liveTokens(b.id)).toBe(0);
    expect((await read(b)).status).toBe(401);
});

test('restoring a banned owner does not bring the revoked tokens back', async () => {
    const b = await bot('restoredbot');
    expect((await ctx.request.post(`/admin/users/${owner.userId}/ban`).set(admin.auth)).status).toBe(200);
    await ctx.db.query(`UPDATE users SET account_status = 'active' WHERE id = $1`, [owner.userId]);
    expect((await read(b)).status).toBe(401);

    // The owner issues a new token, which works
    const fresh = await ctx.request.post(`/servers/${server.serverId}/bots/${b.id}/tokens`).set(owner.auth).send({});
    expect(fresh.status).toBe(201);
    expect((await read({ token: fresh.body.token, channelId: b.channelId })).status).toBe(200);
});
