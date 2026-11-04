import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Encrypted backup bundles (docs/agent-boxes.md §9.4). install/backup.sh streams every part
 * (postgres.sql, files-data.tar, boxes/<id>-home.tar, env.prod, manifest.json) through
 * `encrypt` and appends it to one bundle file, so nothing is written in plain text.
 *
 * A bundle is a sequence of segments, one per part:
 *
 *   header   "AGORABK1" | version 1 | log2(N) | r | p | salt[16] | nonce prefix[8]
 *            | chunk size u32 | name length u16 | name (utf-8)
 *   chunks   type u8 (0 data, 1 trailer) | length u32 | ciphertext | GCM tag[16]
 *
 * The key is scrypt(passphrase, salt). Each chunk is AES-256-GCM with IV = nonce prefix |
 * chunk counter u32, and associated data SHA-256(header) | counter u64 | type, so chunks can't
 * be reordered, moved to another segment or have their type changed. The trailer (always last)
 * carries the part's plaintext SHA-256 and length; a segment without one was truncated. Each
 * chunk is authenticated before its plaintext is released, so `verify` can check a whole
 * bundle as a stream, and `extract` never emits bytes that failed authentication.
 *
 *   node dist/src/tools/backup-crypt.js encrypt --name <part> --passphrase-file <f>  < plain > segment
 *   node dist/src/tools/backup-crypt.js verify  --passphrase-file <f>                 < bundle
 *   node dist/src/tools/backup-crypt.js extract --name <part> --passphrase-file <f>  < bundle > plain
 *
 * `encrypt` prints `part <name> <sha256> <bytes>` on stderr; `verify` prints the same line
 * for every part on stdout. Exit code 1 on any failure (wrong passphrase, damage, truncation).
 */

export const MAGIC = Buffer.from('AGORABK1', 'ascii');
export const FORMAT_VERSION = 1;
export const DEFAULT_CHUNK = 1024 * 1024;
/** OWASP's scrypt baseline: N = 2^17, r = 8, p = 1 (128 MiB). */
export const DEFAULT_LOG_N = 17;
const MAX_CHUNK = 16 * 1024 * 1024;
const TAG_LEN = 16;
const TYPE_DATA = 0;
const TYPE_TRAILER = 1;
const PART_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export class BackupCryptError extends Error {}

export interface PartSummary {
    name: string;
    sha256: string;
    bytes: number;
}

export interface EncryptOptions {
    chunkSize?: number;
    /** log2 of scrypt's N; tests use a small one. */
    logN?: number;
}

function deriveKey(passphrase: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
    const N = 2 ** logN;
    return new Promise((resolve, reject) => {
        scryptCb(passphrase, salt, 32, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key)));
    });
}

function chunkAad(headerHash: Buffer, counter: number, type: number): Buffer {
    const aad = Buffer.alloc(32 + 8 + 1);
    headerHash.copy(aad, 0);
    aad.writeBigUInt64BE(BigInt(counter), 32);
    aad[40] = type;
    return aad;
}

function chunkIv(prefix: Buffer, counter: number): Buffer {
    const iv = Buffer.alloc(12);
    prefix.copy(iv, 0);
    iv.writeUInt32BE(counter, 8);
    return iv;
}

export function validPartName(name: string): boolean {
    return PART_NAME.test(name) && !name.split('/').some((s) => s === '..' || s === '.' || s === '');
}

