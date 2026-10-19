import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';

// Cookie sessions (#94) meet agent invites (#95): creating an invite is a
// cookie-authenticated write and needs the CSRF token; redeeming is
// unauthenticated and must not be blocked by CSRF, even with a cookie present.
let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let botId: string;
const COOKIE_MODE = { 'X-Agora-Session': 'cookie' };

interface Session { cookie: string; csrf: string }

async function cookieLogin(login: string): Promise<Session> {
    const res = await ctx.request.post('/auth/login').set(COOKIE_MODE).send({ login, password: 'TestPass123!' });
    expect(res.status).toBe(200);
    const setCookies: string[] = res.headers['set-cookie'] ?? [];
    const value = (name: string) => {
        const line = setCookies.find(c => c.startsWith(`${name}=`));
        return line ? line.split(';')[0].slice(name.length + 1) : '';
    };
    const csrf = value('agora_csrf');
    expect(csrf).not.toBe('');
    return { cookie: `agora_session=${value('agora_session')}; agora_csrf=${csrf}`, csrf };
}

const createInvite = (s: Session, csrf?: string) => {
    const req = ctx.request.post(`/servers/${serverId}/agent-invites`).set('Cookie', s.cookie);
    if (csrf !== undefined) req.set('X-CSRF-Token', csrf);
    return req.send({ botId });
};

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'cookie-invite-owner');
    ({ serverId } = await createServer(ctx.request, owner.auth, 'Cookie Invites'));
    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'cookie-invite-bot' });
    expect(bot.status).toBe(201);
    botId = bot.body.id;
});
afterAll(async () => { await ctx.close(); });

test('cookie-authenticated invite creation requires the matching CSRF token', async () => {
    const s = await cookieLogin('cookie-invite-owner');

    const noCsrf = await createInvite(s);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error).toBe('csrf_failed');

    const wrong = await createInvite(s, 'not-the-token');
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe('csrf_failed');

    const ok = await createInvite(s, s.csrf);
    expect(ok.status).toBe(201);
    expect(ok.body.code).toMatch(/^[a-f0-9]{64}$/);
});

test('redeem succeeds without any cookie', async () => {
    const s = await cookieLogin('cookie-invite-owner');
    const invite = await createInvite(s, s.csrf);
    expect(invite.status).toBe(201);

    const res = await ctx.request.post('/agent-invites/redeem').send({ code: invite.body.code });
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^bot_/);
});

test('redeem succeeds with a browser session cookie and no CSRF token', async () => {
    const s = await cookieLogin('cookie-invite-owner');
    const invite = await createInvite(s, s.csrf);
    expect(invite.status).toBe(201);

    const res = await ctx.request.post('/agent-invites/redeem').set('Cookie', s.cookie).send({ code: invite.body.code });
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^bot_/);
});
