import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type supertest from 'supertest';
import { createPrivateDb, dropPrivateDb, runTool, listTree } from '../tool-helpers';

/**
 * OP-04.strip-filenames (S0512): `npm run storage:strip-filenames`
 * (src/tools/strip-storage-filenames.ts), run as a child process the way npm runs it (tsx),
 * against a throwaway database and a temp disk store. Downloads go through the real API in
 * this process, pointed at the same database and store.
 */

const TOOL = 'src/tools/strip-storage-filenames.ts';
const savedEnv = { STORAGE_DIR: process.env.STORAGE_DIR, STORAGE_DRIVER: process.env.STORAGE_DRIVER };

let root: string;
let dbUrl: string;
let app: any;
let db: any;
let request: supertest.Agent;
let auth: Record<string, string>;
let userId: string;
let channelId: string;
let encryptFile: typeof import('../../src/lib/encryption').encryptFile;
let generateUlid: () => string;
let instanceKey: Buffer;

const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agora-strip-'));
    dbUrl = await createPrivateDb('strip');
    // The API reads STORAGE_DIR when its modules load, so set it before importing them
    process.env.STORAGE_DIR = root;
    process.env.STORAGE_DRIVER = 'disk';
    const { buildApp } = await import('../../src/app');
    const helpers = await import('../helpers');
    ({ encryptFile } = await import('../../src/lib/encryption'));
    ({ generateUlid } = await import('../../src/utils/ulid'));
    instanceKey = (await import('../../src/config')).config.encryptionKey;
    const st = (await import('supertest')).default;

    ({ app, db } = await buildApp({ logger: false, jwtSecret: 'test-secret-do-not-use-in-prod', dbUrl, rateLimit: false }));
    await app.ready();
    request = st(app.server);
    await helpers.cleanDatabase(db);
    const owner = await helpers.authedUser(request, 'stripowner');
    ({ auth, userId } = owner);
    ({ generalChannelId: channelId } = await helpers.createServer(request, auth, 'Strip'));
});

