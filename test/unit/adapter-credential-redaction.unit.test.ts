import { describe, it, expect, vi, afterEach } from 'vitest';
import { getAdapter, ProviderHttpError, type Adapter, type ProviderCredentials } from '../../src/ai/adapters';
import { scrubError } from '../../src/ai/adapters/guard';
import { redact, secretsOf } from '../../src/ai/credentials';
import { streamCompletion } from '../../src/ai/providers';

/**
 * Issue #236: the chat, search and speech adapters get the guarantee the decision adapters
 * got in #233. No credential reaches an error message, a connection-test result or a
 * callback, whatever the provider or Node's fetch says, and a key fetch would refuse as a
 * header is never sent. The guard sits on every registered adapter (getAdapter).
 */

const KEY = 'sk-live-5ecret-key-0123456789';
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const adapter = (id: string) => getAdapter(id)!;
const creds: ProviderCredentials = { apiKey: KEY };

/** Each chat, search and speech call, as `(adapter, creds) → the error it ends with`. */
type Call = (a: Adapter, c: ProviderCredentials) => Promise<Error | undefined>;
const caught = (p: Promise<unknown>) => p.then(() => undefined, e => e as Error);
const chat: Call = async (a, c) => {
    let error: Error | undefined;
    // A connection failure throws before any callback (streamCompletion routes it to onError)
    await caught(a.streamChat!(c, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, {
        onToken: () => {}, onDone: async () => {}, onError: async e => { error = e; },
    })).then(thrown => { error ??= thrown; });
    return error;
};
const CALLS: [string, string, Call][] = [
    ['anthropic', 'chat', chat],
    ['openai', 'chat', chat],
    ['gemini', 'chat', chat],
    ['openai', 'tool chat', (a, c) => caught(a.chatWithTools!(c, { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] } as any))],
    ['tavily', 'search', (a, c) => caught(a.search!(c, { model: 'basic', query: 'q' }))],
    ['gemini', 'search', (a, c) => caught(a.search!(c, { model: 'm', query: 'q' }))],
    ['openai', 'speech', (a, c) => caught(a.tts!(c, { model: 'tts-1', text: 'hi' } as any))],
    ['gemini', 'speech', (a, c) => caught(a.tts!(c, { model: 'm', text: 'hi' }))],
    ['openai', 'transcription', (a, c) => caught(a.transcribe!(c, { model: 'whisper-1', audio: Buffer.from('x'), mime: 'audio/mpeg' } as any))],
];
const TESTS: [string, string][] = [['anthropic', 'm'], ['openai', 'm'], ['gemini', 'm'], ['tavily', 'basic']];

afterEach(() => { vi.unstubAllGlobals(); });

function expectClean(text: string | undefined) {
    expect(text).toBeDefined();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(KEY.slice(0, 12));
    expect(text).not.toContain(encodeURIComponent(KEY));
}

