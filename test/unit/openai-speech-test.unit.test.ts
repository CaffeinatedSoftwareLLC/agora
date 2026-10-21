import { afterEach, expect, it, vi } from 'vitest';
import { openaiAdapter } from '../../src/ai/adapters/openai';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['tts', 'stt'] as const)('%s checks a compatible speech server without calling chat or generating audio', async capability => {
    const fetcher = vi.fn(async (url: string) => new Response(url.endsWith('/models') ? '{}' : 'chat unavailable', { status: url.endsWith('/models') ? 200 : 404 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await openaiAdapter.testConnection({ baseUrl: 'http://localhost:8000/v1/' }, 'speech-model', capability)).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/v1/models');
    expect(init.method).toBe('GET'); expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({}); expect(init.signal).toBeInstanceOf(AbortSignal);
});

it('speech metadata accepts a key and checks a selected official OpenAI model', async () => {
    const fetcher = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', fetcher);
    expect(await openaiAdapter.testConnection({ apiKey: 'fixture' }, 'speech/model', 'tts')).toEqual({ ok: true });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/models/speech%2Fmodel');
    expect(init.headers).toEqual({ Authorization: 'Bearer fixture' });
});

it('an unrouted compatible speech connection does not need a model name', async () => {
    const fetcher = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', fetcher);
    expect(await openaiAdapter.testConnection({ baseUrl: 'https://speech.example/v1' }, '', 'stt')).toEqual({ ok: true });
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe('https://speech.example/v1/models');
});

it('keeps explicit chat testing on compatible servers', async () => {
    const fetcher = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', fetcher);
    await openaiAdapter.testConnection({ baseUrl: 'https://compatible.example/v1' }, 'chat-model', 'chat');
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://compatible.example/v1/chat/completions');
    expect(init.method).toBe('POST'); expect(JSON.parse(init.body as string).max_tokens).toBe(1);
});

it('reports speech authentication/model-list failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Bad key' } }), { status: 401 })));
    expect(await openaiAdapter.testConnection({ baseUrl: 'https://speech.example/v1' }, 'm', 'tts'))
        .toEqual({ ok: false, error: 'OpenAI speech API 401: Bad key' });
});

it('gives speech connection tests a 15-second timeout', async () => {
    const controller = new AbortController();
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })));
    const result = openaiAdapter.testConnection({ baseUrl: 'https://speech.example/v1' }, 'm', 'stt');
    expect(deadline).toHaveBeenCalledWith(15_000);
    controller.abort(); expect(await result).toEqual({ ok: false, error: 'timed out after 15 s' });
});
