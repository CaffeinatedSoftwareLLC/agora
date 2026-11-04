import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { MAX_PENDING_PER_BOX, recordEdgeRequest } from '../../src/lib/boxes/edge-requests';

/**
 * The per-box limits on edge requests (docs/agent-boxes.md §4.3): at most MAX_PENDING_PER_BOX
 * waiting cards and one phone notice per box per few minutes, also when a box sends many
 * requests at once, and expired cards never count (Codex review of the rate guard).
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;

beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => {
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'capowner');
    ({ serverId, generalChannelId: channelId } = await createServer(ctx.request, owner.auth, 'Cap Server'));
});

let n = 0;
async function makeBox(): Promise<string> {
    const res = await ctx.request.post(`/servers/${serverId}/boxes`).set(owner.auth).send({ name: `cap${++n}`, adapter: 'claude', homeChannelId: channelId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.box.id;
}

/** Record one request in its own transaction on its own connection, as the edge does. */
async function record(boxId: string, host: string) {
    const client = await ctx.db.connect();
    try {
        await client.query('BEGIN');
        const r = await recordEdgeRequest(client, { boxId, generation: 0, kind: 'domain', subject: { host } });
        await client.query('COMMIT');
        return r;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

const pending = async (boxId: string) => Number((await ctx.db.query(`SELECT count(*) AS n FROM box_edge_requests WHERE box_id = $1 AND status = 'pending'`, [boxId])).rows[0].n);
const notices = async () => Number((await ctx.db.query(`SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND type = 'approval'`, [owner.userId])).rows[0].n);

it('holds the cap when requests with different subjects arrive at the same time', async () => {
    const box = await makeBox();
    for (let i = 0; i < MAX_PENDING_PER_BOX - 1; i++) await record(box, `seed${i}.example.com`);
    expect(await pending(box)).toBe(MAX_PENDING_PER_BOX - 1);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => record(box, `race${i}.example.com`)));
    expect(results.filter(r => r.created)).toHaveLength(1);
    expect(results.filter(r => r.limited)).toHaveLength(7);
    expect(await pending(box)).toBe(MAX_PENDING_PER_BOX);
});

it('sends one phone notice when a box sends its first requests at the same time', async () => {
    const box = await makeBox();
    const before = await notices();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => record(box, `first${i}.example.com`)));
    expect(results.every(r => r.created)).toBe(true);
    expect(await notices() - before).toBe(1);
    // Every request still has its card
    expect(Number((await ctx.db.query(`SELECT count(*) AS n FROM box_edge_requests WHERE box_id = $1 AND message_id IS NOT NULL`, [box])).rows[0].n)).toBe(6);
});

it('expired cards never count towards the cap or stand in for a new request', async () => {
    const box = await makeBox();
    for (let i = 0; i < MAX_PENDING_PER_BOX; i++) await record(box, `old${i}.example.com`);
    expect((await record(box, 'blocked.example.com')).limited).toBe(true);
    // Their time runs out with nothing having expired them yet
    await ctx.db.query(`UPDATE box_edge_requests SET expires_at = NOW() - INTERVAL '1 minute' WHERE box_id = $1`, [box]);
    const fresh = await record(box, 'new.example.com');
    expect(fresh.created).toBe(true);
    // The same subject as an expired card gets a new card, not the stale one
    const again = await record(box, 'old0.example.com');
    expect(again.created).toBe(true);
    expect(await pending(box)).toBe(2);
    expect(Number((await ctx.db.query(`SELECT count(*) AS n FROM box_edge_requests WHERE box_id = $1 AND status = 'expired'`, [box])).rows[0].n)).toBe(MAX_PENDING_PER_BOX);
});
