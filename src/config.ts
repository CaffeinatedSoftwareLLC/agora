import 'dotenv/config';
import path from 'node:path';

// Validate AGORA_ENCRYPTION_KEY format if explicitly set
const rawEncryptionKey = process.env.AGORA_ENCRYPTION_KEY;
if (rawEncryptionKey && !/^[0-9a-fA-F]{64}$/.test(rawEncryptionKey)) {
    throw new Error('AGORA_ENCRYPTION_KEY must be exactly 64 hex characters');
}

// Hard-fail in production if encryption key is missing
if (process.env.NODE_ENV === 'production' && !rawEncryptionKey) {
    throw new Error('AGORA_ENCRYPTION_KEY must be set in production');
}

// Warn in non-test environments if using default key
if (!rawEncryptionKey && process.env.NODE_ENV !== 'test') {
    console.warn('WARNING: Using default AGORA_ENCRYPTION_KEY — set a real key for production');
}

const storageDriver = process.env.STORAGE_DRIVER ?? 'disk';
if (storageDriver !== 'disk' && storageDriver !== 's3') {
    throw new Error('STORAGE_DRIVER must be "disk" or "s3"');
}

export const config = {
    dbUrl: process.env.DATABASE_URL ?? 'postgres://accord:accord@localhost:5432/accord_test',
    testDbUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://accord:accord@localhost:5432/accord_test',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-do-not-use-in-prod',
    port: parseInt(process.env.PORT ?? '3000', 10),
    trustProxy: process.env.TRUST_PROXY === 'true',
    corsOrigin: process.env.CORS_ORIGIN || undefined,
    storage: {
        driver: storageDriver,
        /** Disk driver: where blobs are written (a Docker volume in the compose files). */
        dir: path.resolve(process.env.STORAGE_DIR ?? 'data/files'),
        /** S3 driver. The MINIO_* names are read as fallbacks for pre-#32 configs. */
        s3: {
            endpoint: process.env.S3_ENDPOINT ?? process.env.MINIO_ENDPOINT ?? 'http://localhost:9000',
            accessKey: process.env.S3_ACCESS_KEY ?? process.env.MINIO_ROOT_USER ?? '',
            secretKey: process.env.S3_SECRET_KEY ?? process.env.MINIO_ROOT_PASSWORD ?? '',
            bucket: process.env.S3_BUCKET ?? 'agora-files',
            region: process.env.S3_REGION || undefined,
        },
    },
    encryptionKey: Buffer.from(rawEncryptionKey ?? '0'.repeat(64), 'hex'),
};
