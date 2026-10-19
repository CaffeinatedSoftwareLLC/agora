import { createHash } from 'node:crypto';
import { setupTestApp, authedUser, createServer, cleanDatabase, joinViaInvite } from '../helpers';
import { buildApp } from '../../src/app';
import { Permissions } from '../../src/permissions';
import { generateUlid } from '../../src/utils/ulid';
import * as botTokens from '../../src/auth/bot-tokens';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: typeof owner;
let outsider: typeof owner;
let serverId: string;
let botId: string;
const createInvite = () => ctx.request.post(`/servers/${serverId}/agent-invites`).set(owner.auth).send({ botId });
const redeem = (code: string) => ctx.request.post('/agent-invites/redeem').send({ code });

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'invite-owner');
    member = await authedUser(ctx.request, 'invite-member');
    outsider = await authedUser(ctx.request, 'invite-outsider');
    ({ serverId } = await createServer(ctx.request, owner.auth, 'Invites'));
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'invite-bot' });
    expect(bot.status).toBe(201);
    botId = bot.body.id;
});
afterAll(async () => { await ctx.close(); });

test('creates a ten-minute invite, stores only its digest and audits creation', async () => {
    const res = await createInvite();
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.token).toBeUndefined();
    expect(res.body.code).toMatch(/^[a-f0-9]{64}$/);
    expect(new Date(res.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(590_000);
    const row = (await ctx.db.query('SELECT * FROM agent_invites WHERE id=$1', [res.body.id])).rows[0];
    expect(row.code_hash).toBe(createHash('sha256').update(res.body.code).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(res.body.code);
    const audit = await ctx.db.query("SELECT 1 FROM audit_log WHERE action='agent_invite_create' AND target_id=$1", [botId]);
    expect(audit.rowCount).toBeGreaterThan(0);
});

test('redeems once into a usable bot token; replay fails without another token', async () => {
    const invite = await createInvite();
    const res = await redeem(invite.body.code);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.token).toMatch(/^bot_/);
    expect((await ctx.request.get('/bots/@me').set('Authorization', `Bot ${res.body.token}`)).status).toBe(200);
    const count = await ctx.db.query('SELECT count(*) FROM bot_tokens WHERE bot_id=$1', [botId]);
    expect((await redeem(invite.body.code)).status).toBe(410);
    expect((await ctx.db.query('SELECT count(*) FROM bot_tokens WHERE bot_id=$1', [botId])).rows).toEqual(count.rows);
    expect((await ctx.db.query("SELECT 1 FROM audit_log WHERE action='agent_invite_redeem' AND actor_id=$1", [botId])).rowCount).toBeGreaterThan(0);
});

test('expired and unknown codes fail and are audited without exposing secrets', async () => {
    const invite = await createInvite();
    await ctx.db.query("UPDATE agent_invites SET expires_at=now()-interval '1 second' WHERE id=$1", [invite.body.id]);
    expect((await redeem(invite.body.code)).status).toBe(410);
    expect((await redeem('0'.repeat(64))).status).toBe(410);
    const audit = await ctx.db.query("SELECT * FROM audit_log WHERE action='agent_invite_redeem_failed'");
    expect(audit.rowCount).toBeGreaterThan(0);
    expect(JSON.stringify(audit.rows)).not.toContain(invite.body.code);
});

test('concurrent redemption issues exactly one token', async () => {
    const invite = await createInvite();
    const before = await ctx.db.query('SELECT count(*)::int AS n FROM bot_tokens WHERE bot_id=$1', [botId]);
    const results = await Promise.all(Array.from({ length: 5 }, () => redeem(invite.body.code)));
    expect(results.map(r => r.status).sort()).toEqual([200, 410, 410, 410, 410]);
    const after = await ctx.db.query('SELECT count(*)::int AS n FROM bot_tokens WHERE bot_id=$1', [botId]);
    expect(after.rows[0].n - before.rows[0].n).toBe(1);
});

test('token issuance failure rolls back consumption so the invite can still be used', async () => {
    const invite = await createInvite();
    const generator = vi.spyOn(botTokens, 'generateBotToken').mockRejectedValueOnce(new Error('Simulated token failure'));
    try {
        expect((await redeem(invite.body.code)).status).toBe(500);
        const row = await ctx.db.query('SELECT redeemed_at FROM agent_invites WHERE id=$1', [invite.body.id]);
        expect(row.rows[0].redeemed_at).toBeNull();
    } finally { generator.mockRestore(); }
    expect((await redeem(invite.body.code)).status).toBe(200);
});

test('a member who owns the bot can invite it without administrator permission; cross-server targets fail', async () => {
    const ownedBotId = generateUlid();
    await ctx.db.query('INSERT INTO users (id,username,bot,bot_owner_id,server_id) VALUES ($1,$2,true,$3,$4)', [ownedBotId, 'member-owned-bot', member.userId, serverId]);
    expect((await ctx.request.post(`/servers/${serverId}/agent-invites`).set(member.auth).send({ botId: ownedBotId })).status).toBe(201);
    const other = await createServer(ctx.request, owner.auth, 'Other invite server');
    expect((await ctx.request.post(`/servers/${other.serverId}/agent-invites`).set(owner.auth).send({ botId })).status).toBe(404);
});

test('non-owner members, outsiders and bots cannot create invites', async () => {
    for (const auth of [member.auth, outsider.auth]) {
        expect((await ctx.request.post(`/servers/${serverId}/agent-invites`).set(auth).send({ botId })).status).toBe(403);
        expect((await ctx.request.post(`/servers/${serverId}/agent-invites`).set(auth).send({ username: 'forbidden-bot' })).status).toBe(403);
    }
    const token = await redeem((await createInvite()).body.code);
    expect((await ctx.request.post(`/servers/${serverId}/agent-invites`).set('Authorization', `Bot ${token.body.token}`).send({ botId })).status).toBe(403);
});

test('creates a new bot and grants general access atomically', async () => {
    const res = await ctx.request.post(`/servers/${serverId}/agent-invites`).set(owner.auth).send({ username: 'fresh-invite-bot' });
    expect(res.status).toBe(201);
    const access = await ctx.db.query('SELECT c.name FROM bot_channel_access b JOIN channels c ON c.id=b.channel_id WHERE b.bot_id=$1', [res.body.botId]);
    expect(access.rows).toEqual([{ name: 'general' }]);
    expect((await redeem(res.body.code)).status).toBe(200);
    expect((await ctx.request.post(`/servers/${serverId}/agent-invites`).set(owner.auth).send({ username: 'fresh-invite-bot' })).status).toBe(409);
});

test('administrator members can invite existing and new bots', async () => {
    const id = generateUlid();
    await ctx.db.query('INSERT INTO roles (id, server_id, name, permissions) VALUES ($1,$2,$3,$4)', [id, serverId, 'Invite admin', Permissions.Administrator.toString()]);
    await ctx.db.query('INSERT INTO member_roles (server_id,user_id,role_id) VALUES ($1,$2,$3)', [serverId, member.userId, id]);
    expect((await ctx.request.post(`/servers/${serverId}/agent-invites`).set(member.auth).send({ botId })).status).toBe(201);
    expect((await ctx.request.post(`/servers/${serverId}/agent-invites`).set(member.auth).send({ username: 'admin-invite-bot' })).status).toBe(201);
});

test('rejects ambiguous creation and malformed redemption; creation requires auth', async () => {
    for (const body of [{}, { botId, username: 'both' }, { username: '   ' }]) {
        expect((await ctx.request.post(`/servers/${serverId}/agent-invites`).set(owner.auth).send(body)).status).toBe(400);
    }
    expect((await redeem('bad')).status).toBe(400);
    expect((await ctx.request.post(`/servers/${serverId}/agent-invites`).send({ botId })).status).toBe(401);
});

test('rate limits public redemption and authenticated creation', async () => {
    const { app, db } = await buildApp({ logger: false, jwtSecret: 'test-secret-do-not-use-in-prod', dbUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://accord:accord@localhost:5432/accord_test' });
    try {
        await app.ready();
        for (let i = 0; i < 10; i++) {
            expect((await app.inject({ method: 'POST', url: '/agent-invites/redeem', payload: { code: '0'.repeat(64) } })).statusCode).toBe(410);
            expect((await app.inject({ method: 'POST', url: `/servers/${serverId}/agent-invites`, headers: owner.auth, payload: { botId } })).statusCode).toBe(201);
        }
        expect((await app.inject({ method: 'POST', url: '/agent-invites/redeem', payload: { code: '0'.repeat(64) } })).statusCode).toBe(429);
        expect((await app.inject({ method: 'POST', url: `/servers/${serverId}/agent-invites`, headers: owner.auth, payload: { botId } })).statusCode).toBe(429);
    } finally { await app.close(); await db.end(); }
});
