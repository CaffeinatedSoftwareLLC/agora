import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { io, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, cleanDatabase } from '../helpers';
import { csrfTokenFor } from '../../src/auth/session-cookie';
import { getRedis } from '../../src/auth/token-blacklist';
import { SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS } from '../../src/auth/tokens';

// Cookie sessions: 24 h idle timeout with sliding renewal, 30-day cap from login.
// Tokens are signed here with back-dated claims rather than waiting out the clock.
let ctx: Awaited<ReturnType<typeof setupTestApp>>;
const SECRET = 'test-secret-do-not-use-in-prod';
const PORT = 4999;
const HOUR = 3600;
const sockets: Socket[] = [];
let userId: string;

const now = () => Math.floor(Date.now() / 1000);

function sessionToken(claims: { iat: number; exp: number; authTime?: number; jti?: string; tokenVersion?: number }) {
    const jti = claims.jti ?? randomBytes(16).toString('hex');
    const token = jwt.sign({ userId, tokenVersion: claims.tokenVersion ?? 0, jti, ...claims }, SECRET, { algorithm: 'HS256' });
    return { token, jti, cookie: `agora_session=${token}; agora_csrf=${csrfTokenFor(jti, SECRET)}`, csrf: csrfTokenFor(jti, SECRET) };
}

function cookiesOf(res: { headers: Record<string, any> }): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of (res.headers['set-cookie'] ?? []) as string[]) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return out;
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await ctx.app.listen({ host: '127.0.0.1', port: PORT });
    await cleanDatabase(ctx.db);
    ({ userId } = await authedUser(ctx.request, 'idleuser'));
});
afterEach(() => { for (const s of sockets.splice(0)) s.disconnect(); });
afterAll(async () => { await ctx.close(); });

describe('sliding renewal', () => {
    test('a fresh session is not re-issued on every request', async () => {
        const t = now();
        const s = sessionToken({ iat: t - 60, exp: t - 60 + SESSION_IDLE_SECONDS, authTime: t - 60 });
        const res = await ctx.request.get('/auth/session').set('Cookie', s.cookie);
        expect(res.status).toBe(200);
        expect(res.headers['set-cookie']).toBeUndefined();
    });

    test('activity after an hour renews the session for 24 h, keeping login time, jti and CSRF token', async () => {
        const t = now();
        const authTime = t - 5 * HOUR;
        const s = sessionToken({ iat: t - 2 * HOUR, exp: t + 22 * HOUR, authTime });
        const res = await ctx.request.get('/auth/session').set('Cookie', s.cookie);
        expect(res.status).toBe(200);
        const set = cookiesOf(res);
        expect(set.agora_session).toBeTruthy();
        const renewed = jwt.decode(set.agora_session) as any;
        expect(renewed.exp).toBeGreaterThanOrEqual(t + SESSION_IDLE_SECONDS);
        expect(renewed.exp).toBeLessThanOrEqual(now() + SESSION_IDLE_SECONDS);
        expect(renewed.authTime).toBe(authTime);
        expect(renewed.jti).toBe(s.jti);
        expect(set.agora_csrf).toBe(s.csrf);
        expect(res.headers['set-cookie'].find((c: string) => c.startsWith('agora_session='))).toMatch(/Max-Age=8640\d/);

        // The renewed cookie works with the CSRF token the page already holds
        const post = await ctx.request.post('/servers')
            .set('Cookie', `agora_session=${set.agora_session}; agora_csrf=${s.csrf}`)
            .set('X-CSRF-Token', s.csrf)
            .send({ name: 'renewed' });
        expect(post.status).toBe(201);
        // ...and still needs it
        const noCsrf = await ctx.request.post('/servers').set('Cookie', `agora_session=${set.agora_session}`).send({ name: 'x' });
        expect(noCsrf.status).toBe(403);
        expect(noCsrf.body.error).toBe('csrf_failed');
    });

    test('background (polling) requests do not renew', async () => {
        const t = now();
        const s = sessionToken({ iat: t - 2 * HOUR, exp: t + 22 * HOUR, authTime: t - 2 * HOUR });
        const res = await ctx.request.get('/auth/session').set('Cookie', s.cookie).set('X-Agora-Background', '1');
        expect(res.status).toBe(200);
        expect(res.headers['set-cookie']).toBeUndefined();
    });

    test('a Bearer token is never renewed or idle-limited', async () => {
        const t = now();
        const s = sessionToken({ iat: t - 3 * 24 * HOUR, exp: t + 4 * 24 * HOUR });
        const res = await ctx.request.get('/auth/session').set('Authorization', `Bearer ${s.token}`);
        expect(res.status).toBe(200);
        expect(res.headers['set-cookie']).toBeUndefined();
    });
});

