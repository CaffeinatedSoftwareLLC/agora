import { isServiceUnavailable } from './service-unavailable';

/**
 * Retries a startup step while its dependency is not reachable yet.
 *
 * After a reboot the Docker daemon restarts every `restart: unless-stopped` container at once and
 * ignores compose's `depends_on`, so a service can start before Postgres accepts connections
 * (ECONNREFUSED, or 57P03 "the database system is starting up"). Exiting then costs a container
 * restart and an error in the logs; waiting here costs nothing. Any other error (a wrong
 * encryption key, a bad config) is thrown at once.
 */
export async function retryWhileUnavailable<T>(
    step: string,
    fn: () => Promise<T>,
    opts: {
        /** Give up after this long and throw the last error (default 2 minutes). */
        timeoutMs?: number;
        delayMs?: number;
        log?: (msg: string) => void;
        sleep?: (ms: number) => Promise<void>;
        now?: () => number;
        isTransient?: (err: unknown) => boolean;
    } = {},
): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const delayMs = opts.delayMs ?? 2_000;
    const log = opts.log ?? ((msg: string) => console.warn(msg));
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const now = opts.now ?? Date.now;
    const isTransient = opts.isTransient ?? isServiceUnavailable;
    const deadline = now() + timeoutMs;
    let attempt = 0;
    for (;;) {
        attempt++;
        try {
            return await fn();
        } catch (err) {
            if (!isTransient(err) || now() + delayMs > deadline) throw err;
            const why = err instanceof Error ? ((err as NodeJS.ErrnoException).code || err.message) : String(err);
            log(`${step}: dependency not ready (${why}); retrying in ${Math.round(delayMs / 1000)} s (attempt ${attempt})`);
            await sleep(delayMs);
        }
    }
}
