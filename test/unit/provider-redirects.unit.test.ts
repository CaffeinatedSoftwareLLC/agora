import { afterEach, describe, expect, it, vi } from 'vitest';
import { openaiAdapter } from '../../src/ai/adapters/openai';

// The base URL is checked once (url-guard), so every fetch to it must refuse a redirect
// rather than follow it to a URL that was never checked.

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