/** One encrypted segment for part `name`, yielded as it is produced. */
export async function* encryptPart(
    input: AsyncIterable<Buffer | string>,
    passphrase: string,
    name: string,
    opts: EncryptOptions = {},
    onSummary?: (s: PartSummary) => void,
): AsyncGenerator<Buffer> {
    if (!passphrase) throw new BackupCryptError('empty passphrase');
    if (!validPartName(name)) throw new BackupCryptError(`invalid part name: ${name}`);
    const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK) throw new BackupCryptError('invalid chunk size');
    const logN = opts.logN ?? DEFAULT_LOG_N;
    const r = 8;
    const p = 1;
    const salt = randomBytes(16);
    const prefix = randomBytes(8);
    const nameBuf = Buffer.from(name, 'utf8');
    const fixed = Buffer.alloc(MAGIC.length + 4 + 16 + 8 + 4 + 2);
    let o = MAGIC.copy(fixed, 0);
    fixed[o++] = FORMAT_VERSION;
    fixed[o++] = logN;
    fixed[o++] = r;
    fixed[o++] = p;
    o += salt.copy(fixed, o);
    o += prefix.copy(fixed, o);
    fixed.writeUInt32BE(chunkSize, o);
    fixed.writeUInt16BE(nameBuf.length, o + 4);
    const header = Buffer.concat([fixed, nameBuf]);
    const headerHash = createHash('sha256').update(header).digest();
    const key = await deriveKey(passphrase, salt, logN, r, p);
    yield header;

    let counter = 0;
    const seal = (type: number, plain: Buffer): Buffer => {
        if (counter >= 0xffffffff) throw new BackupCryptError('part too large');
        const cipher = createCipheriv('aes-256-gcm', key, chunkIv(prefix, counter));
        cipher.setAAD(chunkAad(headerHash, counter, type));
        const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
        const head = Buffer.alloc(5);
        head[0] = type;
        head.writeUInt32BE(ct.length, 1);
        counter++;
        return Buffer.concat([head, ct, cipher.getAuthTag()]);
    };

    const hash = createHash('sha256');
    let bytes = 0;
    let pending: Buffer[] = [];
    let pendingLen = 0;
    for await (const piece of input) {
        let buf = typeof piece === 'string' ? Buffer.from(piece) : piece;
        hash.update(buf);
        bytes += buf.length;
        while (buf.length > 0) {
            const take = Math.min(buf.length, chunkSize - pendingLen);
            pending.push(buf.subarray(0, take));
            pendingLen += take;
            buf = buf.subarray(take);
            if (pendingLen === chunkSize) {
                yield seal(TYPE_DATA, Buffer.concat(pending));
                pending = [];
                pendingLen = 0;
            }
        }
    }
    if (pendingLen > 0) yield seal(TYPE_DATA, Buffer.concat(pending));
    const sha256 = hash.digest();
    const trailer = Buffer.alloc(40);
    sha256.copy(trailer, 0);
    trailer.writeBigUInt64BE(BigInt(bytes), 32);
    yield seal(TYPE_TRAILER, trailer);
    onSummary?.({ name, sha256: sha256.toString('hex'), bytes });
}

/** Pulls exact byte counts out of an async byte stream. */
class Reader {
    private buf = Buffer.alloc(0);
    private done = false;
    private readonly it: AsyncIterator<Buffer | string>;
    constructor(input: AsyncIterable<Buffer | string>) {
        this.it = input[Symbol.asyncIterator]();
    }
    private async fill(n: number): Promise<void> {
        while (this.buf.length < n && !this.done) {
            const next = await this.it.next();
            if (next.done) this.done = true;
            else this.buf = Buffer.concat([this.buf, typeof next.value === 'string' ? Buffer.from(next.value) : next.value]);
        }
    }
    /** True at a clean end of input. */
    async atEnd(): Promise<boolean> {
        await this.fill(1);
        return this.buf.length === 0;
    }
    async read(n: number): Promise<Buffer> {
        await this.fill(n);
        if (this.buf.length < n) throw new BackupCryptError('bundle is truncated');
        const out = this.buf.subarray(0, n);
        this.buf = this.buf.subarray(n);
        return out;
    }
}

export type BundleEvent = { type: 'data'; name: string; data: Buffer } | { type: 'part'; summary: PartSummary };

/**
 * Reads a bundle, authenticating every chunk. Yields each part's plaintext as it is verified,
 * then a `part` event once the part's trailer and checksum match. Throws on anything else.
 */
