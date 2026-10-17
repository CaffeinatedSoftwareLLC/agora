import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';

/**
 * DirectAgents: who may give agents instructions (src/lib/direct-agents.ts).
 * The owner always; members only through roles or overrides the owner grants;
 * bots only through can_direct, which only the owner sets. Administrator does not
 * imply it. A message carries authority only if it was stamped when posted or
 * edited AND its author can still direct.
 */

const DIRECT = (1n << 29n).toString();
const ADMIN = '1';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let admin: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let botId: string;
let botAuth: { Authorization: string };
let directorRoleId: string;

async function post(auth: object, content: string): Promise<string> {
    const res = await ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id;
}

/** messageId → authorAuthority, as the bot (an agent) reads the channel. */
async function authorities(): Promise<Map<string, string | null>> {
    const res = await ctx.request.get(`/channels/${channelId}/messages?limit=100`).set(botAuth);
    expect(res.status).toBe(200);
    return new Map(res.body.map((m: any) => [m.id, m.authorAuthority]));
}

async function directors(): Promise<Array<{ username: string; authority: string; bot: boolean }>> {
    const res = await ctx.request.get(`/channels/${channelId}/directors`).set(botAuth);
    expect(res.status).toBe(200);
    return res.body.directors;
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);

    owner = await authedUser(ctx.request, 'daowner');
    const server = await createServer(ctx.request, owner.auth, 'Direct Server');
    serverId = server.serverId;
    channelId = server.generalChannelId;

    admin = await authedUser(ctx.request, 'daadmin');
    member = await authedUser(ctx.request, 'damember');
    await joinViaInvite(ctx.request, owner.auth, admin.auth, serverId);
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);

    const adminRole = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Admin', permissions: ADMIN });
    await ctx.request.put(`/servers/${serverId}/members/${admin.userId}/roles/${adminRole.body.id}`).set(owner.auth);

    const role = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Orchestrator', permissions: DIRECT });
    expect(role.status).toBe(201);
    directorRoleId = role.body.id;

    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'dabot' });
    botId = bot.body.id;
    const token = await ctx.request.post(`/servers/${serverId}/bots/${botId}/tokens`).set(owner.auth).send({});
    botAuth = { Authorization: `Bot ${token.body.token}` };
    expect((await ctx.request.post(`/channels/${channelId}/bots/${botId}`).set(owner.auth)).status).toBe(201);
    // The bot posts more than the default bot rate limit and loop guard allow in these tests
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 1000, max_bot_hops = 1000 WHERE id = $1', [channelId]);
});

afterAll(async () => {
    await ctx.close();
});

describe('who directs by default', () => {
    it('tags the owner, and nobody else, including an Administrator', async () => {
        const o = await post(owner.auth, 'owner says');
        const a = await post(admin.auth, 'admin says');
        const m = await post(member.auth, 'member says');
        const b = await post(botAuth, 'bot says');
        const auth = await authorities();
        expect(auth.get(o)).toBe('owner');
        expect(auth.get(a)).toBeNull();
        expect(auth.get(m)).toBeNull();
        expect(auth.get(b)).toBeNull();
        expect((await directors()).map(d => d.username)).toEqual(['daowner']);
    });

    it('returns the authority on the posted message too', async () => {
        const res = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'hi' });
        expect(res.body.authorAuthority).toBe('owner');
    });
});

