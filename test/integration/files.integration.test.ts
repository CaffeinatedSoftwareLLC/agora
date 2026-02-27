import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { setupTestApp, authedUser, createServer, cleanDatabase, joinViaInvite } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { hashPassword } from '../../src/auth/passwords';
import { generateToken } from '../../src/auth/tokens';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: any, member: any, serverId: string, channelId: string, everyoneRoleId: string;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'fileowner');
    member = await authedUser(ctx.request, 'filemember');
    const srv = await createServer(ctx.request, owner.auth, 'File Server');
    serverId = srv.serverId;
    channelId = srv.generalChannelId;
    everyoneRoleId = srv.everyoneRoleId;
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
});
afterAll(async () => { await ctx.close(); });

// ─── Helpers ───

/** Insert a file row directly into DB, bypassing MinIO upload. */
async function insertTestFile(opts: {
    id?: string;
    uploaderId: string;
    channelId: string;
    messageId?: string;
    filename?: string;
    mimeType?: string;
    sizeBytes?: number;
}): Promise<string> {
    const id = opts.id ?? generateUlid();
    await ctx.db.query(`
        INSERT INTO files (id, uploader_id, channel_id, message_id, filename, content_type, mime_type, size_bytes, bucket, path, storage_key, encryption_iv, encryption_tag)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [
        id,
        opts.uploaderId,
        opts.channelId,
        opts.messageId ?? null,
        opts.filename ?? 'test.txt',
        opts.mimeType ?? 'text/plain',
        opts.mimeType ?? 'text/plain',
        opts.sizeBytes ?? 100,
        'agora-files',
        `${opts.channelId}/${id}/test.txt`,
        `${opts.channelId}/${id}/test.txt`,
        Buffer.from('0'.repeat(24), 'hex'),  // dummy 12-byte IV
        Buffer.from('0'.repeat(32), 'hex'),  // dummy 16-byte auth tag
    ]);
    return id;
}

/** Create a user with is_instance_admin = true directly in DB. */
async function insertAdminUser(username: string) {
    const id = generateUlid();
    const passwordHash = await hashPassword('TestPass123!');
    await ctx.db.query(
        `INSERT INTO users (id, username, email, password_hash, account_status, is_instance_admin)
         VALUES ($1, $2, $3, $4, 'active', true)`,
        [id, username, `${username}@test.com`, passwordHash]
    );
    const token = generateToken({ userId: id }, 'test-secret-do-not-use-in-prod');
    return { userId: id, token, auth: { Authorization: `Bearer ${token}` } };
}

// Pad ULID to exactly 26 chars (Crockford base32)
const FAKE_ULID = '00000000000000000000000000';

// ─── Test Suites ───

describe('Admin file settings', () => {
    let admin: any;

    beforeAll(async () => {
        admin = await insertAdminUser('fileadmin');
    });

    test('GET /admin/settings/files returns default settings', async () => {
        const res = await ctx.request
            .get('/admin/settings/files')
            .set(admin.auth);

        expect(res.status).toBe(200);
        expect(res.body['files.max_size_bytes']).toBe(26214400);
        expect(res.body['files.allowed_extensions']).toBeInstanceOf(Array);
        expect(res.body['files.exif_strip']).toBe(true);
        expect(res.body['files.retention_days']).toBeNull();
        expect(res.body['files.storage_quota_bytes']).toBeNull();
    });

    test('PATCH /admin/settings/files requires admin', async () => {
        const res = await ctx.request
            .patch('/admin/settings/files')
            .set(member.auth)
            .send({ 'files.max_size_bytes': 1024 });

        expect(res.status).toBe(403);
    });

    test('PATCH /admin/settings/files updates settings', async () => {
        const res = await ctx.request
            .patch('/admin/settings/files')
            .set(admin.auth)
            .send({ 'files.max_size_bytes': 5242880 });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Verify the update persisted
        const getRes = await ctx.request
            .get('/admin/settings/files')
            .set(admin.auth);
        expect(getRes.body['files.max_size_bytes']).toBe(5242880);

        // Restore default for other tests
        await ctx.request
            .patch('/admin/settings/files')
            .set(admin.auth)
            .send({ 'files.max_size_bytes': 26214400 });
    });

    test('GET /admin/storage returns storage stats', async () => {
        const res = await ctx.request
            .get('/admin/storage')
            .set(admin.auth);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('totalFiles');
        expect(res.body).toHaveProperty('totalBytes');
        expect(res.body).toHaveProperty('imageCount');
        expect(res.body).toHaveProperty('imageBytes');
        expect(res.body).toHaveProperty('expiringFiles');
        expect(typeof res.body.totalFiles).toBe('number');
    });

    test('GET /admin/storage requires admin', async () => {
        const res = await ctx.request
            .get('/admin/storage')
            .set(member.auth);

        expect(res.status).toBe(403);
    });
});

describe('Message attachments', () => {
    test('message with valid attachment succeeds', async () => {
        const fileId = await insertTestFile({ uploaderId: owner.userId, channelId });
        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'with file', attachments: [fileId] });

        expect(res.status).toBe(201);
        expect(res.body.attachments).toHaveLength(1);
        expect(res.body.attachments[0].id).toBe(fileId);
        expect(res.body.attachments[0].url).toBe(`/files/${fileId}`);
    });

    test('message rejected when attachment belongs to different user', async () => {
        const fileId = await insertTestFile({ uploaderId: member.userId, channelId });
        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'stolen', attachments: [fileId] });

        expect(res.status).toBe(400);
        // RLS prevents the requesting user from seeing files they don't own,
        // so the error may be "invalid or deleted" rather than "does not belong"
        expect(res.body.error).toBeDefined();
    });

    test('message rejected when attachment channel mismatch', async () => {
        // Create a second channel in the same server
        const ch2Res = await ctx.request
            .post(`/servers/${serverId}/channels`)
            .set(owner.auth)
            .send({ name: 'other-ch', channelType: 0 });
        const otherChannelId = ch2Res.body.id;

        const fileId = await insertTestFile({ uploaderId: owner.userId, channelId: otherChannelId });
        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'wrong channel', attachments: [fileId] });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/channel/i);
    });

    test('message rejected when attachment already bound to another message', async () => {
        const fileId = await insertTestFile({ uploaderId: owner.userId, channelId });

        // First message succeeds
        const first = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'first', attachments: [fileId] });
        expect(first.status).toBe(201);

        // Second message with same attachment fails
        const second = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'second', attachments: [fileId] });
        expect(second.status).toBe(400);
        expect(second.body.error).toMatch(/bound|already/i);
    });

    test('message rejected with >10 attachments', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 11; i++) {
            ids.push(await insertTestFile({ uploaderId: owner.userId, channelId }));
        }

        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'too many', attachments: ids });

        // Fastify schema validation rejects maxItems: 10
        expect(res.status).toBe(400);
    });

    test('message rejected with duplicate attachment IDs', async () => {
        const fileId = await insertTestFile({ uploaderId: owner.userId, channelId });
        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'dupes', attachments: [fileId, fileId] });

        expect(res.status).toBe(400);
    });

    test('message rejected when attachment ID does not exist', async () => {
        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'missing', attachments: [FAKE_ULID] });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid|deleted/i);
    });

    test('message with attachments only (no content) succeeds', async () => {
        const fileId = await insertTestFile({ uploaderId: owner.userId, channelId });
        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ attachments: [fileId] });

        expect(res.status).toBe(201);
        expect(res.body.content).toBeNull();
        expect(res.body.attachments).toHaveLength(1);
    });

    test('GET messages includes attachments', async () => {
        const fileId = await insertTestFile({ uploaderId: owner.userId, channelId });
        await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: 'has-file-marker', attachments: [fileId] });

        const res = await ctx.request
            .get(`/channels/${channelId}/messages`)
            .set(owner.auth);

        expect(res.status).toBe(200);
        const msgWithFile = res.body.find((m: any) => m.content === 'has-file-marker');
        expect(msgWithFile).toBeDefined();
        expect(msgWithFile.attachments).toBeDefined();
        expect(msgWithFile.attachments.length).toBeGreaterThanOrEqual(1);
        expect(msgWithFile.attachments[0].id).toBe(fileId);
        expect(msgWithFile.attachments[0].url).toBe(`/files/${fileId}`);
    });

    test('message with empty attachments array and no content succeeds (empty array is valid)', async () => {
        // Fastify schema treats an empty array as satisfying the `attachments` key in anyOf,
        // and the handler treats zero-length attachmentIds as no attachments.
        // This is a valid edge case — the message is created with no content and no attachments.
        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ attachments: [] });

        // Server accepts this; content ends up null and attachments empty
        expect(res.status).toBe(201);
    });
});

describe('File download', () => {
    test('GET /files/:id returns 404 for non-existent file', async () => {
        const res = await ctx.request
            .get(`/files/${FAKE_ULID}`)
            .set(owner.auth);

        expect(res.status).toBe(404);
    });

    test('GET /files/:id returns 404 for soft-deleted file', async () => {
        const fileId = await insertTestFile({ uploaderId: owner.userId, channelId });
        await ctx.db.query('UPDATE files SET deleted_at = NOW() WHERE id = $1', [fileId]);

        const res = await ctx.request
            .get(`/files/${fileId}`)
            .set(owner.auth);

        expect(res.status).toBe(404);
    });

    test('GET /files/:id requires authentication', async () => {
        const fileId = await insertTestFile({ uploaderId: owner.userId, channelId });
        const res = await ctx.request
            .get(`/files/${fileId}`);

        expect(res.status).toBe(401);
    });
});

describe('File delete', () => {
    test('DELETE /files/:id returns 404 for non-existent file', async () => {
        const res = await ctx.request
            .delete(`/files/${FAKE_ULID}`)
            .set(owner.auth);

        expect(res.status).toBe(404);
    });

    test('DELETE own file succeeds (soft-delete)', async () => {
        const fileId = await insertTestFile({ uploaderId: owner.userId, channelId });
        const res = await ctx.request
            .delete(`/files/${fileId}`)
            .set(owner.auth);

        expect(res.status).toBe(200);
        expect(res.body.deleted).toBe(true);

        // Verify it's now 404 on subsequent GET (the COMMIT happens in onResponse
        // after the response is sent, so a direct DB query may race; use the API instead)
        const getRes = await ctx.request
            .get(`/files/${fileId}`)
            .set(owner.auth);
        expect(getRes.status).toBe(404);
    });

    test('DELETE other user file rejected without ManageMessages', async () => {
        const fileId = await insertTestFile({ uploaderId: owner.userId, channelId });
        const res = await ctx.request
            .delete(`/files/${fileId}`)
            .set(member.auth);

        expect(res.status).toBe(403);
    });

    test('DELETE already-deleted file returns 404', async () => {
        const fileId = await insertTestFile({ uploaderId: owner.userId, channelId });
        // First delete succeeds
        await ctx.request.delete(`/files/${fileId}`).set(owner.auth);
        // Second delete returns 404
        const res = await ctx.request
            .delete(`/files/${fileId}`)
            .set(owner.auth);

        expect(res.status).toBe(404);
    });

    test('DELETE requires authentication', async () => {
        const fileId = await insertTestFile({ uploaderId: owner.userId, channelId });
        const res = await ctx.request
            .delete(`/files/${fileId}`);

        expect(res.status).toBe(401);
    });
});

describe('File permission checks', () => {
    test('non-member cannot delete a file in a server channel', async () => {
        const outsider = await authedUser(ctx.request, 'outsider');
        const fileId = await insertTestFile({ uploaderId: owner.userId, channelId });

        const res = await ctx.request
            .delete(`/files/${fileId}`)
            .set(outsider.auth);

        // Non-member: either 403 (not a member) or the file check fails
        expect([403, 404]).toContain(res.status);
    });

    test('member can delete own file', async () => {
        const fileId = await insertTestFile({ uploaderId: member.userId, channelId });
        const res = await ctx.request
            .delete(`/files/${fileId}`)
            .set(member.auth);

        expect(res.status).toBe(200);
        expect(res.body.deleted).toBe(true);
    });
});
