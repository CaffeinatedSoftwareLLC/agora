import 'dotenv/config';

const rawIpKey = process.env.IP_ENCRYPTION_KEY ?? '0'.repeat(64);

// Validate IP_ENCRYPTION_KEY format if explicitly set
if (process.env.IP_ENCRYPTION_KEY && !/^[0-9a-fA-F]{64}$/.test(process.env.IP_ENCRYPTION_KEY)) {
    throw new Error('IP_ENCRYPTION_KEY must be exactly 64 hex characters');
}

// Hard-fail in production if key is missing or default
if (process.env.NODE_ENV === 'production' && (!process.env.IP_ENCRYPTION_KEY || process.env.IP_ENCRYPTION_KEY === '0'.repeat(64))) {
    throw new Error('IP_ENCRYPTION_KEY must be set in production');
}

// Warn in non-test environments if using default key
if (rawIpKey === '0'.repeat(64) && process.env.NODE_ENV !== 'test') {
    console.warn('WARNING: Using default IP_ENCRYPTION_KEY — set a real key for production');
}

export const config = {
    dbUrl: process.env.DATABASE_URL ?? 'postgres://accord:accord@localhost:5432/accord_test',
    testDbUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://accord:accord@localhost:5432/accord_test',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-do-not-use-in-prod',
    port: parseInt(process.env.PORT ?? '3000', 10),
    ipEncryptionKey: Buffer.from(rawIpKey, 'hex'),
    trustProxy: process.env.TRUST_PROXY === 'true',
    livekitUrl: process.env.LIVEKIT_URL ?? 'ws://localhost:7880',
    livekitInternalUrl: process.env.LIVEKIT_INTERNAL_URL || undefined,
    livekitApiKey: process.env.LIVEKIT_API_KEY || undefined,
    livekitApiSecret: process.env.LIVEKIT_API_SECRET || undefined,
    corsOrigin: process.env.CORS_ORIGIN || undefined,
};
