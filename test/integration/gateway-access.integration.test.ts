import { io, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { Permissions } from '../../src/permissions';
import { refreshGatewayAccess } from '../../src/lib/gateway-access';
import { writeGatewayAccess } from '../../src/lib/gateway-gate';
import { tripBot } from '../../src/runtime/tripwires';
import { generateUlid } from '../../src/utils/ulid';
import { publishEvents } from '../../src/lib/event-bridge';
import { getRedis } from '../../src/auth/token-blacklist';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let server: Awaited<ReturnType<typeof createServer>>;
const sockets: Socket[] = [];

function event(socket: Socket, name: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing ${name}`)), 2500);
        socket.once(name, value => { clearTimeout(timer); resolve(value); });
    });
}
function connect(token: string, bot = false) {
    const socket = io('http://localhost:4999', { transports: ['websocket'], auth: { token, ...(bot ? { type: 'bot' } : {}) }, reconnection: false, autoConnect: false });
    sockets.push(socket);
    return socket;
}
async function ready(token: string, bot = false) {
    const socket = connect(token, bot);
    const result = event(socket, bot ? 'BotReady' : 'Ready');
    socket.connect();
    return { socket, data: await result };
}
async function deny() {
    const res = await ctx.request.put(`/channels/${server.generalChannelId}/overrides/members/${member.userId}`)
        .set(owner.auth).send({ allow: '0', deny: Permissions.ViewChannel.toString() });
    expect(res.status).toBe(200);
}
async function bot() {
    const created = await ctx.request.post(`/servers/${server.serverId}/bots`).set(owner.auth).send({ username: 'gatewaybot' });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const token = await ctx.request.post(`/servers/${server.serverId}/bots/${id}/tokens`).set(owner.auth).send({});
    expect(token.status).toBe(201);
    expect((await ctx.request.post(`/channels/${server.generalChannelId}/bots/${id}`).set(owner.auth)).status).toBe(201);
    return { id, token: token.body.token };
}
beforeAll(async () => {
    ctx = await setupTestApp();
    await ctx.app.listen({ port: 4999, host: '127.0.0.1' });
});
beforeEach(async () => {
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'gatewayowner');
    member = await authedUser(ctx.request, 'gatewaymember');
    server = await createServer(ctx.request, owner.auth, 'Gateway');
    await joinViaInvite(ctx.request, owner.auth, member.auth, server.serverId);
});
afterEach(() => { for (const socket of sockets.splice(0)) socket.disconnect(); });
afterAll(async () => { await ctx.close(); });

test('Ready excludes denied channels and unread metadata, and the socket never joins the room', async () => {
    await deny();
    await ctx.db.query('INSERT INTO channel_unreads (channel_id,user_id,mention_count) VALUES ($1,$2,1)', [server.generalChannelId, member.userId]);
    const { socket, data } = await ready(member.token);
    expect(data.channels).toEqual([]);
    expect(data.unreads).toEqual([]);
    expect(ctx.app.io.sockets.sockets.get(socket.id!)!.rooms.has(`channel:${server.generalChannelId}`)).toBe(false);
    const ownerReady = await ready(owner.token);
    expect(ownerReady.data.channels.map((c: any) => c.id)).toContain(server.generalChannelId);
});

test('member override revokes an existing socket before the HTTP success', async () => {
    const { socket } = await ready(member.token);
    const disconnected = event(socket, 'disconnect');
    await deny();
    await disconnected;
    expect(ctx.app.io.sockets.sockets.size).toBe(0);
});

test('failed override mutation does not disconnect sockets', async () => {
    const { socket } = await ready(member.token);
    const res = await ctx.request.put(`/channels/${server.generalChannelId}/overrides/members/${owner.userId}`)
        .set(member.auth).send({ allow: '0', deny: Permissions.ViewChannel.toString() });
    expect(res.status).toBe(403);
    expect(socket.connected).toBe(true);
});

test('role permission change evicts a member who loses ViewChannel', async () => {
    const { socket } = await ready(member.token);
    const disconnected = event(socket, 'disconnect');
    const res = await ctx.request.patch(`/servers/${server.serverId}/roles/${server.everyoneRoleId}`).set(owner.auth).send({ permissions: '0' });
    expect(res.status).toBe(200);
    await disconnected;
});

test('membership removal is detected by the shared refresh helper', async () => {
    const { socket } = await ready(member.token);
    const disconnected = event(socket, 'disconnect');
    // No server kick/leave API exists yet; exercise the same committed-state helper.
    await ctx.db.query('DELETE FROM server_members WHERE server_id=$1 AND user_id=$2', [server.serverId, member.userId]);
    await refreshGatewayAccess(ctx.app.io, ctx.db);
    await disconnected;
});

test('paused bot is disconnected and cannot reconnect', async () => {
    const b = await bot();
    const { socket } = await ready(b.token, true);
    const disconnected = event(socket, 'disconnect');
    expect((await ctx.request.patch(`/servers/${server.serverId}/bots/${b.id}/pause`).set(owner.auth).send({ paused: true })).status).toBe(200);
    await disconnected;
    const retry = connect(b.token, true);
    const rejected = event(retry, 'connect_error');
    retry.connect();
    expect((await rejected).message).toBe('bot_paused');
});

// Extra check (beta security pass): deleting a bot must cut its live socket off
test('deleting a bot disconnects its live socket and it receives no later messages', async () => {
    const b = await bot();
    const { socket } = await ready(b.token, true);
    const ownerSide = await ready(owner.token);
    const received: any[] = [];
    socket.on('Message', m => received.push(m));
    let dropped = false;
    socket.on('disconnect', () => { dropped = true; });
    expect((await ctx.request.delete(`/servers/${server.serverId}/bots/${b.id}`).set(owner.auth)).status).toBe(200);
    const seen = event(ownerSide.socket, 'Message');
    expect((await ctx.request.post(`/channels/${server.generalChannelId}/messages`).set(owner.auth).send({ content: 'after the bot was deleted' })).status).toBe(201);
    expect((await seen).content).toBe('after the bot was deleted');
    await new Promise(r => setTimeout(r, 300));
    expect(received.map(m => m.content)).toEqual([]);
    expect(dropped).toBe(true);
    const retry = connect(b.token, true);
    const rejected = event(retry, 'connect_error');
    retry.connect();
    expect((await rejected).message).toBeTruthy();
});

test('bot allowlist removal disconnects a live bot', async () => {
    const b = await bot();
    const { socket } = await ready(b.token, true);
    const disconnected = event(socket, 'disconnect');
    expect((await ctx.request.delete(`/channels/${server.generalChannelId}/bots/${b.id}`).set(owner.auth)).status).toBe(200);
    await disconnected;
});

test('suspending a bot owner disconnects the bot, revokes its token and blocks reconnect', async () => {
    const b = await bot();
    const { socket } = await ready(b.token, true);
    const admin = await authedUser(ctx.request, 'gatewayadmin');
    await ctx.db.query('UPDATE users SET is_instance_admin=true WHERE id=$1', [admin.userId]);
    const disconnected = event(socket, 'disconnect');
    expect((await ctx.request.post(`/admin/users/${owner.userId}/ban`).set(admin.auth)).status).toBe(200);
    await disconnected;
    // The ban revokes the owner's bot tokens, so the old token is now simply invalid
    const retry = connect(b.token, true);
    const rejected = event(retry, 'connect_error');
    retry.connect();
    expect((await rejected).message).toBe('Invalid bot token');
});

test('a bot whose owner is suspended cannot connect with a live token', async () => {
    const b = await bot();
    await ctx.db.query(`UPDATE users SET account_status = 'suspended' WHERE id = $1`, [owner.userId]);
    const retry = connect(b.token, true);
    const rejected = event(retry, 'connect_error');
    retry.connect();
    expect((await rejected).message).toBe('bot_owner_inactive');
});

test('ServerJoin excludes hidden channels for a previously connected user', async () => {
    const outsider = await authedUser(ctx.request, 'gatewayoutsider');
    expect((await ctx.request.put(`/channels/${server.generalChannelId}/overrides/roles/${server.everyoneRoleId}`).set(owner.auth)
        .send({ allow: '0', deny: Permissions.ViewChannel.toString() })).status).toBe(200);
    const { socket } = await ready(outsider.token);
    const joined = event(socket, 'ServerJoin');
    await joinViaInvite(ctx.request, owner.auth, outsider.auth, server.serverId);
    expect((await joined).channels).toEqual([]);
    expect(ctx.app.io.sockets.sockets.get(socket.id!)!.rooms.has(`channel:${server.generalChannelId}`)).toBe(false);
});

test('Typing cannot target an unauthorized channel or crash on a non-string ID', async () => {
    await deny();
    const observer = await ready(owner.token);
    const sender = await ready(member.token);
    const received: unknown[] = [];
    observer.socket.on('Typing', data => received.push(data));
    sender.socket.emit('Typing', { channelId: 42 });
    sender.socket.emit('Typing', { channelId: server.generalChannelId });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(received).toEqual([]);
    expect(sender.socket.connected).toBe(true);
});

test('tripwire events disconnect a paused bot through the real Redis bridge', async () => {
    const b = await bot();
    const { socket } = await ready(b.token, true);
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO exec_runs (id,server_id,channel_id,submitted_by,code,code_sha256,limits,gate_decision,status)
         VALUES ($1,$2,$3,$4,'x',$5,'{}','auto_run','queued')`,
        [id, server.serverId, server.generalChannelId, b.id, 'a'.repeat(64)]);
    const disconnected = event(socket, 'disconnect');
    const result = await tripBot(ctx.db, id, 'token_misuse');
    expect(result.paused).toBe(true);
    await publishEvents(getRedis(), result.events);
    await disconnected;
});

test('broadcasts wait for revocation and resolve recipients after eviction', async () => {
    const viewer = await ready(member.token);
    const observer = await ready(owner.token);
    const received: unknown[] = [];
    viewer.socket.on('AccessGateProbe', data => received.push(data));
    const delivered = event(observer.socket, 'AccessGateProbe');
    const disconnected = event(viewer.socket, 'disconnect');
    await writeGatewayAccess(ctx.app.io, async () => {
        ctx.app.io.to(`channel:${server.generalChannelId}`).emit('AccessGateProbe', { secret: true });
        await ctx.db.query('DELETE FROM server_members WHERE server_id=$1 AND user_id=$2', [server.serverId, member.userId]);
        await refreshGatewayAccess(ctx.app.io, ctx.db);
    });
    expect(await delivered).toEqual({ secret: true });
    await disconnected;
    expect(received).toEqual([]);
});
