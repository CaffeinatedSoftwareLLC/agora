import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type supertest from 'supertest';
import { createPrivateDb, dropPrivateDb, runTool, startTool, listTree } from '../tool-helpers';

/**
 * OP-05.key-rotate (S0509): `npm run key:rotate` (src/tools/rotate-encryption-key.ts), run as
 * a child process (tsx) on a disposable copy: a throwaway database and a temp disk store.
 *
 * Progress tracking (src/lib/storage-maintenance.ts): each rotated blob is written under the
 * leaf `blob-<first 8 hex of the new key's fingerprint>`, so a re-run with the same two keys
 * skips rows whose key already has that leaf. Provider keys and the fingerprint switch in one
 * transaction after the last file. The interruption here is a real one: the tool is killed
 * while it is part-way through the files.
 *
 * The API in this process runs with the NEW key (set before its modules load), so a 200 with
 * the original bytes from GET /files/:id is "decrypts under the new key, exactly once".
 */

const TOOL = 'src/tools/rotate-encryption-key.ts';
const oldKey = randomBytes(32);
const newKey = randomBytes(32);
const N = 400;
const savedEnv = {
    STORAGE_DIR: process.env.STORAGE_DIR, STORAGE_DRIVER: process.env.STORAGE_DRIVER, AGORA_ENCRYPTION_KEY: process.env.AGORA_ENCRYPTION_KEY,
};

let root: string;
let dbUrl: string;
let app: any;
let db: any;
let request: supertest.Agent;
let auth: Record<string, string>;
let userId: string;
let serverId: string;
let channelId: string;
let enc: typeof import('../../src/lib/encryption');
let fp: typeof import('../../src/lib/key-fingerprint');
let generateUlid: () => string;
let leaf: string;

const files: { id: string; key: string; content: Buffer }[] = [];
const providers: { id: string; secret: string }[] = [];

const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const toolEnv = () => ({
    DATABASE_URL: dbUrl, STORAGE_DIR: root, STORAGE_DRIVER: 'disk',
    AGORA_ENCRYPTION_KEY: oldKey.toString('hex'), AGORA_NEW_ENCRYPTION_KEY: newKey.toString('hex'),
});

beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agora-keyrot-'));
    dbUrl = await createPrivateDb('keyrot');
    process.env.STORAGE_DIR = root;
    process.env.STORAGE_DRIVER = 'disk';
    process.env.AGORA_ENCRYPTION_KEY = newKey.toString('hex');
    const { buildApp } = await import('../../src/app');
    const helpers = await import('../helpers');
    enc = await import('../../src/lib/encryption');
    fp = await import('../../src/lib/key-fingerprint');
    ({ generateUlid } = await import('../../src/utils/ulid'));
    const { config } = await import('../../src/config');
    expect(config.encryptionKey.equals(newKey)).toBe(true);
    leaf = `blob-${fp.keyFingerprint(newKey).slice(0, 8)}`;
    const st = (await import('supertest')).default;

    ({ app, db } = await buildApp({ logger: false, jwtSecret: 'test-secret-do-not-use-in-prod', dbUrl, rateLimit: false }));
    await app.ready();
    request = st(app.server);
    await helpers.cleanDatabase(db);
    const owner = await helpers.authedUser(request, 'keyowner');
    ({ auth, userId } = owner);
    ({ serverId, generalChannelId: channelId } = await helpers.createServer(request, auth, 'Rotation'));
});

