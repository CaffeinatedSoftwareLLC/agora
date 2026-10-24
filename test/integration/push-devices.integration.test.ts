import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { setRelayFetch } from '../../src/lib/push-relay';
import { drainPushOutbox, MAX_ATTEMPTS } from '../../src/workers/push-sender';
import { rotateEncryptionKey } from '../../src/lib/storage-maintenance';
import { storage } from '../../src/lib/storage';
import { config } from '../../src/config';
import { decryptString } from '../../src/lib/encryption';

/**
 * App push (docs/notifications.md, mobile-apps.md section 8): the allowed-relays admin
 * setting, POST/GET/DELETE /me/push-devices, the push sender against a stubbed relay, and
 * key rotation of stored handles.
 * No request leaves the process: every relay call goes to `calls`.
 */

const RELAY = 'https://relay.test';
const ORIGIN = 'https://agora.example.test';
const HANDLE = 'A'.repeat(42) + 'b';
const OTHER_HANDLE = 'C'.repeat(42) + 'd';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let other: Awaited<ReturnType<typeof authedUser>>;
let channelId: string;

interface Call { url: string; method: string; auth: string | null; body: any }
let calls: Call[] = [];
let answer: { status: number; retryAfter?: string } = { status: 202 };
const log = { warn: vi.fn() };

function stubRelay() {
    setRelayFetch(async (url, init) => {
        const headers = init.headers as Record<string, string>;
        calls.push({ url, method: init.method!, auth: headers.Authorization ?? null, body: init.body ? JSON.parse(init.body as string) : null });
        return { status: answer.status, headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? answer.retryAfter ?? null : null) } };
    });
}

const register = (auth: object, body: Record<string, unknown> = {}, origin: string | null = ORIGIN) => {
    const req = ctx.request.post('/me/push-devices').set(auth);
    if (origin) req.set('Origin', origin);
    return req.send({ relay: RELAY, handle: HANDLE, platform: 'android', label: 'Pixel 8', ...body });
};

async function allowRelays(relays: string[]) {
    const res = await ctx.request.patch('/admin/settings/push').set(admin.auth).send({ allowedRelays: relays });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** Mention the member so a notification (and its outbox rows) is written. */
async function mentionMember() {
    const res = await ctx.request.post(`/channels/${channelId}/messages`).set(admin.auth).send({ content: '@pushmember look' });
    expect(res.status).toBe(201);
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    admin = await authedUser(ctx.request, 'pushadmin');
    await ctx.db.query('UPDATE users SET is_instance_admin = true WHERE id = $1', [admin.userId]);
    const server = await createServer(ctx.request, admin.auth, 'Push Server');
    channelId = server.generalChannelId;
    member = await authedUser(ctx.request, 'pushmember');
    other = await authedUser(ctx.request, 'pushother');
    await joinViaInvite(ctx.request, admin.auth, member.auth, server.serverId);
    stubRelay();
});

afterAll(async () => {
    setRelayFetch();
    await ctx.close();
});

beforeEach(async () => {
    await ctx.db.query('TRUNCATE notifications, notification_preferences, push_outbox, push_devices CASCADE');
    await ctx.db.query(`DELETE FROM instance_settings WHERE key = 'push.allowed_relays'`);
    calls = [];
    answer = { status: 202 };
    log.warn.mockClear();
});

describe('allowed relays', () => {
    test('is admin only, empty by default, and takes https origins only', async () => {
        expect((await ctx.request.get('/admin/settings/push').set(admin.auth)).body).toEqual({ allowedRelays: [] });
        expect((await ctx.request.get('/admin/settings/push').set(member.auth)).status).toBe(403);
        expect((await ctx.request.patch('/admin/settings/push').set(member.auth).send({ allowedRelays: [RELAY] })).status).toBe(403);
        for (const bad of ['http://relay.test', 'https://relay.test/v1', 'https://u:p@relay.test', 'relay.test']) {
            const res = await ctx.request.patch('/admin/settings/push').set(admin.auth).send({ allowedRelays: [bad] });
            expect(res.status, bad).toBe(400);
        }
        await allowRelays([`${RELAY}/`]);
        expect((await ctx.request.get('/admin/settings/push').set(admin.auth)).body).toEqual({ allowedRelays: [RELAY] });
    });
});

