process.env.AGORA_SETUP_TOKEN = 'test-setup-token-that-is-at-least-32chars!';

import { io, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { resetInitializedCache } from '../../src/instance/check-initialized';

// Browser sessions in an httpOnly cookie with a session-bound CSRF token (#77)
let ctx: Awaited<ReturnType<typeof setupTestApp>>;
const sockets: Socket[] = [];
const PORT = 4999;
const COOKIE_MODE = { 'X-Agora-Session': 'cookie' };

interface Session { cookie: string; csrf: string; setCookies: string[] }

function sessionFrom(res: { headers: Record<string, any> }): Session {
    const setCookies: string[] = res.headers['set-cookie'] ?? [];
    const value = (name: string) => {
        const line = setCookies.find(c => c.startsWith(`${name}=`));
        return line ? line.split(';')[0].slice(name.length + 1) : '';
    };
    const session = value('agora_session');
    const csrf = value('agora_csrf');
    return { cookie: `agora_session=${session}; agora_csrf=${csrf}`, csrf, setCookies };
}

async function cookieLogin(login = 'cookieuser'): Promise<Session> {
    const res = await ctx.request.post('/auth/login').set(COOKIE_MODE).send({ login, password: 'TestPass123!' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeUndefined();
    return sessionFrom(res);
}

function event(socket: Socket, name: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing ${name}`)), 4000);
        socket.once(name, data => { clearTimeout(timer); resolve(data); });
    });
}

function cookieSocket(cookie: string, origin?: string) {
    const socket = io(`http://localhost:${PORT}`, {
        transports: ['websocket'], autoConnect: false, reconnection: false,
        extraHeaders: { cookie, ...(origin ? { origin } : {}) },
    });
    sockets.push(socket);
    return socket;
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await ctx.app.listen({ host: '127.0.0.1', port: PORT });
});
beforeEach(async () => {
    await cleanDatabase(ctx.db);
    await authedUser(ctx.request, 'cookieuser');
});
afterEach(() => { for (const s of sockets.splice(0)) s.disconnect(); });
afterAll(async () => { await ctx.close(); });

test('cookie login sets an httpOnly Secure SameSite=Strict session and a readable CSRF cookie', async () => {
    const { setCookies } = await cookieLogin();
    const session = setCookies.find(c => c.startsWith('agora_session='))!;
    const csrf = setCookies.find(c => c.startsWith('agora_csrf='))!;
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/SameSite=Strict/);
    expect(session).toMatch(/Path=\//);
    expect(session).toMatch(/Max-Age=86400/); // 24 h idle window (renewed on activity)
    expect(csrf).not.toMatch(/HttpOnly/);
    expect(csrf).toMatch(/Secure/);
    expect(csrf).toMatch(/SameSite=Strict/);
});

test('without the session-mode header, login still returns a bearer token and sets no cookie', async () => {
    const res = await ctx.request.post('/auth/login').send({ login: 'cookieuser', password: 'TestPass123!' });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await ctx.request.get('/auth/session').set({ Authorization: `Bearer ${res.body.accessToken}` })).status).toBe(200);
});

