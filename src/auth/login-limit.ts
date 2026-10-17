import { getRedis } from './token-blacklist';
import { config } from '../config';

/**
 * Login attempt limits, kept in Redis.
 *
 * Two counters, both checked before any password is hashed:
 * - a per-account count of attempts not yet followed by a success, for every account
 *   an identifier matched
 *   (one identifier can match up to five accounts, so counting only the one the
 *   password unlocks would let guesses against the others go uncounted);
 * - an instance-wide count of attempts per minute, which also covers identifiers
 *   that match no account. Unknown identifiers leave no state of their own.
 *
 * Nothing here depends on the client's IP address: behind the proxies the
 * forwarded address can't be relied on, and every local agent shares one address.
 */
export interface LoginLimits {
    maxFailures: number;      // failed logins per account before it is locked
    lockSeconds: number;      // how long failures are remembered (and the lock lasts)
    globalPerMinute: number;  // login attempts per minute across the instance
}

export const defaultLoginLimits: LoginLimits = config.loginLimits;

const FAIL_PREFIX = 'login:fail:';
const GLOBAL_PREFIX = 'login:global:';

export function failureKey(userId: string): string {
    return `${FAIL_PREFIX}${userId.trim()}`;
}

export class LoginLimiter {
    constructor(private readonly limits: LoginLimits = defaultLoginLimits) {}

    /** Count one attempt against this minute's budget. False when it is spent. */
    async takeGlobalAttempt(): Promise<boolean> {
        const key = `${GLOBAL_PREFIX}${Math.floor(Date.now() / 60_000)}`;
        const results = await getRedis().multi().incr(key).expire(key, 120).exec();
        const count = Number(results?.[0]?.[1] ?? 0);
        return count <= this.limits.globalPerMinute;
    }

    /**
     * Charge one attempt to every matched account before the password is checked,
     * so parallel guesses can't all pass a check-then-count. True when any of them
     * is over its limit: the login must then be refused without hashing anything.
     * A successful login clears its own account's count.
     */
    async reserveAttempt(userIds: string[]): Promise<boolean> {
        if (userIds.length === 0) return false;
        const multi = getRedis().multi();
        for (const id of userIds) {
            const key = failureKey(id);
            multi.incr(key);
            // NX: the window starts at the first attempt and is not extended by later ones
            multi.expire(key, this.limits.lockSeconds, 'NX');
        }
        const results = await multi.exec();
        return userIds.some((_, i) => Number(results?.[i * 2]?.[1] ?? 0) > this.limits.maxFailures);
    }

    async clearFailures(userId: string): Promise<void> {
        await getRedis().del(failureKey(userId));
    }

    get lockSeconds(): number {
        return this.limits.lockSeconds;
    }
}
