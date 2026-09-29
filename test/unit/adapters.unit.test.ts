import { describe, it, expect, vi, afterEach } from 'vitest';
import { geminiAdapter } from '../../src/ai/adapters/gemini';
import { openaiAdapter } from '../../src/ai/adapters/openai';
import { getAdapter, listAdapters, adapterSupports, LEGACY_PROVIDER_ADAPTER } from '../../src/ai/adapters';
import { streamCompletion } from '../../src/ai/providers';

function sseResponse(events: unknown[], status = 200): Response {
    const body = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function callbacks() {
    const tokens: string[] = [];
    const done = vi.fn(async () => {});
    const error = vi.fn(async () => {});
    return { tokens, done, error, cb: { onToken: (t: string) => tokens.push(t), onDone: done, onError: error } };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('gemini adapter', () => {
    it('streams text parts, maps roles, and reports usage from the final chunk', async () => {
        const fetchMock = vi.fn(async () => sseResponse([
            { candidates: [{ content: { parts: [{ text: 'Hel' }], role: 'model' } }] },
            { candidates: [{ content: { parts: [{ text: 'lo' }], role: 'model' } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 } },
        ]));
        vi.stubGlobal('fetch', fetchMock);
        const { tokens, done, error, cb } = callbacks();

        await geminiAdapter.streamChat(
            { apiKey: 'g-key' },
            {
                model: 'gemini-3.8-flash',
                systemPrompt: 'Be brief.',
                messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'again' }],
            },
            cb,
        );

        expect(tokens.join('')).toBe('Hello');
        expect(done).toHaveBeenCalledWith({ inputTokens: 7, outputTokens: 2 });
        expect(error).not.toHaveBeenCalled();

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
        expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
        const body = JSON.parse(init.body as string);
        expect(body.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);
        expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
        expect(body.generationConfig.maxOutputTokens).toBe(4096);
    });

    it('skips thought parts', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
            { candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: 'Answer' }] } }] },
        ])));
        const { tokens, cb } = callbacks();
        await geminiAdapter.streamChat({ apiKey: 'k' }, { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'q' }] }, cb);
        expect(tokens).toEqual(['Answer']);
    });

    it('accepts a models/ prefixed model id', async () => {
        const fetchMock = vi.fn(async () => sseResponse([]));
        vi.stubGlobal('fetch', fetchMock);
        const { cb } = callbacks();
        await geminiAdapter.streamChat({ apiKey: 'k' }, { model: 'models/gemini-3.8-flash', messages: [] }, cb);
        expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain('/models/gemini-3.8-flash:streamGenerateContent');
    });

    it('non-200 calls onError with the API status', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 403 })));
        const { error, done, cb } = callbacks();
        await geminiAdapter.streamChat({ apiKey: 'k' }, { model: 'gemini-3.8-flash', messages: [] }, cb);
        expect(error).toHaveBeenCalledOnce();
        expect((error.mock.calls[0] as unknown as [Error])[0].message).toBe('Gemini API 403: bad key');
        expect(done).not.toHaveBeenCalled();
    });

    it('testConnection uses non-streaming generateContent', async () => {
        const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const result = await geminiAdapter.testConnection({ apiKey: 'k' }, 'gemini-3.8-flash');
        expect(result).toEqual({ ok: true });
        expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toMatch(/:generateContent$/);
    });
});

describe('openai adapter', () => {
    it('uses a custom base URL and omits Authorization without a key (local servers)', async () => {
        const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'ok' } }] }]));
        vi.stubGlobal('fetch', fetchMock);
        const { tokens, cb } = callbacks();

        await openaiAdapter.streamChat(
            { baseUrl: 'http://localhost:11434/v1/' },
            { model: 'qwen3:14b', messages: [{ role: 'user', content: 'hi' }] },
            cb,
        );

        expect(tokens).toEqual(['ok']);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://localhost:11434/v1/chat/completions');
        expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    });
});

describe('adapter registry', () => {
    it('lists adapters with capabilities and no functions', () => {
        const list = listAdapters();
        expect(list.map(a => a.id)).toEqual(['anthropic', 'openai', 'gemini']);
        for (const a of list) {
            expect(a.capabilities).toContain('chat');
            expect(Object.values(a).some(v => typeof v === 'function')).toBe(false);
        }
    });

    it('resolves adapters and capabilities', () => {
        expect(getAdapter('gemini')?.label).toBe('Google Gemini');
        expect(getAdapter('nope')).toBeUndefined();
        expect(adapterSupports('gemini', 'chat')).toBe(true);
        expect(adapterSupports('anthropic', 'image')).toBe(false);
    });

    it('maps legacy provider names', () => {
        expect(LEGACY_PROVIDER_ADAPTER.claude).toBe('anthropic');
        expect(LEGACY_PROVIDER_ADAPTER.openai).toBe('openai');
    });

    it('streamCompletion reports unknown adapters through onError', async () => {
        const { error, cb } = callbacks();
        await streamCompletion({ provider: 'mystery', model: 'x' }, [], cb);
        expect((error.mock.calls[0] as unknown as [Error])[0].message).toContain('Unknown AI provider adapter');
    });

    it('streamCompletion accepts legacy "claude"', async () => {
        const fetchMock = vi.fn(async () => sseResponse([]));
        vi.stubGlobal('fetch', fetchMock);
        const { done, cb } = callbacks();
        await streamCompletion({ provider: 'claude', model: 'claude-sonnet-5-5', apiKey: 'k' }, [], cb);
        expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://api.anthropic.com/v1/messages');
        expect(done).toHaveBeenCalled();
    });
});
