import { afterEach, describe, expect, it, vi } from 'vitest';
import { openaiAdapter } from '../../src/ai/adapters/openai';
import { anthropicAdapter } from '../../src/ai/adapters/anthropic';
import { geminiAdapter } from '../../src/ai/adapters/gemini';
import { tavilyAdapter } from '../../src/ai/adapters/tavily';
import { typesafeAdapter } from '../../src/ai/adapters/typesafe';
import { greenptAdapter } from '../../src/ai/adapters/greenpt';
import { cloudflareAdapter } from '../../src/ai/adapters/cloudflare';
import type { Adapter, ProviderCredentials } from '../../src/ai/adapters';

// The base URL is checked once (url-guard), so every provider fetch must refuse a redirect
// rather than follow it, with the key, to a URL that was never checked.

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function redirecting() {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/elsewhere' } }));
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
}

function expectManual(fetcher: ReturnType<typeof redirecting>) {
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual');
}

describe('OpenAI adapter refuses redirects', () => {
    it('streamChat reports a redirect as an error', async () => {
        const fetcher = redirecting();
        const onError = vi.fn(async () => {});
        const onDone = vi.fn(async () => {});
        await openaiAdapter.streamChat!({ baseUrl: 'https://compatible.example/v1' },
            { model: 'm', messages: [{ role: 'user', content: 'hi' }] } as any,
            { onToken: vi.fn(), onDone, onError });
        expectManual(fetcher);
        expect(onDone).not.toHaveBeenCalled();
        expect((onError.mock.calls[0] as unknown as [Error])[0].message).toBe('OpenAI redirected (HTTP 302); redirects are not followed');
    });

    it.each([
        ['a compatible server', 'https://compatible.example/v1'],
        ['the official API', undefined],
    ])('chat connection test against %s fails on a redirect', async (_label, baseUrl) => {
        const fetcher = redirecting();
        expect(await openaiAdapter.testConnection({ apiKey: 'fixture', baseUrl }, 'm', 'chat'))
            .toEqual({ ok: false, error: 'OpenAI redirected (HTTP 302); redirects are not followed' });
        expectManual(fetcher);
    });

    it.each(['tts', 'stt'] as const)('%s connection test fails on a redirect', async capability => {
        const fetcher = redirecting();
        expect(await openaiAdapter.testConnection({ baseUrl: 'https://speech.example/v1' }, 'm', capability))
            .toEqual({ ok: false, error: 'OpenAI speech redirected (HTTP 302); redirects are not followed' });
        expectManual(fetcher);
    });

    it('speech synthesis fails on a redirect', async () => {
        const fetcher = redirecting();
        await expect(openaiAdapter.tts!({ baseUrl: 'https://speech.example/v1' }, { model: 'm', text: 'hi' } as any))
            .rejects.toThrow('OpenAI speech redirected (HTTP 302); redirects are not followed');
        expectManual(fetcher);
    });

    it('transcription fails on a redirect', async () => {
        const fetcher = redirecting();
        await expect(openaiAdapter.transcribe!({ baseUrl: 'https://speech.example/v1' },
            { model: 'm', audio: Buffer.from('x'), mime: 'audio/wav' } as any))
            .rejects.toThrow('OpenAI transcription redirected (HTTP 302); redirects are not followed');
        expectManual(fetcher);
    });
});

const refused = (what: string) => `${what} redirected (HTTP 302); redirects are not followed`;

function streamed(adapter: Adapter) {
    const onError = vi.fn(async () => {});
    const onDone = vi.fn(async () => {});
    return {
        callbacks: { onToken: vi.fn(), onDone, onError },
        expectRefused(what: string) {
            expect(onDone).not.toHaveBeenCalled();
            expect((onError.mock.calls[0] as unknown as [Error])[0].message).toBe(refused(what));
        },
        run: (callbacks: any) => adapter.streamChat!({ apiKey: 'fixture' },
            { model: 'm', messages: [{ role: 'user', content: 'hi' }] } as any, callbacks),
    };
}

describe('Anthropic adapter refuses redirects', () => {
    it('streamChat reports a redirect as an error', async () => {
        const fetcher = redirecting();
        const s = streamed(anthropicAdapter);
        await s.run(s.callbacks);
        expectManual(fetcher);
        s.expectRefused('Claude');
    });

    it('connection test fails on a redirect', async () => {
        const fetcher = redirecting();
        expect(await anthropicAdapter.testConnection({ apiKey: 'fixture' }, 'm')).toEqual({ ok: false, error: refused('Claude') });
        expectManual(fetcher);
    });
});

