// Set LiveKit env vars BEFORE any imports (config.ts reads at import time)
process.env.LIVEKIT_API_KEY = 'devkey';
process.env.LIVEKIT_API_SECRET = 'secret-that-is-at-least-32-characters-long';

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { clearAllCalls, getCallById, addCall, setCallConnected, type ActiveCall } from '../../src/call-state';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
});

afterAll(async () => {
    await ctx.close();
});

beforeEach(() => {
    clearAllCalls();
});

// ─── Helpers ─────────────────────────────────────────────────────────────

async function createDmChannel(
    req: any,
    auth1: object,
    auth2: object,
    userId2: string,
): Promise<string> {
    const res = await req.post('/channels/dm').set(auth1).send({ recipientId: userId2 });
    expect(res.status).toBe(201);
    return res.body.id;
}

// ─── POST /calls/initiate ────────────────────────────────────────────────

describe('POST /calls/initiate', () => {
    test('401 without auth', async () => {
        const res = await ctx.request.post('/calls/initiate').send({ channelId: 'x', callType: 'voice' });
        expect(res.status).toBe(401);
    });

    test('400 missing channelId', async () => {
        const user = await authedUser(ctx.request, 'init_400a');
        const res = await ctx.request.post('/calls/initiate').set(user.auth).send({ callType: 'voice' });
        expect(res.status).toBe(400);
    });

    test('400 missing callType', async () => {
        const user = await authedUser(ctx.request, 'init_400b');
        const res = await ctx.request.post('/calls/initiate').set(user.auth).send({ channelId: 'x' });
        expect(res.status).toBe(400);
    });

    test('400 invalid callType', async () => {
        const user = await authedUser(ctx.request, 'init_400c');
        const res = await ctx.request.post('/calls/initiate').set(user.auth).send({ channelId: 'x', callType: 'hologram' });
        expect(res.status).toBe(400);
    });

    test('404 channel not found', async () => {
        const user = await authedUser(ctx.request, 'init_404a');
        const res = await ctx.request
            .post('/calls/initiate')
            .set(user.auth)
            .send({ channelId: '00000000000000000000000000', callType: 'voice' });
        expect(res.status).toBe(404);
    });

    test('404 channel is server_text, not DM', async () => {
        const user = await authedUser(ctx.request, 'init_404b');
        const { generalChannelId } = await createServer(ctx.request, user.auth, 'InitNotDm');
        const res = await ctx.request
            .post('/calls/initiate')
            .set(user.auth)
            .send({ channelId: generalChannelId, callType: 'voice' });
        expect(res.status).toBe(404);
    });

    test('403 not a DM member', async () => {
        const user1 = await authedUser(ctx.request, 'init_403a');
        const user2 = await authedUser(ctx.request, 'init_403b');
        const outsider = await authedUser(ctx.request, 'init_403c');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const res = await ctx.request
            .post('/calls/initiate')
            .set(outsider.auth)
            .send({ channelId: dmId, callType: 'voice' });
        expect(res.status).toBe(403);
    });

    test('201 returns callId, token, url, callType for voice call', async () => {
        const user1 = await authedUser(ctx.request, 'init_201a');
        const user2 = await authedUser(ctx.request, 'init_201b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const res = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });

        expect(res.status).toBe(201);
        expect(typeof res.body.callId).toBe('string');
        expect(res.body.callId.length).toBe(26);
        expect(typeof res.body.token).toBe('string');
        expect(res.body.token.length).toBeGreaterThan(0);
        expect(typeof res.body.url).toBe('string');
        expect(res.body.callType).toBe('voice');
    });

    test('201 for video call', async () => {
        const user1 = await authedUser(ctx.request, 'init_vid_a');
        const user2 = await authedUser(ctx.request, 'init_vid_b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const res = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'video' });

        expect(res.status).toBe(201);
        expect(res.body.callType).toBe('video');
    });

    test('409 call_already_active when channel has active call', async () => {
        const user1 = await authedUser(ctx.request, 'init_409a');
        const user2 = await authedUser(ctx.request, 'init_409b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        // First call succeeds
        const first = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        expect(first.status).toBe(201);

        // Second call from user2 on same channel
        const second = await ctx.request
            .post('/calls/initiate')
            .set(user2.auth)
            .send({ channelId: dmId, callType: 'voice' });
        expect(second.status).toBe(409);
        expect(second.body.error).toBe('call_already_active');
    });

    test('409 already_in_call when caller is in another call', async () => {
        const user1 = await authedUser(ctx.request, 'init_busy_a');
        const user2 = await authedUser(ctx.request, 'init_busy_b');
        const user3 = await authedUser(ctx.request, 'init_busy_c');

        const dm1 = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);
        const dm2 = await createDmChannel(ctx.request, user1.auth, user3.auth, user3.userId);

        // user1 calls user2
        const first = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dm1, callType: 'voice' });
        expect(first.status).toBe(201);

        // user1 tries to call user3
        const second = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dm2, callType: 'voice' });
        expect(second.status).toBe(409);
        expect(second.body.error).toBe('already_in_call');
    });

    test('409 recipient_in_call when recipient is in another call', async () => {
        const user1 = await authedUser(ctx.request, 'init_rcpt_a');
        const user2 = await authedUser(ctx.request, 'init_rcpt_b');
        const user3 = await authedUser(ctx.request, 'init_rcpt_c');

        const dm1 = await createDmChannel(ctx.request, user2.auth, user3.auth, user3.userId);
        const dm2 = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        // user2 calls user3 (user2 is now in a call as caller)
        const first = await ctx.request
            .post('/calls/initiate')
            .set(user2.auth)
            .send({ channelId: dm1, callType: 'voice' });
        expect(first.status).toBe(201);

        // user1 tries to call user2 (user2 is in a call)
        const second = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dm2, callType: 'voice' });
        expect(second.status).toBe(409);
        expect(second.body.error).toBe('recipient_in_call');
    });
});

