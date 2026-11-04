import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
    BackupCryptError, MAGIC, encryptPart, extractPart, readBundle, validPartName, verifyBundle,
} from '../../src/tools/backup-crypt';

/** docs/agent-boxes.md §9.4: the backup bundle is encrypted in chunks, each authenticated. */
const PASS = 'correct horse battery staple';
// Small scrypt cost for tests; the tool's default is N = 2^17
const FAST = { logN: 10, chunkSize: 64 };

async function collect(gen: AsyncIterable<Buffer>): Promise<Buffer> {
    const out: Buffer[] = [];
    for await (const c of gen) out.push(c);
    return Buffer.concat(out);
}
async function* from(...bufs: Buffer[]) {
    for (const b of bufs) yield b;
}
/** Feeds a buffer back a few bytes at a time, as a pipe would. */
async function* trickle(buf: Buffer, step = 7) {
    for (let i = 0; i < buf.length; i += step) yield buf.subarray(i, i + step);
}
const seg = (data: Buffer, name: string, pass = PASS) => collect(encryptPart(from(data), pass, name, FAST));

describe('backup-crypt', () => {
    it('round-trips several parts in one bundle and reports their checksums', async () => {
        const a = randomBytes(1000);
        const b = Buffer.from('hello');
        const empty = Buffer.alloc(0);
        const bundle = Buffer.concat([await seg(a, 'postgres.sql'), await seg(b, 'boxes/01abc-home.tar'), await seg(empty, 'manifest.json')]);
        expect(bundle.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
        const parts = await verifyBundle(trickle(bundle), PASS);
        expect(parts).toEqual([
            { name: 'postgres.sql', sha256: createHash('sha256').update(a).digest('hex'), bytes: 1000 },
            { name: 'boxes/01abc-home.tar', sha256: createHash('sha256').update(b).digest('hex'), bytes: 5 },
            { name: 'manifest.json', sha256: createHash('sha256').update(empty).digest('hex'), bytes: 0 },
        ]);
        expect((await collect(extractPart(trickle(bundle), PASS, 'postgres.sql'))).equals(a)).toBe(true);
        expect((await collect(extractPart(from(bundle), PASS, 'boxes/01abc-home.tar'))).toString()).toBe('hello');
    });

    it('never writes the plaintext into the bundle', async () => {
        const secret = Buffer.from('AGORA_ENCRYPTION_KEY=' + 'ab'.repeat(32));
        const bundle = await seg(secret, 'env.prod');
        expect(bundle.includes(secret)).toBe(false);
        expect(bundle.includes(Buffer.from('ab'.repeat(8)))).toBe(false);
    });

    it('refuses the wrong passphrase', async () => {
        const bundle = await seg(Buffer.from('x'.repeat(200)), 'postgres.sql');
        await expect(verifyBundle(from(bundle), 'not the passphrase')).rejects.toThrow(/wrong passphrase/);
    });

    it('detects a flipped byte in any chunk, and emits nothing past it', async () => {
        const data = randomBytes(300);
        const bundle = await seg(data, 'files-data.tar');
        const bad = Buffer.from(bundle);
        bad[bad.length - 30] ^= 1;
        await expect(verifyBundle(from(bad), PASS)).rejects.toThrow(BackupCryptError);
        const got: Buffer[] = [];
        await expect((async () => {
            for await (const c of extractPart(from(bad), PASS, 'files-data.tar')) got.push(c);
        })()).rejects.toThrow(/damaged/);
        // Every byte released was authentic
        expect(data.subarray(0, Buffer.concat(got).length).equals(Buffer.concat(got))).toBe(true);
    });

    it('detects truncation, even at a chunk boundary', async () => {
        const bundle = await seg(randomBytes(256), 'postgres.sql');
        await expect(verifyBundle(from(bundle.subarray(0, bundle.length - 1)), PASS)).rejects.toThrow(/truncated/);
        // Drop the trailer chunk (5-byte head + 40 bytes + 16-byte tag): no checksum, so truncated
        await expect(verifyBundle(from(bundle.subarray(0, bundle.length - 61)), PASS)).rejects.toThrow(/truncated/);
    });

    it('detects chunks swapped between positions or between parts', async () => {
        const one = await seg(Buffer.alloc(128, 1), 'a.tar');
        // Swap the two 64-byte data chunks (each 5 + 64 + 16 = 85 bytes) after the header
        const headerLen = 42 + 'a.tar'.length; // fixed header + name
        expect(one.length).toBe(headerLen + 85 + 85 + 61); // two data chunks, then the trailer
        const c1 = one.subarray(headerLen, headerLen + 85);
        const c2 = one.subarray(headerLen + 85, headerLen + 170);
        const swapped = Buffer.concat([one.subarray(0, headerLen), c2, c1, one.subarray(headerLen + 170)]);
        await expect(verifyBundle(from(swapped), PASS)).rejects.toThrow(/damaged/);
        // The same data under another part's header: the header hash is in every chunk's AAD
        const other = await seg(Buffer.alloc(128, 1), 'b.tar');
        const renamed = Buffer.concat([other.subarray(0, headerLen), one.subarray(headerLen)]);
        await expect(verifyBundle(from(renamed), PASS)).rejects.toThrow(BackupCryptError);
    });

    it('rejects garbage and an empty bundle', async () => {
        await expect(verifyBundle(from(Buffer.from('not a bundle at all, just text')), PASS)).rejects.toThrow(/not an Agora backup/);
        await expect(verifyBundle(from(), PASS)).rejects.toThrow(/empty/);
    });

    it('says which part is missing', async () => {
        const bundle = await seg(Buffer.from('x'), 'postgres.sql');
        await expect(collect(extractPart(from(bundle), PASS, 'files-data.tar'))).rejects.toThrow(/not in the bundle/);
    });

    it('accepts only plain relative part names', () => {
        for (const ok of ['postgres.sql', 'boxes/01hz-home.tar', 'manifest.json']) expect(validPartName(ok)).toBe(true);
        for (const bad of ['../etc/passwd', '/abs', 'a//b', 'boxes/../x', '', '.hidden/..']) expect(validPartName(bad)).toBe(false);
    });

    it('streams events per part in order', async () => {
        const bundle = Buffer.concat([await seg(Buffer.from('one'), 'a'), await seg(Buffer.from('two'), 'b')]);
        const events: string[] = [];
        for await (const ev of readBundle(from(bundle), PASS)) events.push(ev.type === 'data' ? `data:${ev.name}` : `part:${ev.summary.name}`);
        expect(events).toEqual(['data:a', 'part:a', 'data:b', 'part:b']);
    });

    it('works as a CLI: encrypt, verify, extract over pipes', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agora-backup-crypt-'));
        const passFile = join(dir, 'pass');
        writeFileSync(passFile, `${PASS}\n`, { mode: 0o600 });
        const tool = resolve(__dirname, '../../src/tools/backup-crypt.ts');
        const tsx = ['--import', 'tsx', tool];
        const data = randomBytes(5000);
        const enc = spawnSync(process.execPath, [...tsx, 'encrypt', '--name', 'postgres.sql', '--passphrase-file', passFile], { input: data });
        expect(enc.status).toBe(0);
        expect(enc.stderr.toString()).toMatch(new RegExp(`^part postgres.sql ${createHash('sha256').update(data).digest('hex')} 5000`, 'm'));
        const ver = spawnSync(process.execPath, [...tsx, 'verify', '--passphrase-file', passFile], { input: enc.stdout });
        expect(ver.status).toBe(0);
        expect(ver.stdout.toString()).toContain('part postgres.sql');
        const ext = spawnSync(process.execPath, [...tsx, 'extract', '--name', 'postgres.sql', '--passphrase-file', passFile], { input: enc.stdout, maxBuffer: 1 << 24 });
        expect(ext.status).toBe(0);
        expect(Buffer.from(ext.stdout).equals(data)).toBe(true);
        writeFileSync(passFile, 'short\n');
        const weak = spawnSync(process.execPath, [...tsx, 'verify', '--passphrase-file', passFile], { input: enc.stdout });
        expect(weak.status).toBe(1);
        expect(weak.stderr.toString()).toMatch(/at least 12/);
    }, 60_000);
});
