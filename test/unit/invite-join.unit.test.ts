import { afterEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { serverRoutes } from '../../src/routes/servers';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function fixture(join: { server_id: string; joined: boolean } | null, fail = false) {
    const app = Fastify(); apps.push(app);
    let events: unknown[] = [];
    const query = vi.fn(async (sql: string) => {
        if (sql.includes('public.join_server_by_invite')) {
            if (fail) throw new Error('database unavailable');
            return { rows: join ? [join] : [] };
        }
        if (sql.includes('FROM servers')) return { rows: [{ id: 'S', name: 'Server', owner_id: 'O' }] };
        if (sql.includes('FROM channels')) return { rows: [{ id: 'C', name: 'general', channel_type: 3 }] };
        throw new Error(`Unexpected query: ${sql}`);
    });
    app.addHook('onRequest', async request => {
        request.dbClient = { query } as unknown as PoolClient;
        request.userId = 'U';
        request.pendingEvents = [];
        events = request.pendingEvents;
    });
    await app.register(serverRoutes);
    return { query, events: () => events, post: () => app.inject({ method: 'POST', url: '/invites/known-code' }) };
}

it('uses only the exact-code function for joining and queues ServerJoin for a new member', async () => {
    const f = await fixture({ server_id: 'S', joined: true });
    const res = await f.post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ serverId: 'S', userId: 'U' });
    expect(f.query).toHaveBeenCalledWith('SELECT server_id, joined FROM public.join_server_by_invite($1)', ['known-code']);
    expect(f.query.mock.calls.some(([sql]) => /INSERT INTO server_members|UPDATE server_invites/.test(sql))).toBe(false);
    expect(f.events()).toEqual([{ event: 'ServerJoin', room: 'user:U', data: {
        server: { id: 'S', name: 'Server', ownerId: 'O' }, channels: [{ id: 'C', name: 'general', channelType: 3, serverId: 'S' }],
    } }]);
});

it('does not announce or query server details again for an existing member', async () => {
    const f = await fixture({ server_id: 'S', joined: false });
    expect((await f.post()).statusCode).toBe(200);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.events()).toEqual([]);
});

it('maps an unknown, expired or exhausted code to the existing generic 404', async () => {
    const f = await fixture(null);
    const res = await f.post();
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Invite not found' });
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.events()).toEqual([]);
});

it('propagates database failures without reporting a join', async () => {
    const f = await fixture(null, true);
    expect((await f.post()).statusCode).toBe(500);
    expect(f.events()).toEqual([]);
});
