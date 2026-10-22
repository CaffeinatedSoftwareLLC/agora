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
