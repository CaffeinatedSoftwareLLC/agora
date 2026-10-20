import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupTestApp, cleanDatabase, authedUser } from '../helpers';
import { getRedis } from '../../src/auth/token-blacklist';
import { LoginLimiter, failureKey } from '../../src/auth/login-limit';
import { config } from '../../src/config';

const PASSWORD = 'TestPass123!';

async function clearLoginKeys() {
    const keys = await getRedis().keys('login:*');
    if (keys.length > 0) await getRedis().del(...keys);
}

function login(ctx: Awaited<ReturnType<typeof setupTestApp>>, login: string, password: string) {
    return ctx.request.post('/auth/login').send({ login, password });
}

describe('login attempt limits', () => {
    let ctx: Awaited<ReturnType<typeof setupTestApp>>;

    beforeAll(async () => {
        ctx = await setupTestApp({ loginLimits: { maxFailures: 3, lockSeconds: 60, globalPerMinute: 1000 } });
        await cleanDatabase(ctx.db);
    });
    afterAll(async () => {
        await clearLoginKeys();
        await ctx.close();
    });
    beforeEach(async () => {
        await cleanDatabase(ctx.db);
        await clearLoginKeys();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('locks an account after too many failed logins, even for the right password', async () => {
        await authedUser(ctx.request, 'alice');
        for (let i = 0; i < 3; i++) {
            expect((await login(ctx, 'alice', 'wrong-password')).status).toBe(401);
        }
        const res = await login(ctx, 'alice', PASSWORD);
        expect(res.status).toBe(429);
        expect(res.body.error).toBe('too_many_attempts');
        expect(res.headers['retry-after']).toBe('60');
    });

    it('counts the email, the username and any case as the same account', async () => {
        await authedUser(ctx.request, 'alice');
        expect((await login(ctx, 'alice@test.com', 'wrong')).status).toBe(401);
        expect((await login(ctx, '  ALICE ', 'wrong')).status).toBe(401);
        expect((await login(ctx, 'Alice@Test.com', 'wrong')).status).toBe(401);
        expect((await login(ctx, 'alice', PASSWORD)).status).toBe(429);
    });

    it('clears the count after a successful login', async () => {
        await authedUser(ctx.request, 'alice');
        expect((await login(ctx, 'alice', 'wrong')).status).toBe(401);
        expect((await login(ctx, 'alice', 'wrong')).status).toBe(401);
        expect((await login(ctx, 'alice', PASSWORD)).status).toBe(200);
        expect((await login(ctx, 'alice', 'wrong')).status).toBe(401);
        expect((await login(ctx, 'alice', 'wrong')).status).toBe(401);
        expect((await login(ctx, 'alice', PASSWORD)).status).toBe(200);
    });

    it('charges every account an ambiguous identifier matches', async () => {
        // bob's username is alice's email, so "alice@test.com" matches both accounts
        const alice = await authedUser(ctx.request, 'alice');
        const reg = await ctx.request.post('/auth/register').send({
            username: 'alice@test.com', email: 'bob@test.com', password: 'BobPass123!',
        });
        expect(reg.status).toBe(201);

        for (let i = 0; i < 3; i++) {
            expect((await login(ctx, 'alice@test.com', 'wrong')).status).toBe(401);
        }
        // Both accounts are now over the limit, whichever name is used
        expect((await login(ctx, 'alice', PASSWORD)).status).toBe(429);
        expect((await login(ctx, 'bob@test.com', 'BobPass123!')).status).toBe(429);
        expect(await getRedis().get(failureKey(alice.userId))).toBe('4');
    });

    it('lets through no more than the limit when guesses arrive at once', async () => {
        await authedUser(ctx.request, 'alice');
        const results = await Promise.all(
            Array.from({ length: 10 }, () => login(ctx, 'alice', 'wrong'))
        );
        const statuses = results.map(r => r.status);
        expect(statuses.filter(s => s === 401)).toHaveLength(3);
        expect(statuses.filter(s => s === 429)).toHaveLength(7);
    });

    it('keeps no per-account state for identifiers that match nobody', async () => {
        for (let i = 0; i < 5; i++) {
            expect((await login(ctx, `nobody-${i}`, 'wrong')).status).toBe(401);
        }
        expect(await getRedis().keys('login:fail:*')).toHaveLength(0);
    });

    it('locks one account without affecting another', async () => {
        await authedUser(ctx.request, 'alice');
        await authedUser(ctx.request, 'carol');
        for (let i = 0; i < 3; i++) await login(ctx, 'alice', 'wrong');
        expect((await login(ctx, 'alice', PASSWORD)).status).toBe(429);
        expect((await login(ctx, 'carol', PASSWORD)).status).toBe(200);
    });

    it('refuses an over-long password before hashing it', async () => {
        await authedUser(ctx.request, 'alice');
        const res = await login(ctx, 'alice', 'x'.repeat(1025));
        expect(res.status).toBe(400);
    });

    it('refuses logins when a counter key holds the wrong type', async () => {
        const alice = await authedUser(ctx.request, 'alice');
        await getRedis().rpush(failureKey(alice.userId), 'x');
        const res = await login(ctx, 'alice', PASSWORD);
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('login_unavailable');
    });

    it('refuses logins when the instance counter holds the wrong type', async () => {
        await authedUser(ctx.request, 'alice');
        const minute = Math.floor(Date.now() / 60_000);
        for (const m of [minute, minute + 1]) await getRedis().hset(`login:global:${m}`, 'x', '1');
        const res = await login(ctx, 'alice', PASSWORD);
        expect(res.status).toBe(503);
    });

    it('refuses logins when the Redis transaction is aborted', async () => {
        await authedUser(ctx.request, 'alice');
        const fake: any = { incr: () => fake, expire: () => fake, exec: async () => null };
        vi.spyOn(getRedis(), 'multi').mockReturnValue(fake);
        const res = await login(ctx, 'alice', PASSWORD);
        expect(res.status).toBe(503);
    });

    it('caps passwords at registration the same way', async () => {
        const res = await ctx.request.post('/auth/register').send({
            username: 'longpw', email: 'longpw@test.com', password: 'x'.repeat(1025),
        });
        expect(res.status).toBe(400);
    });

    it('refuses logins when the limit store is unavailable', async () => {
        await authedUser(ctx.request, 'alice');
        vi.spyOn(LoginLimiter.prototype, 'takeGlobalAttempt').mockRejectedValue(new Error('redis down'));
        const res = await login(ctx, 'alice', PASSWORD);
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('login_unavailable');
    });
});

describe('instance-wide login budget', () => {
    let ctx: Awaited<ReturnType<typeof setupTestApp>>;

    beforeAll(async () => {
        ctx = await setupTestApp({ loginLimits: { maxFailures: 100, lockSeconds: 60, globalPerMinute: 4 } });
        await cleanDatabase(ctx.db);
        await clearLoginKeys();
    });
    afterAll(async () => {
        await clearLoginKeys();
        await ctx.close();
    });

    it("refuses logins once the minute's budget is spent, including for unknown names", async () => {
        // The budget is per clock minute: don't start in the last few seconds of one
        const intoMinute = Date.now() % 60_000;
        if (intoMinute > 50_000) await new Promise(r => setTimeout(r, 60_500 - intoMinute));
        await authedUser(ctx.request, 'alice');
        for (let i = 0; i < 4; i++) {
            expect((await login(ctx, `nobody-${i}`, 'wrong')).status).toBe(401);
        }
        const res = await login(ctx, 'alice', PASSWORD);
        expect(res.status).toBe(429);
        expect(res.headers['retry-after']).toBe('60');
    });
});

/**
 * beta-test-plan §6.3 Login limits: the production default of 10 failures, behind a proxy whose
 * X-Forwarded-For is trusted, with every attempt claiming a different client address.
 */
describe('beta §6.3: a forged X-Forwarded-For does not get around the lock', () => {
    let ctx: Awaited<ReturnType<typeof setupTestApp>>;
    let trustProxy: boolean;

    beforeAll(async () => {
        trustProxy = config.trustProxy;
        (config as { trustProxy: boolean }).trustProxy = true;
        ctx = await setupTestApp({ loginLimits: { maxFailures: 10, lockSeconds: 15 * 60, globalPerMinute: 1000 } });
        await cleanDatabase(ctx.db);
        await clearLoginKeys();
    });
    afterAll(async () => {
        (config as { trustProxy: boolean }).trustProxy = trustProxy;
        await clearLoginKeys();
        await ctx.close();
    });

    it('10 bad attempts from 10 "addresses" lock the account for the right password from an 11th', async () => {
        await authedUser(ctx.request, 'mallory');
        for (let i = 0; i < 10; i++) {
            const res = await ctx.request.post('/auth/login').set('X-Forwarded-For', `203.0.113.${i + 1}`)
                .send({ login: 'mallory', password: 'wrong-password' });
            expect(res.status, `attempt ${i + 1}`).toBe(401);
        }
        for (const forged of ['198.51.100.7', '127.0.0.1', '10.0.0.1, 127.0.0.1']) {
            const res = await ctx.request.post('/auth/login').set('X-Forwarded-For', forged).send({ login: 'mallory', password: PASSWORD });
            expect(res.status, forged).toBe(429);
            expect(res.body.error).toBe('too_many_attempts');
            expect(res.body.accessToken).toBeUndefined();
            expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        }
    });
});
