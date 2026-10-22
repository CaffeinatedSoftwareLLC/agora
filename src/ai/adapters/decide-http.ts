import { DecideError, type ProviderCredentials } from './types';
import { CREDENTIAL_CHARS } from '../credentials';

/**
 * The HTTP side shared by decision adapters: one POST with a single deadline that
 * covers every retry, backoff that honours `Retry-After`, and errors that never
 * carry key material. Error text comes from the provider (which may echo the key)
 * and from Node's fetch (which can quote a header value), so every message is
 * redacted before it is normalised, truncated, stored or shown.
 */

/** Decisions sit in front of something a person is waiting for; retries share this one deadline. */
export const DECIDE_DEFAULT_TIMEOUT_MS = 3000;
const MAX_RETRIES = 3;
const BACKOFF_MS = [150, 400, 900];

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const CREDENTIAL_PROBLEM = 'The stored key or account ID contains characters it cannot have (spaces, line breaks, control or non-ASCII characters)';

/** The credential values to keep out of messages. Very short values would match ordinary words, and no real key is that short. */
export function secretsOf(creds: ProviderCredentials): string[] {
    return [creds.apiKey, creds.accountId].filter((s): s is string => typeof s === 'string' && s.length >= 4);
}

/** `text` with every credential replaced, in the forms a provider might echo it: as sent, JSON-escaped, URL-encoded. */
export function redact(text: string, secrets: readonly string[]): string {
    let out = text;
    for (const secret of secrets) {
        for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])) {
            out = out.split(form).join('[redacted]');
        }
    }
    return out;
}

/** Whitespace collapsed and cut at 300 characters. Redact first: a cut can leave part of a key. */
function tidy(message: string): string {
    const text = message.replace(/\s+/g, ' ').trim();
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** "<Provider> API <status>: <message>". Redact first. */
export function decideErrorText(provider: string, status: number, message: string): string {
    const text = tidy(message);
    return `${provider} API ${status}${text ? `: ${text}` : ''}`;
}

/** A network failure as a category, never Node's own text (which can quote a header, and so the key). */
function networkFailure(provider: string, err: unknown): string {
    const code = (err as { cause?: { code?: unknown } })?.cause?.code;
    const safe = typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : '';
    return `Could not reach ${provider}${safe}`;
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
    /** Credentials sent with the request: checked before sending, removed from every error. */
    secrets: readonly string[];
    /** An error body → the provider's message. */
    errorMessage(body: string): string;
    /** A 200 body that is still a failure (Cloudflare's `success: false`) → its message, or null. */
    failure?(json: any): string | null;
}

/** POST once, retrying `retryable` statuses until the deadline. Returns the parsed JSON body. */
export async function postDecision(p: DecidePost): Promise<any> {
    // A value fetch would refuse as a header (or that would change the request) is never sent
    if (p.secrets.some(s => !CREDENTIAL_CHARS.test(s))) throw new DecideError('permanent', CREDENTIAL_PROBLEM);
    const clean = (text: string) => redact(text, p.secrets);

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
            throw new DecideError('transient', networkFailure(p.provider, err));
        }

        if (res.ok) {
            let json: any;
            try {
                json = await res.json();
            } catch {
                throw new DecideError('invalid_response', `${p.provider} returned a body that is not JSON`);
            }
            const failed = p.failure?.(json);
            if (failed !== null && failed !== undefined) {
                throw new DecideError('invalid_response', `${p.provider} reported a failure: ${tidy(clean(failed))}`);
            }
            return json;
        }

        const body = clean(await res.text().catch(() => ''));
        const message = decideErrorText(p.provider, res.status, clean(p.errorMessage(body)));
        if (!p.retryable.has(res.status)) {
            // 5xx may pass; 4xx (bad key, bad request) will not
            throw new DecideError(res.status >= 500 ? 'transient' : 'permanent', message, res.status);
        }
        const wait = retryAfterMs(res) ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        if (attempt >= MAX_RETRIES || Date.now() + wait >= deadline) throw new DecideError('transient', message, res.status);
        await sleep(wait);
    }
}

/** `Retry-After` in milliseconds (seconds or an HTTP date), or null. */
function retryAfterMs(res: Response): number | null {
    const header = res.headers.get('retry-after');
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(header);
    return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}
