import Redis from 'ioredis';
import { config } from '../config';

const BLACKLIST_PREFIX = 'token:blacklist:';

let redis: Redis | null = null;

export function getRedis(): Redis {
    if (!redis) {
        redis = new Redis(config.redisUrl);
    }
    return redis;
}

/**
 * Blacklist a token by its jti. TTL = seconds until the token expires,
 * so the blacklist entry auto-cleans after the token would have expired anyway.
 */
export async function blacklistToken(jti: string, expUnix: number): Promise<void> {
    const ttl = expUnix - Math.floor(Date.now() / 1000);
    if (ttl <= 0) return; // already expired
    await getRedis().set(`${BLACKLIST_PREFIX}${jti}`, '1', 'EX', ttl);
}

/** Check if a token jti has been blacklisted. */
export async function isTokenBlacklisted(jti: string): Promise<boolean> {
    const result = await getRedis().get(`${BLACKLIST_PREFIX}${jti}`);
    return result !== null;
}

export async function closeRedis(): Promise<void> {
    if (redis) {
        await redis.quit();
        redis = null;
    }
}
