import type { ProviderCredentials } from './adapters/types';

/**
 * Provider keys travel in an HTTP header. A line break, control or non-ASCII
 * character there breaks the request, and Node's fetch quotes the offending value
 * in its error, so such keys are refused when saved and again before any request.
 */

/** What a key, token or account ID may contain: visible ASCII, no spaces or control characters. */
export const CREDENTIAL_CHARS = /^[\x21-\x7E]+$/;

export const BAD_KEY = 'The API key contains characters an API key cannot have (spaces, line breaks, control or non-ASCII characters)';

/** True for a non-empty key with characters a key cannot have. */
export const badKey = (key: unknown): boolean => typeof key === 'string' && key !== '' && !CREDENTIAL_CHARS.test(key);

/** Shortest secret worth matching: very short values would match ordinary words, and no real key is that short. */
const MIN_SECRET = 4;
/** Shortest key fragment removed where a message was cut short ("…"). */
const MIN_FRAGMENT = 8;

/** True when the key or account ID has characters fetch would refuse in a header (or quote in its error). */
export const badCredentials = (creds: ProviderCredentials): boolean => badKey(creds.apiKey) || badKey(creds.accountId);

/**
 * The credential values to keep out of messages: the key, the account ID, and anything
 * secret a base URL carries (user info, query values such as `?key=`), as written in the
 * URL and decoded.
 */
export function secretsOf(creds: ProviderCredentials): string[] {
    const out = [creds.apiKey, creds.accountId];
    if (creds.baseUrl) {
        try {
            const url = new URL(creds.baseUrl);
            const raw = [url.username, url.password, ...url.search.slice(1).split('&').map(pair => pair.slice(pair.indexOf('=') + 1))];
            for (const part of raw) {
                out.push(part);
                let decoded = '';
                try { decoded = decodeURIComponent(part.replace(/\+/g, ' ')); } catch { /* malformed escape */ }
                // A decoded value with spaces could never be sent as is; its encoded form is covered above
                if (CREDENTIAL_CHARS.test(decoded)) out.push(decoded);
            }
        } catch { /* not a URL: nothing to take from it */ }
    }
    return [...new Set(out.filter((s): s is string => typeof s === 'string' && s.length >= MIN_SECRET))];
}

/**
 * `text` with every credential replaced, in the forms a provider might echo it: as sent,
 * JSON-escaped, URL-encoded. A message truncated in the middle of a key ("sk-abc12…")
 * loses that fragment too.
 */
export function redact(text: string, secrets: readonly string[]): string {
    let out = text;
    for (const secret of secrets) {
        for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])) {
            out = out.split(form).join('[redacted]');
            for (let n = form.length - 1; n >= MIN_FRAGMENT; n--) {
                const cut = `${form.slice(0, n)}…`;
                if (out.includes(cut)) out = out.split(cut).join('[redacted]…');
            }
        }
    }
    return out;
}
