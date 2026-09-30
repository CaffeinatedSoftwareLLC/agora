import { describe, it, expect, vi, afterEach } from 'vitest';
import { geminiAdapter } from '../../src/ai/adapters/gemini';
import { openaiAdapter } from '../../src/ai/adapters/openai';
import { tavilyAdapter } from '../../src/ai/adapters/tavily';
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

        await geminiAdapter.streamChat!(
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
        await geminiAdapter.streamChat!({ apiKey: 'k' }, { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'q' }] }, cb);
        expect(tokens).toEqual(['Answer']);
    });

    it('accepts a models/ prefixed model id', async () => {
        const fetchMock = vi.fn(async () => sseResponse([]));
        vi.stubGlobal('fetch', fetchMock);
        const { cb } = callbacks();
        await geminiAdapter.streamChat!({ apiKey: 'k' }, { model: 'models/gemini-3.8-flash', messages: [] }, cb);
        expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain('/models/gemini-3.8-flash:streamGenerateContent');
    });

    it('non-200 calls onError with the API status', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 403 })));
        const { error, done, cb } = callbacks();
        await geminiAdapter.streamChat!({ apiKey: 'k' }, { model: 'gemini-3.8-flash', messages: [] }, cb);
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

        await openaiAdapter.streamChat!(
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

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): { url: string; body: any; headers: Record<string, string> } {
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    return { url, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> };
}

describe('gemini media and search', () => {
    it('search: googleSearch tool, grounding citations deduped, Search Suggestions kept for display', async () => {
        const fetchMock = vi.fn(async () => jsonResponse({
            candidates: [{
                content: { parts: [{ text: 'Spain won ' }, { text: 'Euro 2024.' }] },
                groundingMetadata: {
                    webSearchQueries: ['euro 2024 winner'],
                    searchEntryPoint: { renderedContent: '<div class="chips">x</div>' },
                    groundingChunks: [
                        { web: { uri: 'https://a.example/1', title: 'a.example' } },
                        { web: { uri: 'https://a.example/1', title: 'a.example' } },
                        { web: { uri: 'https://b.example/2' } },
                        { maps: { uri: 'https://maps.example' } },
                    ],
                },
            }],
            usageMetadata: { promptTokenCount: 10, toolUsePromptTokenCount: 40, candidatesTokenCount: 5 },
        }));
        vi.stubGlobal('fetch', fetchMock);

        const res = await geminiAdapter.search!({ apiKey: 'k' }, { model: 'gemini-3.8-flash', query: 'who won euro 2024' });
        expect(res).toEqual({
            answer: 'Spain won Euro 2024.',
            citations: [{ url: 'https://a.example/1', title: 'a.example' }, { url: 'https://b.example/2' }],
            display: { kind: 'google_search_suggestions', html: '<div class="chips">x</div>', queries: ['euro 2024 winner'] },
            usage: { inputTokens: 50, outputTokens: 5 },
        });
        const { url, body } = lastCall(fetchMock);
        expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
        expect(body.tools).toEqual([{ googleSearch: {} }]);
        expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'who won euro 2024' }] }]);
    });

    it('search without grounding metadata has no display requirement', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] })));
        const res = await geminiAdapter.search!({ apiKey: 'k' }, { model: 'm', query: 'q' });
        expect(res.display).toBeUndefined();
        expect(res.citations).toEqual([]);
    });

    it('image: responseModalities + imageConfig, returns the inline image bytes', async () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const fetchMock = vi.fn(async () => jsonResponse({
            candidates: [{ content: { parts: [{ text: 'Here you go' }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }],
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1290 },
        }));
        vi.stubGlobal('fetch', fetchMock);

        const res = await geminiAdapter.generateImage!({ apiKey: 'k' }, { model: 'gemini-3.1-flash-image', prompt: 'a fern', aspectRatio: '16:9' });
        expect(res.data.equals(png)).toBe(true);
        expect(res.mime).toBe('image/png');
        expect(res.text).toBe('Here you go');
        expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 1290 });
        expect(lastCall(fetchMock).body.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } });
    });

    it('image: text-only, blocked, and HTTP errors are readable', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'no' }] }, finishReason: 'IMAGE_SAFETY' }] })));
        await expect(geminiAdapter.generateImage!({ apiKey: 'k' }, { model: 'm', prompt: 'x' })).rejects.toThrow('Gemini returned no image (IMAGE_SAFETY)');
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } })));
        await expect(geminiAdapter.generateImage!({ apiKey: 'k' }, { model: 'm', prompt: 'x' })).rejects.toThrow('Gemini blocked the prompt (SAFETY)');
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'API key not valid' } }, 400)));
        await expect(geminiAdapter.generateImage!({ apiKey: 'k' }, { model: 'm', prompt: 'x' })).rejects.toThrow('Gemini API 400: API key not valid');
    });

    it('tts: single voice, wraps raw PCM in a WAV header', async () => {
        const pcm = Buffer.alloc(480, 1);
        const fetchMock = vi.fn(async () => jsonResponse({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }],
        }));
        vi.stubGlobal('fetch', fetchMock);

        const res = await geminiAdapter.tts!({ apiKey: 'k' }, { model: 'gemini-3.8-flash-tts', text: 'Hello', voice: 'Puck' });
        expect(res.mime).toBe('audio/wav');
        expect(res.data.subarray(0, 4).toString('ascii')).toBe('RIFF');
        expect(res.data.subarray(8, 12).toString('ascii')).toBe('WAVE');
        expect(res.data.readUInt32LE(24)).toBe(24000);
        expect(res.data.readUInt32LE(40)).toBe(480);
        expect(res.data.length).toBe(44 + 480);
        expect(lastCall(fetchMock).body.generationConfig).toEqual({
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        });
    });

    it('tts: multi-speaker config; non-PCM audio passes through', async () => {
        const fetchMock = vi.fn(async () => jsonResponse({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: Buffer.from('RIFFxxxx').toString('base64') } }] } }],
        }));
        vi.stubGlobal('fetch', fetchMock);
        const res = await geminiAdapter.tts!({ apiKey: 'k' }, {
            model: 'm', text: 'Joe: hi\nJane: hey',
            speakers: [{ speaker: 'Joe', voice: 'Kore' }, { speaker: 'Jane', voice: 'Puck' }],
        });
        expect(res.mime).toBe('audio/wav');
        expect(res.data.toString()).toBe('RIFFxxxx');
        expect(lastCall(fetchMock).body.generationConfig.speechConfig).toEqual({
            multiSpeakerVoiceConfig: {
                speakerVoiceConfigs: [
                    { speaker: 'Joe', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
                    { speaker: 'Jane', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
                ],
            },
        });
    });
});