describe('/me/push-devices', () => {
    test('refuses every relay while none is allowed, and relays not on the list', async () => {
        expect((await register(member.auth)).status).toBe(403);
        await allowRelays(['https://other-relay.test']);
        expect((await register(member.auth)).body).toEqual({ error: 'relay_not_allowed' });
    });

    test('registers, lists without the handle, stores the handle encrypted, and removes', async () => {
        await allowRelays([RELAY]);
        const res = await register(member.auth);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(Object.keys(res.body)).toEqual(['id']);

        const list = await ctx.request.get('/me/push-devices').set(member.auth);
        expect(list.body.devices).toHaveLength(1);
        expect(list.body.devices[0]).toMatchObject({ id: res.body.id, relay: RELAY, platform: 'android', label: 'Pixel 8', lastOkAt: null });
        expect(JSON.stringify(list.body)).not.toContain(HANDLE);
        expect((await ctx.request.get('/me/push-devices').set(other.auth)).body.devices).toEqual([]);

        const row = (await ctx.db.query('SELECT * FROM push_devices')).rows[0];
        expect(row.instance_origin).toBe(ORIGIN);
        expect(JSON.stringify(row)).not.toContain(HANDLE);

        // Someone else's device: not found
        expect((await ctx.request.delete(`/me/push-devices/${res.body.id}`).set(other.auth)).status).toBe(404);
        answer = { status: 204 };
        expect((await ctx.request.delete(`/me/push-devices/${res.body.id}`).set(member.auth)).status).toBe(204);
        expect((await ctx.db.query('SELECT 1 FROM push_devices')).rows).toHaveLength(0);
        // The relay is told after commit, without holding up the reply
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0]).toEqual({ url: `${RELAY}/v1/handles`, method: 'DELETE', auth: `Bearer ${HANDLE}`, body: null });
    });

    test('validates the body and needs an https instance origin', async () => {
        await allowRelays([RELAY]);
        expect((await register(member.auth, { handle: 'short' })).status).toBe(400);
        expect((await register(member.auth, { platform: 'web' })).status).toBe(400);
        expect((await register(member.auth, { label: '' })).status).toBe(400);
        expect((await register(member.auth, {}, null)).body).toEqual({ error: 'instance_origin_unknown' });
        expect((await register(member.auth, {}, 'http://agora.example.test')).status).toBe(400);
    });

    test('the same handle registered again moves to the account now signed in on the phone', async () => {
        await allowRelays([RELAY]);
        const first = await register(member.auth);
        const again = await register(member.auth, { label: 'Renamed' });
        expect(again.body.id).toBe(first.body.id);
        const moved = await register(other.auth);
        expect(moved.body.id).toBe(first.body.id);
        expect((await ctx.request.get('/me/push-devices').set(member.auth)).body.devices).toEqual([]);
        expect((await ctx.request.get('/me/push-devices').set(other.auth)).body.devices).toHaveLength(1);
    });
});