afterAll(async () => {
    await app?.close();
    await db?.end();
    await dropPrivateDb(dbUrl);
    await fs.rm(root, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

/** A file stored the pre-0.2.0 way: the storage key ends in the original file name. */
async function insertOldStyleFile(filename: string, content: Buffer): Promise<{ id: string; oldKey: string }> {
    const id = generateUlid();
    const oldKey = `${channelId}/${id}/${filename}`;
    const { encrypted, iv, authTag } = encryptFile(content, instanceKey);
    await fs.mkdir(path.join(root, channelId, id), { recursive: true });
    await fs.writeFile(path.join(root, channelId, id, filename), encrypted);
    await db.query(
        `INSERT INTO files (id, uploader_id, channel_id, filename, content_type, mime_type, size_bytes, bucket, path, storage_key, encryption_iv, encryption_tag)
         VALUES ($1, $2, $3, $4, 'text/plain', 'text/plain', $5, 'agora-files', $6, $7, $8, $9)`,
        [id, userId, channelId, filename, content.length, oldKey, oldKey, iv, authTag]
    );
    return { id, oldKey };
}

async function download(id: string) {
    const res = await request.get(`/files/${id}`).set(auth).buffer(true).parse(binary);
    expect(res.status, id).toBe(200);
    return { body: res.body as Buffer, disposition: res.headers['content-disposition'] as string };
}

const keysById = async () => Object.fromEntries((await db.query(
    'SELECT id, storage_key, path FROM files WHERE deleted_at IS NULL ORDER BY id')).rows.map((r: any) => [r.id.trim(), { key: r.storage_key.trim(), path: r.path.trim() }]));

describe('npm run storage:strip-filenames', () => {
    const names = ['secret merger.txt', 'salaries-2026.txt', 'Q3 board notes.md', 'résumé final.txt'];
    let files: { id: string; oldKey: string; filename: string; content: Buffer }[] = [];
    let before: Record<string, { body: Buffer; disposition: string }> = {};

    it('[OP-04.strip-filenames] pre-0.2.0 keys are renamed to <channel>/<file>/blob, and downloads are unchanged', async () => {
        for (const filename of names) {
            const content = Buffer.from(`contents of ${filename}\n${generateUlid()}`);
            files.push({ ...(await insertOldStyleFile(filename, content)), filename, content });
        }
        // A file uploaded after 0.2.0 is left alone
        const upload = await request.post('/files/upload').set(auth).field('channel_id', channelId)
            .attach('file', Buffer.from('uploaded after 0.2.0'), 'new upload.txt');
        expect(upload.status).toBe(201);
        const uploadKey = (await keysById())[upload.body.id].key;
        expect(uploadKey).toBe(`${channelId}/${upload.body.id}/blob`);

        for (const f of files) {
            before[f.id] = await download(f.id);
            expect(before[f.id].body.equals(f.content)).toBe(true);
        }
        const rawBefore = Object.fromEntries(await Promise.all(files.map(async f =>
            [f.id, await fs.readFile(path.join(root, ...f.oldKey.split('/')))] as const)));

        const run = await runTool(TOOL, { DATABASE_URL: dbUrl, STORAGE_DIR: root, STORAGE_DRIVER: 'disk' });
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).toContain(`Done: ${names.length} renamed, 1 already without a file name, 0 missing from storage.`);

        const keys = await keysById();
        for (const f of files) {
            expect(keys[f.id]).toEqual({ key: `${channelId}/${f.id}/blob`, path: `${channelId}/${f.id}/blob` });
            // The blob was moved as is: same ciphertext, still decrypts with the same IV and tag
            expect((await fs.readFile(path.join(root, channelId, f.id, 'blob'))).equals(rawBefore[f.id])).toBe(true);
            const after = await download(f.id);
            expect(after.body.equals(before[f.id].body)).toBe(true);
            expect(after.disposition).toBe(before[f.id].disposition);
        }
        expect(keys[upload.body.id].key).toBe(uploadKey);
        expect((await download(upload.body.id)).body.toString()).toBe('uploaded after 0.2.0');

        // No file name anywhere in the store: one `blob` per file, nothing else
        const tree = await listTree(root);
        expect(tree).toEqual([...files.map(f => `${channelId}/${f.id}/blob`), `${channelId}/${upload.body.id}/blob`].sort());
        for (const n of [...names, 'new upload.txt']) expect(tree.join('\n')).not.toContain(n);
        for (const n of ['merger', 'salaries', 'board', 'sum']) expect(tree.join('\n')).not.toContain(n);
    });

    it('[OP-04.strip-filenames] a re-run renames 0 and changes nothing', async () => {
        const keysBefore = await keysById();
        const treeBefore = await listTree(root);

        const run = await runTool(TOOL, { DATABASE_URL: dbUrl, STORAGE_DIR: root, STORAGE_DRIVER: 'disk' });
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).toContain(`Done: 0 renamed, ${names.length + 1} already without a file name, 0 missing from storage.`);

        expect(await keysById()).toEqual(keysBefore);
        expect(await listTree(root)).toEqual(treeBefore);
        for (const f of files) {
            const after = await download(f.id);
            expect(after.body.equals(f.content)).toBe(true);
            expect(after.disposition).toBe(before[f.id].disposition);
        }
    });

    it('[OP-04.strip-filenames] a row whose blob is missing is reported and left as it was', async () => {
        const lost = await insertOldStyleFile('lost file.txt', Buffer.from('gone'));
        await fs.rm(path.join(root, channelId, lost.id), { recursive: true });

        const run = await runTool(TOOL, { DATABASE_URL: dbUrl, STORAGE_DIR: root, STORAGE_DRIVER: 'disk' });
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).toContain(`Done: 0 renamed, ${names.length + 1} already without a file name, 1 missing from storage.`);
        expect(run.stdout).toContain(`missing blob for file ${lost.id}`);
        expect((await keysById())[lost.id]).toEqual({ key: lost.oldKey, path: lost.oldKey });
        await db.query('UPDATE files SET deleted_at = NOW() WHERE id = $1', [lost.id]);
    });
});