afterAll(async () => {
    await app?.close();
    await db?.end();
    await dropPrivateDb(dbUrl);
    await fs.rm(root, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function seed() {
    for (let i = 0; i < N; i++) {
        const id = generateUlid();
        // Mix of pre-0.2.0 keys (file name) and 0.2.0 keys (`blob`)
        const key = `${channelId}/${id}/${i % 2 ? 'blob' : `doc ${i}.txt`}`;
        const content = Buffer.from(`file ${i} ${randomBytes(12).toString('hex')}\n`);
        const { encrypted, iv, authTag } = enc.encryptFile(content, oldKey);
        await fs.mkdir(path.join(root, channelId, id), { recursive: true });
        await fs.writeFile(path.join(root, ...key.split('/')), encrypted);
        await db.query(
            `INSERT INTO files (id, uploader_id, channel_id, filename, content_type, mime_type, size_bytes, bucket, path, storage_key, encryption_iv, encryption_tag)
             VALUES ($1, $2, $3, $4, 'text/plain', 'text/plain', $5, 'agora-files', $6, $7, $8, $9)`,
            [id, userId, channelId, `doc ${i}.txt`, content.length, key, key, iv, authTag]
        );
        files.push({ id, key, content });
    }
    for (const label of ['OpenAI', 'Ollama']) {
        const id = generateUlid();
        const secret = `sk-${label}-${randomBytes(8).toString('hex')}`;
        const { encrypted, iv, authTag } = enc.encryptString(secret, oldKey);
        await db.query(
            `INSERT INTO ai_providers (id, server_id, adapter, label, api_key_enc, api_key_iv, api_key_tag) VALUES ($1, $2, 'openai', $3, $4, $5, $6)`,
            [id, serverId, label, encrypted, iv, authTag]);
        providers.push({ id, secret });
    }
    // The instance was set up with the old key
    expect(await fp.verifyEncryptionKey(db, oldKey)).toBe('recorded');
}

const fileRows = async () => (await db.query(
    'SELECT id, storage_key, encryption_iv, encryption_tag FROM files WHERE deleted_at IS NULL ORDER BY id')).rows
    .map((r: any) => ({ id: r.id.trim(), key: r.storage_key.trim(), iv: r.encryption_iv, tag: r.encryption_tag }));
const rotatedCount = async () => (await db.query(
    'SELECT count(*)::int AS n FROM files WHERE storage_key LIKE $1', [`%/${leaf}`])).rows[0].n;
const storedFingerprint = async () => (await db.query(
    "SELECT value FROM instance_config WHERE key = 'encryption_key_fingerprint'")).rows[0]?.value;

function decrypts(blob: Buffer, key: Buffer, iv: any, tag: any, expected: Buffer): boolean {
    try { return enc.decryptFile(blob, key, iv, tag).equals(expected); } catch { return false; }
}

async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer().listen(0, '127.0.0.1', () => {
            const { port } = s.address() as net.AddressInfo;
            s.close(() => resolve(port));
        }).on('error', reject);
    });
}

