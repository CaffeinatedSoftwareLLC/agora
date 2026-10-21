import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type supertest from 'supertest';
import { createPrivateDb, dropPrivateDb, runTool, listTree } from '../tool-helpers';

/**
 * OP-04.minio-migrate (S0511 `npm run storage:migrate-from-s3`, S0549 docker-compose.minio-migrate.yml).
 *
 * Supported path: CHANGELOG 0.2.0 "Upgrading" step 2 says an install that used the bundled
 * MinIO copies its files to the new volume once (README "Upgrading"), and
 * docker-compose.minio-migrate.yml runs this tool with S3_ENDPOINT=http://minio:9000.
 *
 * No MinIO here, so the source is a minimal in-process S3-compatible stub (path-style
 * GetObject, plus GetBucketLocation and ListObjectsV2 in case the client asks). The tool runs
 * as a child process (tsx) against a throwaway database; the target is a temp disk store,
 * which the real API in this process then serves downloads from.
 */

const TOOL = 'src/tools/migrate-storage-from-s3.ts';
const BUCKET = 'agora-files';
const ACCESS_KEY = 'agora';
const SECRET_KEY = 'old-minio-password';
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

// ─── S3 stub ───
const objects = new Map<string, Buffer>();
const requests: { method: string; url: string; credential: string | null }[] = [];
let s3: http.Server;
let endpoint: string;

function xmlError(res: http.ServerResponse, status: number, code: string, resource: string) {
    res.writeHead(status, { 'Content-Type': 'application/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message><Resource>${resource}</Resource><RequestId>stub</RequestId><HostId>stub</HostId></Error>`);
}

function startS3Stub(): Promise<void> {
    s3 = http.createServer((req, res) => {
        const url = new URL(req.url!, 'http://stub');
        const authz = req.headers.authorization ?? '';
        const credential = /Credential=([^/]+)\//.exec(authz)?.[1] ?? null;
        requests.push({ method: req.method!, url: req.url!, credential });
        if (credential !== ACCESS_KEY) return xmlError(res, 403, 'InvalidAccessKeyId', url.pathname);

        const [, bucket, ...rest] = url.pathname.split('/');
        if (bucket !== BUCKET) return xmlError(res, 404, 'NoSuchBucket', url.pathname);
        const key = rest.map(decodeURIComponent).join('/');

        if (!key && url.searchParams.has('location')) {
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            return res.end('<?xml version="1.0" encoding="UTF-8"?><LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></LocationConstraint>');
        }
        if (!key && req.method === 'GET') {
            const prefix = url.searchParams.get('prefix') ?? '';
            const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET}</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>`
                + keys.map(k => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.length}</Size></Contents>`).join('') + '</ListBucketResult>');
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
            const blob = objects.get(key);
            if (!blob) return xmlError(res, 404, 'NoSuchKey', url.pathname);
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': blob.length, ETag: '"stub"' });
            return res.end(req.method === 'GET' ? blob : undefined);
        }
        xmlError(res, 405, 'MethodNotAllowed', url.pathname);
    });
    return new Promise(resolve => s3.listen(0, '127.0.0.1', () => {
        endpoint = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
        resolve();
    }));
}

const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
    await startS3Stub();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agora-s3mig-'));
    dbUrl = await createPrivateDb('s3mig');
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
    const owner = await helpers.authedUser(request, 's3owner');
    ({ auth, userId } = owner);
    ({ generalChannelId: channelId } = await helpers.createServer(request, auth, 'MinIO install'));
});

