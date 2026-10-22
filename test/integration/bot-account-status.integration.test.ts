import { randomBytes } from 'node:crypto';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { hashToken } from '../../src/runtime/runner';
import { resolveLimits } from '../../src/runtime/limits';

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

test('a wrong secret is 401 whatever the bot\'s account status, so the status is not revealed', async () => {
    const b = await bot('wrongsecretbot');
    const [tokenId] = b.token.slice('bot_'.length).split('.');
    const wrong = { token: `bot_${tokenId}.${'A'.repeat(43)}`, channelId: b.channelId };
    expect((await read(wrong)).status).toBe(401);
    for (const target of [b.id, owner.userId]) {
        await ctx.db.query(`UPDATE users SET account_status = 'suspended' WHERE id = $1`, [target]);
        const res = await read(wrong);
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid bot token');
        await ctx.db.query(`UPDATE users SET account_status = 'active' WHERE id = $1`, [target]);
    }
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

async function run(botId: string, status: string) {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO exec_runs (id, server_id, channel_id, submitted_by, code, code_sha256, limits, gate_decision, status)
         VALUES ($1, $2, $3, $4, 'x', $5, $6, 'auto_run', $7)`,
        [id, server.serverId, server.generalChannelId, botId, 'a'.repeat(64), JSON.stringify(resolveLimits('standard')), status]);
    const token = `art_${randomBytes(32).toString('base64url')}`;
    await ctx.db.query(
        `INSERT INTO exec_run_tokens (token_hash, run_id, server_id, capabilities, expires_at)
         VALUES ($1, $2, $3, '{chat}', NOW() + INTERVAL '5 minutes')`,
        [hashToken(token), id, server.serverId]);
    return id;
}

const runRow = async (id: string) =>
    (await ctx.db.query('SELECT status, error FROM exec_runs WHERE id = $1', [id])).rows[0];
const liveRunTokens = async (id: string) =>
    (await ctx.db.query('SELECT COUNT(*)::int AS n FROM exec_run_tokens WHERE run_id = $1 AND revoked_at IS NULL', [id])).rows[0].n;

test('banning an owner revokes its bots\' run tokens and denies their runs that have not started', async () => {
    const b = await bot('runningbot');
    const queued = await run(b.id, 'queued');
    const awaiting = await run(b.id, 'awaiting_approval');
    const running = await run(b.id, 'running');
    const done = await run(b.id, 'succeeded');

    const other = await authedUser(ctx.request, 'runotherowner');
    const otherServer = await createServer(ctx.request, other.auth, 'Other runs');
    const unrelated = await bot('unrelatedrunbot', other.auth, otherServer);
    const unrelatedRun = await run(unrelated.id, 'queued');

    expect((await ctx.request.post(`/admin/users/${owner.userId}/ban`).set(admin.auth)).status).toBe(200);

    for (const id of [queued, awaiting]) {
        expect(await runRow(id)).toEqual({ status: 'denied', error: 'The submitting bot or its owner was suspended' });
    }
    // A started or finished run keeps its status; the run token is what stops a running one
    expect((await runRow(running)).status).toBe('running');
    expect((await runRow(done)).status).toBe('succeeded');
    for (const id of [queued, awaiting, running, done]) expect(await liveRunTokens(id)).toBe(0);

    expect((await runRow(unrelatedRun)).status).toBe('queued');
    expect(await liveRunTokens(unrelatedRun)).toBe(1);
});

describe('agent invites', () => {
    const invite = async (botId: string) => {
        const res = await ctx.request.post(`/servers/${server.serverId}/agent-invites`).set(owner.auth).send({ botId });
        expect(res.status).toBe(201);
        return res.body as { id: string; code: string };
    };
    const redeem = (code: string) => ctx.request.post('/agent-invites/redeem').send({ code });
    const tokens = async (botId: string) =>
        (await ctx.db.query('SELECT COUNT(*)::int AS n FROM bot_tokens WHERE bot_id = $1', [botId])).rows[0].n;

    test.each(['bot', 'owner'])('an invite is not redeemed while the %s is suspended, and is not used up', async who => {
        const b = await bot(`invite${who}bot`);
        const inv = await invite(b.id);
        const before = await tokens(b.id);
        const target = who === 'bot' ? b.id : owner.userId;
        await ctx.db.query(`UPDATE users SET account_status = 'suspended' WHERE id = $1`, [target]);
        const res = await redeem(inv.code);
        expect(res.status).toBe(410);
        expect(res.body).toEqual({ error: 'invite_invalid_or_expired' });
        expect(await tokens(b.id)).toBe(before);
        expect((await ctx.db.query('SELECT redeemed_at FROM agent_invites WHERE id = $1', [inv.id])).rows[0].redeemed_at).toBeNull();

        await ctx.db.query(`UPDATE users SET account_status = 'active' WHERE id = $1`, [target]);
        expect((await redeem(inv.code)).status).toBe(200);
    });

    test('an invite of a bot without an owner is not redeemed', async () => {
        const b = await bot('inviteorphanbot');
        const inv = await invite(b.id);
        await ctx.db.query('UPDATE users SET bot_owner_id = NULL WHERE id = $1', [b.id]);
        expect((await redeem(inv.code)).status).toBe(410);
    });

    test('banning the owner expires the unredeemed invites of its bots; restoring it does not revive them', async () => {
        const b = await bot('invitebannedbot');
        const inv = await invite(b.id);
        expect((await ctx.request.post(`/admin/users/${owner.userId}/ban`).set(admin.auth)).status).toBe(200);
        const row = (await ctx.db.query('SELECT expires_at <= NOW() AS expired FROM agent_invites WHERE id = $1', [inv.id])).rows[0];
        expect(row.expired).toBe(true);

        await ctx.db.query(`UPDATE users SET account_status = 'active' WHERE id = $1`, [owner.userId]);
        expect((await redeem(inv.code)).status).toBe(410);
        expect(await tokens(b.id)).toBe(1);
    });

    test('only an instance admin can expire invites, and only for an account that is not active', async () => {
        const b = await bot('inviteguardbot');
        const inv = await invite(b.id);
        const call = async (actorId: string) => {
            const client = await ctx.db.connect();
            try {
                await client.query('BEGIN');
                await client.query('SET LOCAL ROLE app_user');
                await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [actorId]);
                await client.query('SELECT expire_agent_invites_for_suspended($1)', [owner.userId]);
                return null;
            } catch (err) {
                return (err as { code?: string }).code;
            } finally {
                await client.query('ROLLBACK');
                client.release();
            }
        };
        // Not an admin, even while the owner is suspended
        await ctx.db.query(`UPDATE users SET account_status = 'suspended' WHERE id = $1`, [owner.userId]);
        expect(await call(owner.userId)).toBe('42501');
        await ctx.db.query(`UPDATE users SET account_status = 'active' WHERE id = $1`, [owner.userId]);
        // An admin, but the owner is active
        expect(await call(admin.userId)).toBe('42501');
        expect((await ctx.db.query('SELECT expires_at > NOW() AS live FROM agent_invites WHERE id = $1', [inv.id])).rows[0].live).toBe(true);
    });
});
