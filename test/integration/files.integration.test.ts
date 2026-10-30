import { Readable } from 'node:stream';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { setupTestApp, authedUser, createServer, cleanDatabase, joinViaInvite } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { hashPassword } from '../../src/auth/passwords';
import { generateToken } from '../../src/auth/tokens';
import { invalidateSettingsCache } from '../../src/lib/settings';
import { OOXML_MIME_BY_EXTENSION } from '../../src/lib/file-validation';
import { makeDocx, makePptx, makeXlsx, makeZip } from '../ooxml-helper';

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

/** Insert a file row directly into DB, without storing a blob. */
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

    // #155: Ajv coercion inside oneOf turned null into 0, and /admin/storage then divided by zero
    test('PATCH null retention and quota round-trips as null, and /admin/storage still loads', async () => {
        const set = await ctx.request.patch('/admin/settings/files').set(admin.auth)
            .send({ 'files.retention_days': 30, 'files.storage_quota_bytes': 1073741824 });
        expect(set.status).toBe(200);

        const clear = await ctx.request.patch('/admin/settings/files').set(admin.auth)
            .send({ 'files.retention_days': null, 'files.storage_quota_bytes': null });
        expect(clear.status).toBe(200);

        const stored = await ctx.db.query(
            "SELECT key, value FROM instance_settings WHERE key IN ('files.retention_days', 'files.storage_quota_bytes') ORDER BY key");
        expect(stored.rows).toEqual([
            { key: 'files.retention_days', value: null },
            { key: 'files.storage_quota_bytes', value: null },
        ]);
        const got = await ctx.request.get('/admin/settings/files').set(admin.auth);
        expect(got.body['files.retention_days']).toBeNull();
        expect(got.body['files.storage_quota_bytes']).toBeNull();

        const storage = await ctx.request.get('/admin/storage').set(admin.auth);
        expect(storage.status).toBe(200);
        expect(storage.body.quotaBytes).toBeNull();
        expect(storage.body.quotaUsedPercent).toBeNull();
    });

    test('PATCH rejects 0 for retention and quota', async () => {
        expect((await ctx.request.patch('/admin/settings/files').set(admin.auth).send({ 'files.retention_days': 0 })).status).toBe(400);
        expect((await ctx.request.patch('/admin/settings/files').set(admin.auth).send({ 'files.storage_quota_bytes': 0 })).status).toBe(400);
    });

    test('a stored quota of 0 counts as no quota instead of a 500', async () => {
        // Rows the coercion bug already wrote on existing instances
        await ctx.db.query(
            `INSERT INTO instance_settings (key, value) VALUES ('files.storage_quota_bytes', '0'::jsonb)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
        invalidateSettingsCache();
        try {
            const storage = await ctx.request.get('/admin/storage').set(admin.auth);
            expect(storage.status).toBe(200);
            expect(storage.body.quotaBytes).toBeNull();
            expect(storage.body.quotaUsedPercent).toBeNull();
        } finally {
            await ctx.db.query(
                `UPDATE instance_settings SET value = 'null'::jsonb WHERE key = 'files.storage_quota_bytes'`);
            invalidateSettingsCache();
        }
    });

    test('PATCH /admin/settings/runtime keeps a null code retention as null', async () => {
        const res = await ctx.request.patch('/admin/settings/runtime').set(admin.auth).send({ codeRetentionDays: null });
        expect(res.status).toBe(200);
        expect(res.body.codeRetentionDays).toBeNull();
        const stored = await ctx.db.query("SELECT value FROM instance_settings WHERE key = 'runtime.code_retention_days'");
        expect(stored.rows[0].value).toBeNull();
        expect((await ctx.request.get('/admin/settings/runtime').set(admin.auth)).body.codeRetentionDays).toBeNull();
        // Back to the default retention for the rest of the file
        await ctx.request.patch('/admin/settings/runtime').set(admin.auth).send({ codeRetentionDays: 30, confirm: true });
    });
});

// #157: @fastify/multipart's default fileSize (Fastify's 1 MiB bodyLimit) refused files before
// storeFile() saw them. The admin setting is the only cap.
describe('Upload size follows the admin setting', () => {
    let admin: any;
    const MB = 1000 * 1000;

    beforeAll(async () => { admin = await insertAdminUser('sizeadmin'); });

    async function setMaxSize(bytes: number) {
        const res = await ctx.request.patch('/admin/settings/files').set(admin.auth).send({ 'files.max_size_bytes': bytes });
        expect(res.status).toBe(200);
    }
    const fileCount = async () => (await ctx.db.query('SELECT COUNT(*)::int AS n FROM files')).rows[0].n as number;

    test('a 1.5 MB file under a 25 MB setting is stored', async () => {
        await setMaxSize(25 * 1024 * 1024);
        const res = await ctx.request.post('/files/upload').set(owner.auth)
            .field('channel_id', channelId)
            .attach('file', Buffer.alloc(1.5 * MB, 'a'), 'one-and-a-half.txt');
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.size).toBe(1.5 * MB);
    });

    test('a 2 MB file over a 1 MB setting gets the setting refusal and stores nothing', async () => {
        await setMaxSize(1 * MB);
        try {
            const before = await fileCount();
            const res = await ctx.request.post('/files/upload').set(owner.auth)
                .field('channel_id', channelId)
                .attach('file', Buffer.alloc(2 * MB, 'b'), 'two.txt');
            expect(res.status).toBe(413);
            expect(res.body.error).toBe('File exceeds maximum allowed size');
            expect(res.body.code).toBeUndefined();
            expect(await fileCount()).toBe(before);
        } finally {
            await setMaxSize(26214400);
        }
    });

    // 2026-10-23: a 54 MB upload under a 25 MB setting was stored as its first 25 MB with no
    // error. When a body chunk ends exactly at fileSize and the rest arrives later, busboy sets
    // `truncated` with nothing left to push, so multipart's toBuffer() never sees it and returns
    // exactly fileSize bytes. Reproduced here deterministically with a two-chunk stream.
    test('an upload whose first chunk ends exactly at the limit is refused, not stored cut', async () => {
        const limit = 100_000;
        await setMaxSize(limit);
        try {
            const before = await fileCount();
            const B = 'TRUNCATIONBOUNDARY';
            const head = `--${B}\r\nContent-Disposition: form-data; name="channel_id"\r\n\r\n${channelId}\r\n`
                + `--${B}\r\nContent-Disposition: form-data; name="file"; filename="cut.txt"\r\nContent-Type: text/plain\r\n\r\n`;
            const first = Buffer.concat([Buffer.from(head), Buffer.alloc(limit, 'd')]);
            const rest = Buffer.concat([Buffer.alloc(50_000, 'd'), Buffer.from(`\r\n--${B}--\r\n`)]);
            async function* body() { yield first; await new Promise(r => setTimeout(r, 50)); yield rest; }
            const res = await ctx.app.inject({
                method: 'POST', url: '/files/upload',
                headers: { ...owner.auth, 'content-type': `multipart/form-data; boundary=${B}` },
                payload: Readable.from(body()),
            });
            expect(res.statusCode, res.body).toBe(413);
            expect(await fileCount()).toBe(before);
        } finally {
            await setMaxSize(26214400);
        }
    });

    test('a file exactly at the setting is stored', async () => {
        await setMaxSize(1 * MB);
        try {
            const res = await ctx.request.post('/files/upload').set(owner.auth)
                .field('channel_id', channelId)
                .attach('file', Buffer.alloc(1 * MB, 'c'), 'exact.txt');
            expect(res.status, JSON.stringify(res.body)).toBe(201);
        } finally {
            await setMaxSize(26214400);
        }
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

    test('refuses a message with an empty attachments array and no content', async () => {
        const res = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ attachments: [] });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('empty_content');
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

describe('Office documents and text-like files (#291)', () => {
    const EXTRA = ['docx', 'xlsx', 'pptx', 'ipynb', 'py', 'html', 'xml', 'toml'];
    let admin: any;
    let before: string[];

    beforeAll(async () => {
        admin = await insertAdminUser('officeadmin');
        before = (await ctx.request.get('/admin/settings/files').set(admin.auth)).body['files.allowed_extensions'];
        const res = await ctx.request.patch('/admin/settings/files').set(admin.auth).send({ 'files.allowed_extensions': [...before, ...EXTRA] });
        expect(res.status).toBe(200);
    });
    afterAll(async () => {
        await ctx.request.patch('/admin/settings/files').set(admin.auth).send({ 'files.allowed_extensions': before });
    });

    /** Upload, post in a message (only posted files can be read), and read the text back. */
    async function shareAndRead(name: string, content: Buffer) {
        const up = await ctx.request.post('/files/upload').set(owner.auth).field('channel_id', channelId).attach('file', content, name);
        expect(up.status, JSON.stringify(up.body)).toBe(201);
        const msg = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: name, attachments: [up.body.id] });
        expect(msg.status).toBe(201);
        const text = await ctx.request.get(`/files/${up.body.id}/text`).set(owner.auth);
        const stored = (await ctx.db.query('SELECT mime_type FROM files WHERE id = $1', [up.body.id])).rows[0].mime_type.trim();
        return { mime: up.body.mime as string, stored, text };
    }

    const notebook = { nbformat: 4, metadata: {}, cells: [{ cell_type: 'markdown', source: 'Decision trees' }, { cell_type: 'code', source: 'tree.fit(X, y)', outputs: [{ output_type: 'stream', text: 'OUTPUT' }] }] };
    test.each([
        ['essay.docx', makeDocx(['Data policy project', 'Logistic regression on churn']), OOXML_MIME_BY_EXTENSION.docx, 'Logistic regression on churn'],
        ['export.docx', makeDocx(['From Google Docs'], { googleDocs: true }), OOXML_MIME_BY_EXTENSION.docx, 'From Google Docs'],
        ['sales.xlsx', makeXlsx([{ name: 'Sales', rows: [['product', 'total'], ['Guava Bar', 11126.45]] }]), OOXML_MIME_BY_EXTENSION.xlsx, 'Sheet: Sales\nproduct\ttotal\nGuava Bar\t11126.45'],
        ['deck.pptx', makePptx([['Why diversify?'], ['Final tips']]), OOXML_MIME_BY_EXTENSION.pptx, '--- Slide 2 ---\nFinal tips'],
        ['week3.ipynb', Buffer.from(JSON.stringify(notebook)), 'application/x-ipynb+json', '```\ntree.fit(X, y)\n```'],
        ['clean.py', Buffer.from('import pandas as pd\n'), 'text/x-python', 'import pandas as pd'],
        ['notes.html', Buffer.from('<html><body><h1>Big data</h1><script>x()</script><p>Hadoop &amp; Spark</p></body></html>'), 'text/html', 'Big data\n\nHadoop & Spark'],
        ['plants.xml', Buffer.from('<?xml version="1.0"?>\n<plants><plant>Monstera</plant></plants>'), 'application/xml', '<plant>Monstera</plant>'],
        ['pyproject.toml', Buffer.from('[project]\nname = "plantbeat"\n'), 'application/toml', 'name = "plantbeat"'],
    ])('%s is stored with its real type and its text can be read', async (name, content, mime, expected) => {
        const res = await shareAndRead(name, content);
        expect(res.mime).toBe(mime);
        expect(res.stored).toBe(mime);
        expect(res.text.status, JSON.stringify(res.text.body)).toBe(200);
        expect(res.text.body.text).toContain(expected);
        expect(res.text.body.text).not.toContain('OUTPUT');
    });

    test('a zip named .docx is refused even though zip uploads are allowed', async () => {
        const res = await ctx.request.post('/files/upload').set(owner.auth).field('channel_id', channelId)
            .attach('file', makeZip([{ name: 'readme.txt', data: 'not a document' }]), 'fake.docx');
        expect(res.status).toBe(415);
        expect(res.body.error).toBe('File content does not match its extension');
    });

    test('a Word document whose text cannot be read is still stored, and reading it says why', async () => {
        const docx = makeDocx(['will be damaged']);
        // Keep the zip directory intact but break the document part's compressed bytes
        const at = docx.indexOf(Buffer.from('word/document.xml')) + 'word/document.xml'.length;
        const broken = Buffer.from(docx);
        broken.fill(0xff, at, at + 12);
        const res = await shareAndRead('broken.docx', broken);
        expect(res.mime).toBe(OOXML_MIME_BY_EXTENSION.docx);
        expect(res.text.status).toBe(422);
        expect(res.text.body.error).toMatch(/^The Word document could not be read: /);
    });
});