describe('gemini video (Veo)', () => {
    const OP = 'models/veo-3.1-fast-generate-preview/operations/op123';
    const VIDEO_URI = 'https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media';
    const mp4 = Buffer.from('....ftypisom-fake-mp4-bytes');

    /** Scripted fetch: submit → N pending polls → done → 302 → storage bytes. */
    function veoFetch(opts: { pending?: number; done?: any; redirect?: string | null; uri?: string } = {}) {
        let polls = 0;
        return vi.fn(async (url: string | URL, init?: RequestInit) => {
            const u = String(url);
            if (u.endsWith(':predictLongRunning')) return jsonResponse({ name: OP });
            if (u.endsWith(`/${OP}`)) {
                polls++;
                if (polls <= (opts.pending ?? 1)) return jsonResponse({ name: OP, done: false });
                return jsonResponse(opts.done ?? { name: OP, done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: opts.uri ?? VIDEO_URI } }] } } });
            }
            if (u === (opts.uri ?? VIDEO_URI)) {
                if (opts.redirect === null) return new Response(mp4, { status: 200 });
                return new Response(null, { status: 302, headers: { location: opts.redirect ?? 'https://storage.googleapis.com/veo/abc.mp4?sig=x' } });
            }
            if (u.startsWith('https://storage.googleapis.com/')) return new Response(mp4, { status: 200, headers: { 'content-length': String(mp4.length) } });
            throw new Error(`unexpected fetch ${u} ${JSON.stringify(init?.headers)}`);
        });
    }

    it('submits, polls until done, and downloads through the redirect without the API key', async () => {
        const fetchMock = veoFetch({ pending: 2 });
        vi.stubGlobal('fetch', fetchMock);
        const res = await geminiAdapter.generateVideo!({ apiKey: 'veo-key' }, {
            model: 'veo-3.1-fast-generate-preview', prompt: 'a fern unfurling, timelapse', aspectRatio: '9:16', durationSeconds: 8, resolution: '1080p', pollMs: 1,
        });
        expect(res.mime).toBe('video/mp4');
        expect(res.data.equals(mp4)).toBe(true);

        const calls = fetchMock.mock.calls as unknown as [string | URL, RequestInit | undefined][];
        const [submitUrl, submitInit] = calls[0];
        expect(String(submitUrl)).toBe('https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning');
        expect(JSON.parse(submitInit!.body as string)).toEqual({
            instances: [{ prompt: 'a fern unfurling, timelapse' }],
            parameters: { aspectRatio: '9:16', durationSeconds: 8, resolution: '1080p' },
        });
        expect((submitInit!.headers as Record<string, string>)['x-goog-api-key']).toBe('veo-key');
        // 3 polls (2 pending + done), then download + redirect
        expect(calls.filter(([u]) => String(u).endsWith(`/${OP}`))).toHaveLength(3);
        const download = calls.find(([u]) => String(u) === VIDEO_URI)!;
        expect(download[1]!.redirect).toBe('manual');
        expect((download[1]!.headers as Record<string, string>)['x-goog-api-key']).toBe('veo-key');
        const storage = calls.find(([u]) => String(u).startsWith('https://storage.googleapis.com/'))!;
        expect(JSON.stringify(storage[1] ?? {})).not.toContain('veo-key');
    });

    it('omits parameters when none are given and accepts a direct (non-redirect) download', async () => {
        const fetchMock = veoFetch({ pending: 0, redirect: null });
        vi.stubGlobal('fetch', fetchMock);
        await geminiAdapter.generateVideo!({ apiKey: 'k' }, { model: 'veo-3.1-generate-preview', prompt: 'x', pollMs: 1 });
        const [, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0];
        expect(JSON.parse(init.body as string)).toEqual({ instances: [{ prompt: 'x' }] });
    });

    it('reports operation errors, filtered videos, and timeouts', async () => {
        vi.stubGlobal('fetch', veoFetch({ done: { name: OP, done: true, error: { code: 3, message: 'Prompt violates policy' } } }));
        await expect(geminiAdapter.generateVideo!({ apiKey: 'k' }, { model: 'm', prompt: 'x', pollMs: 1 })).rejects.toThrow('Veo failed: Prompt violates policy');

        vi.stubGlobal('fetch', veoFetch({ done: { name: OP, done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['Contains a real person'] } } } }));
        await expect(geminiAdapter.generateVideo!({ apiKey: 'k' }, { model: 'm', prompt: 'x', pollMs: 1 })).rejects.toThrow('Veo filtered the video: Contains a real person');

        vi.stubGlobal('fetch', veoFetch({ pending: 1000 }));
        await expect(geminiAdapter.generateVideo!({ apiKey: 'k' }, { model: 'm', prompt: 'x', pollMs: 5, timeoutMs: 30 })).rejects.toThrow('Veo did not finish within 0 s');

        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'Model not found' } }, 404)));
        await expect(geminiAdapter.generateVideo!({ apiKey: 'k' }, { model: 'm', prompt: 'x', pollMs: 1 })).rejects.toThrow('Veo API 404: Model not found');
    });

    it('refuses odd operation names and never sends the key to another host', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ name: '../../evil' })));
        await expect(geminiAdapter.generateVideo!({ apiKey: 'k' }, { model: 'm', prompt: 'x', pollMs: 1 })).rejects.toThrow('invalid operation name');

        const fetchMock = veoFetch({ pending: 0, uri: 'https://attacker.example/video.mp4' });
        vi.stubGlobal('fetch', fetchMock);
        await expect(geminiAdapter.generateVideo!({ apiKey: 'k' }, { model: 'm', prompt: 'x', pollMs: 1 })).rejects.toThrow('unexpected download URL');
        expect((fetchMock.mock.calls as unknown as [string][]).some(([u]) => String(u).includes('attacker'))).toBe(false);

        vi.stubGlobal('fetch', veoFetch({ pending: 0, redirect: 'http://storage.googleapis.com/insecure.mp4' }));
        await expect(geminiAdapter.generateVideo!({ apiKey: 'k' }, { model: 'm', prompt: 'x', pollMs: 1 })).rejects.toThrow('non-HTTPS');
    });
});