describe('Gemini adapter refuses redirects', () => {
    it('streamChat reports a redirect as an error', async () => {
        const fetcher = redirecting();
        const s = streamed(geminiAdapter);
        await s.run(s.callbacks);
        expectManual(fetcher);
        s.expectRefused('Gemini');
    });

    it('connection test fails on a redirect', async () => {
        const fetcher = redirecting();
        expect(await geminiAdapter.testConnection({ apiKey: 'fixture' }, 'm')).toEqual({ ok: false, error: refused('Gemini') });
        expectManual(fetcher);
    });

    it('generateContent (search, image, speech) fails on a redirect', async () => {
        const fetcher = redirecting();
        await expect(geminiAdapter.search!({ apiKey: 'fixture' }, { model: 'm', query: 'q' } as any)).rejects.toThrow(refused('Gemini'));
        expectManual(fetcher);
    });

    it('video submission fails on a redirect', async () => {
        const fetcher = redirecting();
        await expect(geminiAdapter.generateVideo!({ apiKey: 'fixture' }, { model: 'm', prompt: 'p' } as any)).rejects.toThrow(refused('Veo'));
        expectManual(fetcher);
    });

    it('video operation polling fails on a redirect', async () => {
        const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => fetcher.mock.calls.length === 1
            ? Response.json({ name: 'operations/op1', done: false })
            : new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/elsewhere' } }));
        vi.stubGlobal('fetch', fetcher);
        await expect(geminiAdapter.generateVideo!({ apiKey: 'fixture' }, { model: 'm', prompt: 'p', pollMs: 1 } as any))
            .rejects.toThrow(refused('Veo'));
        expect(fetcher).toHaveBeenCalledTimes(2);
        for (const call of fetcher.mock.calls) expect(call[1]?.redirect).toBe('manual');
    });
});

describe('Tavily adapter refuses redirects', () => {
    it('search fails on a redirect', async () => {
        const fetcher = redirecting();
        await expect(tavilyAdapter.search!({ apiKey: 'fixture' }, { model: 'basic', query: 'q' } as any)).rejects.toThrow(refused('Tavily'));
        expectManual(fetcher);
    });

    it('connection test fails on a redirect', async () => {
        const fetcher = redirecting();
        expect(await tavilyAdapter.testConnection({ apiKey: 'fixture' }, 'basic')).toEqual({ ok: false, error: refused('Tavily') });
        expectManual(fetcher);
    });
});

describe('decision adapters refuse redirects', () => {
    const PROVIDERS: Array<[string, Adapter, ProviderCredentials]> = [
        ['TypeSafe', typesafeAdapter, { apiKey: 'fixture-key' }],
        ['GreenPT', greenptAdapter, { apiKey: 'fixture-key' }],
        ['Cloudflare', cloudflareAdapter, { apiKey: 'fixture-key', accountId: 'fixture-account' }],
    ];

    it.each(PROVIDERS)('%s: decide fails permanently on a redirect, without a retry', async (name, adapter, creds) => {
        const fetcher = redirecting();
        const err = await adapter.decide!(creds, {
            model: adapter.defaultModels.decide!, state: 'x',
            questions: { ok: { type: 'noul', instructions: 'Is this a test?' } },
        } as any).catch(e => e);
        expect(err).toMatchObject({ kind: 'permanent', status: 302, message: refused(name) });
        expectManual(fetcher);
    });

    it.each(PROVIDERS)('%s: connection test fails on a redirect', async (name, adapter, creds) => {
        const fetcher = redirecting();
        expect(await adapter.testConnection(creds, adapter.defaultModels.decide!)).toEqual({ ok: false, error: refused(name) });
        expectManual(fetcher);
    });
});

describe('redirect responses', () => {
    it('a refused redirect has its body cancelled, not left open', async () => {
        const res = new Response('moved', { status: 302, headers: { location: 'http://127.0.0.1:9/elsewhere' } });
        const cancel = vi.spyOn(res.body!, 'cancel');
        vi.stubGlobal('fetch', vi.fn(async () => res));
        expect(await anthropicAdapter.testConnection({ apiKey: 'fixture' }, 'm')).toEqual({ ok: false, error: refused('Claude') });
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('the Veo download follows one key-less hop to storage and no further', async () => {
        const api = 'https://generativelanguage.googleapis.com/v1beta';
        const fetcher = vi.fn(async (url: string | URL, _init?: RequestInit) => {
            const href = String(url);
            if (href.endsWith(':predictLongRunning')) {
                return Response.json({ name: 'operations/op1', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${api}/files/v1:download` } }] } } });
            }
            if (href.startsWith(api)) return new Response(null, { status: 302, headers: { location: 'https://storage.example/video.mp4' } });
            return new Response(Buffer.from('mp4'), { status: 200 });
        });
        vi.stubGlobal('fetch', fetcher);
        const result = await geminiAdapter.generateVideo!({ apiKey: 'fixture' }, { model: 'm', prompt: 'p' } as any);
        expect(result.data.toString()).toBe('mp4');
        const [first, storage] = fetcher.mock.calls.slice(1);
        expect(first[1]?.redirect).toBe('manual');
        expect(String(storage[0])).toBe('https://storage.example/video.mp4');
        expect(storage[1]).toEqual({ redirect: 'error' });
    });
});
