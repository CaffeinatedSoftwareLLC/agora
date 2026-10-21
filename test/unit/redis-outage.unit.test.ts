import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
const fake = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), getdel: vi.fn(), quit: vi.fn().mockResolvedValue('OK'),
    on: vi.fn(), ctor: vi.fn() }));
vi.mock('ioredis', () => ({ default: class {
    constructor(...args: unknown[]) { fake.ctor(...args); }
    get = fake.get; set = fake.set; getdel = fake.getdel; quit = fake.quit; on = fake.on;
} }));
import { closeRedis, getRedis, isTokenBlacklisted } from '../../src/auth/token-blacklist';
import { requireAuth } from '../../src/auth/middleware';
import { generateToken } from '../../src/auth/tokens';
import { saveCeremony, takeCeremony } from '../../src/auth/passkeys';
import { installDependencyErrorHandler } from '../../src/lib/service-unavailable';
afterEach(async () => { await closeRedis(); vi.clearAllMocks(); });

it('bounds Redis commands and retries and handles connection error events', () => {
    getRedis();
    expect(fake.ctor).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ commandTimeout: 2000, connectTimeout: 2000, maxRetriesPerRequest: 1 }));
    expect(fake.on).toHaveBeenCalledWith('error', expect.any(Function));
});

it('never treats an unavailable blacklist as not revoked', async () => {
    fake.get.mockRejectedValue(new Error('Command timed out'));
    await expect(isTokenBlacklisted('session')).rejects.toThrow('Command timed out');
    const app = Fastify(); installDependencyErrorHandler(app);
    app.decorate('jwtSecret', 'fixture-secret');
    const handler = vi.fn(() => ({ authenticated: true }));
    app.get('/', { preHandler: requireAuth }, handler);
    try {
        const token = generateToken({ userId: 'user' }, 'fixture-secret');
        const res = await app.inject({ url: '/', headers: { authorization: `Bearer ${token}` } });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: 'service_unavailable' });
        expect(res.headers['retry-after']).toBe('5');
        expect(handler).not.toHaveBeenCalled();
    } finally { await app.close(); }
});

it.each(['save', 'take'])('passkey challenge %s returns 503 when Redis is unavailable', async action => {
    fake.set.mockRejectedValue(new Error('Command timed out'));
    fake.getdel.mockRejectedValue(Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }));
    const app = Fastify(); installDependencyErrorHandler(app);
    app.get('/', async () => action === 'save'
        ? saveCeremony({ purpose: 'login', challenge: 'c', origin: 'https://test', rpID: 'test' })
        : takeCeremony('flow', 'login'));
    try {
        const res = await app.inject('/');
        expect(res.statusCode).toBe(503);
        expect(res.headers['retry-after']).toBe('5');
        expect(res.json()).toEqual({ error: 'service_unavailable' });
    } finally { await app.close(); }
});
