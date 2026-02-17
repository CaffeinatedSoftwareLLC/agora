import { io, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';

const TEST_PORT = 4999;

// Socket helper — lives here, not in shared helpers.
// Resolves ONLY after Ready event. Ready = rooms joined (server contract).
function connectSocket(token: string): Promise<{ socket: Socket; ready: any }> {
    return new Promise((resolve, reject) => {
        const socket = io(`http://localhost:${TEST_PORT}`, {
            auth: { token },
            transports: ['websocket'],
        });

        const timeout = setTimeout(() => {
            socket.disconnect();
            reject(new Error('Socket connect + Ready timeout (2s)'));
        }, 2000);

        socket.on('Ready', (data: any) => {
            clearTimeout(timeout);
            resolve({ socket, ready: data });
        });

        socket.on('connect_error', (err: Error) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    // This is the only test file that actually listens on a port
    await ctx.app.listen({ port: TEST_PORT, host: '0.0.0.0' });
});

afterAll(async () => {
    await ctx.close();
});

describe('WebSocket Gateway', () => {
    test('member receives Message event after Ready', async () => {
        const user1 = await authedUser(ctx.request, 'ws1');
        const user2 = await authedUser(ctx.request, 'ws2');

        const { serverId, generalChannelId } = await createServer(
            ctx.request, user1.auth, 'WS Server'
        );
        await joinViaInvite(ctx.request, user1.auth, user2.auth, serverId);

        // User2 connects — resolves only after Ready (rooms joined)
        const { socket, ready } = await connectSocket(user2.token);

        expect(ready.user.id).toBe(user2.userId);
        expect(ready.servers.length).toBeGreaterThan(0);

        // Register listener BEFORE triggering the message send
        const messagePromise = new Promise<any>((resolve) => {
            socket.on('Message', resolve);
        });

        // User1 sends via REST
        await ctx.request
            .post(`/channels/${generalChannelId}/messages`)
            .set(user1.auth)
            .send({ content: 'Real-time!' });

        // User2 should receive the broadcast
        const event = await messagePromise;
        expect(event.content).toBe('Real-time!');
        expect(event.authorId).toBe(user1.userId);
        expect(event.channelId).toBe(generalChannelId);

        socket.disconnect();
    });

    test('suspended user socket receives error and disconnects', async () => {
        const admin = await authedUser(ctx.request, 'wsadmin');
        const target = await authedUser(ctx.request, 'wstarget');

        // Promote to instance admin
        await ctx.db.query(
            'UPDATE users SET is_instance_admin = true WHERE id = $1',
            [admin.userId]
        );

        // Target connects via WS
        const { socket } = await connectSocket(target.token);

        // Set up listeners before triggering suspend
        const errorPromise = new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('error event timeout (2s)')), 2000);
            socket.on('error', (data: any) => {
                clearTimeout(timeout);
                resolve(data);
            });
        });
        const disconnectPromise = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('disconnect timeout (2s)')), 2000);
            socket.on('disconnect', () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        // Admin suspends target via REST
        const res = await ctx.request
            .post(`/admin/users/${target.userId}/ban`)
            .set(admin.auth);
        expect(res.status).toBe(200);

        // Socket should receive error event and then disconnect
        const error = await errorPromise;
        expect(error.code).toBe('account_suspended');
        await disconnectPromise;
    });
});

describe('ServerJoin WS event', () => {
    test('joining user receives ServerJoin with server and channels', async () => {
        const owner = await authedUser(ctx.request, 'sjoin_owner');
        const joiner = await authedUser(ctx.request, 'sjoin_joiner');

        const { serverId } = await createServer(
            ctx.request, owner.auth, 'ServerJoin Test'
        );

        // Joiner connects via WS BEFORE joining the server
        const { socket } = await connectSocket(joiner.token);

        // Register listener for ServerJoin
        const joinPromise = new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('ServerJoin timeout (2s)')), 2000);
            socket.on('ServerJoin', (data: any) => {
                clearTimeout(timeout);
                resolve(data);
            });
        });

        // Owner creates invite, joiner uses it via REST
        const invite = await ctx.request
            .post(`/servers/${serverId}/invites`)
            .set(owner.auth)
            .send({});
        expect(invite.status).toBe(201);

        const join = await ctx.request
            .post(`/invites/${invite.body.code}`)
            .set(joiner.auth);
        expect(join.status).toBe(200);

        // Joiner should receive ServerJoin event
        const event = await joinPromise;
        expect(event.server.id).toBe(serverId);
        expect(event.server.name).toBe('ServerJoin Test');
        expect(event.server.ownerId).toBe(owner.userId);
        expect(Array.isArray(event.channels)).toBe(true);
        expect(event.channels.length).toBeGreaterThan(0);
        expect(event.channels[0].name).toBe('general');
        expect(event.channels[0].serverId).toBe(serverId);

        socket.disconnect();
    });

    test('joiner receives channel messages immediately after ServerJoin (room-join-before-emit)', async () => {
        const owner = await authedUser(ctx.request, 'sjoin_race_owner');
        const joiner = await authedUser(ctx.request, 'sjoin_race_joiner');

        const { serverId, generalChannelId } = await createServer(
            ctx.request, owner.auth, 'RaceWindow Test'
        );

        // Joiner connects via WS BEFORE joining the server
        const { socket } = await connectSocket(joiner.token);

        // Listen for ServerJoin, then IMMEDIATELY send a message to the channel
        // and verify the joiner's socket receives it. If rooms were joined after
        // emit (old behavior), this message could be missed.
        const messagePromise = new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Message timeout (2s) — room join likely happened after emit')), 2000);
            socket.on('Message', (data: any) => {
                clearTimeout(timeout);
                resolve(data);
            });
        });

        const joinPromise = new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('ServerJoin timeout (2s)')), 2000);
            socket.on('ServerJoin', (data: any) => {
                clearTimeout(timeout);
                resolve(data);
            });
        });

        // Owner creates invite, joiner accepts
        const invite = await ctx.request
            .post(`/servers/${serverId}/invites`)
            .set(owner.auth)
            .send({});

        const join = await ctx.request
            .post(`/invites/${invite.body.code}`)
            .set(joiner.auth);
        expect(join.status).toBe(200);

        // Wait for ServerJoin to confirm the flow completed
        await joinPromise;

        // Owner sends a message right after — joiner must already be in the channel room
        await ctx.request
            .post(`/channels/${generalChannelId}/messages`)
            .set(owner.auth)
            .send({ content: 'Post-join immediate message' });

        const msg = await messagePromise;
        expect(msg.content).toBe('Post-join immediate message');
        expect(msg.channelId).toBe(generalChannelId);

        socket.disconnect();
    });

    test('already-member does not receive ServerJoin on re-invite', async () => {
        const owner = await authedUser(ctx.request, 'sjoin_owner2');
        const member = await authedUser(ctx.request, 'sjoin_member2');

        const { serverId } = await createServer(
            ctx.request, owner.auth, 'ServerJoin NoDupe'
        );

        // Join via invite first
        await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);

        // Member connects via WS (already a member)
        const { socket } = await connectSocket(member.token);

        let received = false;
        socket.on('ServerJoin', () => { received = true; });

        // Try to join again via a new invite
        const invite = await ctx.request
            .post(`/servers/${serverId}/invites`)
            .set(owner.auth)
            .send({});

        await ctx.request
            .post(`/invites/${invite.body.code}`)
            .set(member.auth);

        // Wait a bit, should NOT receive ServerJoin
        await new Promise((r) => setTimeout(r, 300));
        expect(received).toBe(false);

        socket.disconnect();
    });
});
