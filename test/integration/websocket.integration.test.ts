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
});
