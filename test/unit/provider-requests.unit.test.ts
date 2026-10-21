import { afterEach, describe, expect, it, vi } from 'vitest';
import { openaiAdapter } from '../../src/ai/adapters/openai';
import { anthropicAdapter } from '../../src/ai/adapters/anthropic';
import { geminiAdapter } from '../../src/ai/adapters/gemini';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const adapters = [openaiAdapter, anthropicAdapter, geminiAdapter];
const callbacks = () => ({ onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() });

describe('OpenAI token-limit compatibility', () => {
    const endpoints = [
        [undefined, 'max_completion_tokens'],
        ['https://api.openai.com/v1/', 'max_completion_tokens'],
        ['https://API.OPENAI.COM/v1', 'max_completion_tokens'],
        ['https://api.openai.com./v1', 'max_completion_tokens'],
        ['http://localhost:11434/v1', 'max_tokens'],
        ['https://proxy.example/v1', 'max_tokens'],
        ['https://api.openai.com.evil.example/v1', 'max_tokens'],
        ['https://api.openai.com@proxy.example/v1', 'max_tokens'],
    ] as const;
    for (const [baseUrl, field] of endpoints) {
        it.each(['chat', 'test'])(`uses the appropriate endpoint/payload at ${baseUrl ?? 'default OpenAI'} for %s`, async action => {
            const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
            vi.stubGlobal('fetch', fetchMock);
            if (action === 'chat') {
                const cb = callbacks();
                await openaiAdapter.streamChat!({ baseUrl }, { model: 'gpt-6-luna', maxTokens: 123, messages: [] }, cb);
                expect(cb.onError).not.toHaveBeenCalled();
                expect(cb.onDone).toHaveBeenCalledOnce();
            } else {
                expect(await openaiAdapter.testConnection({ baseUrl }, 'gpt-6-luna')).toEqual({ ok: true });
            }
            expect(fetchMock).toHaveBeenCalledOnce();
            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
            if (action === 'test' && field === 'max_completion_tokens') {
                expect(url).toMatch(/\/models\/gpt-6-luna$/);
                expect(init.method).toBe('GET');
                expect(init.body).toBeUndefined();
                return;
            }
            expect(url).toMatch(/\/chat\/completions$/);
            expect(init.method).toBe('POST');
            const body = JSON.parse(init.body as string);
            expect(body[field]).toBe(action === 'chat' ? 123 : 1);
            expect(body).not.toHaveProperty(field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens');
        });
    }

    it.each([401, 404])('official model metadata errors (%s) remain readable', async status => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'key or model unavailable' } }), { status }));
        vi.stubGlobal('fetch', fetchMock);
        expect(await openaiAdapter.testConnection({ apiKey: 'fixture' }, 'gpt-6-luna'))
            .toEqual({ ok: false, error: `OpenAI API ${status}: key or model unavailable` });
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('encodes the model as a single metadata path segment', async () => {
        const fetchMock = vi.fn(async () => new Response('{}'));
        vi.stubGlobal('fetch', fetchMock);
        expect(await openaiAdapter.testConnection({ apiKey: 'fixture' }, 'model/name?x=1')).toEqual({ ok: true });
        expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://api.openai.com/v1/models/model%2Fname%3Fx%3D1');
    });
});

describe.each(adapters)('$id connection-test deadline', adapter => {
    it('aborts a silent endpoint at the configured 15-second deadline with a readable error', async () => {
        const controller = new AbortController();
        const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
        const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }));
        vi.stubGlobal('fetch', fetchMock);
        const result = adapter.testConnection({ apiKey: 'fixture' }, 'model');
        expect(deadline).toHaveBeenCalledWith(15_000);
        expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
        controller.abort(new DOMException('deadline', 'TimeoutError'));
        expect(await result).toEqual({ ok: false, error: 'timed out after 15 s' });
    });

    it('reports timeout while reading a stalled error body, even though apiError tolerates body errors', async () => {
        const controller = new AbortController();
        vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
        let reading!: () => void;
        const beganReading = new Promise<void>(resolve => { reading = resolve; });
        vi.stubGlobal('fetch', vi.fn(async () => {
            const response = new Response('', { status: 500 });
            vi.spyOn(response, 'text').mockImplementation(() => new Promise((_resolve, reject) => {
                reading();
                controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
            }));
            return response;
        }));
        const result = adapter.testConnection({ apiKey: 'fixture' }, 'model');
        await beganReading;
        controller.abort(new DOMException('deadline', 'TimeoutError'));
        expect(await result).toEqual({ ok: false, error: 'timed out after 15 s' });
    });

    it('retains useful network-error causes', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }));
        expect(await adapter.testConnection({ apiKey: 'fixture' }, 'model')).toEqual({ ok: false, error: 'fetch failed (ECONNREFUSED)' });
    });

    it('keeps the caller signal and timeout policy for chat streaming', async () => {
        const deadline = vi.spyOn(AbortSignal, 'timeout');
        const signal = new AbortController().signal;
        const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const cb = callbacks();
        await adapter.streamChat!({ apiKey: 'fixture' }, { model: 'model', messages: [], signal }, cb);
        expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(signal);
        expect(deadline).not.toHaveBeenCalled();
        expect(cb.onError).not.toHaveBeenCalled();
    });
});
