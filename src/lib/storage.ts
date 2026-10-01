import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from 'minio';
import { config } from '../config';

/**
 * Where encrypted file blobs live (#32). The default is a directory on local disk
 * (in Docker, a volume shared by the API and cap-gateway): no extra service and no
 * storage credentials. `STORAGE_DRIVER=s3` uses any S3-compatible service instead
 * (AWS S3, Cloudflare R2, Backblaze B2, Garage, SeaweedFS, an existing MinIO, ...).
 *
 * Blobs are already encrypted by the caller (file-store.ts); keys look like
 * `<channelId>/<fileId>/blob` (files stored before 0.2.0 end in the file name instead).
 */
export interface ObjectStore {
    readonly kind: 'disk' | 's3';
    /** Create the directory or bucket if needed; call once at startup. */
    init(): Promise<void>;
    put(key: string, data: Buffer): Promise<void>;
    /** The blob, or null when it doesn't exist. */
    get(key: string): Promise<Buffer | null>;
    /** Delete a blob; deleting a missing one is not an error. */
    remove(key: string): Promise<void>;
}

/** Legacy bucket name, also recorded in `files.bucket`. */
export const BUCKET_NAME = 'agora-files';

export function diskStore(root: string): ObjectStore {
    const base = path.resolve(root);

    /** Keys come from our own code, but never let one escape the root. */
    const pathOf = (key: string): string => {
        const segments = key.split('/');
        if (!key || segments.some(s => !s || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))) {
            throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
        }
        return path.join(base, ...segments);
    };

    return {
        kind: 'disk',
        async init() {
            await fs.mkdir(base, { recursive: true });
        },
        async put(key, data) {
            const file = pathOf(key);
            await fs.mkdir(path.dirname(file), { recursive: true });
            // Write then rename, so a crash never leaves a partial blob under the real name
            const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
            try {
                await fs.writeFile(tmp, data);
                await fs.rename(tmp, file);
            } catch (err) {
                await fs.rm(tmp, { force: true });
                throw err;
            }
        },
        async get(key) {
            try {
                return await fs.readFile(pathOf(key));
            } catch (err: any) {
                if (err.code === 'ENOENT') return null;
                throw err;
            }
        },
        async remove(key) {
            const file = pathOf(key);
            await fs.rm(file, { force: true });
            // Drop the now-empty per-file and per-channel directories (fails harmlessly if not empty)
            for (let dir = path.dirname(file); dir !== base && dir.startsWith(base); dir = path.dirname(dir)) {
                try { await fs.rmdir(dir); } catch { break; }
            }
        },
    };
}

export interface S3Options {
    endpoint: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
    region?: string;
}

export function s3Store(opts: S3Options): ObjectStore {
    const url = new URL(opts.endpoint);
    const client = new Client({
        endPoint: url.hostname,
        port: url.port ? parseInt(url.port, 10) : undefined,
        useSSL: url.protocol === 'https:',
        accessKey: opts.accessKey,
        secretKey: opts.secretKey,
        region: opts.region,
        pathStyle: true,
    });

    return {
        kind: 's3',
        async init() {
            if (!(await client.bucketExists(opts.bucket))) await client.makeBucket(opts.bucket, opts.region);
        },
        async put(key, data) {
            await client.putObject(opts.bucket, key, data, data.length, { 'Content-Type': 'application/octet-stream' });
        },
        async get(key) {
            let stream;
            try {
                stream = await client.getObject(opts.bucket, key);
            } catch (err: any) {
                if (err.code === 'NoSuchKey' || err.code === 'NotFound') return null;
                throw err;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            return Buffer.concat(chunks);
        },
        async remove(key) {
            await client.removeObject(opts.bucket, key);
        },
    };
}

export function storeFromConfig(): ObjectStore {
    return config.storage.driver === 's3' ? s3Store(config.storage.s3) : diskStore(config.storage.dir);
}

/** The instance's file store. */
export const storage: ObjectStore = storeFromConfig();
