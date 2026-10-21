import type { PoolClient } from 'pg';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'joinowner');
    serverId = (await createServer(ctx.request, owner.auth, 'Checked joins')).serverId;
});
afterAll(async () => { await ctx.close(); });

async function invite(opts: { maxUses?: number; expired?: boolean } = {}) {
    const code = generateUlid().slice(-12);
    await ctx.db.query(`INSERT INTO server_invites (code, server_id, creator_id, max_uses, expires_at)
        VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN now() - interval '1 second' ELSE NULL END)`,
    [code, serverId, owner.userId, opts.maxUses ?? null, opts.expired ?? false]);
    return code;
}
async function asActor<T>(userId: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await ctx.db.connect();
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE app_user');
        await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId ?? '']);
        return await fn(client);
    } finally {
        await client.query('ROLLBACK');
        client.release();
    }
}
async function state(code: string, userId: string) {
    return (await ctx.db.query(`SELECT use_count, EXISTS (
        SELECT 1 FROM server_members WHERE server_id = $2 AND user_id = $3
    ) AS member FROM server_invites WHERE code = $1`, [code, serverId, userId])).rows[0];
}

it.each([{ expired: true }, { maxUses: 0 }])('refuses an unusable exact code without membership or a use: %j', async opts => {
    const user = await authedUser(ctx.request, opts.expired ? 'joinexpired' : 'joinmaxed');
    const code = await invite(opts);
    const res = await ctx.request.post(`/invites/${code}`).set(user.auth);
    expect(res.status).toBe(404);
    expect(await state(code, user.userId)).toEqual({ use_count: 0, member: false });
});

it('allows exactly one of two concurrent users to consume the last use', async () => {
    const users = await Promise.all(['joinracea', 'joinraceb'].map(name => authedUser(ctx.request, name)));
    const code = await invite({ maxUses: 1 });
    const results = await Promise.all(users.map(user => ctx.request.post(`/invites/${code}`).set(user.auth)));
    expect(results.map(r => r.status).sort()).toEqual([200, 404]);
    expect((await ctx.db.query('SELECT use_count FROM server_invites WHERE code = $1', [code])).rows[0].use_count).toBe(1);
    const members = await Promise.all(users.map(user => state(code, user.userId)));
    expect(members.filter(row => row.member)).toHaveLength(1);
});

it('repeating a successful last-use join does not increment use_count', async () => {
    const user = await authedUser(ctx.request, 'joinrepeat');
    const code = await invite({ maxUses: 1 });
    expect((await ctx.request.post(`/invites/${code}`).set(user.auth)).status).toBe(200);
    expect((await ctx.request.post(`/invites/${code}`).set(user.auth)).status).toBe(200);
    expect(await state(code, user.userId)).toEqual({ use_count: 1, member: true });
});

it('a member cannot directly reset counters or rewrite invite limits, and a non-member cannot update them', async () => {
    const user = await authedUser(ctx.request, 'joinwriter');
    const code = await invite();
    for (const actor of [user.userId, owner.userId]) {
        await asActor(actor, async client => {
            const r = await client.query('UPDATE server_invites SET use_count = 0, max_uses = NULL, expires_at = NULL WHERE code = $1 RETURNING code', [code]);
            expect(r.rowCount).toBe(0);
        });
    }
});

it('the function rejects missing identity, inactive humans and bots even with a valid code', async () => {
    const inactive = await authedUser(ctx.request, 'joininactive');
    await ctx.db.query("UPDATE users SET account_status = 'suspended' WHERE id = $1", [inactive.userId]);
    const made = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'joinbot' });
    expect(made.status).toBe(201);
    const code = await invite();
    for (const actor of [null, inactive.userId, made.body.id]) {
        await asActor(actor, async client => {
            expect((await client.query('SELECT * FROM public.join_server_by_invite($1)', [code])).rows).toEqual([]);
        });
    }
    expect((await ctx.db.query('SELECT use_count FROM server_invites WHERE code = $1', [code])).rows[0].use_count).toBe(0);
});

it('helper functions exclude temporary schemas and do not grant PUBLIC execution', async () => {
    const functions = ['is_server_member', 'is_bot_channel_member', 'rls_is_channel_member', 'rls_can_create_agent_invite', 'join_server_by_invite'];
    const rows = (await ctx.db.query(`SELECT p.proname, p.proconfig,
        EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1)`, [functions])).rows;
    expect(rows).toHaveLength(functions.length);
    for (const row of rows) {
        expect(row.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
        expect(row.public_execute).toBe(false);
    }
});

it('temporary membership tables cannot fool a SECURITY DEFINER membership helper', async () => {
    const user = await authedUser(ctx.request, 'jointempshadow');
    await asActor(user.userId, async client => {
        await client.query('CREATE TEMP TABLE server_members (server_id CHAR(26), user_id CHAR(26))');
        await client.query('INSERT INTO pg_temp.server_members VALUES ($1, $2)', [serverId, user.userId]);
        expect((await client.query('SELECT public.is_server_member($1, $2) AS member', [serverId, user.userId])).rows[0].member).toBe(false);
    });
});