describe('limits', () => {
    test('more than 24 h without activity ends the session', async () => {
        const t = now();
        const expired = sessionToken({ iat: t - 25 * HOUR, exp: t - HOUR, authTime: t - 25 * HOUR });
        expect((await ctx.request.get('/auth/session').set('Cookie', expired.cookie)).status).toBe(401);
        // A 7-day cookie from before this change, unused for 25 h, is idle too
        const legacy = sessionToken({ iat: t - 25 * HOUR, exp: t + 6 * 24 * HOUR });
        const res = await ctx.request.get('/auth/session').set('Cookie', legacy.cookie);
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('session_idle_timeout');
    });

    test('30 days after login the session ends, however active', async () => {
        const t = now();
        const s = sessionToken({ iat: t - 600, exp: t + 23 * HOUR, authTime: t - SESSION_MAX_SECONDS - 10 });
        const res = await ctx.request.get('/auth/session').set('Cookie', s.cookie);
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('session_expired');
    });

    test('renewal near the cap is clipped to it', async () => {
        const t = now();
        const authTime = t - SESSION_MAX_SECONDS + 3 * HOUR;
        const s = sessionToken({ iat: t - 2 * HOUR, exp: t + HOUR, authTime });
        const res = await ctx.request.get('/auth/session').set('Cookie', s.cookie);
        expect(res.status).toBe(200);
        const renewed = jwt.decode(cookiesOf(res).agora_session) as any;
        expect(renewed.exp).toBe(authTime + SESSION_MAX_SECONDS);

        // Already at the cap: nothing to renew
        const atCap = sessionToken({ iat: t - 2 * HOUR, exp: authTime + SESSION_MAX_SECONDS, authTime });
        const again = await ctx.request.get('/auth/session').set('Cookie', atCap.cookie);
        expect(again.status).toBe(200);
        expect(again.headers['set-cookie']).toBeUndefined();
    });
});

describe('revocation still applies to renewed sessions', () => {
    test('logging out with the old cookie revokes the renewed one, until the 30-day cap', async () => {
        const t = now();
        const authTime = t - 2 * HOUR;
        const s = sessionToken({ iat: authTime, exp: authTime + SESSION_IDLE_SECONDS, authTime });
        const renewedRes = await ctx.request.get('/auth/session').set('Cookie', s.cookie);
        const renewed = cookiesOf(renewedRes).agora_session;
        expect(renewed).toBeTruthy();

        expect((await ctx.request.post('/auth/logout').set('Cookie', s.cookie)).status).toBe(200);
        expect((await ctx.request.get('/auth/session').set('Cookie', `agora_session=${renewed}`)).status).toBe(401);
        const ttl = await getRedis().ttl(`token:blacklist:${s.jti}`);
        expect(ttl).toBeGreaterThan(SESSION_MAX_SECONDS - 3 * HOUR);
    });

    test('log out everywhere revokes renewed sessions', async () => {
        const t = now();
        const s = sessionToken({ iat: t - 2 * HOUR, exp: t + 22 * HOUR, authTime: t - 2 * HOUR });
        const renewed = cookiesOf(await ctx.request.get('/auth/session').set('Cookie', s.cookie)).agora_session;
        const out = await ctx.request.post('/auth/logout-all').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
        expect(out.status).toBe(200);
        expect((await ctx.request.get('/auth/session').set('Cookie', `agora_session=${renewed}`)).status).toBe(401);
        // Later sessions sign with the new token_version
        const v = (await ctx.db.query('SELECT token_version FROM users WHERE id = $1', [userId])).rows[0].token_version;
        const fresh = sessionToken({ iat: now(), exp: now() + SESSION_IDLE_SECONDS, authTime: now(), tokenVersion: v });
        expect((await ctx.request.get('/auth/session').set('Cookie', fresh.cookie)).status).toBe(200);
    });
});

