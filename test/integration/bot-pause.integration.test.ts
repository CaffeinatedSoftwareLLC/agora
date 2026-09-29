import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { parseBotToken } from '../../src/auth/bot-tokens';

/**
 * Bot pause/resume: admins can halt a bot without revoking its tokens.
 * Paused bots keep read access (and cursor updates) but every other write is 423.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

async function waitForRow(table: string, column: string, value: string) {
    for (let i = 0; i < 20; i++) {
        const res = await ctx.db.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [value]);
        if (res.rows.length > 0) return;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`Row never appeared: ${table}.${column} = ${value}`);
}

/** Poll until the bot's paused state matches (onResponse COMMIT race). */
async function waitForPaused(botId: string, paused: boolean) {
    for (let i = 0; i < 20; i++) {
        const res = await ctx.db.query('SELECT bot_paused_at FROM users WHERE id = $1', [botId]);
        if ((res.rows[0].bot_paused_at !== null) === paused) return;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`Bot ${botId} paused state never became ${paused}`);
}

let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let botId: string;
let botAuth: { Authorization: string };
let parentId: string;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);

    owner = await authedUser(ctx.request, 'pauseowner');
    const server = await createServer(ctx.request, owner.auth, 'Pause Server');
    serverId = server.serverId;
    channelId = server.generalChannelId;

    member = await authedUser(ctx.request, 'pausemember');
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);

    const botRes = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'pausebot' });
    botId = botRes.body.id;
    await waitForRow('users', 'id', botId);

    const tokenRes = await ctx.request.post(`/servers/${serverId}/bots/${botId}/tokens`).set(owner.auth).send({});
    botAuth = { Authorization: `Bot ${tokenRes.body.token}` };
    await waitForRow('bot_tokens', 'id', parseBotToken(tokenRes.body.token)!.tokenId);

    await ctx.request.post(`/channels/${channelId}/bots/${botId}`).set(owner.auth);
    await waitForRow('bot_channel_access', 'bot_id', botId);

    const parent = await ctx.request.post(`/channels/${channelId}/messages`).set(botAuth).send({ content: 'bot thread' });
    parentId = parent.body.id;
    await waitForRow('messages', 'id', parentId);
});

afterAll(async () => {
    await ctx.close();
});

describe('PATCH /servers/:serverId/bots/:id/pause', () => {
    test('non-admin member cannot pause', async () => {
        const res = await ctx.request
            .patch(`/servers/${serverId}/bots/${botId}/pause`)
            .set(member.auth)
            .send({ paused: true });
        expect(res.status).toBe(403);
    });

    test('bots cannot pause bots', async () => {
        const res = await ctx.request
            .patch(`/servers/${serverId}/bots/${botId}/pause`)
            .set(botAuth)
            .send({ paused: true });
        expect(res.status).toBe(403);
    });

    test('rejects invalid bodies', async () => {
        const res = await ctx.request
            .patch(`/servers/${serverId}/bots/${botId}/pause`)
            .set(owner.auth)
            .send({ reason: 'no flag' });
        expect(res.status).toBe(400);
    });

    test('unknown bot is 404', async () => {
        const res = await ctx.request
            .patch(`/servers/${serverId}/bots/01AAAAAAAAAAAAAAAAAAAAAAAA/pause`)
            .set(owner.auth)
            .send({ paused: true });
        expect(res.status).toBe(404);
    });

    test('admin pauses with a reason; audit entry written', async () => {
        const res = await ctx.request
            .patch(`/servers/${serverId}/bots/${botId}/pause`)
            .set(owner.auth)
            .send({ paused: true, reason: 'looping' });

        expect(res.status).toBe(200);
        expect(res.body.id).toBe(botId);
        expect(res.body.pausedAt).toBeTruthy();
        expect(res.body.pausedReason).toBe('looping');
        await waitForPaused(botId, true);

        const audit = await ctx.db.query(
            "SELECT action, reason FROM audit_log WHERE target_id = $1 AND action = 'bot_pause'",
            [botId]
        );
        expect(audit.rows[0].reason).toBe('looping');
    });
});

describe('while paused', () => {
    test('bot list and /bots/@me report the pause', async () => {
        const list = await ctx.request.get(`/servers/${serverId}/bots`).set(owner.auth);
        const bot = list.body.find((b: any) => b.id === botId);
        expect(bot.pausedAt).toBeTruthy();
        expect(bot.pausedReason).toBe('looping');

        const me = await ctx.request.get('/bots/@me').set(botAuth);
        expect(me.status).toBe(200);
        expect(me.body.paused).toBe(true);
        expect(me.body.pausedReason).toBe('looping');
    });

    test('reads still work', async () => {
        const res = await ctx.request.get(`/channels/${channelId}/messages`).set(botAuth);
        expect(res.status).toBe(200);
        const replies = await ctx.request.get(`/channels/${channelId}/messages/${parentId}/replies`).set(botAuth);
        expect(replies.status).toBe(200);
    });

    test('cursor updates still work', async () => {
        const res = await ctx.request
            .put(`/bots/@me/cursors/${channelId}`)
            .set(botAuth)
            .send({ lastReadId: parentId });
        expect(res.status).toBe(200);
    });

    test('sending, replying, editing, and closing threads are 423', async () => {
        const send = await ctx.request.post(`/channels/${channelId}/messages`).set(botAuth).send({ content: 'hi' });
        expect(send.status).toBe(423);
        expect(send.body).toMatchObject({ error: 'bot_paused', reason: 'looping' });

        const reply = await ctx.request
            .post(`/channels/${channelId}/messages/${parentId}/replies`)
            .set(botAuth)
            .send({ content: 'hi' });
        expect(reply.status).toBe(423);

        const edit = await ctx.request
            .patch(`/channels/${channelId}/messages/${parentId}`)
            .set(botAuth)
            .send({ content: 'edited' });
        expect(edit.status).toBe(423);

        const close = await ctx.request
            .patch(`/channels/${channelId}/messages/${parentId}/thread`)
            .set(botAuth)
            .send({ closed: true });
        expect(close.status).toBe(423);
    });

    test('pausing again keeps the original pausedAt', async () => {
        const before = await ctx.db.query('SELECT bot_paused_at FROM users WHERE id = $1', [botId]);
        const res = await ctx.request
            .patch(`/servers/${serverId}/bots/${botId}/pause`)
            .set(owner.auth)
            .send({ paused: true, reason: 'still looping' });
        expect(res.status).toBe(200);
        expect(new Date(res.body.pausedAt).getTime()).toBe(new Date(before.rows[0].bot_paused_at).getTime());
        expect(res.body.pausedReason).toBe('still looping');
    });
});

describe('resume', () => {
    test('admin resumes; bot can post again', async () => {
        const res = await ctx.request
            .patch(`/servers/${serverId}/bots/${botId}/pause`)
            .set(owner.auth)
            .send({ paused: false });
        expect(res.status).toBe(200);
        expect(res.body.pausedAt).toBeNull();
        expect(res.body.pausedReason).toBeNull();
        await waitForPaused(botId, false);

        const send = await ctx.request.post(`/channels/${channelId}/messages`).set(botAuth).send({ content: 'back' });
        expect(send.status).toBe(201);

        const me = await ctx.request.get('/bots/@me').set(botAuth);
        expect(me.body.paused).toBe(false);
    });
});
