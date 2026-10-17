import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { Permissions } from '../../src/permissions';
import { generateUlid } from '../../src/utils/ulid';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let messageId: string;
let botAuth: { Authorization: string };

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'viewowner');
    member = await authedUser(ctx.request, 'viewmember');
    const server = await createServer(ctx.request, owner.auth, 'Visibility');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    const message = await ctx.request.post(`/channels/${channelId}/messages`).set(member.auth).send({ content: 'private text' });
    expect(message.status).toBe(201);
    messageId = message.body.id;
    expect((await ctx.request.post(`/channels/${channelId}/messages/${messageId}/replies`).set(member.auth).send({ content: 'private reply' })).status).toBe(201);
    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'viewbot' });
    const token = await ctx.request.post(`/servers/${serverId}/bots/${bot.body.id}/tokens`).set(owner.auth).send({});
    botAuth = { Authorization: `Bot ${token.body.token}` };
    expect((await ctx.request.post(`/channels/${channelId}/bots/${bot.body.id}`).set(owner.auth)).status).toBe(201);
    expect((await ctx.request.put(`/channels/${channelId}/overrides/members/${member.userId}`).set(owner.auth)
        .send({ allow: '0', deny: Permissions.ViewChannel.toString() })).status).toBe(200);
});
afterAll(async () => { await ctx.close(); });

test('hidden message and thread reads are refused despite server membership', async () => {
    for (const path of [`/channels/${channelId}/messages`, `/channels/${channelId}/messages?before=${messageId}`,
        `/channels/${channelId}/messages/${messageId}/replies`, `/channels/${channelId}/threads`]) {
        expect((await ctx.request.get(path).set(member.auth)).status).toBe(403);
        expect((await ctx.request.get(path).set(owner.auth)).status).toBe(200);
    }
});

test('a member cannot send, edit, delete, reply or close threads in a hidden channel', async () => {
    const responses = [
        await ctx.request.post(`/channels/${channelId}/messages`).set(member.auth).send({ content: 'blocked' }),
        await ctx.request.patch(`/channels/${channelId}/messages/${messageId}`).set(member.auth).send({ content: 'blocked' }),
        await ctx.request.delete(`/channels/${channelId}/messages/${messageId}`).set(member.auth),
        await ctx.request.post(`/channels/${channelId}/messages/${messageId}/replies`).set(member.auth).send({ content: 'blocked' }),
        await ctx.request.patch(`/channels/${channelId}/messages/${messageId}/thread`).set(member.auth).send({ closed: true }),
    ];
    expect(responses.map(r => r.status)).toEqual([403, 403, 403, 403, 403]);
    const original = (await ctx.db.query('SELECT content, deleted_at FROM messages WHERE id=$1', [messageId])).rows[0];
    expect(original).toEqual({ content: 'private text', deleted_at: null });
});

test('hidden channel names and unread metadata are omitted from REST lists', async () => {
    const channels = await ctx.request.get(`/servers/${serverId}/channels`).set(member.auth);
    expect(channels.status).toBe(200);
    expect(channels.body).toEqual([]);
    const unreads = await ctx.request.get('/unreads').set(member.auth);
    expect(unreads.status).toBe(200);
    expect(unreads.body).toEqual([]);
    expect((await ctx.request.get(`/channels/${channelId}/unreads`).set(member.auth)).status).toBe(403);
    expect((await ctx.request.put(`/channels/${channelId}/ack`).set(member.auth).send({ messageId })).status).toBe(403);
});

test('hidden members cannot inspect run output, download code or approve the run', async () => {
    const runId = generateUlid();
    await ctx.db.query(
        `INSERT INTO exec_runs (id,server_id,channel_id,submitted_by,code,code_sha256,limits,gate_decision,status)
         VALUES ($1,$2,$3,$4,'private code',$5,'{}','needs_approval','awaiting_approval')`,
        [runId, serverId, channelId, member.userId, 'a'.repeat(64)]);
    expect((await ctx.request.get(`/runtime/runs/${runId}`).set(member.auth)).status).toBe(404);
    expect((await ctx.request.get(`/runtime/runs/${runId}/code`).set(member.auth)).status).toBe(404);
    expect((await ctx.request.post(`/runtime/runs/${runId}/approve`).set(member.auth)).status).toBe(404);
    expect((await ctx.request.get(`/runtime/runs/${runId}`).set(owner.auth)).status).toBe(200);
});

test('explicitly allowlisted bots retain access, and removing the member deny restores access', async () => {
    expect((await ctx.request.get(`/channels/${channelId}/messages`).set(botAuth)).status).toBe(200);
    expect((await ctx.request.get(`/channels/${channelId}/messages/${messageId}/replies`).set(botAuth)).status).toBe(200);
    expect((await ctx.request.delete(`/channels/${channelId}/overrides/members/${member.userId}`).set(owner.auth)).status).toBe(200);
    expect((await ctx.request.get(`/channels/${channelId}/messages`).set(member.auth)).status).toBe(200);
    const channels = await ctx.request.get(`/servers/${serverId}/channels`).set(member.auth);
    expect(channels.body.map((c: any) => c.id)).toContain(channelId);
});