describe('provider errors never carry the key (#236)', () => {
    it.each(CALLS)('%s %s: a key echoed in a JSON or plain-text error, or straddling the 300-character cut, is redacted', async (id, _what, call) => {
        for (const body of [
            () => json({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401),
            () => new Response(`Unauthorized: ${KEY}`, { status: 401 }),
            () => new Response(`${'x'.repeat(290)} ${KEY}`, { status: 401 }),
            () => json({ message: `bad ${JSON.stringify(KEY).slice(1, -1)} / ${encodeURIComponent(KEY)}` }, 403),
        ]) {
            vi.stubGlobal('fetch', vi.fn(async () => body()));
            const err = await call(adapter(id), creds);
            expectClean(err?.message);
            expectClean(err?.stack);
        }
    });

    it.each(TESTS)('%s: a connection test that fails with the key echoed is redacted', async (id, model) => {
        vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: `Invalid key ${KEY}` } }, 401)));
        const result = await adapter(id).testConnection(creds, model);
        expect(result.ok).toBe(false);
        expectClean(result.error);
        expect(result.error).toContain('[redacted]');
    });

    it.each(CALLS)('%s %s: Node\'s fetch error quoting the key, in its message or its cause, is redacted', async (id, _what, call) => {
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new TypeError(`Headers.append: "Bearer ${KEY}" is an invalid header value.`, { cause: { code: 'ERR_INVALID_CHAR', message: `bad ${KEY}` } });
        }));
        const err = await call(adapter(id), creds);
        expectClean(err?.message);
        expect(JSON.stringify((err as { cause?: unknown }).cause ?? null)).not.toContain(KEY);
    });

    it.each(TESTS)('%s: a connection test whose fetch throws with the key is redacted', async (id, model) => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause: { message: `invalid header ${KEY}` } }); }));
        const result = await adapter(id).testConnection(creds, model);
        expect(result.ok).toBe(false);
        expectClean(result.error);
    });

    it.each(CALLS)('%s %s: a key with a line break, NUL, space or non-ASCII is refused before any request', async (id, _what, call) => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        for (const bad of [`${KEY}\nX-Evil: 1`, `${KEY}\r\n`, `${KEY}\u0000`, `sk live ${KEY}`, `${KEY}ключ`]) {
            const err = await call(adapter(id), { apiKey: bad });
            expect(err?.message).toContain('characters it cannot have');
            expectClean(err?.message);
        }
        for (const [tid, model] of TESTS) {
            const result = await adapter(tid).testConnection({ apiKey: `${KEY}\r\n` }, model);
            expect(result).toEqual({ ok: false, error: expect.stringContaining('characters it cannot have') });
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a key carried in a base URL (user info or ?key=) is redacted too', async () => {
        const urlKey = 'url-5ecret-0123456789';
        vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(`no route for ${url}`, { status: 404 })));
        for (const baseUrl of [`https://user:${urlKey}@llm.example/v1`, `https://llm.example/v1?api_key=${urlKey}`, `https://${urlKey}@llm.example/v1`]) {
            const err = await chat(adapter('openai'), { baseUrl });
            expect(err?.message).toContain('404');
            expect(err?.message).not.toContain(urlKey);
        }
    });

    it('errors keep their class and status, so callers still branch on them', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: `key ${KEY} rate limited` } }, 429)));
        const err = await caught(adapter('openai').chatWithTools!(creds, { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] } as any));
        expect(err).toBeInstanceOf(ProviderHttpError);
        expect((err as ProviderHttpError).status).toBe(429);
        expectClean(err?.message);
    });

    it('the provider facade the assistant uses (streamCompletion) passes on only the redacted error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(`fetch failed for ${KEY}`, { cause: { code: 'ECONNREFUSED', message: KEY } }); }));
        const onError = vi.fn(async (_e: Error) => {});
        await streamCompletion({ provider: 'anthropic', model: 'm', apiKey: KEY }, [{ role: 'user', content: 'hi' }], {
            onToken: () => {}, onDone: async () => {}, onError,
        });
        expect(onError).toHaveBeenCalledOnce();
        expectClean(onError.mock.calls[0][0].message);
    });
});

describe('redaction helpers', () => {
    it('secretsOf takes the key, the account and a base URL\'s secrets, and skips values too short to be keys', () => {
        expect(secretsOf({ apiKey: KEY, accountId: 'acct-1234', baseUrl: 'https://me:p%40ss-word@h.example/v1?key=abc%2Bdef&x=1' }))
            .toEqual(expect.arrayContaining([KEY, 'acct-1234', 'p%40ss-word', 'p@ss-word', 'abc%2Bdef', 'abc+def']));
        expect(secretsOf({ apiKey: 'abc' })).toEqual([]);
        expect(secretsOf({ baseUrl: 'not a url' })).toEqual([]);
    });

    it('redact removes a key fragment left where a message was cut short', () => {
        expect(redact(`error: ${KEY.slice(0, 15)}…`, [KEY])).toBe('error: [redacted]…');
        expect(redact('a short sk-l…', [KEY])).toBe('a short sk-l…');   // under 8 characters: not worth the false matches
    });

    it('scrubError redacts a DOMException, whose message is a getter', () => {
        const err = scrubError(new DOMException(`aborted ${KEY}`, 'AbortError'), [KEY]);
        expect(err.name).toBe('AbortError');
        expect(err.message).toBe('aborted [redacted]');
    });
});