export async function* readBundle(input: AsyncIterable<Buffer | string>, passphrase: string): AsyncGenerator<BundleEvent> {
    const reader = new Reader(input);
    const keys = new Map<string, Buffer>();
    let segments = 0;
    while (!(await reader.atEnd())) {
        const magic = await reader.read(MAGIC.length).catch(() => Buffer.alloc(0));
        if (!magic.equals(MAGIC)) {
            throw new BackupCryptError(segments === 0 ? 'not an Agora backup bundle' : 'bundle is damaged (bad segment header)');
        }
        const fixed = Buffer.concat([magic, await reader.read(4 + 16 + 8 + 4 + 2)]);
        let o = MAGIC.length;
        const version = fixed[o++];
        if (version !== FORMAT_VERSION) throw new BackupCryptError(`unsupported bundle version ${version}`);
        const logN = fixed[o++];
        const r = fixed[o++];
        const p = fixed[o++];
        if (logN < 10 || logN > 22 || r < 1 || r > 32 || p < 1 || p > 16) throw new BackupCryptError('bundle is damaged (bad key parameters)');
        const salt = fixed.subarray(o, o + 16);
        o += 16;
        const prefix = fixed.subarray(o, o + 8);
        o += 8;
        const chunkSize = fixed.readUInt32BE(o);
        const nameLen = fixed.readUInt16BE(o + 4);
        if (chunkSize < 1 || chunkSize > MAX_CHUNK || nameLen < 1 || nameLen > 200) throw new BackupCryptError('bundle is damaged (bad header)');
        const nameBuf = await reader.read(nameLen);
        const header = Buffer.concat([fixed, nameBuf]);
        const headerHash = createHash('sha256').update(header).digest();
        const name = nameBuf.toString('utf8');
        // The header is checked by the first chunk's tag; the name is only trusted after that
        const cacheKey = `${salt.toString('hex')}:${logN}:${r}:${p}`;
        let key = keys.get(cacheKey);
        if (!key) {
            key = await deriveKey(passphrase, Buffer.from(salt), logN, r, p);
            keys.set(cacheKey, key);
        }

        const hash = createHash('sha256');
        let bytes = 0;
        for (let counter = 0; ; counter++) {
            const head = await reader.read(5);
            const type = head[0];
            const len = head.readUInt32BE(1);
            if ((type !== TYPE_DATA && type !== TYPE_TRAILER) || len > chunkSize) throw new BackupCryptError('bundle is damaged (bad chunk)');
            const ct = await reader.read(len);
            const tag = await reader.read(TAG_LEN);
            const decipher = createDecipheriv('aes-256-gcm', key, chunkIv(prefix, counter));
            decipher.setAAD(chunkAad(headerHash, counter, type));
            decipher.setAuthTag(tag);
            let plain: Buffer;
            try {
                plain = Buffer.concat([decipher.update(ct), decipher.final()]);
            } catch {
                throw new BackupCryptError(
                    segments === 0 && counter === 0 ? 'wrong passphrase, or the bundle is damaged' : `bundle is damaged (part ${name}, chunk ${counter})`,
                );
            }
            if (type === TYPE_DATA) {
                hash.update(plain);
                bytes += plain.length;
                if (plain.length > 0) yield { type: 'data', name, data: plain };
                continue;
            }
            if (plain.length !== 40) throw new BackupCryptError('bundle is damaged (bad trailer)');
            const want = plain.subarray(0, 32);
            const got = hash.digest();
            if (!timingSafeEqual(want, got) || Number(plain.readBigUInt64BE(32)) !== bytes) {
                throw new BackupCryptError(`bundle is damaged (part ${name} checksum)`);
            }
            if (!validPartName(name)) throw new BackupCryptError('bundle is damaged (bad part name)');
            yield { type: 'part', summary: { name, sha256: got.toString('hex'), bytes } };
            break;
        }
        segments++;
    }
    if (segments === 0) throw new BackupCryptError('bundle is empty');
}

/** Every part's summary, after checking the whole bundle. */
export async function verifyBundle(input: AsyncIterable<Buffer | string>, passphrase: string): Promise<PartSummary[]> {
    const parts: PartSummary[] = [];
    for await (const ev of readBundle(input, passphrase)) if (ev.type === 'part') parts.push(ev.summary);
    return parts;
}

/** The plaintext of one part, verified chunk by chunk. Throws if the part isn't there. */
export async function* extractPart(input: AsyncIterable<Buffer | string>, passphrase: string, name: string): AsyncGenerator<Buffer> {
    let found = false;
    for await (const ev of readBundle(input, passphrase)) {
        if (ev.type === 'data' && ev.name === name) yield ev.data;
        if (ev.type === 'part' && ev.summary.name === name) found = true;
    }
    if (!found) throw new BackupCryptError(`part ${name} is not in the bundle`);
}

// ─── CLI ───

function arg(args: string[], name: string): string | undefined {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : undefined;
}

export function readPassphrase(file: string): string {
    // One line; a trailing newline from `echo` or an editor isn't part of it
    const pass = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    if (pass.length < 12) throw new BackupCryptError('the backup passphrase must be at least 12 characters');
    return pass;
}

async function write(out: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
    if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
}

async function main(argv: string[]): Promise<void> {
    const [cmd, ...rest] = argv;
    const passFile = arg(rest, 'passphrase-file');
    if (!cmd || !['encrypt', 'verify', 'extract'].includes(cmd) || !passFile) {
        throw new BackupCryptError('usage: backup-crypt encrypt|verify|extract --passphrase-file <file> [--name <part>]');
    }
    const passphrase = readPassphrase(passFile);
    if (cmd === 'encrypt') {
        const name = arg(rest, 'name');
        if (!name) throw new BackupCryptError('encrypt needs --name');
        for await (const chunk of encryptPart(process.stdin, passphrase, name, {}, (s) => {
            process.stderr.write(`part ${s.name} ${s.sha256} ${s.bytes}\n`);
        })) await write(process.stdout, chunk);
        return;
    }
    if (cmd === 'verify') {
        for (const s of await verifyBundle(process.stdin, passphrase)) process.stdout.write(`part ${s.name} ${s.sha256} ${s.bytes}\n`);
        return;
    }
    const name = arg(rest, 'name');
    if (!name) throw new BackupCryptError('extract needs --name');
    for await (const chunk of extractPart(process.stdin, passphrase, name)) await write(process.stdout, chunk);
}

if (require.main === module) {
    main(process.argv.slice(2)).catch((err: unknown) => {
        process.stderr.write(`backup-crypt: ${err instanceof BackupCryptError ? err.message : 'failed'}\n`);
        if (!(err instanceof BackupCryptError)) process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`);
        process.exit(1);
    });
}