describe('sockets', () => {
    async function currentVersion() {
        return (await ctx.db.query('SELECT token_version FROM users WHERE id = $1', [userId])).rows[0].token_version as number;
    }
    function connect(cookie: string) {
        const s = io(`http://localhost:${PORT}`, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: { cookie } });
        sockets.push(s);
        return s;
    }

    test('an idle session is refused at the handshake', async () => {
        const t = now();
        const s = sessionToken({ iat: t - 25 * HOUR, exp: t + 6 * 24 * HOUR, tokenVersion: await currentVersion() });
        const socket = connect(s.cookie);
        const err = await new Promise<Error>(resolve => { socket.on('connect_error', resolve); socket.connect(); });
        expect(err.message).toBe('token_expired');
    });

    test('at its deadline a socket is told to reconnect (renewable) or that the session is over (cap)', async () => {
        const t = now();
        const tokenVersion = await currentVersion();
        // Idle deadline in ~7 s, far from the cap: the client should reconnect with its current cookie
        const renewable = sessionToken({ iat: t - SESSION_IDLE_SECONDS + 7, exp: t + 7, authTime: t - HOUR, tokenVersion });
        // The 30-day cap in ~7 s: nothing left to renew
        const capped = sessionToken({ iat: t - HOUR, exp: t + 7, authTime: t - SESSION_MAX_SECONDS + 7, tokenVersion });
        const codes = await Promise.all([renewable, capped].map(s => new Promise<string>((resolve, reject) => {
            const socket = connect(s.cookie);
            socket.on('connect_error', reject);
            socket.on('error', (e: { code: string }) => resolve(e.code));
            socket.connect();
        })));
        expect(codes).toEqual(['session_renew', 'token_expired']);
    }, 15_000);
});

/**
 * beta-test-plan §6.3 Idle/cap: a real cookie login kept "alive" only by background polling
 * still ends 24 h after the last foreground request. The clock (Date only) is moved forward.
 * A current cookie's JWT expires at the idle deadline, so the refusal is `Invalid token`
 * (docs/api-reference.md); `session_idle_timeout` is what a pre-#77 7-day cookie gets.
 */
describe('beta §6.3: background polling never keeps a session alive', () => {
    afterEach(() => { vi.useRealTimers(); });

    test('polling for 24 h gets no new cookie, and the session ends at the idle deadline', async () => {
        const login = await ctx.request.post('/auth/login').set('X-Agora-Session', 'cookie').send({ login: 'idleuser', password: 'TestPass123!' });
        expect(login.status).toBe(200);
        const set = cookiesOf(login);
        const cookie = `agora_session=${set.agora_session}; agora_csrf=${set.agora_csrf}`;
        const start = Date.now();
        vi.useFakeTimers({ toFake: ['Date'] });
        for (const hours of [2, 8, 16, 23.9]) {
            vi.setSystemTime(start + hours * HOUR * 1000);
            const res = await ctx.request.get('/auth/session').set('Cookie', cookie).set('X-Agora-Background', '1');
            expect(res.status, `background poll at ${hours} h`).toBe(200);
            expect(res.headers['set-cookie'], `background poll at ${hours} h`).toBeUndefined();
        }
        vi.setSystemTime(start + (SESSION_IDLE_SECONDS + 5) * 1000);
        const after = await ctx.request.get('/auth/session').set('Cookie', cookie).set('X-Agora-Background', '1');
        expect(after.status).toBe(401);
        expect(after.body.error).toBe('Invalid token');
        // A foreground request can't revive it either
        const foreground = await ctx.request.get('/auth/session').set('Cookie', cookie);
        expect(foreground.status).toBe(401);
        expect(foreground.headers['set-cookie']).toBeUndefined();
    });
});
