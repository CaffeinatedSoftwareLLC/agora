// Set LiveKit env vars BEFORE any imports (config.ts reads at import time)
process.env.LIVEKIT_API_KEY = 'devkey';
process.env.LIVEKIT_API_SECRET = 'secret-that-is-at-least-32-characters-long';

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { io as ioClient, Socket } from 'socket.io-client';
import { buildApp } from '../../src/app';
import supertest from 'supertest';
import { cleanDatabase, authedUser } from '../helpers';
import { clearAllCalls, getCallById } from '../../src/call-state';
import { resetInitializedCache } from '../../src/instance/check-initialized';

const TEST_PORT = 4998;

let app: any;
let db: any;
let req: any;

function connectSocket(token: string): Promise<{ socket: Socket; ready: any }> {
    return new Promise((resolve, reject) => {
        const socket = ioClient(`http://localhost:${TEST_PORT}`, {
            auth: { token },
            transports: ['websocket'],
        });

        const timeout = setTimeout(() => {
            socket.disconnect();
            reject(new Error('Socket connect + Ready timeout (3s)'));
        }, 3000);

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

function waitForEvent(socket: Socket, event: string, timeoutMs = 3000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for event: ${event}`));
        }, timeoutMs);

        socket.on(event, (data: any) => {
            clearTimeout(timeout);
            resolve(data);
        });
    });
}

async function createDmChannel(
    request: any,
    auth1: object,
    auth2: object,
    userId2: string,
): Promise<string> {
    const res = await request.post('/channels/dm').set(auth1).send({ recipientId: userId2 });
    expect(res.status).toBe(201);
    return res.body.id;
}

beforeAll(async () => {
    const built = await buildApp({
        logger: false,
        jwtSecret: 'test-secret-do-not-use-in-prod',
        dbUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
            ?? 'postgres://accord:accord@localhost:5432/accord_test',
        rateLimit: false,
        callTimeoutMs: 300, // Short timeout for timeout test
    });
    app = built.app;
    db = built.db;
    await app.ready();

    // Clean database
    await db.query('TRUNCATE users, servers, roles, channels, server_invites, sessions, messages, message_reactions, message_mentions, channel_unreads, instance_config, audit_log, ip_bans CASCADE');
    await db.query(
        `INSERT INTO instance_config (key, value) VALUES
            ('setup_complete', 'true'),
            ('registration_policy', 'open'),
            ('instance_name', 'Agora')`,
    );
    resetInitializedCache();

    await app.listen({ port: TEST_PORT, host: '0.0.0.0' });
    req = supertest(app.server);
});

afterAll(async () => {
    clearAllCalls();
    await app.close();
    await db.end();
});

beforeEach(() => {
    clearAllCalls();
});

describe('DM Call WebSocket Events', () => {
    test('initiating a call emits call:incoming to recipient', async () => {
        const user1 = await authedUser(req, 'ws_init_a');
        const user2 = await authedUser(req, 'ws_init_b');
        const dmId = await createDmChannel(req, user1.auth, user2.auth, user2.userId);

        // Connect user2 socket (recipient)
        const { socket: socket2 } = await connectSocket(user2.token);
        const incomingPromise = waitForEvent(socket2, 'call:incoming');

        // user1 initiates call
        const initRes = await req
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        expect(initRes.status).toBe(201);

        const event = await incomingPromise;
        expect(event.callId).toBe(initRes.body.callId);
        expect(event.channelId).toBe(dmId);
        expect(event.callerId).toBe(user1.userId);
        expect(event.callType).toBe('voice');

        socket2.disconnect();
    });

    test('accepting emits call:accepted to caller', async () => {
        const user1 = await authedUser(req, 'ws_acc_a');
        const user2 = await authedUser(req, 'ws_acc_b');
        const dmId = await createDmChannel(req, user1.auth, user2.auth, user2.userId);

        // Connect caller socket
        const { socket: socket1 } = await connectSocket(user1.token);
        const acceptedPromise = waitForEvent(socket1, 'call:accepted');

        // Initiate call
        const initRes = await req
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        const callId = initRes.body.callId;

        // Accept
        const accRes = await req
            .post('/calls/accept')
            .set(user2.auth)
            .send({ callId });
        expect(accRes.status).toBe(200);

        const event = await acceptedPromise;
        expect(event.callId).toBe(callId);

        socket1.disconnect();
    });

    test('declining emits call:declined to caller', async () => {
        const user1 = await authedUser(req, 'ws_dec_a');
        const user2 = await authedUser(req, 'ws_dec_b');
        const dmId = await createDmChannel(req, user1.auth, user2.auth, user2.userId);

        const { socket: socket1 } = await connectSocket(user1.token);
        const declinedPromise = waitForEvent(socket1, 'call:declined');

        const initRes = await req
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });

        await req
            .post('/calls/decline')
            .set(user2.auth)
            .send({ callId: initRes.body.callId });

        const event = await declinedPromise;
        expect(event.callId).toBe(initRes.body.callId);

        socket1.disconnect();
    });

    test('cancelling emits call:cancelled to recipient', async () => {
        const user1 = await authedUser(req, 'ws_can_a');
        const user2 = await authedUser(req, 'ws_can_b');
        const dmId = await createDmChannel(req, user1.auth, user2.auth, user2.userId);

        const { socket: socket2 } = await connectSocket(user2.token);
        const cancelledPromise = waitForEvent(socket2, 'call:cancelled');

        const initRes = await req
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });

        await req
            .post('/calls/cancel')
            .set(user1.auth)
            .send({ callId: initRes.body.callId });

        const event = await cancelledPromise;
        expect(event.callId).toBe(initRes.body.callId);

        socket2.disconnect();
    });

    test('ending emits call:ended to other party', async () => {
        const user1 = await authedUser(req, 'ws_end_a');
        const user2 = await authedUser(req, 'ws_end_b');
        const dmId = await createDmChannel(req, user1.auth, user2.auth, user2.userId);

        const { socket: socket2 } = await connectSocket(user2.token);
        const endedPromise = waitForEvent(socket2, 'call:ended');

        const initRes = await req
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        const callId = initRes.body.callId;

        // Accept
        await req.post('/calls/accept').set(user2.auth).send({ callId });

        // End
        await req.post('/calls/end').set(user1.auth).send({ callId });

        const event = await endedPromise;
        expect(event.callId).toBe(callId);
        expect(typeof event.duration).toBe('number');

        socket2.disconnect();
    });

    test('timeout emits call:timeout to both parties', async () => {
        const user1 = await authedUser(req, 'ws_to_a');
        const user2 = await authedUser(req, 'ws_to_b');
        const dmId = await createDmChannel(req, user1.auth, user2.auth, user2.userId);

        const { socket: socket1 } = await connectSocket(user1.token);
        const { socket: socket2 } = await connectSocket(user2.token);

        const timeout1Promise = waitForEvent(socket1, 'call:timeout', 5000);
        const timeout2Promise = waitForEvent(socket2, 'call:timeout', 5000);

        const initRes = await req
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        const callId = initRes.body.callId;

        // Wait for timeout (300ms configured + some buffer)
        const [event1, event2] = await Promise.all([timeout1Promise, timeout2Promise]);

        expect(event1.callId).toBe(callId);
        expect(event2.callId).toBe(callId);

        // Call state should be cleaned up
        expect(getCallById(callId)).toBeUndefined();

        socket1.disconnect();
        socket2.disconnect();
    });
});
