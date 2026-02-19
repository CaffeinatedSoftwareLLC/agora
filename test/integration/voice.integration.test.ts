import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
});
afterAll(async () => { await ctx.close(); });

describe('Voice – POST /voice/token', () => {
    test('returns token for authenticated member with voice channel', async () => {
        const owner = await authedUser(ctx.request, 'vt_owner');
        const { serverId } = await createServer(ctx.request, owner.auth, 'Voice Token Server');

        // Create a voice channel (channelType 4 = server_voice)
        const ch = await ctx.request
            .post(`/servers/${serverId}/channels`)
            .set(owner.auth)
            .send({ name: 'Voice Chat', channelType: 4 });
        expect(ch.status).toBe(201);
        const voiceChannelId = ch.body.id;

        const res = await ctx.request
            .post('/voice/token')
            .set(owner.auth)
            .send({ channelId: voiceChannelId });

        expect(res.status).toBe(200);
        expect(typeof res.body.token).toBe('string');
        expect(res.body.token.length).toBeGreaterThan(0);
        expect(typeof res.body.url).toBe('string');
    });

    test('returns 403 for non-member', async () => {
        const owner = await authedUser(ctx.request, 'vt_owner2');
        const outsider = await authedUser(ctx.request, 'vt_outsider');
        const { serverId } = await createServer(ctx.request, owner.auth, 'Voice Token Forbid');

        const ch = await ctx.request
            .post(`/servers/${serverId}/channels`)
            .set(owner.auth)
            .send({ name: 'VC Forbid', channelType: 4 });
        const voiceChannelId = ch.body.id;

        const res = await ctx.request
            .post('/voice/token')
            .set(outsider.auth)
            .send({ channelId: voiceChannelId });

        expect(res.status).toBe(403);
    });

    test('returns 404 for text channel', async () => {
        const owner = await authedUser(ctx.request, 'vt_owner3');
        const { generalChannelId } = await createServer(ctx.request, owner.auth, 'Voice Token Text');

        const res = await ctx.request
            .post('/voice/token')
            .set(owner.auth)
            .send({ channelId: generalChannelId });

        expect(res.status).toBe(404);
    });

    test('returns 404 for non-existent channel', async () => {
        const owner = await authedUser(ctx.request, 'vt_owner4');
        await createServer(ctx.request, owner.auth, 'Voice Token Missing');

        const res = await ctx.request
            .post('/voice/token')
            .set(owner.auth)
            .send({ channelId: '00000000000000000000000000' });

        expect(res.status).toBe(404);
    });

    test('returns 401 without auth', async () => {
        const res = await ctx.request
            .post('/voice/token')
            .send({ channelId: '00000000000000000000000000' });

        expect(res.status).toBe(401);
    });
});

describe('Voice – GET /voice/participants/:channelId', () => {
    test('returns empty array when LiveKit is not running', async () => {
        const owner = await authedUser(ctx.request, 'vp_owner');
        const { serverId } = await createServer(ctx.request, owner.auth, 'Voice Participants');

        const ch = await ctx.request
            .post(`/servers/${serverId}/channels`)
            .set(owner.auth)
            .send({ name: 'VC Participants', channelType: 4 });
        const voiceChannelId = ch.body.id;

        const res = await ctx.request
            .get(`/voice/participants/${voiceChannelId}`)
            .set(owner.auth);

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    test('returns 403 for non-member', async () => {
        const owner = await authedUser(ctx.request, 'vp_owner2');
        const outsider = await authedUser(ctx.request, 'vp_outsider');
        const { serverId } = await createServer(ctx.request, owner.auth, 'VP Forbid');

        const ch = await ctx.request
            .post(`/servers/${serverId}/channels`)
            .set(owner.auth)
            .send({ name: 'VC Forbid2', channelType: 4 });
        const voiceChannelId = ch.body.id;

        const res = await ctx.request
            .get(`/voice/participants/${voiceChannelId}`)
            .set(outsider.auth);

        expect(res.status).toBe(403);
    });

    test('returns 404 for non-voice channel', async () => {
        const owner = await authedUser(ctx.request, 'vp_owner3');
        const { generalChannelId } = await createServer(ctx.request, owner.auth, 'VP Text');

        const res = await ctx.request
            .get(`/voice/participants/${generalChannelId}`)
            .set(owner.auth);

        expect(res.status).toBe(404);
    });
});

describe('Voice – POST /voice/kick', () => {
    test('returns 403 for non-member', async () => {
        const owner = await authedUser(ctx.request, 'vk_owner');
        const outsider = await authedUser(ctx.request, 'vk_outsider');
        const { serverId } = await createServer(ctx.request, owner.auth, 'VK Forbid');

        const ch = await ctx.request
            .post(`/servers/${serverId}/channels`)
            .set(owner.auth)
            .send({ name: 'VC Kick', channelType: 4 });
        const voiceChannelId = ch.body.id;

        const res = await ctx.request
            .post('/voice/kick')
            .set(outsider.auth)
            .send({ channelId: voiceChannelId, userId: owner.userId });

        expect(res.status).toBe(403);
    });

    test('returns 403 without VoiceMoveMembers permission', async () => {
        const owner = await authedUser(ctx.request, 'vk_owner2');
        const member = await authedUser(ctx.request, 'vk_member');
        const { serverId } = await createServer(ctx.request, owner.auth, 'VK Perm');

        await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);

        const ch = await ctx.request
            .post(`/servers/${serverId}/channels`)
            .set(owner.auth)
            .send({ name: 'VC Kick2', channelType: 4 });
        const voiceChannelId = ch.body.id;

        // Regular member — default @everyone perms don't include VoiceMoveMembers
        const res = await ctx.request
            .post('/voice/kick')
            .set(member.auth)
            .send({ channelId: voiceChannelId, userId: owner.userId });

        expect(res.status).toBe(403);
    });

    test('succeeds for server owner (has all permissions)', async () => {
        const owner = await authedUser(ctx.request, 'vk_owner3');
        const member = await authedUser(ctx.request, 'vk_target');
        const { serverId } = await createServer(ctx.request, owner.auth, 'VK Owner');

        await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);

        const ch = await ctx.request
            .post(`/servers/${serverId}/channels`)
            .set(owner.auth)
            .send({ name: 'VC Kick3', channelType: 4 });
        const voiceChannelId = ch.body.id;

        // Owner bypasses permission checks — LiveKit call may fail but auth passes
        const res = await ctx.request
            .post('/voice/kick')
            .set(owner.auth)
            .send({ channelId: voiceChannelId, userId: member.userId });

        // Should not be 403 (auth passed); likely 200 since the catch swallows LiveKit errors
        expect(res.status).toBe(200);
    });
});