describe('tavily adapter', () => {
    it('searches with the route model as depth and maps results to citations', async () => {
        const fetchMock = vi.fn(async () => jsonResponse({
            query: 'q', answer: 'Deno 2.9 is out.',
            results: [{ title: 'Deno blog', url: 'https://deno.com/blog', content: 'Release notes', score: 0.9 }, { title: 'no url' }],
            usage: { credits: 1 },
        }));
        vi.stubGlobal('fetch', fetchMock);

        const res = await tavilyAdapter.search!({ apiKey: 'tvly-key' }, { model: 'advanced', query: 'latest deno', maxResults: 3 });
        expect(res).toEqual({
            answer: 'Deno 2.9 is out.',
            citations: [{ url: 'https://deno.com/blog', title: 'Deno blog', snippet: 'Release notes' }],
            usage: { inputTokens: 0, outputTokens: 0 },
        });
        const { url, body, headers } = lastCall(fetchMock);
        expect(url).toBe('https://api.tavily.com/search');
        expect(headers.Authorization).toBe('Bearer tvly-key');
        expect(body).toEqual({ query: 'latest deno', search_depth: 'advanced', max_results: 3, include_answer: 'basic' });
    });

    it('rejects an unknown depth before calling the API and surfaces API errors', async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ detail: { error: 'Unauthorized: missing or invalid API key.' } }, 401));
        vi.stubGlobal('fetch', fetchMock);
        await expect(tavilyAdapter.search!({ apiKey: 'k' }, { model: 'gpt-5', query: 'q' })).rejects.toThrow('search depth');
        expect(fetchMock).not.toHaveBeenCalled();
        await expect(tavilyAdapter.search!({ apiKey: 'k' }, { model: 'basic', query: 'q' })).rejects.toThrow('Tavily API 401');
        expect(await tavilyAdapter.testConnection({ apiKey: 'k' }, 'basic')).toMatchObject({ ok: false });
    });
});

