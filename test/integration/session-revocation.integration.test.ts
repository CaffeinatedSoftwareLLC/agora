import { io, Socket } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let user: Awaited<ReturnType<typeof authedUser>>;
const sockets: Socket[] = [];
function event(socket: Socket, name: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing ${name}`)), 4000);
        socket.once(name, data => { clearTimeout(timer); resolve(data); });
    });
}
function socketFor(token: string, bot = false) {
    const socket = io('http://localhost:4999', { transports: ['websocket'], auth: { token, ...(bot ? { type: 'bot' } : {}) }, autoConnect: false, reconnection: false });
    sockets.push(socket);
    return socket;
}
async function connect(token: string, bot = false) {
    const socket = socketFor(token, bot);
    const ready = event(socket, bot ? 'BotReady' : 'Ready');
    socket.connect();
    await ready;
    return socket;
}
async function rejected(token: string) {
    const socket = socketFor(token);
    const error = event(socket, 'connect_error');
    socket.connect();
    return (await error).message;
}
async function login() {
    const res = await ctx.request.post('/auth/login').send({ login: 'sessionuser', password: 'TestPass123!' });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
}
beforeAll(async () => {
    ctx = await setupTestApp();
    await ctx.app.listen({ host: '127.0.0.1', port: 4999 });
});
beforeEach(async () => {
    await cleanDatabase(ctx.db);
    user = await authedUser(ctx.request, 'sessionuser');
});
afterEach(() => { for (const socket of sockets.splice(0)) socket.disconnect(); });
afterAll(async () => { await ctx.close(); });

test('logout-all revokes every token and open socket for this account, preserving other accounts', async () => {
    const second = await login();
    const other = await authedUser(ctx.request, 'sessionother');
    const a = await connect(user.token);
    const b = await connect(second);
    const c = await connect(other.token);
    const goneA = event(a, 'disconnect');
    const goneB = event(b, 'disconnect');
    expect((await ctx.request.post('/auth/logout-all').set(user.auth)).status).toBe(200);
    await Promise.all([goneA, goneB]);
    expect(c.connected).toBe(true);
    for (const token of [user.token, second]) {
        expect((await ctx.request.get('/users/search?q=ses').set('Authorization', `Bearer ${token}`)).status).toBe(401);
        expect(await rejected(token)).toBe('Token revoked');
    }
    expect((await ctx.request.get('/users/search?q=ses').set(other.auth)).status).toBe(200);
    const fresh = await login();
    expect((jwt.decode(fresh) as any).tokenVersion).toBe(1);
    expect((await ctx.request.get('/users/search?q=ses').set('Authorization', `Bearer ${fresh}`)).status).toBe(200);
    await connect(fresh);
});

test('logout disconnects only sockets using that token', async () => {
    const second = await login();
    const a = await connect(user.token);
    const b = await connect(second);
    const gone = event(a, 'disconnect');
    expect((await ctx.request.post('/auth/logout').set(user.auth)).status).toBe(200);
    await gone;
    expect(b.connected).toBe(true);
    expect(await rejected(user.token)).toBe('Token revoked');
    expect((await ctx.request.get('/users/search?q=ses').set('Authorization', `Bearer ${second}`)).status).toBe(200);
});

test('logout-all requires a valid current human token', async () => {
    expect((await ctx.request.post('/auth/logout-all')).status).toBe(401);
    expect((await ctx.request.post('/auth/logout-all').set('Authorization', 'Bearer invalid')).status).toBe(401);
    expect((await ctx.request.post('/auth/logout-all').set(user.auth)).status).toBe(200);
    expect((await ctx.request.post('/auth/logout-all').set(user.auth)).status).toBe(401);
    expect((await ctx.db.query('SELECT token_version FROM users WHERE id=$1', [user.userId])).rows[0].token_version).toBe(1);
});

test('legacy tokens without a version work at zero and are revoked by logout-all', async () => {
    const legacy = jwt.sign({ userId: user.userId, jti: 'legacy-session' }, ctx.app.jwtSecret, { expiresIn: '1h' });
    expect((await ctx.request.get('/users/search?q=ses').set('Authorization', `Bearer ${legacy}`)).status).toBe(200);
    const socket = await connect(legacy);
    const gone = event(socket, 'disconnect');
    expect((await ctx.request.post('/auth/logout-all').set(user.auth)).status).toBe(200);
    await gone;
    expect((await ctx.request.get('/users/search?q=ses').set('Authorization', `Bearer ${legacy}`)).status).toBe(401);
    expect(await rejected(legacy)).toBe('Token revoked');
});

test('an already-open socket expires with its JWT', async () => {
    const token = jwt.sign({ userId: user.userId, tokenVersion: 0, jti: 'short-session' }, ctx.app.jwtSecret, { expiresIn: 2 });
    const socket = await connect(token);
    const gone = event(socket, 'disconnect');
    const error = event(socket, 'error');
    expect((await error).code).toBe('token_expired');
    await gone;
});

test('bot-token revocation disconnects only sockets using that bot token', async () => {
    const server = await createServer(ctx.request, user.auth, 'Session bots');
    const bot = await ctx.request.post(`/servers/${server.serverId}/bots`).set(user.auth).send({ username: 'sessionbot' });
    const endpoint = `/servers/${server.serverId}/bots/${bot.body.id}/tokens`;
    const first = await ctx.request.post(endpoint).set(user.auth).send({});
    const second = await ctx.request.post(endpoint).set(user.auth).send({});
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const a = await connect(first.body.token, true);
    const b = await connect(second.body.token, true);
    const gone = event(a, 'disconnect');
    expect((await ctx.request.delete(`${endpoint}/${first.body.tokenId}`).set(user.auth)).status).toBe(200);
    await gone;
    expect(b.connected).toBe(true);
    expect((await ctx.request.post('/auth/logout-all').set('Authorization', `Bot ${second.body.token}`)).status).toBe(403);
});