// ─── POST /calls/accept ─────────────────────────────────────────────────

describe('POST /calls/accept', () => {
    test('401 without auth', async () => {
        const res = await ctx.request.post('/calls/accept').send({ callId: 'x' });
        expect(res.status).toBe(401);
    });

    test('400 missing callId', async () => {
        const user = await authedUser(ctx.request, 'acc_400');
        const res = await ctx.request.post('/calls/accept').set(user.auth).send({});
        expect(res.status).toBe(400);
    });

    test('404 call not found or not ringing', async () => {
        const user = await authedUser(ctx.request, 'acc_404');
        const res = await ctx.request
            .post('/calls/accept')
            .set(user.auth)
            .send({ callId: '00000000000000000000000000' });
        expect(res.status).toBe(404);
    });

    test('403 not the recipient', async () => {
        const user1 = await authedUser(ctx.request, 'acc_403a');
        const user2 = await authedUser(ctx.request, 'acc_403b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const initRes = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        expect(initRes.status).toBe(201);

        // Caller tries to accept their own call
        const res = await ctx.request
            .post('/calls/accept')
            .set(user1.auth)
            .send({ callId: initRes.body.callId });
        expect(res.status).toBe(403);
    });

    test('200 with callId, token, url', async () => {
        const user1 = await authedUser(ctx.request, 'acc_200a');
        const user2 = await authedUser(ctx.request, 'acc_200b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const initRes = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });

        const res = await ctx.request
            .post('/calls/accept')
            .set(user2.auth)
            .send({ callId: initRes.body.callId });

        expect(res.status).toBe(200);
        expect(res.body.callId).toBe(initRes.body.callId);
        expect(typeof res.body.token).toBe('string');
        expect(res.body.token.length).toBeGreaterThan(0);
        expect(typeof res.body.url).toBe('string');

        // Verify call is now connected in state
        const call = getCallById(initRes.body.callId);
        expect(call).toBeDefined();
        expect(call!.status).toBe('connected');
    });
});

// ─── POST /calls/decline ────────────────────────────────────────────────

describe('POST /calls/decline', () => {
    test('401 without auth', async () => {
        const res = await ctx.request.post('/calls/decline').send({ callId: 'x' });
        expect(res.status).toBe(401);
    });

    test('404 call not found or not ringing', async () => {
        const user = await authedUser(ctx.request, 'dec_404');
        const res = await ctx.request
            .post('/calls/decline')
            .set(user.auth)
            .send({ callId: '00000000000000000000000000' });
        expect(res.status).toBe(404);
    });

    test('403 not the recipient', async () => {
        const user1 = await authedUser(ctx.request, 'dec_403a');
        const user2 = await authedUser(ctx.request, 'dec_403b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const initRes = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });

        // Caller tries to decline
        const res = await ctx.request
            .post('/calls/decline')
            .set(user1.auth)
            .send({ callId: initRes.body.callId });
        expect(res.status).toBe(403);
    });

    test('200 cleans up call state and inserts call_declined system message', async () => {
        const user1 = await authedUser(ctx.request, 'dec_200a');
        const user2 = await authedUser(ctx.request, 'dec_200b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const initRes = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        const callId = initRes.body.callId;

        const res = await ctx.request
            .post('/calls/decline')
            .set(user2.auth)
            .send({ callId });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Call state should be cleaned up
        expect(getCallById(callId)).toBeUndefined();

        // System message should be inserted
        const msgs = await ctx.request
            .get(`/channels/${dmId}/messages`)
            .set(user1.auth);
        const systemMsg = msgs.body.find((m: any) => m.content === 'Voice call declined');
        expect(systemMsg).toBeDefined();
    });
});

// ─── POST /calls/cancel ─────────────────────────────────────────────────

describe('POST /calls/cancel', () => {
    test('401 without auth', async () => {
        const res = await ctx.request.post('/calls/cancel').send({ callId: 'x' });
        expect(res.status).toBe(401);
    });

    test('404 call not found or not ringing', async () => {
        const user = await authedUser(ctx.request, 'can_404');
        const res = await ctx.request
            .post('/calls/cancel')
            .set(user.auth)
            .send({ callId: '00000000000000000000000000' });
        expect(res.status).toBe(404);
    });

    test('403 not the caller', async () => {
        const user1 = await authedUser(ctx.request, 'can_403a');
        const user2 = await authedUser(ctx.request, 'can_403b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const initRes = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });

        // Recipient tries to cancel
        const res = await ctx.request
            .post('/calls/cancel')
            .set(user2.auth)
            .send({ callId: initRes.body.callId });
        expect(res.status).toBe(403);
    });

    test('200 cleans up all call state and inserts call_missed system message', async () => {
        const user1 = await authedUser(ctx.request, 'can_200a');
        const user2 = await authedUser(ctx.request, 'can_200b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const initRes = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        const callId = initRes.body.callId;

        const res = await ctx.request
            .post('/calls/cancel')
            .set(user1.auth)
            .send({ callId });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Call state should be cleaned up
        expect(getCallById(callId)).toBeUndefined();

        // System message should be inserted
        const msgs = await ctx.request
            .get(`/channels/${dmId}/messages`)
            .set(user1.auth);
        const systemMsg = msgs.body.find((m: any) => m.content === 'Missed voice call');
        expect(systemMsg).toBeDefined();
    });
});

// ─── POST /calls/end ─────────────────────────────────────────────────────

describe('POST /calls/end', () => {
    test('401 without auth', async () => {
        const res = await ctx.request.post('/calls/end').send({ callId: 'x' });
        expect(res.status).toBe(401);
    });

    test('404 call not found', async () => {
        const user = await authedUser(ctx.request, 'end_404');
        const res = await ctx.request
            .post('/calls/end')
            .set(user.auth)
            .send({ callId: '00000000000000000000000000' });
        expect(res.status).toBe(404);
    });

    test('403 not a participant', async () => {
        const user1 = await authedUser(ctx.request, 'end_403a');
        const user2 = await authedUser(ctx.request, 'end_403b');
        const outsider = await authedUser(ctx.request, 'end_403c');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const initRes = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });

        // Accept the call so it's connected
        await ctx.request
            .post('/calls/accept')
            .set(user2.auth)
            .send({ callId: initRes.body.callId });

        // Outsider tries to end
        const res = await ctx.request
            .post('/calls/end')
            .set(outsider.auth)
            .send({ callId: initRes.body.callId });
        expect(res.status).toBe(403);
    });

    test('200 with duration for connected call, inserts call_ended system message', async () => {
        const user1 = await authedUser(ctx.request, 'end_200a');
        const user2 = await authedUser(ctx.request, 'end_200b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const initRes = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        const callId = initRes.body.callId;

        // Accept
        await ctx.request
            .post('/calls/accept')
            .set(user2.auth)
            .send({ callId });

        // Small delay so duration > 0
        await new Promise(r => setTimeout(r, 50));

        // End
        const res = await ctx.request
            .post('/calls/end')
            .set(user1.auth)
            .send({ callId });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(typeof res.body.duration).toBe('number');
        expect(res.body.duration).toBeGreaterThanOrEqual(0);

        // Call state should be cleaned up
        expect(getCallById(callId)).toBeUndefined();

        // System message should be inserted
        const msgs = await ctx.request
            .get(`/channels/${dmId}/messages`)
            .set(user1.auth);
        const systemMsg = msgs.body.find((m: any) => m.content && m.content.startsWith('Voice call'));
        expect(systemMsg).toBeDefined();
    });

    test('200 caller can end ringing call (not yet accepted)', async () => {
        const user1 = await authedUser(ctx.request, 'end_ring_a');
        const user2 = await authedUser(ctx.request, 'end_ring_b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const initRes = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });

        const res = await ctx.request
            .post('/calls/end')
            .set(user1.auth)
            .send({ callId: initRes.body.callId });

        expect(res.status).toBe(200);
        expect(res.body.duration).toBe(0);
    });
});

// ─── Cycle 11: System messages in GET /channels/:id/messages ─────────────

describe('System messages passthrough', () => {
    test('GET /channels/:id/messages returns systemEvent field for system messages', async () => {
        const user1 = await authedUser(ctx.request, 'sysmsg_a');
        const user2 = await authedUser(ctx.request, 'sysmsg_b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        // Initiate and decline to create a system message
        const initRes = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        await ctx.request
            .post('/calls/decline')
            .set(user2.auth)
            .send({ callId: initRes.body.callId });

        const msgs = await ctx.request
            .get(`/channels/${dmId}/messages`)
            .set(user1.auth);

        const systemMsg = msgs.body.find((m: any) => m.systemEvent === 'call_declined');
        expect(systemMsg).toBeDefined();
        expect(systemMsg.content).toBe('Voice call declined');
        expect(systemMsg.systemEvent).toBe('call_declined');
    });

    test('GET /channels/:id/messages returns systemEvent undefined for normal messages', async () => {
        const user1 = await authedUser(ctx.request, 'sysmsg_norm_a');
        const user2 = await authedUser(ctx.request, 'sysmsg_norm_b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        // Send a normal message
        await ctx.request
            .post(`/channels/${dmId}/messages`)
            .set(user1.auth)
            .send({ content: 'Hello!' });

        const msgs = await ctx.request
            .get(`/channels/${dmId}/messages`)
            .set(user1.auth);

        const normalMsg = msgs.body.find((m: any) => m.content === 'Hello!');
        expect(normalMsg).toBeDefined();
        expect(normalMsg.systemEvent).toBeUndefined();
    });
});

// ─── Cycle 12: Timeout integration test ──────────────────────────────────

describe('Call timeout', () => {
    test('unanswered call times out, inserts system message, accept returns 404', async () => {
        // Build a separate app with short timeout
        const { buildApp } = await import('../../src/app');
        const { app: timeoutApp, db: timeoutDb } = await buildApp({
            logger: false,
            jwtSecret: 'test-secret-do-not-use-in-prod',
            dbUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
                ?? 'postgres://accord:accord@localhost:5432/accord_test',
            rateLimit: false,
            callTimeoutMs: 200,
        });
        await timeoutApp.ready();

        const { default: supertest } = await import('supertest');
        const req = supertest(timeoutApp.server);

        try {
            const user1 = await authedUser(req as any, 'timeout_a');
            const user2 = await authedUser(req as any, 'timeout_b');
            const dmRes = await req.post('/channels/dm').set(user1.auth).send({ recipientId: user2.userId });
            const dmId = dmRes.body.id;

            const initRes = await req
                .post('/calls/initiate')
                .set(user1.auth)
                .send({ channelId: dmId, callType: 'voice' });
            expect(initRes.status).toBe(201);
            const callId = initRes.body.callId;

            // Wait for timeout to fire
            await waitUntil(async () => {
                return getCallById(callId) === undefined;
            }, 3000, 50);

            // Call should be gone
            expect(getCallById(callId)).toBeUndefined();

            // Accept should return 404
            const acceptRes = await req
                .post('/calls/accept')
                .set(user2.auth)
                .send({ callId });
            expect(acceptRes.status).toBe(404);

            // System message should exist
            const msgs = await req
                .get(`/channels/${dmId}/messages`)
                .set(user1.auth);
            const missedMsg = msgs.body.find((m: any) => m.content && m.content.includes('Missed'));
            expect(missedMsg).toBeDefined();
        } finally {
            clearAllCalls();
            await timeoutApp.close();
            await timeoutDb.end();
        }
    });
});

// ─── Cycle 15: Idempotency ──────────────────────────────────────────────

describe('Idempotency', () => {
    test('decline after already declined → 404', async () => {
        const user1 = await authedUser(ctx.request, 'idemp_dec_a');
        const user2 = await authedUser(ctx.request, 'idemp_dec_b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const initRes = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        const callId = initRes.body.callId;

        await ctx.request.post('/calls/decline').set(user2.auth).send({ callId });
        const res = await ctx.request.post('/calls/decline').set(user2.auth).send({ callId });
        expect(res.status).toBe(404);
    });

    test('cancel after already cancelled → 404', async () => {
        const user1 = await authedUser(ctx.request, 'idemp_can_a');
        const user2 = await authedUser(ctx.request, 'idemp_can_b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const initRes = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        const callId = initRes.body.callId;

        await ctx.request.post('/calls/cancel').set(user1.auth).send({ callId });
        const res = await ctx.request.post('/calls/cancel').set(user1.auth).send({ callId });
        expect(res.status).toBe(404);
    });

    test('end after already ended → 404', async () => {
        const user1 = await authedUser(ctx.request, 'idemp_end_a');
        const user2 = await authedUser(ctx.request, 'idemp_end_b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const initRes = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        const callId = initRes.body.callId;

        await ctx.request.post('/calls/accept').set(user2.auth).send({ callId });
        await ctx.request.post('/calls/end').set(user1.auth).send({ callId });
        const res = await ctx.request.post('/calls/end').set(user1.auth).send({ callId });
        expect(res.status).toBe(404);
    });

    test('accept after decline → 404', async () => {
        const user1 = await authedUser(ctx.request, 'idemp_ad_a');
        const user2 = await authedUser(ctx.request, 'idemp_ad_b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const initRes = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        const callId = initRes.body.callId;

        await ctx.request.post('/calls/decline').set(user2.auth).send({ callId });
        const res = await ctx.request.post('/calls/accept').set(user2.auth).send({ callId });
        expect(res.status).toBe(404);
    });

    test('decline after accept → 404 (call is connected, not ringing)', async () => {
        const user1 = await authedUser(ctx.request, 'idemp_da_a');
        const user2 = await authedUser(ctx.request, 'idemp_da_b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const initRes = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        const callId = initRes.body.callId;

        await ctx.request.post('/calls/accept').set(user2.auth).send({ callId });
        const res = await ctx.request.post('/calls/decline').set(user2.auth).send({ callId });
        expect(res.status).toBe(404);
    });

    test('double initiate → 409', async () => {
        const user1 = await authedUser(ctx.request, 'idemp_dbl_a');
        const user2 = await authedUser(ctx.request, 'idemp_dbl_b');
        const dmId = await createDmChannel(ctx.request, user1.auth, user2.auth, user2.userId);

        const first = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        expect(first.status).toBe(201);

        const second = await ctx.request
            .post('/calls/initiate')
            .set(user1.auth)
            .send({ channelId: dmId, callType: 'voice' });
        expect(second.status).toBe(409);
    });
});

// ─── Helper ──────────────────────────────────────────────────────────────

async function waitUntil(
    fn: () => Promise<boolean>,
    timeoutMs = 2000,
    intervalMs = 50,
): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await fn()) return;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error('waitUntil timed out');
}
