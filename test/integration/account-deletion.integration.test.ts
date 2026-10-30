import { io, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { SoftPasskey } from '../webauthn-authenticator';
import { Permissions } from '../../src/permissions';
import { storage } from '../../src/lib/storage';
import { setRelayFetch } from '../../src/lib/push-relay';
import { formatMessages } from '../../agora-mcp/src/tools';

// Self-service account deletion (DELETE /users/@me, docs/account-deletion.md)
let ctx: Awaited<ReturnType<typeof setupTestApp>>;
type User = Awaited<ReturnType<typeof authedUser>>;
let owner: User;
let alice: User;
let serverId: string;
let channelId: string;
const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'TestPass123!';
const sockets: Socket[] = [];

function event(socket: Socket, name: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing ${name}`)), 4000);
        socket.once(name, data => { clearTimeout(timer); resolve(data); });
    });
}
async function connect(token: string, bot = false) {
    const socket = io('http://localhost:4999', { transports: ['websocket'], auth: { token, ...(bot ? { type: 'bot' } : {}) }, autoConnect: false, reconnection: false });
    sockets.push(socket);
    const ready = event(socket, bot ? 'BotReady' : 'Ready');
    socket.connect();
    await ready;
    return socket;
}

function deleteAccount(user: User, body: Record<string, unknown>) {
    return ctx.request.delete('/users/@me').set(user.auth).send(body);
}
async function post(user: User, content: string, extra: Record<string, unknown> = {}) {
    const res = await ctx.request.post(`/channels/${channelId}/messages`).set(user.auth).send({ content, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}
async function reply(user: User, parentId: string, content: string) {
    const res = await ctx.request.post(`/channels/${channelId}/messages/${parentId}/replies`).set(user.auth).send({ content });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}
async function makeAdmin(user: User) {
    await ctx.db.query('UPDATE users SET is_instance_admin = true WHERE id = $1', [user.userId]);
}
async function setPolicy(value: 'anonymize' | 'remove') {
    await makeAdmin(owner);
    const res = await ctx.request.patch('/admin/settings/accounts').set(owner.auth).send({ deletedAccountMessages: value });
    expect(res.status).toBe(200);
}
async function userExists(id: string) {
    return (await ctx.db.query('SELECT 1 FROM users WHERE id = $1', [id])).rows.length === 1;
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await ctx.app.listen({ host: '127.0.0.1', port: 4999 });
});
beforeEach(async () => {
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'ad_owner');
    alice = await authedUser(ctx.request, 'ad_alice');
    const server = await createServer(ctx.request, owner.auth, 'Deletion');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    await joinViaInvite(ctx.request, owner.auth, alice.auth, serverId);
});
afterEach(() => { for (const s of sockets.splice(0)) s.disconnect(); });
afterAll(async () => { await ctx.close(); });

describe('admin setting', () => {
    test('defaults to anonymize; only an instance admin reads or changes it, and only to a known value', async () => {
        expect((await ctx.request.get('/admin/settings/accounts').set(owner.auth)).status).toBe(403);
        expect((await ctx.request.patch('/admin/settings/accounts').set(owner.auth).send({ deletedAccountMessages: 'remove' })).status).toBe(403);
        await makeAdmin(owner);
        expect((await ctx.request.get('/admin/settings/accounts').set(owner.auth)).body).toEqual({ deletedAccountMessages: 'anonymize' });
        expect((await ctx.request.patch('/admin/settings/accounts').set(owner.auth).send({ deletedAccountMessages: 'shred' })).status).toBe(400);
        expect((await ctx.request.patch('/admin/settings/accounts').set(owner.auth).send({ deletedAccountMessages: 'remove' })).status).toBe(200);
        expect((await ctx.request.get('/admin/settings/accounts').set(owner.auth)).body).toEqual({ deletedAccountMessages: 'remove' });
        expect((await ctx.request.get('/users/@me/deletion').set(alice.auth)).body.deletedAccountMessages).toBe('remove');
    });
});

describe('preview', () => {
    test('shows the policy and what blocks deletion', async () => {
        const mine = await ctx.request.get('/users/@me/deletion').set(alice.auth);
        expect(mine.status).toBe(200);
        expect(mine.body).toMatchObject({ deletedAccountMessages: 'anonymize', passkeys: 0, ownedServers: [], lastAdmin: false, ownedBots: [] });
        const theirs = await ctx.request.get('/users/@me/deletion').set(owner.auth);
        expect(theirs.body.ownedServers).toEqual([{ id: serverId, name: 'Deletion' }]);
    });
});

describe('re-authentication and confirmation', () => {
    test('needs the password or a passkey, the right password, and the username typed out', async () => {
        expect((await deleteAccount(alice, { confirm: 'ad_alice' })).status).toBe(400);
        const wrong = await deleteAccount(alice, { confirm: 'ad_alice', password: 'not-it' });
        expect(wrong.status).toBe(403);
        expect(wrong.body.error).toBe('reauth_failed');
        const mistyped = await deleteAccount(alice, { confirm: 'ad_alicee', password: PASSWORD });
        expect(mistyped.status).toBe(400);
        expect(mistyped.body.error).toBe('confirmation_mismatch');
        expect(await userExists(alice.userId)).toBe(true);
        expect((await ctx.request.get('/users/search?q=ad').set(alice.auth)).status).toBe(200);
    });

    test('a passkey assertion from one of your own passkeys works instead of the password', async () => {
        const key = new SoftPasskey({ origin: ORIGIN });
        const reg = await ctx.request.post('/auth/passkeys/register/options').set(alice.auth).set('Origin', ORIGIN).send();
        expect((await ctx.request.post('/auth/passkeys/register/verify').set(alice.auth).set('Origin', ORIGIN)
            .send({ flowId: reg.body.flowId, name: 'Phone', response: key.register(reg.body.options) })).status).toBe(201);

        // Someone else's ceremony can't be used
        const bobKey = new SoftPasskey({ origin: ORIGIN });
        const bob = await authedUser(ctx.request, 'ad_bob');
        const bobReg = await ctx.request.post('/auth/passkeys/register/options').set(bob.auth).set('Origin', ORIGIN).send();
        await ctx.request.post('/auth/passkeys/register/verify').set(bob.auth).set('Origin', ORIGIN)
            .send({ flowId: bobReg.body.flowId, name: 'Bob', response: bobKey.register(bobReg.body.options) });
        const bobFlow = await ctx.request.post('/users/@me/deletion/passkey-options').set(bob.auth).set('Origin', ORIGIN).send();
        const stolen = await deleteAccount(alice, { confirm: 'ad_alice', passkey: { flowId: bobFlow.body.flowId, response: key.authenticate(bobFlow.body.options) } });
        expect(stolen.status).toBe(403);
        expect(stolen.body.error).toBe('challenge_invalid');

        const flow = await ctx.request.post('/users/@me/deletion/passkey-options').set(alice.auth).set('Origin', ORIGIN).send();
        expect(flow.status).toBe(200);
        expect(flow.body.options.allowCredentials).toHaveLength(1);
        // An assertion from a key that isn't registered to alice fails
        const other = await deleteAccount(alice, { confirm: 'ad_alice', passkey: { flowId: flow.body.flowId, response: bobKey.authenticate(flow.body.options) } });
        expect(other.status).toBe(403);
        expect(await userExists(alice.userId)).toBe(true);

        const fresh = await ctx.request.post('/users/@me/deletion/passkey-options').set(alice.auth).set('Origin', ORIGIN).send();
        const ok = await deleteAccount(alice, { confirm: 'ad_alice', passkey: { flowId: fresh.body.flowId, response: key.authenticate(fresh.body.options) } });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(await userExists(alice.userId)).toBe(false);
        expect((await ctx.db.query('SELECT count(*)::int AS n FROM user_passkeys WHERE user_id = $1', [alice.userId])).rows[0].n).toBe(0);
    });

    test('bots cannot delete themselves through this route', async () => {
        const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'ad_bot' });
        const token = await ctx.request.post(`/servers/${serverId}/bots/${bot.body.id}/tokens`).set(owner.auth).send({});
        const res = await ctx.request.delete('/users/@me').set({ Authorization: `Bot ${token.body.token}` }).send({ confirm: 'ad_bot', password: 'x' });
        expect(res.status).toBe(403);
        expect(await userExists(bot.body.id)).toBe(true);
    });
});

describe('refusals', () => {
    test('a server owner must transfer or delete their servers first', async () => {
        const res = await deleteAccount(owner, { confirm: 'ad_owner', password: PASSWORD });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'owns_servers', servers: [{ id: serverId, name: 'Deletion' }] });
        expect(await userExists(owner.userId)).toBe(true);
    });

    test('the last instance admin cannot delete themselves; with a second admin they can', async () => {
        await makeAdmin(alice);
        expect((await ctx.request.get('/users/@me/deletion').set(alice.auth)).body.lastAdmin).toBe(true);
        const refused = await deleteAccount(alice, { confirm: 'ad_alice', password: PASSWORD });
        expect(refused.status).toBe(409);
        expect(refused.body.error).toBe('last_admin');
        await makeAdmin(owner);
        expect((await deleteAccount(alice, { confirm: 'ad_alice', password: PASSWORD })).status).toBe(200);
        expect(await userExists(alice.userId)).toBe(false);
    });
});

describe('anonymize (default)', () => {
    test('messages stay without an author and carry no authority; sessions end; the username is free', async () => {
        const role = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth)
            .send({ name: 'Director', permissions: Permissions.DirectAgents.toString() });
        expect((await ctx.request.put(`/servers/${serverId}/members/${alice.userId}/roles/${role.body.id}`).set(owner.auth)).status).toBe(200);
        const msg = await post(alice, 'keep this');
        expect(msg.authorAuthority).toBe('director');
        const parent = await post(owner, 'a thread');
        await reply(alice, parent.id, 'my reply');

        const socket = await connect(alice.token);
        const gone = event(socket, 'disconnect');
        const res = await deleteAccount(alice, { confirm: 'ad_alice', password: PASSWORD });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ deleted: true, deletedAccountMessages: 'anonymize' });
        await gone;

        // Every token of the account is dead
        expect((await ctx.request.get('/users/search?q=ad').set(alice.auth)).status).toBe(401);
        expect((await ctx.request.get('/users/@me/deletion').set(alice.auth)).status).toBe(401);

        const list = await ctx.request.get(`/channels/${channelId}/messages`).set(owner.auth);
        const kept = list.body.find((m: any) => m.id === msg.id);
        expect(kept).toMatchObject({ content: 'keep this', authorId: null, authorUsername: null, authorAuthority: null });
        expect(kept.systemEvent).toBeUndefined();
        // Agents see the post as a deleted account's, not as a system line, and with no tag
        const line = formatMessages(list.body).split('\n').find(l => l.includes(msg.id))!;
        expect(line).toContain(`(${msg.id}) Deleted user: keep this`);
        const stamp = await ctx.db.query('SELECT author_could_direct FROM messages WHERE id = $1', [msg.id]);
        expect(stamp.rows[0].author_could_direct).toBe(false);
        const replies = await ctx.request.get(`/channels/${channelId}/messages/${parent.id}/replies`).set(owner.auth);
        expect(replies.body.replies ?? replies.body).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'my reply', authorId: null })]));

        // A new account with the same name does not inherit the old messages or authority
        const again = await authedUser(ctx.request, 'ad_alice');
        expect(again.userId).not.toBe(alice.userId);
        const after = await ctx.request.get(`/channels/${channelId}/messages`).set(owner.auth);
        expect(after.body.find((m: any) => m.id === msg.id).authorId).toBeNull();

        const audit = await ctx.db.query(`SELECT actor_id, changes FROM audit_log WHERE action = 'account_delete' AND target_id = $1`, [alice.userId]);
        expect(audit.rows[0].actor_id).toBeNull();
        expect(audit.rows[0].changes).toMatchObject({ messages: 'anonymize', messagesRemoved: 0 });
    });

    test('an anonymized file stays readable to members; only ManageMessages can delete it', async () => {
        const up = await ctx.request.post('/files/upload').set(alice.auth).field('channel_id', channelId)
            .attach('file', Buffer.from('notes'), 'notes.txt');
        expect(up.status).toBe(201);
        await post(alice, 'file', { attachments: [up.body.id] });
        expect((await deleteAccount(alice, { confirm: 'ad_alice', password: PASSWORD })).status).toBe(200);
        expect((await ctx.request.get(`/files/${up.body.id}`).set(owner.auth)).status).toBe(200);
        const bob = await authedUser(ctx.request, 'ad_bob');
        await joinViaInvite(ctx.request, owner.auth, bob.auth, serverId);
        expect((await ctx.request.delete(`/files/${up.body.id}`).set(bob.auth)).status).toBe(403);
        expect((await ctx.request.delete(`/files/${up.body.id}`).set(owner.auth)).status).toBe(200);
    });
});

describe('remove', () => {
    test("deletes the person's messages and files, keeps other people's replies in their threads", async () => {
        await setPolicy('remove');
        const up = await ctx.request.post('/files/upload').set(alice.auth).field('channel_id', channelId)
            .attach('file', Buffer.from('secret notes'), 'secret.txt');
        expect(up.status).toBe(201);
        const withFile = await post(alice, 'see attached', { attachments: [up.body.id] });
        const key = (await ctx.db.query('SELECT storage_key FROM files WHERE id = $1', [up.body.id])).rows[0].storage_key.trim();
        expect(await storage.get(key)).not.toBeNull();

        const hers = await post(alice, 'my thread');
        await reply(owner, hers.id, 'owner answers');
        const his = await post(owner, 'owner thread');
        await reply(alice, his.id, 'alice answers');
        await reply(owner, his.id, 'owner again');
        const ownerMsg = await post(owner, 'unrelated');

        const res = await deleteAccount(alice, { confirm: 'ad_alice', password: PASSWORD });
        expect(res.status).toBe(200);
        expect(res.body.deletedAccountMessages).toBe('remove');

        const rows = await ctx.db.query(
            'SELECT id, content, deleted_at, author_id FROM messages WHERE id = ANY($1)',
            [[withFile.id, hers.id, ownerMsg.id]]
        );
        const byId = new Map(rows.rows.map((r: any) => [r.id.trim(), r]));
        for (const id of [withFile.id, hers.id]) {
            expect(byId.get(id).content).toBeNull();
            expect(byId.get(id).deleted_at).not.toBeNull();
            expect(byId.get(id).author_id).toBeNull();
        }
        expect(byId.get(ownerMsg.id).content).toBe('unrelated');
        const aliceReplies = await ctx.db.query(`SELECT count(*)::int AS n FROM messages WHERE content = 'alice answers'`);
        expect(aliceReplies.rows[0].n).toBe(0);

        // Her thread keeps the owner's reply under a deleted parent
        const hersReplies = await ctx.request.get(`/channels/${channelId}/messages/${hers.id}/replies`).set(owner.auth);
        expect(JSON.stringify(hersReplies.body)).toContain('owner answers');
        // The owner's thread lost one reply from its count
        const parent = await ctx.db.query('SELECT reply_count FROM messages WHERE id = $1', [his.id]);
        expect(parent.rows[0].reply_count).toBe(1);

        // The file is soft-deleted and its blob is gone
        const file = await ctx.db.query('SELECT deleted_at FROM files WHERE id = $1', [up.body.id]);
        expect(file.rows[0].deleted_at).not.toBeNull();
        expect((await ctx.request.get(`/files/${up.body.id}`).set(owner.auth)).status).toBe(404);
        expect(await storage.get(key)).toBeNull();
    });

    test('a refused deletion changes nothing', async () => {
        await setPolicy('remove');
        await makeAdmin(owner);
        const kept = await post(owner, 'still here');
        expect((await deleteAccount(owner, { confirm: 'ad_owner', password: PASSWORD })).status).toBe(409);
        const row = await ctx.db.query('SELECT content, deleted_at FROM messages WHERE id = $1', [kept.id]);
        expect(row.rows[0]).toMatchObject({ content: 'still here', deleted_at: null });
    });
});

describe('bots the person owns', () => {
    test('are paused with their tokens revoked and sockets dropped; history stays, the server can delete them', async () => {
        const created = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'ad_alicebot' });
        const botId = created.body.id as string;
        const token = await ctx.request.post(`/servers/${serverId}/bots/${botId}/tokens`).set(owner.auth).send({});
        expect((await ctx.request.post(`/channels/${channelId}/bots/${botId}`).set(owner.auth)).status).toBe(201);
        // The bot is alice's (as if she had created it with ManageBots)
        await ctx.db.query('UPDATE users SET bot_owner_id = $1 WHERE id = $2', [alice.userId, botId]);
        const botAuth = { Authorization: `Bot ${token.body.token}` };
        const botMsg = await ctx.request.post(`/channels/${channelId}/messages`).set(botAuth).send({ content: 'bot was here' });
        expect(botMsg.status).toBe(201);
        expect((await ctx.request.get('/users/@me/deletion').set(alice.auth)).body.ownedBots).toEqual([{ id: botId, username: 'ad_alicebot', serverId }]);

        const socket = await connect(token.body.token, true);
        const gone = event(socket, 'disconnect');
        expect((await deleteAccount(alice, { confirm: 'ad_alice', password: PASSWORD })).status).toBe(200);
        await gone;

        const bot = await ctx.db.query('SELECT bot_owner_id, bot_paused_at, bot_paused_reason FROM users WHERE id = $1', [botId]);
        expect(bot.rows[0].bot_owner_id).toBeNull();
        expect(bot.rows[0].bot_paused_at).not.toBeNull();
        expect(bot.rows[0].bot_paused_reason).toBe('Owner deleted their account');
        const live = await ctx.db.query('SELECT count(*)::int AS n FROM bot_tokens WHERE bot_id = $1 AND revoked_at IS NULL', [botId]);
        expect(live.rows[0].n).toBe(0);
        expect((await ctx.request.get(`/channels/${channelId}/messages`).set(botAuth)).status).toBe(401);

        const list = await ctx.request.get(`/channels/${channelId}/messages`).set(owner.auth);
        expect(list.body.find((m: any) => m.id === botMsg.body.id).authorUsername).toBe('ad_alicebot');
        expect((await ctx.request.delete(`/servers/${serverId}/bots/${botId}`).set(owner.auth)).status).toBe(200);
    });
});

describe('push devices', () => {
    const RELAY = 'https://relay.test';
    const HANDLES = ['A'.repeat(42) + 'b', 'C'.repeat(42) + 'd'];
    afterEach(() => setRelayFetch());

    test('are deleted, and each relay is told to forget its handle after commit', async () => {
        const calls: Array<{ url: string; method: string; auth: string }> = [];
        setRelayFetch(async (url, init) => {
            calls.push({ url, method: init.method!, auth: (init.headers as Record<string, string>).Authorization });
            return { status: 204, headers: { get: () => null } };
        });
        await makeAdmin(owner);
        expect((await ctx.request.patch('/admin/settings/push').set(owner.auth).send({ allowedRelays: [RELAY] })).status).toBe(200);
        for (const [user, handle] of [[alice, HANDLES[0]], [alice, HANDLES[1]], [owner, 'E'.repeat(42) + 'f']] as const) {
            const res = await ctx.request.post('/me/push-devices').set(user.auth).set('Origin', 'https://agora.example.test')
                .send({ relay: RELAY, handle, platform: 'android', label: 'Pixel 8' });
            expect(res.status, JSON.stringify(res.body)).toBe(201);
        }

        expect((await deleteAccount(alice, { confirm: 'ad_alice', password: PASSWORD })).status).toBe(200);
        expect((await ctx.db.query('SELECT 1 FROM push_devices WHERE user_id = $1', [alice.userId])).rows).toHaveLength(0);
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        expect(calls.map(c => c.auth).sort()).toEqual(HANDLES.map(h => `Bearer ${h}`).sort());
        for (const c of calls) expect(c).toMatchObject({ url: `${RELAY}/v1/handles`, method: 'DELETE' });
        // Someone else's device stays registered
        expect((await ctx.db.query('SELECT 1 FROM push_devices WHERE user_id = $1', [owner.userId])).rows).toHaveLength(1);
    });
});

describe('schema', () => {
    // A new foreign key to users with no ON DELETE action makes deletion fail at commit for
    // anyone with such a row. These three are cleared or refused by src/lib/account-deletion.ts.
    test('every foreign key to users says what happens on delete, or is handled before it', async () => {
        const rows = await ctx.db.query(
            `SELECT c.conrelid::regclass::text || '.' || a.attname AS col
             FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
             WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass AND c.confdeltype IN ('a', 'r')
             ORDER BY 1`
        );
        expect(rows.rows.map((r: any) => r.col)).toEqual(['channels.owner_id', 'files.trusted_by', 'servers.owner_id']);
    });
});

describe('row level security', () => {
    test('a deleted id sees nothing, and the deletion touched no one else', async () => {
        const up = await ctx.request.post('/files/upload').set(owner.auth).field('channel_id', channelId)
            .attach('file', Buffer.from('owner file'), 'owner.txt');
        await post(owner, 'owner file', { attachments: [up.body.id] });
        await setPolicy('remove');
        expect((await deleteAccount(alice, { confirm: 'ad_alice', password: PASSWORD })).status).toBe(200);

        const client = await ctx.db.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET LOCAL ROLE app_user');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [alice.userId]);
            expect((await client.query('SELECT id FROM files')).rows).toHaveLength(0);
            expect((await client.query('SELECT id FROM user_passkeys')).rows).toHaveLength(0);
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [owner.userId]);
            expect((await client.query('SELECT id FROM files WHERE id = $1', [up.body.id])).rows).toHaveLength(1);
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
        const ownerFile = await ctx.db.query('SELECT deleted_at FROM files WHERE id = $1', [up.body.id]);
        expect(ownerFile.rows[0].deleted_at).toBeNull();

        // An outsider still can't read the server's messages
        const outsider = await authedUser(ctx.request, 'ad_outsider');
        expect((await ctx.request.get(`/channels/${channelId}/messages`).set(outsider.auth)).status).toBe(403);
    });
});
