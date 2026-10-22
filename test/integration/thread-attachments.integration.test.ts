import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { setupTestApp, authedUser, createServer, cleanDatabase, joinViaInvite } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: any, member: any, channelId: string, otherChannelId: string, parentId: string;
beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'threadfilesowner');
    member = await authedUser(ctx.request, 'threadfilesmember');
    const server = await createServer(ctx.request, owner.auth, 'Thread files');
    channelId = server.generalChannelId;
    await joinViaInvite(ctx.request, owner.auth, member.auth, server.serverId);
    const channel = await ctx.request.post(`/servers/${server.serverId}/channels`).set(owner.auth).send({ name: 'other', channelType: 3 });
    expect(channel.status).toBe(201);
    otherChannelId = channel.body.id;
    const parent = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'Thread parent' });
    parentId = parent.body.id;
});
afterAll(async () => { await ctx.close(); });

async function file(overrides: { uploaderId?: string; channelId?: string; messageId?: string; deleted?: boolean } = {}) {
    const id = generateUlid();
    await ctx.db.query(`INSERT INTO files
        (id, uploader_id, channel_id, message_id, filename, content_type, mime_type, size_bytes, bucket, path, storage_key, encryption_iv, encryption_tag, deleted_at)
        VALUES ($1,$2,$3,$4,'note.txt','text/plain','text/plain',3,'agora-files',$5,$6,$7,$8,$9)`,
        [id, overrides.uploaderId ?? owner.userId, overrides.channelId ?? channelId, overrides.messageId ?? null,
            `${id}/note.txt`, `${id}/note.txt`, Buffer.alloc(12), Buffer.alloc(16), overrides.deleted ? new Date() : null]);
    return id;
}
const post = (body: Record<string, unknown>) => ctx.request.post(`/channels/${channelId}/messages/${parentId}/replies`).set(owner.auth).send(body);

describe('thread reply attachments (#207)', () => {
    it('returns numeric attachment sizes on channel posts as well as replies', async () => {
        const id = await file();
        const res = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ attachments: [id] });
        expect(res.status).toBe(201);
        expect(res.body.attachments[0].size).toBe(3);
    });
    it('creates an attachment-only reply with response and read envelopes', async () => {
        const id = await file();
        const res = await post({ attachments: [id] });
        expect(res.status).toBe(201);
        expect(res.body.content).toBeNull();
        expect(res.body.threadId).toBe(parentId);
        expect(res.body.attachments).toEqual([expect.objectContaining({ id, name: 'note.txt', mime: 'text/plain', size: 3, url: `/files/${id}` })]);
        const reads = await ctx.request.get(`/channels/${channelId}/messages/${parentId}/replies`).set(owner.auth);
        expect(reads.body.find((r: any) => r.id === res.body.id).attachments).toEqual([expect.objectContaining(res.body.attachments[0])]);
        expect((await ctx.db.query('SELECT message_id FROM files WHERE id=$1', [id])).rows[0].message_id.trim()).toBe(res.body.id);
    });

    it('accepts text with ten files and refuses an eleven-item schema', async () => {
        const ids = await Promise.all(Array.from({ length: 10 }, () => file()));
        const res = await post({ content: 'Ten notes', attachments: ids });
        expect(res.status).toBe(201);
        expect(res.body.attachments).toHaveLength(10);
        expect((await post({ attachments: [...ids, generateUlid()] })).status).toBe(400);
    });

    it.each(['deleted', 'foreign', 'channel', 'bound', 'missing', 'duplicate'] as const)('rejects a %s attachment before creating a reply or changing its parent', async kind => {
        const id = kind === 'missing' ? generateUlid() : await file({
            deleted: kind === 'deleted', uploaderId: kind === 'foreign' ? member.userId : undefined,
            channelId: kind === 'channel' ? otherChannelId : undefined, messageId: kind === 'bound' ? parentId : undefined,
        });
        const before = (await ctx.db.query('SELECT reply_count FROM messages WHERE id=$1', [parentId])).rows[0].reply_count;
        const marker = `refused-${kind}`;
        const res = await post({ content: marker, attachments: kind === 'duplicate' ? [id, id] : [id] });
        expect(res.status).toBe(400);
        expect((await ctx.db.query('SELECT id FROM messages WHERE content=$1', [marker])).rows).toHaveLength(0);
        expect((await ctx.db.query('SELECT reply_count FROM messages WHERE id=$1', [parentId])).rows[0].reply_count).toBe(before);
    });

    it('does not bind any valid file when another ID is invalid, and permits retry', async () => {
        const id = await file();
        expect((await post({ content: 'mixed', attachments: [id, generateUlid()] })).status).toBe(400);
        expect((await ctx.db.query('SELECT message_id FROM files WHERE id=$1', [id])).rows[0].message_id).toBeNull();
        expect((await post({ attachments: [id] })).status).toBe(201);
    });

    it('rejects empty arrays with no content or artifact', async () => {
        expect((await post({ attachments: [] })).status).toBe(400);
    });

    it('serializes concurrent channel/reply claims on the same file', async () => {
        const id = await file();
        const results = await Promise.all([
            post({ content: 'reply claim', attachments: [id] }),
            ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'channel claim', attachments: [id] }),
        ]);
        expect(results.map(r => r.status).sort()).toEqual([201, 400]);
        const winner = results.find(r => r.status === 201)!;
        expect((await ctx.db.query('SELECT message_id FROM files WHERE id=$1', [id])).rows[0].message_id.trim()).toBe(winner.body.id);
    });

    it('replays concurrent client-key retries that share an attachment', async () => {
        const id = await file();
        const body = { content: 'one keyed reply', attachments: [id], client_key: `thread-file-${generateUlid()}` };
        const results = await Promise.all([post(body), post(body)]);
        expect(results.map(r => r.status).sort()).toEqual([200, 201]);
        expect(results[0].body.id).toBe(results[1].body.id);
        expect(results[0].body.attachments).toEqual(results[1].body.attachments);
    });
});
