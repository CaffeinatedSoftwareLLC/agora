import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authedUser, cleanDatabase, createServer, setupTestApp } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { hashPassword } from '../../src/auth/passwords';
import { generateBotToken } from '../../src/auth/bot-tokens';
import { signEdge } from '../../src/lib/boxes/contract';
import { BoxGoneError, prepareBoxRestore, rotateBoxTokens } from '../../src/lib/boxes/tokens';

/**
 * boxd's token minting (docs/agent-boxes.md §3.2, §4.1, §9.4) against the real API auth:
 * after a rotation the old host and bot tokens are 401 and the new ones carry the new generation.
 */

const EDGE_SECRET = randomBytes(32).toString('hex');

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let serverId: string;
let channelId: string;
let ownerId: string;

/** A box as the owner API creates it: bot, box host (placeholder secret), profile, box row. */
async function makeBox(name: string) {
    const db = ctx.db;
    const boxId = generateUlid();
    const botId = generateUlid();
    const hostId = generateUlid();
    const profileId = generateUlid();
    await db.query(`INSERT INTO users (id, username, bot, bot_owner_id, server_id) VALUES ($1, $2, true, $3, $4)`, [botId, name, ownerId, serverId]);
    await db.query(`INSERT INTO bot_channel_access (bot_id, channel_id, granted_by) VALUES ($1, $2, $3)`, [botId, channelId, ownerId]);
    await db.query(
        `INSERT INTO agent_hosts (id, server_id, name, secret_hash, created_by, kind, box_id) VALUES ($1, $2, $3, $4, $5, 'box', $6)`,
        [hostId, serverId, `box-${name}`, await hashPassword(randomBytes(32).toString('hex')), ownerId, boxId]
    );
    await db.query(
        `INSERT INTO agent_profiles (id, server_id, name, bot_id, host_id, adapter, workdir_alias, created_by, host_mode)
         VALUES ($1, $2, $3, $4, $5, 'claude', 'work', $6, false)`,
        [profileId, serverId, name, botId, hostId, ownerId]
    );
    await db.query(
        `INSERT INTO agent_boxes (id, server_id, profile_id, host_id, home_channel_id, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [boxId, serverId, profileId, hostId, channelId, ownerId]
    );
    return { boxId, botId, hostId, profileId };
}

const edge = (boxId: string, gen: number) => signEdge(EDGE_SECRET, boxId, gen);
const asHost = (token: string, boxId: string, gen: number) =>
    ctx.request.get('/agent-hosts/@me/runs/next').set({ Authorization: `AgentHost ${token}`, ...edge(boxId, gen) });
const asBot = (token: string, boxId: string, gen: number) =>
    ctx.request.get('/bots/@me').set({ Authorization: `Bot ${token}`, ...edge(boxId, gen) });

beforeAll(async () => {
    process.env.AGORA_EDGE_SECRET = EDGE_SECRET;
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    const owner = await authedUser(ctx.request, 'boxowner');
    ownerId = owner.userId;
    const s = await createServer(ctx.request, owner.auth, 'Boxes');
    serverId = s.serverId;
    channelId = s.generalChannelId;
});

afterAll(async () => {
    delete process.env.AGORA_EDGE_SECRET;
    await ctx.close();
});

describe('box token rotation', () => {
    it('mints a host and bot token bound to generation 1, both usable through the edge', async () => {
        const box = await makeBox('rot1');
        const t = await rotateBoxTokens(ctx.db, box.boxId);
        expect(t.generation).toBe(1);
        expect(t.hostToken).toMatch(new RegExp(`^ah_${box.hostId}\\.[0-9a-f]{64}$`));
        expect(t.botToken).toMatch(/^bot_[0-9A-Z]{26}\.[0-9a-f]{64}$/);
        expect(t.botId).toBe(box.botId);

        const row = (await ctx.db.query(`SELECT generation FROM agent_boxes WHERE id = $1`, [box.boxId])).rows[0];
        expect(row.generation).toBe(1);
        const host = (await ctx.db.query(`SELECT box_generation, revoked_at FROM agent_hosts WHERE id = $1`, [box.hostId])).rows[0];
        expect(host).toEqual({ box_generation: 1, revoked_at: null });
        const tokens = (await ctx.db.query(`SELECT box_id, box_generation, revoked_at FROM bot_tokens WHERE bot_id = $1`, [box.botId])).rows;
        expect(tokens).toEqual([{ box_id: box.boxId, box_generation: 1, revoked_at: null }]);

        expect((await asHost(t.hostToken, box.boxId, 1)).status).toBe(204);
        expect((await asBot(t.botToken, box.boxId, 1)).status).toBe(200);
    });

    it('a rotation makes the old host and bot tokens 401 and binds the new ones to the new generation', async () => {
        const box = await makeBox('rot2');
        const old = await rotateBoxTokens(ctx.db, box.boxId);
        const fresh = await rotateBoxTokens(ctx.db, box.boxId);
        expect(fresh.generation).toBe(2);

        expect((await asHost(old.hostToken, box.boxId, 2)).status).toBe(401);
        expect((await asBot(old.botToken, box.boxId, 2)).status).toBe(401);
        // Not even with the old generation's edge headers
        expect((await asHost(old.hostToken, box.boxId, 1)).status).toBe(401);
        expect((await asBot(old.botToken, box.boxId, 1)).status).toBe(401);

        expect((await asHost(fresh.hostToken, box.boxId, 2)).status).toBe(204);
        expect((await asBot(fresh.botToken, box.boxId, 2)).status).toBe(200);
        const live = (await ctx.db.query(
            `SELECT box_generation FROM bot_tokens WHERE bot_id = $1 AND revoked_at IS NULL`, [box.botId]
        )).rows;
        expect(live).toEqual([{ box_generation: 2 }]);
        expect((await ctx.db.query(`SELECT box_generation FROM agent_hosts WHERE id = $1`, [box.hostId])).rows[0].box_generation).toBe(2);
    });

    it('revokes every token the box bot had, including an unbound one', async () => {
        const box = await makeBox('rot3');
        const stray = await generateBotToken();
        await ctx.db.query(`INSERT INTO bot_tokens (id, bot_id, secret_hash, name) VALUES ($1, $2, $3, 'stray')`, [stray.tokenId, box.botId, stray.secretHash]);
        await rotateBoxTokens(ctx.db, box.boxId);
        expect((await ctx.request.get('/bots/@me').set({ Authorization: `Bot ${stray.raw}` })).status).toBe(401);
    });

    it('brings a host revoked by a delete back when the box was restored', async () => {
        const box = await makeBox('rot4');
        await ctx.db.query(`UPDATE agent_hosts SET revoked_at = NOW() WHERE id = $1`, [box.hostId]);
        const t = await rotateBoxTokens(ctx.db, box.boxId);
        expect((await asHost(t.hostToken, box.boxId, t.generation)).status).toBe(204);
    });

    it('refuses to mint for a deleted box and changes nothing', async () => {
        const box = await makeBox('rot5');
        await ctx.db.query(`UPDATE agent_boxes SET desired_state = 'deleted' WHERE id = $1`, [box.boxId]);
        await expect(rotateBoxTokens(ctx.db, box.boxId)).rejects.toBeInstanceOf(BoxGoneError);
        expect((await ctx.db.query(`SELECT generation FROM agent_boxes WHERE id = $1`, [box.boxId])).rows[0].generation).toBe(0);
        expect((await ctx.db.query(`SELECT 1 FROM bot_tokens WHERE bot_id = $1`, [box.botId])).rows).toHaveLength(0);
    });

    it('two concurrent rotations end with exactly one live bot token', async () => {
        const box = await makeBox('rot6');
        const [a, b] = await Promise.all([rotateBoxTokens(ctx.db, box.boxId), rotateBoxTokens(ctx.db, box.boxId)]);
        expect([a.generation, b.generation].sort()).toEqual([1, 2]);
        const live = (await ctx.db.query(`SELECT box_generation FROM bot_tokens WHERE bot_id = $1 AND revoked_at IS NULL`, [box.botId])).rows;
        expect(live).toEqual([{ box_generation: 2 }]);
    });
});

describe('box restore prep', () => {
    it('bumps every generation, kills all box credentials and expires open edge requests', async () => {
        const box = await makeBox('rest1');
        const t = await rotateBoxTokens(ctx.db, box.boxId);
        const mkReq = async (status: string) => {
            const id = generateUlid();
            await ctx.db.query(
                `INSERT INTO box_edge_requests (id, server_id, box_id, generation, kind, subject, subject_hash, status, expires_at)
                 VALUES ($1, $2, $3, $4, 'domain', $5, $6, $7, NOW() + INTERVAL '1 hour')`,
                [id, serverId, box.boxId, t.generation, JSON.stringify({ host: `${status}.example.com` }), randomBytes(32).toString('hex'), status]
            );
            return id;
        };
        const pending = await mkReq('pending');
        const allowed = await mkReq('allowed');
        const inFlight = await mkReq('in_flight');
        const used = await mkReq('used');

        const r = await prepareBoxRestore(ctx.db);
        expect(r.boxes).toBeGreaterThanOrEqual(1);
        expect(r.requests).toBeGreaterThanOrEqual(3);

        const gen = (await ctx.db.query(`SELECT generation FROM agent_boxes WHERE id = $1`, [box.boxId])).rows[0].generation;
        expect(gen).toBe(t.generation + 1);
        expect((await asHost(t.hostToken, box.boxId, t.generation)).status).toBe(401);
        expect((await asBot(t.botToken, box.boxId, t.generation)).status).toBe(401);
        expect((await ctx.db.query(`SELECT 1 FROM bot_tokens WHERE bot_id = $1 AND revoked_at IS NULL`, [box.botId])).rows).toHaveLength(0);

        const statuses = Object.fromEntries((await ctx.db.query(
            `SELECT id, status FROM box_edge_requests WHERE id = ANY($1)`, [[pending, allowed, inFlight, used]]
        )).rows.map((x: any) => [x.id.trim(), x.status]));
        expect(statuses).toEqual({ [pending]: 'expired', [allowed]: 'expired', [inFlight]: 'expired', [used]: 'used' });

        // boxd's next rotation works again from the new generation
        const next = await rotateBoxTokens(ctx.db, box.boxId);
        expect(next.generation).toBe(gen + 1);
        expect((await asHost(next.hostToken, box.boxId, next.generation)).status).toBe(204);
    });
});
