import { afterEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';

vi.mock('../../src/auth/passwords', () => ({ hashPassword: vi.fn(async () => 'hash'), verifyPassword: vi.fn() }));
import { hashPassword } from '../../src/auth/passwords';
import { authRoutes } from '../../src/routes/auth';
import { botRoutes } from '../../src/routes/bots';

const apps: FastifyInstance[] = [];
afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
    vi.clearAllMocks();
});

async function fixture(opts: { taken?: string; writeError?: object; missingBot?: boolean; member?: boolean } = {}) {
    const app = Fastify();
    apps.push(app);
    const query = vi.fn(async (sql: string, values: unknown[] = []): Promise<{ rows: any[] }> => {
        if (sql.includes('lower(username) = lower($1)')) {
            return { rows: opts.taken && opts.taken !== values[1] ? [{ '?column?': 1 }] : [] };
        }
        if (sql.includes('registration_policy')) return { rows: [{ value: 'approval' }] };
        if (sql.includes('FROM server_members')) return { rows: opts.member === false ? [] : [{}] };
        if (sql.includes('FROM servers')) return { rows: [{ owner_id: 'O', everyone_role_id: 'E' }] };
        if (sql.includes('FROM member_roles') || sql.includes('FROM roles')) return { rows: [] };
        if (sql.includes('FROM users WHERE id =')) {
            return { rows: opts.missingBot ? [] : [{ id: 'B', username: 'original', avatar_url: null }] };
        }
        if (sql.includes('INSERT INTO users') || sql.includes('UPDATE users')) {
            if (opts.writeError) throw opts.writeError;
            return { rows: [] };
        }
        throw new Error(`Unexpected unit DB query: ${sql}`);
    });
    app.addHook('onRequest', async request => {
        request.dbClient = { query } as unknown as PoolClient;
        request.userId = 'O';
        request.isBot = false;
    });
    await app.register(authRoutes);
    await app.register(botRoutes);
    await app.ready();
    const register = () => app.inject({ method: 'POST', url: '/auth/register', payload: {
        username: 'CaseCodex', email: 'fresh@example.com', password: 'password123',
    } });
    const create = () => app.inject({ method: 'POST', url: '/servers/S/bots', payload: { username: 'CaseCodex' } });
    const rename = (body = { username: 'CaseCodex' }) => app.inject({ method: 'PATCH', url: '/servers/S/bots/B', payload: body });
    return { query, register, create, rename };
}

it.each(['register', 'create', 'rename'] as const)('%s refuses a case-insensitive name clash before writing', async method => {
    const f = await fixture({ taken: 'OTHER' });
    const res = await f[method]();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'username_taken' });
    const calls = f.query.mock.calls;
    expect(calls.some(([sql]) => /INSERT INTO users|UPDATE users/.test(sql))).toBe(false);
    expect(calls.find(([sql]) => sql.includes('lower(username)'))?.[1]).toEqual(method === 'rename' ? ['CaseCodex', 'B'] : ['CaseCodex']);
    if (method === 'register') expect(hashPassword).not.toHaveBeenCalled();
});

it.each(['register', 'create', 'rename'] as const)('%s maps a concurrent index clash to username_taken', async method => {
    const f = await fixture({ writeError: { code: '23505', constraint: 'users_username_lower_key' } });
    const res = await f[method]();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'username_taken' });
});

it('keeps the email-conflict registration error', async () => {
    const f = await fixture({ writeError: { code: '23505', constraint: 'users_email_key' } });
    expect((await f.register()).json()).toEqual({ error: 'username_or_email_taken' });
});

it('still maps the original username constraint during registration races', async () => {
    const f = await fixture({ writeError: { code: '23505', constraint: 'uq_users_username' } });
    expect((await f.register()).json()).toEqual({ error: 'username_taken' });
});

it('allows a bot to change only the casing of its own username', async () => {
    const f = await fixture({ taken: 'B' });
    const res = await f.rename();
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe('CaseCodex');
    expect(f.query.mock.calls.some(([sql]) => sql.includes('UPDATE users SET username'))).toBe(true);
});

it('does not probe names before the bot management permission check', async () => {
    const f = await fixture({ member: false, taken: 'OTHER' });
    expect((await f.create()).statusCode).toBe(403);
    expect(f.query.mock.calls.some(([sql]) => sql.includes('lower(username)'))).toBe(false);
});

it('does not probe names for a bot missing from the requested server', async () => {
    const f = await fixture({ missingBot: true, taken: 'OTHER' });
    expect((await f.rename()).statusCode).toBe(404);
    expect(f.query.mock.calls.some(([sql]) => sql.includes('lower(username)'))).toBe(false);
});

it.each(['register', 'create', 'rename'] as const)('%s propagates unrelated DB failures', async method => {
    const f = await fixture({ writeError: { code: '08006' } });
    expect((await f[method]()).statusCode).toBe(500);
});