describe('npm run key:rotate', () => {
    let doneAtKill = 0;

    it('[OP-05.key-rotate] killed part-way: files done so far are on the new key, the instance is still on the old one', async () => {
        await seed();
        const { child, done } = startTool(TOOL, toolEnv());
        // Kill it once some, but not all, files have moved
        let seen = 0;
        for (let i = 0; i < 2000 && seen === 0; i++) {
            seen = await rotatedCount();
            if (seen === 0) await new Promise(r => setTimeout(r, 5));
        }
        child.kill('SIGKILL');
        const result = await done;
        expect(result.code === 0, `the tool finished before it could be interrupted: ${result.stdout}`).toBe(false);
        expect(result.stdout).not.toContain('Rotated');

        // A statement the tool sent just before it died can still commit: wait until its backend is gone
        for (let i = 0; i < 200; i++) {
            const others = await db.query(
                `SELECT count(*)::int AS n FROM pg_stat_activity
                 WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'`);
            if (others.rows[0].n === 0) break;
            await new Promise(r => setTimeout(r, 10));
        }
        doneAtKill = await rotatedCount();
        expect(doneAtKill).toBeGreaterThan(0);
        expect(doneAtKill).toBeLessThan(N);
        // Provider keys and the fingerprint switch only after the last file
        expect(await storedFingerprint()).toBe(fp.keyFingerprint(oldKey));
        for (const p of providers) {
            const row = (await db.query('SELECT api_key_enc, api_key_iv, api_key_tag FROM ai_providers WHERE id = $1', [p.id])).rows[0];
            expect(enc.decryptString(row.api_key_enc, oldKey, row.api_key_iv, row.api_key_tag)).toBe(p.secret);
        }
        // Every row still opens with the key its row says: rotated ones with the new key, the rest with the old
        const byId = new Map(files.map(f => [f.id, f]));
        for (const row of await fileRows()) {
            const blob = await fs.readFile(path.join(root, ...row.key.split('/')));
            const key = row.key.endsWith(`/${leaf}`) ? newKey : oldKey;
            expect(decrypts(blob, key, row.iv, row.tag, byId.get(row.id)!.content), row.key).toBe(true);
        }
    });

    it('[OP-05.key-rotate] the re-run completes: every file and provider key decrypts under the new key, none needs the old one, none is double-encrypted', async () => {
        const run = await runTool(TOOL, toolEnv());
        expect(run.code, run.stderr).toBe(0);
        const m = /Rotated (\d+) file\(s\) and (\d+) provider key\(s\); (\d+) file\(s\) were already done; (\d+) missing from storage\./.exec(run.stdout);
        expect(m, run.stdout).not.toBeNull();
        const [rotated, providerKeys, alreadyDone, missing] = m!.slice(1).map(Number);
        expect(alreadyDone).toBe(doneAtKill);
        expect(rotated).toBe(N - doneAtKill);
        expect(providerKeys).toBe(providers.length);
        expect(missing).toBe(0);

        expect(await storedFingerprint()).toBe(fp.keyFingerprint(newKey));
        expect(await fp.verifyEncryptionKey(db, newKey)).toBe('matched');

        const byId = new Map(files.map(f => [f.id, f]));
        const rows = await fileRows();
        expect(rows).toHaveLength(N);
        for (const row of rows) {
            const f = byId.get(row.id)!;
            expect(row.key).toBe(`${channelId}/${row.id}/${leaf}`);
            const blob = await fs.readFile(path.join(root, ...row.key.split('/')));
            // Exactly one layer of encryption under the new key; the old key opens nothing
            expect(decrypts(blob, newKey, row.iv, row.tag, f.content), row.key).toBe(true);
            expect(decrypts(blob, oldKey, row.iv, row.tag, f.content), row.key).toBe(false);
        }
        // Downloads through the API (running with the new key) return the original bytes
        for (const f of files.filter((_, i) => i % 20 === 0)) {
            const res = await request.get(`/files/${f.id}`).set(auth).buffer(true).parse(binary);
            expect(res.status, f.id).toBe(200);
            expect((res.body as Buffer).equals(f.content), f.id).toBe(true);
        }
        for (const p of providers) {
            const row = (await db.query('SELECT api_key_enc, api_key_iv, api_key_tag FROM ai_providers WHERE id = $1', [p.id])).rows[0];
            expect(enc.decryptString(row.api_key_enc, newKey, row.api_key_iv, row.api_key_tag)).toBe(p.secret);
            expect(() => enc.decryptString(row.api_key_enc, oldKey, row.api_key_iv, row.api_key_tag)).toThrow();
        }

        // The store holds the N rotated blobs. The kill may leave at most one unreferenced blob
        // ("at worst one unreferenced blob", storage-maintenance.ts): the old-key blob when it
        // landed between "row updated" and "old blob deleted", or a `<leaf>.<hex>.tmp` partial
        // write when it landed inside diskStore.put (src/lib/storage.ts write-then-rename).
        const referenced = new Set(rows.map((r: { key: string }) => r.key));
        const tree = await listTree(root);
        const extra = tree.filter(p => !referenced.has(p));
        expect(tree.filter(p => referenced.has(p))).toHaveLength(N);
        expect(extra.length, `unreferenced blobs: ${extra.join(', ')}`).toBeLessThanOrEqual(1);
        for (const p of extra) expect(p.endsWith(`/${leaf}`), p).toBe(false);
        for (const p of extra) expect(/\/(doc \d+\.txt|blob)$/.test(p) || new RegExp(`/${leaf}\\.[0-9a-f]{12}\\.tmp$`).test(p), p).toBe(true);
    });

    it('[OP-05.key-rotate] a third run is a no-op', async () => {
        const before = await fileRows();
        const run = await runTool(TOOL, toolEnv());
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).toContain('This instance is already on the new key. Nothing to do.');
        expect(await fileRows()).toEqual(before);
    });

    it('[OP-05.key-rotate] starting the API with the old key gives the fingerprint refusal', async () => {
        const port = await freePort();
        const { child, done } = startTool('src/index.ts', {
            DATABASE_URL: dbUrl, STORAGE_DIR: root, STORAGE_DRIVER: 'disk',
            AGORA_ENCRYPTION_KEY: oldKey.toString('hex'), PORT: String(port), HOST: '127.0.0.1',
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        const result = await done;
        clearTimeout(timer);
        expect(result.code, result.stdout + result.stderr).toBe(1);
        expect(result.stderr).toContain('Failed to start');
        expect(result.stderr).toContain('AGORA_ENCRYPTION_KEY does not match the key this instance was set up with.');
        expect(result.stdout).not.toContain('Agora listening');
        // The refusal changed nothing
        expect(await storedFingerprint()).toBe(fp.keyFingerprint(newKey));
    });

    it('[OP-05.key-rotate] the tool refuses a missing or all-zero new key without touching anything', async () => {
        const before = await fileRows();
        for (const bad of ['', '0'.repeat(64), 'abc']) {
            const run = await runTool(TOOL, { ...toolEnv(), AGORA_NEW_ENCRYPTION_KEY: bad });
            expect(run.code, bad).toBe(1);
            expect(run.stderr).toContain('Set AGORA_NEW_ENCRYPTION_KEY to the new key');
        }
        // Rotating again from a key that is no longer the instance's key is refused
        const third = randomBytes(32).toString('hex');
        const wrong = await runTool(TOOL, { ...toolEnv(), AGORA_NEW_ENCRYPTION_KEY: third });
        expect(wrong.code).toBe(1);
        expect(wrong.stderr).toContain('AGORA_ENCRYPTION_KEY is not the key this instance was set up with');
        expect(await fileRows()).toEqual(before);
        expect(await storedFingerprint()).toBe(fp.keyFingerprint(newKey));
    });
});
