import { io, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';

const TEST_PORT = 4999;
const SHARED_CHANNELS = 50;

// Resolves only after Ready: rooms are joined by then (server contract).
function connectSocket(token: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = io(`http://localhost:${TEST_PORT}`, { auth: { token }, transports: ['websocket'] });
        const timeout = setTimeout(() => {
            socket.disconnect();
            reject(new Error('Socket connect + Ready timeout (2s)'));
        }, 2000);
        socket.on('Ready', () => { clearTimeout(timeout); resolve(socket); });
        socket.on('connect_error', (err: Error) => { clearTimeout(timeout); reject(err); });
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

// #239: presence went out once per shared channel room, so a co-member of N channels got N copies
test(`a co-member of ${SHARED_CHANNELS} channels gets one online and one offline PresenceUpdate`, async () => {
    const viewer = await authedUser(ctx.request, 'fanviewer');
    const user = await authedUser(ctx.request, 'fanuser');
    const { serverId } = await createServer(ctx.request, viewer.auth, 'Fan-out Server');
    for (let i = 1; i < SHARED_CHANNELS; i++) {
        const res = await ctx.request.post(`/servers/${serverId}/channels`).set(viewer.auth).send({ name: `fan-${i}`, channelType: 3 });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    await joinViaInvite(ctx.request, viewer.auth, user.auth, serverId);

    const viewerSocket = await connectSocket(viewer.token);
    const seen: string[] = [];
    // The user's second connect only broadcasts online once the disconnect handler has
    // cleared them, and that handler emits offline first, so that online closes the cycle.
    const nextCycle = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`second online timeout (3s), saw ${seen.join(',')}`)), 3000);
        viewerSocket.on('PresenceUpdate', (data: { userId: string; status: string }) => {
            if (data.userId !== user.userId) return;
            if (data.status === 'online' && seen.includes('offline')) { clearTimeout(timeout); resolve(); return; }
            seen.push(data.status);
        });
    });

    const sockets = [viewerSocket];
    try {
        const userSocket = await connectSocket(user.token);
        userSocket.disconnect();
        sockets.push(await connectSocket(user.token));
        await nextCycle;

        const count = (status: string) => seen.filter(s => s === status).length;
        expect({ online: count('online'), offline: count('offline') }).toEqual({ online: 1, offline: 1 });
    } finally {
        // A socket left open would hold the server open past afterAll
        for (const socket of sockets) socket.disconnect();
    }
});