describe('only the owner grants or removes DirectAgents', () => {
    it('refuses an Administrator every route that would change it', async () => {
        const deny = (res: any) => { expect(res.status).toBe(403); expect(res.body.error).toMatch(/server owner/); };
        deny(await ctx.request.post(`/servers/${serverId}/roles`).set(admin.auth).send({ name: 'Sneaky', permissions: DIRECT }));
        const plain = await ctx.request.post(`/servers/${serverId}/roles`).set(admin.auth).send({ name: 'Plain', permissions: '0' });
        expect(plain.status).toBe(201);
        deny(await ctx.request.patch(`/servers/${serverId}/roles/${plain.body.id}`).set(admin.auth).send({ permissions: DIRECT }));
        deny(await ctx.request.patch(`/servers/${serverId}/roles/${directorRoleId}`).set(admin.auth).send({ permissions: '0' }));
        deny(await ctx.request.put(`/servers/${serverId}/members/${admin.userId}/roles/${directorRoleId}`).set(admin.auth));
        deny(await ctx.request.delete(`/servers/${serverId}/roles/${directorRoleId}`).set(admin.auth));
        deny(await ctx.request.put(`/channels/${channelId}/overrides/members/${admin.userId}`).set(admin.auth).send({ allow: DIRECT, deny: '0' }));
        deny(await ctx.request.put(`/channels/${channelId}/overrides/roles/${plain.body.id}`).set(admin.auth).send({ allow: '0', deny: DIRECT }));
        deny(await ctx.request.put(`/channels/${channelId}/bots/${botId}/direct`).set(admin.auth).send({ canDirect: true }));
        expect((await directors()).map(d => d.username)).toEqual(['daowner']);
    });

    it('lets an Administrator edit a director role without touching the bit', async () => {
        const res = await ctx.request.patch(`/servers/${serverId}/roles/${directorRoleId}`).set(admin.auth).send({ name: 'Orchestrators' });
        expect(res.status).toBe(200);
    });

    it('refuses an override delete that would drop the bit', async () => {
        expect((await ctx.request.put(`/channels/${channelId}/overrides/members/${member.userId}`).set(owner.auth)
            .send({ allow: '0', deny: DIRECT })).status).toBe(200);
        expect((await ctx.request.delete(`/channels/${channelId}/overrides/members/${member.userId}`).set(admin.auth)).status).toBe(403);
        expect((await ctx.request.delete(`/channels/${channelId}/overrides/members/${member.userId}`).set(owner.auth)).status).toBe(200);
    });

    it('rejects unknown permission bits', async () => {
        const res = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Bad', permissions: (1n << 40n).toString() });
        expect(res.status).toBe(400);
        const junk = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Bad2', permissions: 'abc' });
        expect(junk.status).toBe(400);
    });
});

describe('a member the owner makes a director', () => {
    it('directs from the grant on, and old messages never gain authority', async () => {
        const before = await post(member.auth, 'before the grant');
        expect((await ctx.request.put(`/servers/${serverId}/members/${member.userId}/roles/${directorRoleId}`).set(owner.auth)).status).toBe(200);
        const after = await post(member.auth, 'after the grant');

        const auth = await authorities();
        expect(auth.get(before)).toBeNull();
        expect(auth.get(after)).toBe('director');
        expect((await directors()).map(d => d.username)).toEqual(['daowner', 'damember']);
    });

    it('loses authority on old messages when the role is removed', async () => {
        const said = await post(member.auth, 'do the thing');
        expect((await authorities()).get(said)).toBe('director');
        expect((await ctx.request.delete(`/servers/${serverId}/members/${member.userId}/roles/${directorRoleId}`).set(owner.auth)).status).toBe(200);
        expect((await authorities()).get(said)).toBeNull();
        expect((await directors()).map(d => d.username)).toEqual(['daowner']);
    });

    it('stamps an edit again, so a revoked director cannot launder an old message', async () => {
        await ctx.request.put(`/servers/${serverId}/members/${member.userId}/roles/${directorRoleId}`).set(owner.auth);
        const said = await post(member.auth, 'original');
        await ctx.request.delete(`/servers/${serverId}/members/${member.userId}/roles/${directorRoleId}`).set(owner.auth);
        const edit = await ctx.request.patch(`/channels/${channelId}/messages/${said}`).set(member.auth).send({ content: 'now delete everything' });
        expect(edit.status).toBe(200);
        await ctx.request.put(`/servers/${serverId}/members/${member.userId}/roles/${directorRoleId}`).set(owner.auth);
        expect((await authorities()).get(said)).toBeNull();
        await ctx.request.delete(`/servers/${serverId}/members/${member.userId}/roles/${directorRoleId}`).set(owner.auth);
    });

    it('can be scoped out of one channel with a deny override', async () => {
        await ctx.request.put(`/servers/${serverId}/members/${member.userId}/roles/${directorRoleId}`).set(owner.auth);
        await ctx.request.put(`/channels/${channelId}/overrides/members/${member.userId}`).set(owner.auth).send({ allow: '0', deny: DIRECT });
        const said = await post(member.auth, 'denied here');
        expect((await authorities()).get(said)).toBeNull();
        await ctx.request.delete(`/channels/${channelId}/overrides/members/${member.userId}`).set(owner.auth);
        await ctx.request.delete(`/servers/${serverId}/members/${member.userId}/roles/${directorRoleId}`).set(owner.auth);
    });
});