afterAll(async () => {
    await app?.close();
    await db?.end();
    await dropPrivateDb(dbUrl);
    await fs.rm(root, { recursive: true, force: true });
    await new Promise(resolve => s3?.close(resolve));
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

/** A file as a MinIO install stored it: row in `files`, encrypted blob in the bucket. */
async function insertS3File(filename: string, content: Buffer, opts: { nameless?: boolean; inBucket?: boolean; deleted?: boolean } = {}) {
    const id = generateUlid();
    const key = `${channelId}/${id}/${opts.nameless ? 'blob' : filename}`;
    const { encrypted, iv, authTag } = encryptFile(content, instanceKey);
    if (opts.inBucket !== false) objects.set(key, encrypted);
    await db.query(
        `INSERT INTO files (id, uploader_id, channel_id, filename, content_type, mime_type, size_bytes, bucket, path, storage_key, encryption_iv, encryption_tag, deleted_at)
         VALUES ($1, $2, $3, $4, 'text/plain', 'text/plain', $5, 'agora-files', $6, $7, $8, $9, $10)`,
        [id, userId, channelId, filename, content.length, key, key, iv, authTag, opts.deleted ? new Date() : null]
    );
    return { id, key, content, encrypted };
}

async function download(id: string) {
    const res = await request.get(`/files/${id}`).set(auth).buffer(true).parse(binary);
    return { status: res.status, body: res.body as Buffer };
}

const s3Env = () => ({
    DATABASE_URL: dbUrl, STORAGE_DIR: root, STORAGE_DRIVER: 'disk',
    S3_ENDPOINT: endpoint, S3_ACCESS_KEY: ACCESS_KEY, S3_SECRET_KEY: SECRET_KEY, S3_BUCKET: BUCKET, S3_REGION: 'us-east-1',
});

describe('npm run storage:migrate-from-s3', () => {
    const N = 6;
    let files: Awaited<ReturnType<typeof insertS3File>>[] = [];
    let lost: Awaited<ReturnType<typeof insertS3File>>;
    let deleted: Awaited<ReturnType<typeof insertS3File>>;

    it('[OP-04.minio-migrate] N blobs are copied from the S3 endpoint to the disk store, byte for byte', async () => {
        for (let i = 0; i < N; i++) {
            const content = Buffer.from(`minio file ${i} ${generateUlid()}\n`.repeat(i + 1));
            files.push(await insertS3File(`report ${i}.txt`, content, { nameless: i % 3 === 0 }));
        }
        lost = await insertS3File('never uploaded.txt', Buffer.from('lost'), { inBucket: false });
        deleted = await insertS3File('deleted.txt', Buffer.from('deleted'), { deleted: true });

        // Before the copy the API cannot serve them: nothing on disk yet
        expect((await download(files[0].id)).status).toBe(404);

        const run = await runTool(TOOL, s3Env());
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).toContain(`Copying ${N + 1} file(s) from ${endpoint} (bucket ${BUCKET}) to ${root}`);
        expect(run.stdout).toContain(`Done: ${N} copied, 0 already on disk, 1 missing from S3.`);
        expect(run.stdout).toContain(`missing: ${lost.key}`);

        // Every live row's blob was fetched with the configured credentials, and only those
        const gets = requests.filter(r => r.method === 'GET' && !r.url.includes('?'));
        expect(gets.every(r => r.credential === ACCESS_KEY)).toBe(true);
        expect(gets.map(r => decodeURIComponent(r.url.slice(BUCKET.length + 2))).sort())
            .toEqual([...files.map(f => f.key), lost.key].sort());

        for (const f of files) {
            const onDisk = await fs.readFile(path.join(root, ...f.key.split('/')));
            expect(onDisk.equals(f.encrypted), f.key).toBe(true);
        }
        expect(await listTree(root)).toEqual(files.map(f => f.key).sort());
    });

    it('[OP-04.minio-migrate] files download and match the originals byte for byte', async () => {
        for (const f of files) {
            const res = await download(f.id);
            expect(res.status, f.key).toBe(200);
            expect(res.body.equals(f.content), f.key).toBe(true);
        }
        expect((await download(lost.id)).status).toBe(404);
        expect((await download(deleted.id)).status).toBe(404);
    });

    it('[OP-04.minio-migrate] a re-run copies 0 (pre-#32 MINIO_* settings are read as fallbacks)', async () => {
        const treeBefore = await listTree(root);
        const mtimes = await Promise.all(files.map(async f => (await fs.stat(path.join(root, ...f.key.split('/')))).mtimeMs));
        requests.length = 0;

        const run = await runTool(TOOL, {
            DATABASE_URL: dbUrl, STORAGE_DIR: root, STORAGE_DRIVER: 'disk', S3_REGION: 'us-east-1',
            MINIO_ENDPOINT: endpoint, MINIO_ROOT_USER: ACCESS_KEY, MINIO_ROOT_PASSWORD: SECRET_KEY,
        });
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).toContain(`Done: 0 copied, ${N} already on disk, 1 missing from S3.`);
        // Only the missing one was asked for again
        expect(requests.filter(r => r.method === 'GET').map(r => decodeURIComponent(r.url.slice(BUCKET.length + 2)))).toEqual([lost.key]);
        expect(await listTree(root)).toEqual(treeBefore);
        const after = await Promise.all(files.map(async f => (await fs.stat(path.join(root, ...f.key.split('/')))).mtimeMs));
        expect(after).toEqual(mtimes);
        for (const f of files) expect((await download(f.id)).body.equals(f.content)).toBe(true);
    });

    // S0549 cannot be run here (no Docker); this pins that the overlay runs this same tool into the API's volume
    it('[OP-04.minio-migrate] docker-compose.minio-migrate.yml runs this tool against MinIO into the API\'s files volume', async () => {
        const repo = path.resolve(__dirname, '../..');
        const overlay = await fs.readFile(path.join(repo, 'docker-compose.minio-migrate.yml'), 'utf8');
        const prod = await fs.readFile(path.join(repo, 'docker-compose.prod.yml'), 'utf8');
        const service = overlay.slice(overlay.indexOf('  storage-migrate:'), overlay.indexOf('\nvolumes:'));
        expect(service).toContain('command: ["node", "dist/src/tools/migrate-storage-from-s3.js"]');
        await fs.access(path.join(repo, TOOL)); // tsconfig rootDir "." compiles it to dist/src/tools/
        expect(service).toMatch(/S3_ENDPOINT: http:\/\/minio:9000/);
        expect(service).toMatch(/S3_ACCESS_KEY: \$\{MINIO_ROOT_USER:-agora\}/);
        expect(service).toMatch(/S3_SECRET_KEY: \$\{MINIO_ROOT_PASSWORD\}/);
        expect(service).toMatch(/STORAGE_DIR: \/data\/files/);
        expect(service).toMatch(/- files-data:\/data\/files/);
        expect(service).toMatch(/DATABASE_URL: postgres:\/\/accord:\$\{DB_PASSWORD\}@postgres:5432\/agora/);
        // The API reads the same directory on the same volume
        const api = prod.slice(prod.indexOf('\n  api:'), prod.indexOf('\n  sandbox-image:'));
        expect(api).toMatch(/STORAGE_DIR: \/data\/files/);
        expect(api).toMatch(/- files-data:\/data\/files/);
        expect(prod).toMatch(/\n  files-perms:/);
    });

    it('[OP-04.minio-migrate] wrong credentials fail the run and copy nothing', async () => {
        const fresh = await insertS3File('late upload.txt', Buffer.from('late'));
        const run = await runTool(TOOL, { ...s3Env(), S3_ACCESS_KEY: 'wrong' });
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('Storage migration failed');
        await expect(fs.stat(path.join(root, ...fresh.key.split('/')))).rejects.toThrow();
        await db.query('UPDATE files SET deleted_at = NOW() WHERE id = $1', [fresh.id]);
    });
});
