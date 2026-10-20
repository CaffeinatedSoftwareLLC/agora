import sharp from 'sharp';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { share, upload } from '../tagging-helpers';
import { storage } from '../../src/lib/storage';
import { generateUlid } from '../../src/utils/ulid';

/**
 * Agents looking at images shared in Agora (issue #117): bots download files in channels
 * they were given and nowhere else, see attachments in chat history, and read images
 * scaled down for a model through GET /files/:id/image.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let outsider: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let otherChannelId: string;
let botId: string;
let botAuth: { Authorization: string };
let smallPng: Buffer;
let shotId: string;          // small PNG posted in the bot's channel
let bigId: string;           // 3000x2000 PNG posted in the bot's channel
let hiddenId: string;        // PNG in a channel the bot was not given
let textId: string;

const pause = (paused: boolean) => ctx.db.query(
    `UPDATE users SET bot_paused_at = ${paused ? 'NOW()' : 'NULL'}, bot_paused_reason = NULL WHERE id = $1`, [botId]);

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    await storage.init();
    owner = await authedUser(ctx.request, 'imgowner');
    outsider = await authedUser(ctx.request, 'imgoutsider');
    ({ serverId, generalChannelId: channelId } = await createServer(ctx.request, owner.auth, 'Images'));
    const other = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: 'other', channelType: 3 });
    otherChannelId = other.body.id;

    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'looker' });
    botId = bot.body.id;
    const token = await ctx.request.post(`/servers/${serverId}/bots/${botId}/tokens`).set(owner.auth).send({ name: 'test' });
    botAuth = { Authorization: `Bot ${token.body.token}` };
    expect((await ctx.request.post(`/channels/${channelId}/bots/${botId}`).set(owner.auth)).status).toBeLessThan(300);

    smallPng = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#3a7' } }).png().toBuffer();
    const bigPng = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#a37' } }).png().toBuffer();
    shotId = await share(ctx.request, owner.auth, channelId, 'screenshot.png', smallPng);
    bigId = await share(ctx.request, owner.auth, channelId, 'big.png', bigPng);
    hiddenId = await share(ctx.request, owner.auth, otherChannelId, 'hidden.png', smallPng);
    textId = await share(ctx.request, owner.auth, channelId, 'notes.txt', 'just notes');
});

afterAll(async () => {
    await ctx.close();
});

afterEach(async () => { await pause(false); });

describe('bot file download (GET /files/:id)', () => {
    test('a bot downloads an image posted in a channel it was given', async () => {
        const res = await ctx.request.get(`/files/${shotId}`).set(botAuth).buffer(true).parse((r, cb) => {
            const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('image/png');
        expect(Buffer.compare(res.body, smallPng)).toBe(0);
    });

    test('a bot is refused files in channels it was not given', async () => {
        const res = await ctx.request.get(`/files/${hiddenId}`).set(botAuth);
        expect(res.status).toBe(403);
        expect((await ctx.request.get(`/files/${generateUlid()}`).set(botAuth)).status).toBe(404);
    });

    test('a paused bot cannot download', async () => {
        await pause(true);
        const res = await ctx.request.get(`/files/${shotId}`).set(botAuth);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('bot_paused');
    });

    test('an unattached upload cannot be downloaded by a bot', async () => {
        const loose = await upload(ctx.request, owner.auth, channelId, 'loose.png', smallPng);
        expect((await ctx.request.get(`/files/${loose}`).set(botAuth)).status).toBe(404);
    });

    test('people keep their access rules', async () => {
        expect((await ctx.request.get(`/files/${shotId}`).set(owner.auth)).status).toBe(200);
        expect((await ctx.request.get(`/files/${shotId}`).set(outsider.auth)).status).not.toBe(200);
    });
});

describe('attachments in chat history', () => {
    test('a bot sees the image attachments of messages in its channel, with file IDs', async () => {
        const res = await ctx.request.get(`/channels/${channelId}/messages`).set(botAuth);
        expect(res.status).toBe(200);
        const attachments = res.body.flatMap((m: any) => m.attachments ?? []);
        expect(attachments.map((a: any) => a.id)).toEqual(expect.arrayContaining([shotId, bigId, textId]));
        expect(attachments.find((a: any) => a.id === shotId)).toMatchObject({ name: 'screenshot.png', mime: 'image/png' });
        expect(attachments.map((a: any) => a.id)).not.toContain(hiddenId);
    });

    test('thread replies carry their attachments for bots too', async () => {
        const parent = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'thread' });
        const fileId = await upload(ctx.request, owner.auth, channelId, 'reply.png', smallPng);
        const reply = await ctx.request.post(`/channels/${channelId}/messages/${parent.body.id}/replies`).set(owner.auth)
            .send({ content: 'look' });
        expect(reply.status).toBe(201);
        // The reply route takes no attachments; bind the file the way agent-posted images are bound
        await ctx.db.query('UPDATE files SET message_id = $1 WHERE id = $2', [reply.body.id, fileId]);
        const res = await ctx.request.get(`/channels/${channelId}/messages/${parent.body.id}/replies`).set(botAuth);
        expect(res.status).toBe(200);
        const list = Array.isArray(res.body) ? res.body : res.body.replies ?? res.body.messages;
        expect(list.flatMap((m: any) => m.attachments ?? []).map((a: any) => a.id)).toContain(fileId);
    });
});

describe('GET /files/:id/image', () => {
    const image = (id: string, auth: object = botAuth) => ctx.request.get(`/files/${id}/image`).set(auth);

    test('a small image comes back untouched, with its uploader', async () => {
        const res = await image(shotId);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            id: shotId, name: 'screenshot.png', mime: 'image/png', originalMime: 'image/png',
            width: 40, height: 30, resized: false, bytes: smallPng.length,
            uploader: { id: owner.userId, username: 'imgowner' },
        });
        expect(Buffer.compare(Buffer.from(res.body.data, 'base64'), smallPng)).toBe(0);
    });

    test('a large image is scaled down to 1568px on its longest side', async () => {
        const res = await image(bigId);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ resized: true, width: 1568, height: 1045, originalWidth: 3000, originalHeight: 2000 });
        const meta = await sharp(Buffer.from(res.body.data, 'base64')).metadata();
        expect([meta.width, meta.height]).toEqual([1568, 1045]);
        expect(res.body.data.length).toBeLessThanOrEqual(3.5 * 1024 * 1024);
    });

    test('other channels, missing files and non-images', async () => {
        const hidden = await image(hiddenId);
        const missing = await image(generateUlid());
        expect(hidden.status).toBe(404);
        expect(hidden.body).toEqual(missing.body);
        expect((await image(textId)).status).toBe(415);
        expect((await image(hiddenId, outsider.auth)).status).toBe(404);
        expect((await ctx.request.get(`/files/${shotId}/image`)).status).toBe(401);
    });

    test('a paused bot cannot read images; people can', async () => {
        await pause(true);
        expect((await image(shotId)).status).toBe(403);
        expect((await image(shotId, owner.auth)).status).toBe(200);
    });
});
