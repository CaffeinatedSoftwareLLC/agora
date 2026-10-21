import { afterEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { botAttentionRoutes } from '../../src/routes/bot-attention';
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function fixture(isBot = true, allowed = true) {
    const app = Fastify(); apps.push(app);
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM bot_channel_access') && allowed ? [{}] : [] }));
    app.addHook('onRequest', async request => { request.isBot = isBot; request.userId = 'B'; request.dbClient = { query } as unknown as PoolClient; });
    await app.register(botAttentionRoutes);
    return { app, query };
}
it('refuses human attention reads before querying message data', async () => {
    const f = await fixture(false);
    expect((await f.app.inject('/channels/C/attention')).statusCode).toBe(403);
    expect(f.query).not.toHaveBeenCalled();
});
it('refuses bots without channel access before querying message data', async () => {
    const f = await fixture(true, false);
    expect((await f.app.inject('/channels/C/attention')).statusCode).toBe(403);
    expect(f.query).toHaveBeenCalledTimes(1);
});
it('scopes an authorized empty feed to the authenticated bot and requested channel', async () => {
    const f = await fixture();
    const res = await f.app.inject('/channels/C/attention?limit=5');
    expect(res.statusCode).toBe(200); expect(res.json()).toEqual([]);
    expect(f.query.mock.calls).toHaveLength(2);
    expect(f.query).toHaveBeenLastCalledWith(expect.stringContaining('WITH cutoff'), ['B', 'C', null, 5]);
});