describe('adapter registry', () => {
    it('lists adapters with capabilities and no functions', () => {
        const list = listAdapters();
        expect(list.map(a => a.id)).toEqual(['anthropic', 'openai', 'gemini', 'tavily']);
        for (const a of list) {
            expect(a.capabilities.length).toBeGreaterThan(0);
            expect(Object.values(a).some(v => typeof v === 'function')).toBe(false);
        }
    });

    it('each adapter implements exactly the capabilities it lists', () => {
        const methods = { chat: 'streamChat', search: 'search', image: 'generateImage', tts: 'tts', video: 'generateVideo' } as const;
        for (const { id } of listAdapters()) {
            const adapter = getAdapter(id)! as unknown as Record<string, unknown>;
            for (const [capability, method] of Object.entries(methods)) {
                expect(typeof adapter[method] === 'function', `${id}.${method}`).toBe(adapterSupports(id, capability as any));
            }
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

describe('provider error messages', () => {
    it('extracts error.message from JSON error bodies', async () => {
        const body = JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 400 })));
        const result = await geminiAdapter.testConnection({ apiKey: 'bad' }, 'gemini-3.8-flash');
        expect(result).toEqual({ ok: false, error: 'Gemini API 400: API key not valid. Please pass a valid API key.' });
    });

    it('names the network cause when a local server is down', async () => {
        const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        vi.stubGlobal('fetch', vi.fn(async () => { throw err; }));
        const result = await openaiAdapter.testConnection({ baseUrl: 'http://localhost:11434/v1' }, 'qwen3:14b');
        expect(result).toEqual({ ok: false, error: 'fetch failed (ECONNREFUSED)' });
    });
});
