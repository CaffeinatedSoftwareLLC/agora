import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';

/**
 * Settings → Bots says who each token counts as (docs/provider-terms.md, "Which tokens count
 * as you"): GET /servers/:id/bots/:id/tokens returns purpose, createdBy, createdByName and
 * countsAsYou for the caller. A legacy personal token (made before migration 090, no maker)
 * can be claimed by the bot's owner alone: POST .../tokens/:tokenId/claim.
 */

const ADMINISTRATOR = (1n << 0n).toString();

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let admin: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let outsider: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;

type Row = { id: string; purpose: string; createdBy: string | null; createdByName: string | null; countsAsYou: boolean; revokedAt: string | null };

async function makeBot(by: { auth: Record<string, string> }, username: string): Promise<{ id: string; token: string; tokenId: string }> {
    const created = await ctx.request.post(`/servers/${serverId}/bots`).set(by.auth).send({ username });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const token = await ctx.request.post(`/servers/${serverId}/bots/${created.body.id}/tokens`).set(by.auth).send({ name: 'first' });
    expect(token.status).toBe(201);
    return { id: created.body.id, token: token.body.token, tokenId: token.body.tokenId };
}

async function mint(botId: string, by: { auth: Record<string, string> }, name = 'terminal'): Promise<string> {
    const res = await ctx.request.post(`/servers/${serverId}/bots/${botId}/tokens`).set(by.auth).send({ name });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.tokenId;
}

