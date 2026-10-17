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

/**
 * MULTI/EXEC can succeed as a whole while single commands in it fail (a key of the
 * wrong type, an ACL denial), and EXEC returns null when the transaction is aborted.
 * Any of these would read as a count of zero and let attempts through, so they are
 * errors here, which the login route turns into 503.
 */
function checkedResults(results: [Error | null, unknown][] | null, expected: number): unknown[] {
    if (!results || results.length !== expected) {
        throw new Error('login limit: Redis transaction did not run');
    }
    return results.map(([err, value]) => {
        if (err) throw err;
        return value;
    });
}

function count(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`login limit: unexpected counter value ${String(value)}`);
    }
    return value;
}

export class LoginLimiter {
    constructor(private readonly limits: LoginLimits = defaultLoginLimits) {}

    /** Count one attempt against this minute's budget. False when it is spent. */
    async takeGlobalAttempt(): Promise<boolean> {
        const key = `${GLOBAL_PREFIX}${Math.floor(Date.now() / 60_000)}`;
        const [attempts] = checkedResults(await getRedis().multi().incr(key).expire(key, 120).exec(), 2);
        return count(attempts) <= this.limits.globalPerMinute;
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
        // Each account has an INCR and an EXPIRE; an EXPIRE error is caught too, so a
        // counter can't be left without its expiry (a lock that never lifts)
        const values = checkedResults(await multi.exec(), userIds.length * 2);
        return userIds.some((_, i) => count(values[i * 2]) > this.limits.maxFailures);
    }

    async clearFailures(userId: string): Promise<void> {
        await getRedis().del(failureKey(userId));
    }

    get lockSeconds(): number {
        return this.limits.lockSeconds;
    }
}