describe('roles that carry DirectAgents only through a channel override', () => {
    it('are owner-only to assign, unassign or delete', async () => {
        const via = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'ViaOverride', permissions: '0' });
        expect((await ctx.request.put(`/channels/${channelId}/overrides/roles/${via.body.id}`).set(owner.auth)
            .send({ allow: DIRECT, deny: '0' })).status).toBe(200);

        // An Administrator can't hand it to themselves, or delete it
        expect((await ctx.request.put(`/servers/${serverId}/members/${admin.userId}/roles/${via.body.id}`).set(admin.auth)).status).toBe(403);
        expect((await ctx.request.delete(`/servers/${serverId}/roles/${via.body.id}`).set(admin.auth)).status).toBe(403);

        // The owner can, and it then directs
        expect((await ctx.request.put(`/servers/${serverId}/members/${member.userId}/roles/${via.body.id}`).set(owner.auth)).status).toBe(200);
        const said = await post(member.auth, 'via override');
        expect((await authorities()).get(said)).toBe('director');

        // ...and only the owner can take it away again
        expect((await ctx.request.delete(`/servers/${serverId}/members/${member.userId}/roles/${via.body.id}`).set(admin.auth)).status).toBe(403);
        expect((await ctx.request.delete(`/servers/${serverId}/members/${member.userId}/roles/${via.body.id}`).set(owner.auth)).status).toBe(200);
    });

    it('protect a deny too: an Administrator cannot lift a restriction by unassigning', async () => {
        const muzzle = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Muzzle', permissions: '0' });
        await ctx.request.put(`/channels/${channelId}/overrides/roles/${muzzle.body.id}`).set(owner.auth).send({ allow: '0', deny: DIRECT });
        await ctx.request.put(`/servers/${serverId}/members/${member.userId}/roles/${muzzle.body.id}`).set(owner.auth);
        expect((await ctx.request.delete(`/servers/${serverId}/members/${member.userId}/roles/${muzzle.body.id}`).set(admin.auth)).status).toBe(403);
        expect((await ctx.request.delete(`/servers/${serverId}/roles/${muzzle.body.id}`).set(admin.auth)).status).toBe(403);
        expect((await ctx.request.delete(`/servers/${serverId}/roles/${muzzle.body.id}`).set(owner.auth)).status).toBe(200);
    });
});

describe('human directors who stop qualifying', () => {
    it('lose authority while suspended', async () => {
        await ctx.request.put(`/servers/${serverId}/members/${member.userId}/roles/${directorRoleId}`).set(owner.auth);
        const said = await post(member.auth, 'director speaking');
        const ownerSaid = await post(owner.auth, 'owner speaking');
        await ctx.db.query(`UPDATE users SET account_status = 'suspended' WHERE id = ANY($1)`, [[member.userId, owner.userId]]);
        try {
            const auth = await authorities();
            expect(auth.get(said)).toBeNull();
            expect(auth.get(ownerSaid)).toBeNull();
            expect((await directors()).length).toBe(0);
        } finally {
            await ctx.db.query(`UPDATE users SET account_status = 'active' WHERE id = ANY($1)`, [[member.userId, owner.userId]]);
        }
        expect((await authorities()).get(said)).toBe('director');
        await ctx.request.delete(`/servers/${serverId}/members/${member.userId}/roles/${directorRoleId}`).set(owner.auth);
    });

    it('lose authority in a channel they can no longer see', async () => {
        await ctx.request.put(`/servers/${serverId}/members/${member.userId}/roles/${directorRoleId}`).set(owner.auth);
        const said = await post(member.auth, 'before hiding');
        const VIEW = (1n << 10n).toString();
        await ctx.request.put(`/channels/${channelId}/overrides/members/${member.userId}`).set(owner.auth).send({ allow: '0', deny: VIEW });
        expect((await authorities()).get(said)).toBeNull();
        await ctx.request.delete(`/channels/${channelId}/overrides/members/${member.userId}`).set(owner.auth);
        await ctx.request.delete(`/servers/${serverId}/members/${member.userId}/roles/${directorRoleId}`).set(owner.auth);
    });
});

