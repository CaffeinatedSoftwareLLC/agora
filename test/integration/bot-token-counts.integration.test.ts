import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';

/**
 * Settings → Agents → the agent says who each token counts as (docs/provider-terms.md, "Owner bots"):
 * GET /servers/:id/bots/:id/tokens returns purpose, createdBy, createdByName and countsAsYou for
 * the caller. countsAsYou: a live personal or invite token on a bot the caller owns, that no
 * other person made (the caller made it, or no recorded maker). An agent host's or box's token
 * counts only in runs only the owner can have caused (decided per post), a model agent's never.
 * There is nothing to claim any more, so the claim route is gone.
 */

const ADMINISTRATOR = (1n << 0n).toString();

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let admin: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
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

/** A token with no maker on record: made by Agora (a box's), or before Agora recorded makers. */
async function makerless(botId: string, purpose: 'personal' | 'invite' | 'host' | 'box' | 'model', revoked = false): Promise<string> {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO bot_tokens (id, bot_id, secret_hash, name, purpose, created_by, revoked_at, created_at)
         VALUES ($1, $2, 'x', $3, $4, NULL, $5, '2020-01-01T00:00:00Z')`,
        [id, botId, `makerless ${purpose}`, purpose, revoked ? new Date() : null]
    );
    return id;
}

async function list(botId: string, by: { auth: Record<string, string> }): Promise<Map<string, Row>> {
    const res = await ctx.request.get(`/servers/${serverId}/bots/${botId}/tokens`).set(by.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return new Map(res.body.map((r: Row) => [r.id, r]));
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'countowner');
    admin = await authedUser(ctx.request, 'countadmin');
    member = await authedUser(ctx.request, 'countmember');
    const server = await createServer(ctx.request, owner.auth, 'Token Counts');
    serverId = server.serverId;
    await joinViaInvite(ctx.request, owner.auth, admin.auth, serverId);
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    const role = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Admins', permissions: ADMINISTRATOR });
    expect(role.status).toBe(201);
    await ctx.request.put(`/servers/${serverId}/members/${admin.userId}/roles/${role.body.id}`).set(owner.auth);
});

afterAll(async () => { await ctx.close(); });

describe('token list: who each token counts as', () => {
    it('countsAsYou for a live personal token on your own bot that no other person made; never one someone else made', async () => {
        const bot = await makeBot(owner, 'listbot');
        const adminMinted = await mint(bot.id, admin, 'admin made');
        const revoked = await mint(bot.id, owner, 'old');
        expect((await ctx.request.delete(`/servers/${serverId}/bots/${bot.id}/tokens/${revoked}`).set(owner.auth)).status).toBe(200);
        const host = await makerless(bot.id, 'host');
        const box = await makerless(bot.id, 'box');
        const model = await makerless(bot.id, 'model');
        const old = await makerless(bot.id, 'personal');
        const oldRevoked = await makerless(bot.id, 'personal', true);

        const asOwner = await list(bot.id, owner);
        expect(asOwner.get(bot.tokenId)).toMatchObject({ purpose: 'personal', createdBy: owner.userId, createdByName: 'countowner', countsAsYou: true });
        expect(asOwner.get(adminMinted)).toMatchObject({ purpose: 'personal', createdBy: admin.userId, createdByName: 'countadmin', countsAsYou: false });
        expect(asOwner.get(revoked)).toMatchObject({ createdBy: owner.userId, countsAsYou: false });
        // Predates recorded makers: yours. Agent host, box and model agent tokens are not a blanket "you"
        expect(asOwner.get(old)).toMatchObject({ purpose: 'personal', createdBy: null, countsAsYou: true });
        expect(asOwner.get(host)).toMatchObject({ purpose: 'host', createdBy: null, createdByName: null, countsAsYou: false });
        expect(asOwner.get(box)).toMatchObject({ purpose: 'box', countsAsYou: false });
        expect(asOwner.get(model)).toMatchObject({ purpose: 'model', countsAsYou: false });
        expect(asOwner.get(oldRevoked)).toMatchObject({ countsAsYou: false });
        expect(asOwner.get(old)).not.toHaveProperty('madeBeforeMakers');

        // The same list for an Administrator: nothing counts as them on someone else's bot,
        // not even the token they made
        const asAdmin = await list(bot.id, admin);
        expect(asAdmin.get(bot.tokenId)).toMatchObject({ createdBy: owner.userId, countsAsYou: false });
        expect(asAdmin.get(adminMinted)).toMatchObject({ createdBy: admin.userId, countsAsYou: false });
        expect([...asAdmin.values()].some(t => t.countsAsYou)).toBe(false);
    });

    it("the agent host token made with an agent is the owner's, but not a blanket \"counts as you\"", async () => {
        const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
        expect(host.status).toBe(201);
        const agent = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
            .send({ hostModeAck: true, name: 'hostagent', adapter: 'claude', hostId: host.body.host.id, workdirAlias: 'agora' });
        expect(agent.status, JSON.stringify(agent.body)).toBe(201);
        const tokenId = String(agent.body.token).slice('bot_'.length).split('.')[0];
        expect((await list(agent.body.bot.id, owner)).get(tokenId)).toMatchObject({ purpose: 'host', createdBy: owner.userId, countsAsYou: false });
    });

    it('an invite token counts as whoever created the invite, on their own bot; not on a bot someone else owns', async () => {
        const bot = await makeBot(owner, 'invitebot');
        const invite = await ctx.request.post(`/servers/${serverId}/agent-invites`).set(owner.auth).send({ botId: bot.id });
        expect(invite.status, JSON.stringify(invite.body)).toBe(201);
        const redeemed = await ctx.request.post('/agent-invites/redeem').send({ code: invite.body.code });
        expect(redeemed.status).toBe(200);
        const tokenId = redeemed.body.token.slice('bot_'.length).split('.')[0];
        expect((await list(bot.id, owner)).get(tokenId)).toMatchObject({ purpose: 'invite', createdBy: owner.userId, countsAsYou: true });

        const adminInvite = await ctx.request.post(`/servers/${serverId}/agent-invites`).set(admin.auth).send({ botId: bot.id });
        expect(adminInvite.status, JSON.stringify(adminInvite.body)).toBe(201);
        const adminRedeemed = await ctx.request.post('/agent-invites/redeem').send({ code: adminInvite.body.code });
        const adminTokenId = adminRedeemed.body.token.slice('bot_'.length).split('.')[0];
        expect((await list(bot.id, owner)).get(adminTokenId)).toMatchObject({ purpose: 'invite', createdBy: admin.userId, countsAsYou: false });
    });

    it('authorization is unchanged: a plain member is refused', async () => {
        const bot = await makeBot(owner, 'listauthbot');
        expect((await ctx.request.get(`/servers/${serverId}/bots/${bot.id}/tokens`).set(member.auth)).status).toBe(403);
    });
});

describe('no claiming', () => {
    it('the claim route is gone: a makerless token already counts as its bot owner', async () => {
        const bot = await makeBot(owner, 'claimbot');
        const old = await makerless(bot.id, 'personal');
        const res = await ctx.request.post(`/servers/${serverId}/bots/${bot.id}/tokens/${old}/claim`).set(owner.auth);
        expect(res.status).toBe(404);
        const row = (await ctx.db.query('SELECT created_by FROM bot_tokens WHERE id = $1', [old])).rows[0];
        expect(row.created_by).toBeNull();
    });
});