/** A token as an older Agora (or an agent host, box or model agent) left it: no maker on record. */
async function legacy(botId: string, purpose: 'personal' | 'invite' | 'host' | 'box' | 'model', revoked = false): Promise<string> {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO bot_tokens (id, bot_id, secret_hash, name, purpose, created_by, revoked_at) VALUES ($1, $2, 'x', $3, $4, NULL, $5)`,
        [id, botId, `legacy ${purpose}`, purpose, revoked ? new Date() : null]
    );
    return id;
}

async function list(botId: string, by: { auth: Record<string, string> }): Promise<Map<string, Row>> {
    const res = await ctx.request.get(`/servers/${serverId}/bots/${botId}/tokens`).set(by.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return new Map(res.body.map((r: Row) => [r.id, r]));
}

const claim = (botId: string, tokenId: string, by: { auth: Record<string, string> }) =>
    ctx.request.post(`/servers/${serverId}/bots/${botId}/tokens/${tokenId}/claim`).set(by.auth);

const madeBy = async (tokenId: string) =>
    (await ctx.db.query('SELECT created_by FROM bot_tokens WHERE id = $1', [tokenId])).rows[0].created_by?.trim() ?? null;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'claimowner');
    admin = await authedUser(ctx.request, 'claimadmin');
    member = await authedUser(ctx.request, 'claimmember');
    outsider = await authedUser(ctx.request, 'claimoutsider');
    const server = await createServer(ctx.request, owner.auth, 'Token Claims');
    serverId = server.serverId;
    await joinViaInvite(ctx.request, owner.auth, admin.auth, serverId);
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    const role = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Admins', permissions: ADMINISTRATOR });
    expect(role.status).toBe(201);
    await ctx.request.put(`/servers/${serverId}/members/${admin.userId}/roles/${role.body.id}`).set(owner.auth);
});

afterAll(async () => { await ctx.close(); });

describe('token list: who each token counts as', () => {
    it('countsAsYou only for a live personal or invite token the caller made, on the caller\'s own bot', async () => {
        const bot = await makeBot(owner, 'listbot');
        const adminMinted = await mint(bot.id, admin, 'admin made');
        const revoked = await mint(bot.id, owner, 'old');
        expect((await ctx.request.delete(`/servers/${serverId}/bots/${bot.id}/tokens/${revoked}`).set(owner.auth)).status).toBe(200);
        const host = await legacy(bot.id, 'host');
        const old = await legacy(bot.id, 'personal');

        const asOwner = await list(bot.id, owner);
        expect(asOwner.get(bot.tokenId)).toMatchObject({ purpose: 'personal', createdBy: owner.userId, createdByName: 'claimowner', countsAsYou: true });
        expect(asOwner.get(adminMinted)).toMatchObject({ purpose: 'personal', createdBy: admin.userId, createdByName: 'claimadmin', countsAsYou: false });
        expect(asOwner.get(revoked)).toMatchObject({ createdBy: owner.userId, countsAsYou: false });
        expect(asOwner.get(host)).toMatchObject({ purpose: 'host', createdBy: null, createdByName: null, countsAsYou: false });
        expect(asOwner.get(old)).toMatchObject({ purpose: 'personal', createdBy: null, createdByName: null, countsAsYou: false });

        // The same list for an Administrator: nothing counts as them on someone else's bot,
        // not even the token they made
        const asAdmin = await list(bot.id, admin);
        expect(asAdmin.get(bot.tokenId)).toMatchObject({ createdBy: owner.userId, countsAsYou: false });
        expect(asAdmin.get(adminMinted)).toMatchObject({ createdBy: admin.userId, countsAsYou: false });
        expect([...asAdmin.values()].some(t => t.countsAsYou)).toBe(false);
    });

    it('an invite token counts as whoever created the invite, on their own bot', async () => {
        const bot = await makeBot(owner, 'invitebot');
        const invite = await ctx.request.post(`/servers/${serverId}/agent-invites`).set(owner.auth).send({ botId: bot.id });
        expect(invite.status, JSON.stringify(invite.body)).toBe(201);
        const redeemed = await ctx.request.post('/agent-invites/redeem').send({ code: invite.body.code });
        expect(redeemed.status).toBe(200);
        const tokenId = redeemed.body.token.slice('bot_'.length).split('.')[0];
        expect((await list(bot.id, owner)).get(tokenId)).toMatchObject({ purpose: 'invite', createdBy: owner.userId, countsAsYou: true });
    });

    it('authorization is unchanged: a plain member is refused', async () => {
        const bot = await makeBot(owner, 'listauthbot');
        expect((await ctx.request.get(`/servers/${serverId}/bots/${bot.id}/tokens`).set(member.auth)).status).toBe(403);
    });
});

describe('claiming a legacy token', () => {
    it("the bot's owner claims a live legacy personal token: it counts as them, with an audit entry", async () => {
        const bot = await makeBot(owner, 'claimbot');
        const old = await legacy(bot.id, 'personal');
        const res = await claim(bot.id, old, owner);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toEqual({ claimed: true, tokenId: old });
        expect(await madeBy(old)).toBe(owner.userId);
        expect((await list(bot.id, owner)).get(old)).toMatchObject({ createdBy: owner.userId, createdByName: 'claimowner', countsAsYou: true });
        const audit = await ctx.db.query(`SELECT actor_id, server_id, target_id, changes FROM audit_log WHERE action = 'bot_token_claimed'`);
        expect(audit.rows.map((r: any) => ({ actor: r.actor_id.trim(), server: r.server_id.trim(), bot: r.target_id.trim(), tokenId: r.changes.tokenId })))
            .toEqual([{ actor: owner.userId, server: serverId, bot: bot.id, tokenId: old }]);

        // Once claimed it has a maker: a second claim is refused
        const again = await claim(bot.id, old, owner);
        expect(again.status).toBe(409);
        expect(again.body.error).toBe('already_claimed');
    });

    it('a token someone already made is not claimable, even by the bot owner', async () => {
        const bot = await makeBot(owner, 'madebot');
        const adminMinted = await mint(bot.id, admin);
        const res = await claim(bot.id, adminMinted, owner);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('already_claimed');
        expect(await madeBy(adminMinted)).toBe(admin.userId);
    });

    it('refuses an Administrator on someone else\'s bot, the server owner on an Administrator\'s bot, and a plain member', async () => {
        const ownersBot = await makeBot(owner, 'ownersbot');
        const old = await legacy(ownersBot.id, 'personal');
        for (const who of [admin, member]) {
            const res = await claim(ownersBot.id, old, who);
            expect(res.status, JSON.stringify(res.body)).toBe(403);
        }
        expect((await claim(ownersBot.id, old, admin)).body.error).toBe('not_bot_owner');
        const adminsBot = await makeBot(admin, 'adminsbot');
        const adminsOld = await legacy(adminsBot.id, 'personal');
        const res = await claim(adminsBot.id, adminsOld, owner);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('not_bot_owner');
        expect(await madeBy(old)).toBeNull();
        expect(await madeBy(adminsOld)).toBeNull();
        // The Administrator can claim on their own bot
        expect((await claim(adminsBot.id, adminsOld, admin)).status).toBe(200);
    });

    it('refuses a revoked token, and host, box, model and invite tokens', async () => {
        const bot = await makeBot(owner, 'kindsbot');
        const revoked = await legacy(bot.id, 'personal', true);
        const res = await claim(bot.id, revoked, owner);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('token_revoked');
        for (const purpose of ['host', 'box', 'model', 'invite'] as const) {
            const id = await legacy(bot.id, purpose);
            const refused = await claim(bot.id, id, owner);
            expect(refused.status, purpose).toBe(409);
            expect(refused.body.error, purpose).toBe('not_claimable');
            expect(await madeBy(id)).toBeNull();
        }
        expect(await madeBy(revoked)).toBeNull();
    });

    it('refuses a non-member, a bot, another bot\'s token, and a malformed ID', async () => {
        const bot = await makeBot(owner, 'edgebot');
        const other = await makeBot(owner, 'otheredgebot');
        const old = await legacy(bot.id, 'personal');
        expect((await claim(bot.id, old, outsider)).status).toBe(403);
        expect((await claim(bot.id, old, { auth: { Authorization: `Bot ${bot.token}` } })).status).toBe(403);
        const wrongBot = await claim(other.id, old, owner);
        expect(wrongBot.status).toBe(404);
        expect(wrongBot.body.error).toBe('token_not_found');
        expect((await claim(bot.id, 'not-a-ulid', owner)).status).toBe(400);
        expect(await madeBy(old)).toBeNull();
    });
});
