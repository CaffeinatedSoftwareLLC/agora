import { afterAll, beforeAll, expect, test } from 'vitest';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { Permissions } from '../../src/permissions';
import { invalidateSettingsCache } from '../../src/lib/settings';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let channelId: string, serverId: string, roleId: string, botId: string;
let auth: { Authorization: string };
beforeAll(async () => {
    ctx = await setupTestApp(); await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'uploadowner');
    const server = await createServer(ctx.request, owner.auth, 'Bot upload tests');
    channelId = server.generalChannelId; serverId = server.serverId; roleId = server.everyoneRoleId;
    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'uploadbot' });
    expect(bot.status).toBe(201); botId = bot.body.id;
    const token = await ctx.request.post(`/servers/${serverId}/bots/${botId}/tokens`).set(owner.auth).send({ name: 'upload-tests' });
    expect(token.status).toBe(201); auth = { Authorization: `Bot ${token.body.token}` };
    expect((await ctx.request.post(`/channels/${channelId}/bots/${botId}`).set(owner.auth)).status).toBe(201);
});
afterAll(async () => { await ctx.close(); });

const upload = (name = 'report.txt', bytes = Buffer.from('report from a bot')) => ctx.request.post('/files/upload').set(auth)
    .field('channel_id', channelId).attach('file', bytes, name);
const count = async () => Number((await ctx.db.query('SELECT COUNT(*) AS n FROM files')).rows[0].n);

test('bot upload returns 201 and can be attached to a channel post and a thread reply', async () => {
    expect((await ctx.db.query('SELECT 1 FROM server_members WHERE user_id = $1', [botId])).rows).toHaveLength(0);
    const file = await upload(); expect(file.status, JSON.stringify(file.body)).toBe(201);
    expect(file.body).toMatchObject({ name: 'report.txt', mime: 'text/plain', size: 17 });
    const post = await ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content: '', attachments: [file.body.id] });
    expect(post.status, JSON.stringify(post.body)).toBe(201);
    expect(post.body.attachments[0].id).toBe(file.body.id);
    const second = await upload('reply.txt'); expect(second.status).toBe(201);
    const reply = await ctx.request.post(`/channels/${channelId}/messages/${post.body.id}/replies`).set(auth).send({ content: 'Attached report', attachments: [second.body.id] });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(reply.body.attachments[0].id).toBe(second.body.id);
    const download = await ctx.request.get(`/files/${file.body.id}`).set(owner.auth);
    expect(download.status).toBe(200);
    expect(Buffer.isBuffer(download.body) ? download.body.toString() : download.text).toBe('report from a bot');
});

test.each([Permissions.UploadFiles, Permissions.SendMessages, Permissions.ViewChannel])('bot upload enforces channel permission %s without storing a file', async deny => {
    const before = await count();
    await ctx.db.query('INSERT INTO channel_role_overrides (channel_id, role_id, allow, deny) VALUES ($1, $2, 0, $3) ON CONFLICT (channel_id, role_id) DO UPDATE SET deny = EXCLUDED.deny', [channelId, roleId, deny.toString()]);
    try { expect((await upload()).status).toBe(403); expect(await count()).toBe(before); }
    finally { await ctx.db.query('UPDATE channel_role_overrides SET deny = 0 WHERE channel_id = $1 AND role_id = $2', [channelId, roleId]); }
});

test('bot cannot upload to a channel outside its allowlist', async () => {
    const other = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: 'forbidden', channelType: 3 });
    expect(other.status).toBe(201);
    const before = await count();
    const result = await ctx.request.post('/files/upload').set(auth).field('channel_id', other.body.id).attach('file', Buffer.from('no'), 'no.txt');
    expect(result.status).toBe(403); expect(await count()).toBe(before);
});

test('bot upload keeps admin size, extension, magic-byte and quota checks', async () => {
    const original = (await ctx.db.query("SELECT key, value FROM instance_settings WHERE key LIKE 'files.%'")).rows;
    const setting = async (key: string, value: unknown) => {
        await ctx.db.query('INSERT INTO instance_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]);
        invalidateSettingsCache();
    };
    const before = await count();
    try {
        await setting('files.max_size_bytes', 1024);
        expect((await upload('big.txt', Buffer.alloc(2048, 'x'))).status).toBe(413);
        await setting('files.max_size_bytes', 26214400);
        await setting('files.allowed_extensions', ['txt']);
        expect((await upload('forbidden.pdf', Buffer.from('%PDF-1.4 test'))).status).toBe(415);
        await setting('files.allowed_extensions', ['txt', 'png']);
        expect((await upload('fake.png', Buffer.from('this is not a PNG'))).status).toBe(415);
        await setting('files.storage_quota_bytes', 1);
        expect((await upload()).status).toBe(507);
        expect(await count()).toBe(before);
    } finally {
        for (const row of original) await setting(row.key, row.value);
    }
});

test('paused bots remain read-only and cannot upload', async () => {
    await ctx.db.query('UPDATE users SET bot_paused_at = NOW() WHERE id = $1', [botId]);
    try { expect((await upload()).status).toBe(423); }
    finally { await ctx.db.query('UPDATE users SET bot_paused_at = NULL WHERE id = $1', [botId]); }
});
