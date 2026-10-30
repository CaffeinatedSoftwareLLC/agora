import { badCredentials, redact, secretsOf } from '../credentials';
import { CREDENTIAL_PROBLEM } from './decide-http';
import { DecideError, type Adapter, type ProviderCredentials, type StreamCallbacks } from './types';

/**
 * Every adapter is reached through this wrapper (`getAdapter`), so no provider call can
 * hand key material to a chat message, log, audit row or API response. Error text comes
 * from the provider (which may echo the key) and from Node's fetch (which can quote a
 * header value or a URL), and adapters build it in many places; redacting here covers
 * all of them, including ones added later. A key fetch would refuse as a header is never
 * sent at all.
 */

/** Capability calls that take `(creds, req)` and throw on failure. */
const CALLS = ['chatWithTools', 'search', 'generateImage', 'tts', 'ttsDialogue', 'generateVideo', 'transcribe', 'decide'] as const;

const hidden = (value: unknown) => ({ value, writable: true, configurable: true, enumerable: false });

/**
 * `err` with every credential removed from its message, stack and cause. The error keeps
 * its class and fields (callers check `ProviderHttpError.status`, `DecideError.kind`).
 * Own properties are defined rather than assigned: DOMException's `message` is a getter.
 */
export function scrubError(err: unknown, secrets: readonly string[]): Error {
    if (!(err instanceof Error)) return new Error(redact(String(err), secrets));
    Object.defineProperty(err, 'message', hidden(redact(err.message, secrets)));
    if (typeof err.stack === 'string') Object.defineProperty(err, 'stack', hidden(redact(err.stack, secrets)));
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined) {
        // Only what `networkError` reads: the code, and a message with no key in it
        const { code, message } = (cause ?? {}) as { code?: unknown; message?: unknown };
        Object.defineProperty(err, 'cause', hidden({
            ...(typeof code === 'string' ? { code: redact(code, secrets) } : {}),
            ...(typeof message === 'string' ? { message: redact(message, secrets) } : {}),
        }));
    }
    return err;
}

export function guardAdapter(adapter: Adapter): Adapter {
    const guarded: Adapter = {
        ...adapter,
        async testConnection(creds, model, capability) {
            if (badCredentials(creds)) return { ok: false, error: CREDENTIAL_PROBLEM };
            const secrets = secretsOf(creds);
            try {
                const result = await adapter.testConnection(creds, model, capability);
                return result.error === undefined ? result : { ...result, error: redact(result.error, secrets) };
            } catch (err) {
                return { ok: false, error: scrubError(err, secrets).message };
            }
        },
    };

    // Methods are looked up at call time, so a test can still spy on the adapter itself
    if (adapter.streamChat) {
        guarded.streamChat = async (creds, req, callbacks: StreamCallbacks) => {
            if (badCredentials(creds)) return callbacks.onError(new Error(CREDENTIAL_PROBLEM));
            const secrets = secretsOf(creds);
            try {
                await adapter.streamChat!(creds, req, { ...callbacks, onError: err => callbacks.onError(scrubError(err, secrets)) });
            } catch (err) {
                throw scrubError(err, secrets);
            }
        };
    }

    for (const name of CALLS) {
        if (!adapter[name]) continue;
        (guarded as any)[name] = async (creds: ProviderCredentials, req: unknown) => {
            if (badCredentials(creds)) {
                throw name === 'decide' ? new DecideError('permanent', CREDENTIAL_PROBLEM) : new Error(CREDENTIAL_PROBLEM);
            }
            try {
                return await (adapter[name] as (creds: ProviderCredentials, req: unknown) => Promise<unknown>)(creds, req);
            } catch (err) {
                throw scrubError(err, secretsOf(creds));
            }
        };
    }
    return guarded;
}
