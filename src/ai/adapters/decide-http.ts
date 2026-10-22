import { DecideError } from './types';
import { networkError } from './sse';

/**
 * The HTTP side shared by decision adapters: one POST with a single deadline that
 * covers every retry, backoff that honours `Retry-After`, and errors that never
 * carry key material.
 */

/** Decisions sit in front of something a person is waiting for; retries share this one deadline. */
export const DECIDE_DEFAULT_TIMEOUT_MS = 3000;
const MAX_RETRIES = 3;
const BACKOFF_MS = [150, 400, 900];

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** `Retry-After` in milliseconds (seconds or an HTTP date), or null. */
function retryAfterMs(res: Response): number | null {
    const header = res.headers.get('retry-after');
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(header);
    return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/** "<Provider> API <status>: <message>", whitespace collapsed and cut at 300 characters. */
export function decideErrorText(provider: string, status: number, message: string): string {
    let text = message.replace(/\s+/g, ' ').trim();
    if (text.length > 300) text = `${text.slice(0, 300)}…`;
    return `${provider} API ${status}${text ? `: ${text}` : ''}`;
}

export interface DecidePost {
    /** Provider name for messages ("TypeSafe", "Cloudflare"). */
    provider: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
    timeoutMs: number;
    /** Statuses worth another try inside the deadline (rate limited, overloaded). */
    retryable: ReadonlySet<number>;
    /** An error body → the provider's message. The request (and so the key) is never echoed. */
    errorMessage(body: string): string;
}

/** POST once, retrying `retryable` statuses until the deadline. Returns the parsed JSON body. */
export async function postDecision(p: DecidePost): Promise<any> {
    const deadline = Date.now() + p.timeoutMs;
    const timedOut = () => new DecideError('timeout', `${p.provider} did not answer within ${p.timeoutMs} ms`);

    for (let attempt = 0; ; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw timedOut();

        let res: Response;
        try {
            res = await fetch(p.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...p.headers },
                body: JSON.stringify(p.body),
                signal: AbortSignal.timeout(remaining),
            });
        } catch (err) {
            const name = (err as Error)?.name;
            if (name === 'TimeoutError' || name === 'AbortError') throw timedOut();
            throw new DecideError('transient', networkError(err));
        }

        if (res.ok) {
            try {
                return await res.json();
            } catch {
                throw new DecideError('invalid_response', `${p.provider} returned a body that is not JSON`);
            }
        }

        const message = decideErrorText(p.provider, res.status, p.errorMessage(await res.text().catch(() => '')));
        if (!p.retryable.has(res.status)) {
            // 5xx may pass; 4xx (bad key, bad request) will not
            throw new DecideError(res.status >= 500 ? 'transient' : 'permanent', message, res.status);
        }
        const wait = retryAfterMs(res) ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        if (attempt >= MAX_RETRIES || Date.now() + wait >= deadline) throw new DecideError('transient', message, res.status);
        await sleep(wait);
    }
}