describe('Voice – POST /voice/mute', () => {
    test('returns 403 for non-member', async () => {
        const owner = await authedUser(ctx.request, 'vm_owner');
        const outsider = await authedUser(ctx.request, 'vm_outsider');
        const { serverId } = await createServer(ctx.request, owner.auth, 'VM Forbid');

        const ch = await ctx.request
            .post(`/servers/${serverId}/channels`)
            .set(owner.auth)
            .send({ name: 'VC Mute', channelType: 4 });
        const voiceChannelId = ch.body.id;

        const res = await ctx.request
            .post('/voice/mute')
            .set(outsider.auth)
            .send({ channelId: voiceChannelId, userId: owner.userId });

        expect(res.status).toBe(403);
    });

    test('returns 403 without VoiceMuteMembers permission', async () => {
        const owner = await authedUser(ctx.request, 'vm_owner2');
        const member = await authedUser(ctx.request, 'vm_member');
        const { serverId } = await createServer(ctx.request, owner.auth, 'VM Perm');

        await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);

        const ch = await ctx.request
            .post(`/servers/${serverId}/channels`)
            .set(owner.auth)
            .send({ name: 'VC Mute2', channelType: 4 });
        const voiceChannelId = ch.body.id;

        // Regular member — default @everyone perms don't include VoiceMuteMembers
        const res = await ctx.request
            .post('/voice/mute')
            .set(member.auth)
            .send({ channelId: voiceChannelId, userId: owner.userId });

        expect(res.status).toBe(403);
    });

    test('owner mute attempt reaches LiveKit (not blocked by auth)', async () => {
        const owner = await authedUser(ctx.request, 'vm_owner3');
        const member = await authedUser(ctx.request, 'vm_target');
        const { serverId } = await createServer(ctx.request, owner.auth, 'VM Owner');

        await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);

        const ch = await ctx.request
            .post(`/servers/${serverId}/channels`)
            .set(owner.auth)
            .send({ name: 'VC Mute3', channelType: 4 });
        const voiceChannelId = ch.body.id;

        // Owner has all perms — call reaches LiveKit which will fail (no server)
        // The catch block returns 404 with "Participant not found in voice channel"
        const res = await ctx.request
            .post('/voice/mute')
            .set(owner.auth)
            .send({ channelId: voiceChannelId, userId: member.userId });

        // Should NOT be 403 — auth/permission checks passed
        expect(res.status).not.toBe(403);
        // Expect 404 from the catch block (LiveKit not running → error → participant not found)
        expect(res.status).toBe(404);
    });
});

describe('Voice – POST /webhooks/livekit', () => {
    test('returns 401 for invalid/missing signature', async () => {
        const res = await ctx.request
            .post('/webhooks/livekit')
            .set('Content-Type', 'application/json')
            .send(JSON.stringify({ event: 'participant_joined' }));

        expect(res.status).toBe(401);
    });

    test('returns 401 with wrong authorization header', async () => {
        const res = await ctx.request
            .post('/webhooks/livekit')
            .set('Content-Type', 'application/json')
            .set('Authorization', 'Bearer invalid-token')
            .send(JSON.stringify({ event: 'participant_joined' }));

        expect(res.status).toBe(401);
    });
});