test('reads work with the cookie alone; writes need the matching CSRF token', async () => {
    const s = await cookieLogin();
    const me = await ctx.request.get('/auth/session').set('Cookie', s.cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('cookieuser');

    const noCsrf = await ctx.request.post('/servers').set('Cookie', s.cookie).send({ name: 'x' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error).toBe('csrf_failed');

    const wrong = await ctx.request.post('/servers').set('Cookie', s.cookie).set('X-CSRF-Token', 'nope').send({ name: 'x' });
    expect(wrong.status).toBe(403);

    // Another session's CSRF token does not fit this session
    const other = await cookieLogin();
    const crossed = await ctx.request.post('/servers').set('Cookie', s.cookie).set('X-CSRF-Token', other.csrf).send({ name: 'x' });
    expect(crossed.status).toBe(403);

    const ok = await ctx.request.post('/servers').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send({ name: 'x' });
    expect(ok.status).toBe(201);
});

// beta-test-plan §6.3 CSRF: every unsafe method, every bad token, and nothing changes
test('POST, PUT, PATCH and DELETE with a cookie need this session\'s CSRF token: 403 csrf_failed and nothing changes', async () => {
    const s = await cookieLogin();
    const other = await cookieLogin();
    const ok = (req: any) => req.set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
    const server = await ok(ctx.request.post('/servers')).send({ name: 'csrf' });
    expect(server.status).toBe(201);
    const channels = await ctx.request.get(`/servers/${server.body.id}/channels`).set('Cookie', s.cookie);
    const channelId = channels.body[0].id;
    const msg = await ok(ctx.request.post(`/channels/${channelId}/messages`)).send({ content: 'original' });
    expect(msg.status).toBe(201);
    const counts = async () => (await ctx.db.query(`SELECT
        (SELECT count(*)::int FROM servers) AS servers,
        (SELECT count(*)::int FROM messages WHERE channel_id = $1 AND deleted_at IS NULL) AS messages`, [channelId])).rows[0];
    const before = await counts();

    const attempts: Array<[string, () => any]> = [
        ['POST', () => ctx.request.post('/servers').send({ name: 'forged' })],
        ['POST', () => ctx.request.post(`/channels/${channelId}/messages`).send({ content: 'forged' })],
        ['PUT', () => ctx.request.put(`/channels/${channelId}/project`).send({ instructions: 'forged' })],
        ['PATCH', () => ctx.request.patch(`/channels/${channelId}/messages/${msg.body.id}`).send({ content: 'forged' })],
        ['DELETE', () => ctx.request.delete(`/channels/${channelId}/messages/${msg.body.id}`)],
    ];
    const tokens: Array<[string, string | null]> = [['none', null], ['wrong', 'nope'], ['other session', other.csrf], ['empty', '']];
    for (const [method, make] of attempts) {
        for (const [label, token] of tokens) {
            let req = make().set('Cookie', s.cookie);
            if (token !== null) req = req.set('X-CSRF-Token', token);
            const res = await req;
            expect(res.status, `${method} with ${label} token`).toBe(403);
            expect(res.body.error, `${method} with ${label} token`).toBe('csrf_failed');
        }
    }
    expect(await counts()).toEqual(before);
    const kept = await ctx.db.query('SELECT content, edited_at FROM messages WHERE id = $1', [msg.body.id]);
    expect(kept.rows[0]).toMatchObject({ content: 'original', edited_at: null });
    const project = await ctx.request.get(`/channels/${channelId}/project`).set('Cookie', s.cookie);
    expect(JSON.stringify(project.body)).not.toContain('forged');

    // The same calls with this session's token go through
    expect((await ok(ctx.request.patch(`/channels/${channelId}/messages/${msg.body.id}`)).send({ content: 'edited' })).status).toBe(200);
    expect((await ok(ctx.request.put(`/channels/${channelId}/project`)).send({ instructions: 'real' })).status).toBe(200);
    expect([200, 204]).toContain((await ok(ctx.request.delete(`/channels/${channelId}/messages/${msg.body.id}`))).status);
});

test('a planted CSRF cookie with a matching header does not pass (the token is bound to the session)', async () => {
    const s = await cookieLogin();
    const session = s.cookie.split(';')[0];
    const res = await ctx.request.post('/servers')
        .set('Cookie', `${session}; agora_csrf=attacker`).set('X-CSRF-Token', 'attacker').send({ name: 'x' });
    expect(res.status).toBe(403);
});

test('an Authorization header takes precedence and needs no CSRF token', async () => {
    const res = await ctx.request.post('/auth/login').send({ login: 'cookieuser', password: 'TestPass123!' });
    const s = await cookieLogin();
    const created = await ctx.request.post('/servers')
        .set('Cookie', s.cookie).set({ Authorization: `Bearer ${res.body.accessToken}` }).send({ name: 'x' });
    expect(created.status).toBe(201);
});

test('logout revokes the cookie session and clears both cookies', async () => {
    const s = await cookieLogin();
    const out = await ctx.request.post('/auth/logout').set('Cookie', s.cookie);
    expect(out.status).toBe(200);
    const cleared: string[] = out.headers['set-cookie'];
    expect(cleared.some(c => c.startsWith('agora_session=;') && /Max-Age=0/.test(c))).toBe(true);
    expect(cleared.some(c => c.startsWith('agora_csrf=;') && /Max-Age=0/.test(c))).toBe(true);
    const after = await ctx.request.get('/auth/session').set('Cookie', s.cookie);
    expect(after.status).toBe(401);
});

test('logout-all from a cookie session needs CSRF and revokes every session', async () => {
    const s = await cookieLogin();
    const bearer = (await ctx.request.post('/auth/login').send({ login: 'cookieuser', password: 'TestPass123!' })).body.accessToken;
    expect((await ctx.request.post('/auth/logout-all').set('Cookie', s.cookie)).status).toBe(403);
    const out = await ctx.request.post('/auth/logout-all').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
    expect(out.status).toBe(200);
    expect(out.headers['set-cookie'].some((c: string) => c.startsWith('agora_session=;'))).toBe(true);
    expect((await ctx.request.get('/auth/session').set('Cookie', s.cookie)).status).toBe(401);
    expect((await ctx.request.get('/auth/session').set({ Authorization: `Bearer ${bearer}` })).status).toBe(401);
});

test('register in cookie mode sets the session cookie and returns no token', async () => {
    const res = await ctx.request.post('/auth/register').set(COOKIE_MODE)
        .send({ username: 'cookienew', email: 'cookienew@test.com', password: 'TestPass123!' });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeUndefined();
    const s = sessionFrom(res);
    expect((await ctx.request.get('/auth/session').set('Cookie', s.cookie)).body.user.username).toBe('cookienew');
});

test('Socket.IO authenticates with the session cookie', async () => {
    const s = await cookieLogin();
    const socket = cookieSocket(s.cookie, `http://localhost:${PORT}`);
    const ready = event(socket, 'Ready');
    socket.connect();
    const data = await ready;
    expect(data.user.username).toBe('cookieuser');
});

test('Socket.IO rejects a cookie handshake from a foreign origin', async () => {
    const s = await cookieLogin();
    const socket = cookieSocket(s.cookie, 'https://evil.example');
    const err = event(socket, 'connect_error');
    socket.connect();
    expect((await err).message).toBe('Origin not allowed');
});

test('Socket.IO rejects a revoked cookie session', async () => {
    const s = await cookieLogin();
    await ctx.request.post('/auth/logout').set('Cookie', s.cookie);
    const socket = cookieSocket(s.cookie);
    const err = event(socket, 'connect_error');
    socket.connect();
    expect((await err).message).toBe('Token revoked');
});

test('bots keep using Authorization headers; a bot token is not accepted as a cookie', async () => {
    const owner = await authedUser(ctx.request, 'cookieowner');
    const { serverId } = await createServer(ctx.request, owner.auth, 'cookie-srv');
    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'cookiebot' });
    expect(bot.status).toBe(201);
    const tok = await ctx.request.post(`/servers/${serverId}/bots/${bot.body.id}/tokens`).set(owner.auth).send({});
    expect(tok.status).toBe(201);
    expect((await ctx.request.get('/bots/@me').set({ Authorization: `Bot ${tok.body.token}` })).status).toBe(200);
    expect((await ctx.request.get('/bots/@me').set('Cookie', `agora_session=${tok.body.token}`)).status).toBe(401);
});

test('instance setup in cookie mode signs the admin in with a cookie', async () => {
    await cleanDatabase(ctx.db);
    await ctx.db.query("UPDATE instance_config SET value = 'false' WHERE key = 'setup_complete'");
    resetInitializedCache();
    const res = await ctx.request.post('/instance/setup').set(COOKIE_MODE).send({
        setupToken: process.env.AGORA_SETUP_TOKEN, username: 'cookieadmin', email: 'cookieadmin@test.com',
        password: 'TestPass123!', instanceName: 'Agora',
    });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeUndefined();
    const s = sessionFrom(res);
    const me = await ctx.request.get('/auth/session').set('Cookie', s.cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.isInstanceAdmin).toBe(true);
});
