import { io as ioClient, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';

const TEST_PORT = 4998; // Different port from websocket.integration.test.ts

function connectSocket(token: string): Promise<{ socket: Socket; ready: any }> {
    return new Promise((resolve, reject) => {
        const socket = ioClient(`http://localhost:${TEST_PORT}`, {
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
    await ctx.app.listen({ port: TEST_PORT, host: '0.0.0.0' });
});

afterAll(async () => {
    await ctx.close();
});

describe('Typing events', () => {
    test('typing event is broadcast to other channel members', async () => {
        const user1 = await authedUser(ctx.request, 'typ1');
        const user2 = await authedUser(ctx.request, 'typ2');

        const { serverId, generalChannelId } = await createServer(
            ctx.request, user1.auth, 'Typing Server'
        );
        await joinViaInvite(ctx.request, user1.auth, user2.auth, serverId);

        const { socket: socket1 } = await connectSocket(user1.token);
        const { socket: socket2 } = await connectSocket(user2.token);

        // User2 listens for Typing events
        const typingPromise = new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Typing timeout (2s)')), 2000);
            socket2.on('Typing', (data: any) => {
                clearTimeout(timeout);
                resolve(data);
            });
        });

        // User1 emits Typing
        socket1.emit('Typing', { channelId: generalChannelId });

        const event = await typingPromise;
        expect(event.channelId).toBe(generalChannelId);
        expect(event.userId).toBe(user1.userId);
        expect(event.username).toBe('typ1');

        socket1.disconnect();
        socket2.disconnect();
    });

    test('sender does not receive their own Typing event', async () => {
        const user1 = await authedUser(ctx.request, 'typself');
        const { generalChannelId } = await createServer(
            ctx.request, user1.auth, 'Typing Self Server'
        );

        const { socket: socket1 } = await connectSocket(user1.token);

        let received = false;
        socket1.on('Typing', () => { received = true; });

        socket1.emit('Typing', { channelId: generalChannelId });

        // Wait a bit — should NOT receive own typing
        await new Promise((r) => setTimeout(r, 300));
        expect(received).toBe(false);

        socket1.disconnect();
    });
});

describe('Presence events', () => {
    test('user connect broadcasts PresenceUpdate online to co-members', async () => {
        const user1 = await authedUser(ctx.request, 'pres1');
        const user2 = await authedUser(ctx.request, 'pres2');

        const { serverId } = await createServer(
            ctx.request, user1.auth, 'Presence Server'
        );
        await joinViaInvite(ctx.request, user1.auth, user2.auth, serverId);

        // User1 connects first
        const { socket: socket1 } = await connectSocket(user1.token);

        // Set up listener for PresenceUpdate on user1's socket
        const presencePromise = new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('PresenceUpdate timeout (2s)')), 2000);
            socket1.on('PresenceUpdate', (data: any) => {
                if (data.userId === user2.userId && data.status === 'online') {
                    clearTimeout(timeout);
                    resolve(data);
                }
            });
        });

        // User2 connects — should trigger PresenceUpdate
        const { socket: socket2 } = await connectSocket(user2.token);

        const event = await presencePromise;
        expect(event.userId).toBe(user2.userId);
        expect(event.status).toBe('online');

        socket1.disconnect();
        socket2.disconnect();
    });

    test('user disconnect broadcasts PresenceUpdate offline to co-members', async () => {
        const user1 = await authedUser(ctx.request, 'presoff1');
        const user2 = await authedUser(ctx.request, 'presoff2');

        const { serverId } = await createServer(
            ctx.request, user1.auth, 'Presence Offline Server'
        );
        await joinViaInvite(ctx.request, user1.auth, user2.auth, serverId);

        const { socket: socket1 } = await connectSocket(user1.token);
        const { socket: socket2 } = await connectSocket(user2.token);

        // Set up listener for offline PresenceUpdate
        const offlinePromise = new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Offline PresenceUpdate timeout (2s)')), 2000);
            socket1.on('PresenceUpdate', (data: any) => {
                if (data.userId === user2.userId && data.status === 'offline') {
                    clearTimeout(timeout);
                    resolve(data);
                }
            });
        });

        // User2 disconnects
        socket2.disconnect();

        const event = await offlinePromise;
        expect(event.userId).toBe(user2.userId);
        expect(event.status).toBe('offline');

        socket1.disconnect();
    });
});

describe('Ready unreads', () => {
    test('Ready payload includes unreads array', async () => {
        const user = await authedUser(ctx.request, 'readyunread');
        const { generalChannelId } = await createServer(
            ctx.request, user.auth, 'Ready Unreads Server'
        );

        // Send a message and ack it so there's an unreads row
        const msg = await ctx.request
            .post(`/channels/${generalChannelId}/messages`)
            .set(user.auth)
            .send({ content: 'Before connect' });

        await ctx.request
            .put(`/channels/${generalChannelId}/ack`)
            .set(user.auth)
            .send({ messageId: msg.body.id });

        // Connect via WS
        const { socket, ready } = await connectSocket(user.token);

        expect(Array.isArray(ready.unreads)).toBe(true);
        const channelUnread = ready.unreads.find(
            (u: any) => u.channelId === generalChannelId
        );
        expect(channelUnread).toBeDefined();
        expect(channelUnread.lastReadId).toBe(msg.body.id);
        expect(channelUnread.mentionCount).toBe(0);

        socket.disconnect();
    });
});