describe('push sender', () => {
    async function withDevice() {
        await allowRelays([RELAY]);
        const res = await register(member.auth);
        expect(res.status).toBe(201);
        return res.body.id as string;
    }

    test('posts the contract body to the relay and records the success', async () => {
        const deviceId = await withDevice();
        await mentionMember();
        expect((await ctx.db.query('SELECT 1 FROM push_outbox')).rows).toHaveLength(1);
        await drainPushOutbox(ctx.db, log);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(`${RELAY}/v1/push`);
        expect(calls[0].method).toBe('POST');
        expect(calls[0].auth).toBe(`Bearer ${HANDLE}`);
        expect(calls[0].body).toEqual({
            instance: ORIGIN, type: 'mention', title: 'Mention', body: 'You were mentioned in #general', url: `/app/${channelId}`,
        });
        expect(calls[0].body.body).not.toContain('look');
        expect((await ctx.db.query('SELECT 1 FROM push_outbox')).rows).toHaveLength(0);
        expect((await ctx.db.query('SELECT last_ok_at FROM push_devices WHERE id = $1', [deviceId])).rows[0].last_ok_at).not.toBeNull();
    });

    test('410 deletes the device', async () => {
        const deviceId = await withDevice();
        await mentionMember();
        answer = { status: 410 };
        await drainPushOutbox(ctx.db, log);
        expect((await ctx.db.query('SELECT 1 FROM push_devices WHERE id = $1', [deviceId])).rows).toHaveLength(0);
        expect((await ctx.db.query('SELECT 1 FROM push_outbox')).rows).toHaveLength(0);
    });

    test('401 and 403 delete the device and log without the handle', async () => {
        for (const status of [401, 403]) {
            await ctx.db.query('TRUNCATE notifications, push_outbox, push_devices CASCADE');
            await withDevice();
            await mentionMember();
            answer = { status };
            await drainPushOutbox(ctx.db, log);
            expect((await ctx.db.query('SELECT 1 FROM push_devices')).rows).toHaveLength(0);
        }
        expect(log.warn).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain(HANDLE);
    });

    test('429 and 5xx retry with backoff, then give up', async () => {
        await withDevice();
        await mentionMember();
        answer = { status: 429, retryAfter: '90' };
        await drainPushOutbox(ctx.db, log);
        const row = (await ctx.db.query(`SELECT attempts, next_attempt_at > NOW() + interval '80 seconds' AS later FROM push_outbox`)).rows[0];
        expect(row).toEqual({ attempts: 1, later: true });
        // Not due yet: nothing is sent
        await drainPushOutbox(ctx.db, log);
        expect(calls).toHaveLength(1);

        answer = { status: 503 };
        for (let i = 2; i <= MAX_ATTEMPTS; i++) {
            await ctx.db.query('UPDATE push_outbox SET next_attempt_at = NOW()');
            await drainPushOutbox(ctx.db, log);
        }
        expect(calls).toHaveLength(MAX_ATTEMPTS);
        expect((await ctx.db.query('SELECT 1 FROM push_outbox')).rows).toHaveLength(0);
        // The device stays: only a refusal or 410 removes it
        expect((await ctx.db.query('SELECT 1 FROM push_devices')).rows).toHaveLength(1);
    });

    test('nothing is queued when app push is off or the relay is no longer allowed', async () => {
        await withDevice();
        await ctx.request.put('/me/notification-preferences').set(member.auth).send({ appPush: false });
        await mentionMember();
        expect((await ctx.db.query('SELECT 1 FROM notifications')).rows).toHaveLength(1);
        expect((await ctx.db.query('SELECT 1 FROM push_outbox')).rows).toHaveLength(0);

        await ctx.request.put('/me/notification-preferences').set(member.auth).send({ appPush: true });
        await ctx.db.query('UPDATE notifications SET read_at = NOW()');
        await mentionMember();
        expect((await ctx.db.query('SELECT 1 FROM push_outbox')).rows).toHaveLength(1);
        await allowRelays([]);
        await drainPushOutbox(ctx.db, log);
        expect(calls).toHaveLength(0);
        expect((await ctx.db.query('SELECT 1 FROM push_outbox')).rows).toHaveLength(0);
    });

    test('a second device of the same user gets its own send', async () => {
        await withDevice();
        expect((await register(member.auth, { handle: OTHER_HANDLE, platform: 'ios', label: 'iPhone' })).status).toBe(201);
        await mentionMember();
        await drainPushOutbox(ctx.db, log);
        expect(calls.map(c => c.auth).sort()).toEqual([`Bearer ${HANDLE}`, `Bearer ${OTHER_HANDLE}`].sort());
    });
});

describe('key rotation', () => {
    test('re-encrypts push handles with the new key', async () => {
        await allowRelays([RELAY]);
        expect((await register(member.auth)).status).toBe(201);
        const oldKey = config.encryptionKey;
        const newKey = Buffer.alloc(32, 7);
        const result = await rotateEncryptionKey(ctx.db, storage, oldKey, newKey);
        expect(result).toMatchObject({ status: 'rotated', pushHandles: 1 });
        const row = (await ctx.db.query('SELECT handle_enc, handle_iv, handle_tag FROM push_devices')).rows[0];
        expect(decryptString(row.handle_enc, newKey, row.handle_iv, row.handle_tag)).toBe(HANDLE);
        expect(() => decryptString(row.handle_enc, oldKey, row.handle_iv, row.handle_tag)).toThrow();
        // Leave the database on the key the rest of the suite uses
        await ctx.db.query('TRUNCATE push_devices CASCADE');
        await ctx.db.query(`DELETE FROM instance_config WHERE key = 'encryption_key_fingerprint'`);
    });
});