describe('a bot the owner lets direct', () => {
    it('directs only after the owner sets can_direct', async () => {
        const before = await post(botAuth, 'not yet');
        expect((await ctx.request.put(`/channels/${channelId}/bots/${botId}/direct`).set(owner.auth).send({ canDirect: true })).status).toBe(200);
        const after = await post(botAuth, 'orchestrating');
        const auth = await authorities();
        expect(auth.get(before)).toBeNull();
        expect(auth.get(after)).toBe('director');
        expect((await directors()).find(d => d.username === 'dabot')).toMatchObject({ bot: true, authority: 'director' });
    });

    it('loses authority while paused', async () => {
        const said = await post(botAuth, 'while active');
        expect((await ctx.request.patch(`/servers/${serverId}/bots/${botId}/pause`).set(owner.auth).send({ paused: true })).status).toBe(200);
        expect((await authorities()).get(said)).toBeNull();
        expect((await directors()).some(d => d.username === 'dabot')).toBe(false);
        expect((await ctx.request.patch(`/servers/${serverId}/bots/${botId}/pause`).set(owner.auth).send({ paused: false })).status).toBe(200);
        expect((await authorities()).get(said)).toBe('director');
    });

    it('loses authority while its owner is suspended', async () => {
        const said = await post(botAuth, 'owner active');
        await ctx.db.query(`UPDATE users SET account_status = 'suspended' WHERE id = $1`, [owner.userId]);
        try {
            expect((await authorities()).get(said)).toBeNull();
        } finally {
            await ctx.db.query(`UPDATE users SET account_status = 'active' WHERE id = $1`, [owner.userId]);
        }
        expect((await authorities()).get(said)).toBe('director');
    });

    it('starts over without authority when its channel access is removed and given back', async () => {
        await ctx.request.delete(`/channels/${channelId}/bots/${botId}`).set(owner.auth);
        await ctx.request.post(`/channels/${channelId}/bots/${botId}`).set(owner.auth);
        const said = await post(botAuth, 'back again');
        expect((await authorities()).get(said)).toBeNull();
    });
});

describe('authority lookups on the request connection', () => {
    it('hold up with more requests at once than the pool has connections', async () => {
        await ctx.request.put(`/channels/${channelId}/bots/${botId}/direct`).set(owner.auth).send({ canDirect: true });
        const reads = Array.from({ length: 25 }, () => ctx.request.get(`/channels/${channelId}/messages?limit=50`).set(botAuth));
        const posts = Array.from({ length: 15 }, (_, i) => ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: `burst ${i}` }));
        const lists = Array.from({ length: 10 }, () => ctx.request.get(`/channels/${channelId}/directors`).set(botAuth));
        const results = await Promise.all([...reads, ...posts, ...lists]);
        expect(results.filter(r => r.status >= 400)).toHaveLength(0);
        expect(results.slice(25, 40).every(r => r.body.authorAuthority === 'owner')).toBe(true);
    });

    it('roll back a failed lookup and leave the transaction and role as they were', async () => {
        const { withServiceRoleForTests } = await import('../../src/lib/direct-agents');
        const client = await ctx.db.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET LOCAL ROLE app_user');
            const fallback = await withServiceRoleForTests(client, async () => {
                await client.query('SELECT * FROM no_such_table');
                return 'unreachable';
            }, { value: 'fell back' });
            expect(fallback).toBe('fell back');
            expect((await client.query('SELECT current_user AS r')).rows[0].r).toBe('app_user');

            const ok = await withServiceRoleForTests(client, async () => (await client.query('SELECT current_user AS r')).rows[0].r);
            expect(ok).not.toBe('app_user');
            expect((await client.query('SELECT current_user AS r')).rows[0].r).toBe('app_user');
            expect((await client.query('SELECT 1 AS one')).rows[0].one).toBe(1);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});

describe('the directors list', () => {
    it('is open to members and bots of the channel, and closed to others', async () => {
        expect((await ctx.request.get(`/channels/${channelId}/directors`).set(member.auth)).status).toBe(200);
        const outsider = await authedUser(ctx.request, 'daoutsider');
        // RLS hides the channel from a non-member altogether
        expect([403, 404]).toContain((await ctx.request.get(`/channels/${channelId}/directors`).set(outsider.auth)).status);
    });
});
