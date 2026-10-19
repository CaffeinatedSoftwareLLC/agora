import { describe, it, expect, vi, afterEach } from 'vitest';
import { openaiAdapter } from '../../src/ai/adapters/openai';
import { pcmToWav } from '../../src/ai/adapters/audio';
import { wavToPcm } from '../../src/ai/mp3';
import {
    DEFAULT_VOICE_SETTINGS, cacheSpeech, cachedSpeech, clearSpeechCache, mentionedIds, speakableText,
    voiceEngines, voiceSettingsFromRow,
} from '../../src/ai/voice';

/** Voice in and out (cloud handoff C4): the OpenAI-compatible Audio API calls and the text that is read. */

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('openai adapter speech (Kokoro-FastAPI, OpenAI)', () => {
    it('posts to /audio/speech for WAV and returns it', async () => {
        const wav = pcmToWav(Buffer.alloc(480), 24000);
        const fetchMock = vi.fn(async () => new Response(new Uint8Array(wav), { headers: { 'Content-Type': 'audio/wav' } }));
        vi.stubGlobal('fetch', fetchMock);

        const res = await openaiAdapter.tts!({ baseUrl: 'http://kokoro:8880/v1/' }, { model: 'kokoro', text: 'Hello there.', voice: 'af_heart' });
        expect(res.mime).toBe('audio/wav');
        expect(res.data.equals(wav)).toBe(true);
        expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://kokoro:8880/v1/audio/speech');
        expect(JSON.parse(init.body as string)).toEqual({ model: 'kokoro', input: 'Hello there.', voice: 'af_heart', response_format: 'wav' });
        expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    });

    it('sends the key, defaults the voice, and keeps the type of non-WAV replies', async () => {
        const fetchMock = vi.fn(async () => new Response(new Uint8Array([0xff, 0xfb, 0x90]), { headers: { 'Content-Type': 'audio/mpeg; charset=binary' } }));
        vi.stubGlobal('fetch', fetchMock);
        const res = await openaiAdapter.tts!({ apiKey: 'sk-x' }, { model: 'gpt-4o-mini-tts', text: 'Hi' });
        expect(res.mime).toBe('audio/mpeg');
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://api.openai.com/v1/audio/speech');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-x');
        expect(JSON.parse(init.body as string).voice).toBe('alloy');
    });

    it('turns API errors into readable errors', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Voice not found' } }), { status: 400 })));
        await expect(openaiAdapter.tts!({}, { model: 'kokoro', text: 'x', voice: 'nope' })).rejects.toThrow('Voice not found');
    });
});

describe('openai adapter transcription (speaches / faster-whisper, OpenAI)', () => {
    it('uploads the clip as multipart with a file name matching its type', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: '  Run the tests again. ' }), { headers: { 'Content-Type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);

        const audio = Buffer.from('fake-webm-bytes');
        const res = await openaiAdapter.transcribe!({ baseUrl: 'http://whisper:8000/v1' }, { model: 'Systran/faster-whisper-small', audio, mime: 'audio/webm', language: 'en' });
        expect(res).toEqual({ text: 'Run the tests again.', usage: { inputTokens: 0, outputTokens: 0 } });

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://whisper:8000/v1/audio/transcriptions');
        const form = init.body as FormData;
        expect(form.get('model')).toBe('Systran/faster-whisper-small');
        expect(form.get('language')).toBe('en');
        expect(form.get('response_format')).toBe('json');
        const file = form.get('file') as File;
        expect(file.name).toBe('speech.webm');
        expect(file.type).toBe('audio/webm');
        expect(Buffer.from(await file.arrayBuffer()).equals(audio)).toBe(true);
        // No JSON content type: fetch writes the multipart boundary itself
        expect(init.headers).toEqual({});
    });

    it('maps Safari recordings to .m4a, reports token usage when given, and refuses unknown types', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'ok', usage: { type: 'tokens', input_tokens: 12, output_tokens: 3 } })));
        vi.stubGlobal('fetch', fetchMock);
        const res = await openaiAdapter.transcribe!({ apiKey: 'k' }, { model: 'gpt-4o-transcribe', audio: Buffer.from('x'), mime: 'audio/mp4' });
        expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
        const form = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
        expect((form.get('file') as File).name).toBe('speech.m4a');
        expect(form.get('language')).toBeNull();

        await expect(openaiAdapter.transcribe!({}, { model: 'm', audio: Buffer.from('x'), mime: 'video/quicktime' })).rejects.toThrow("Can't transcribe");
    });

    it('fails on errors and on replies without text', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('model not loaded', { status: 503 })));
        await expect(openaiAdapter.transcribe!({}, { model: 'm', audio: Buffer.from('x'), mime: 'audio/ogg' })).rejects.toThrow('503');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ segments: [] }))));
        await expect(openaiAdapter.transcribe!({}, { model: 'm', audio: Buffer.from('x'), mime: 'audio/ogg' })).rejects.toThrow('no text');
    });
});

describe('wavToPcm with streamed WAV headers', () => {
    it('reads to the end when the data size was left open (0 or 0xFFFFFFFF)', () => {
        const pcm = Buffer.alloc(200);
        for (let i = 0; i < 100; i++) pcm.writeInt16LE(i, i * 2);
        for (const size of [0, 0xFFFFFFFF]) {
            const wav = pcmToWav(pcm, 24000);
            wav.writeUInt32LE(size, 40);
            const out = wavToPcm(wav);
            expect(out.samples.length).toBe(100);
            expect(out.samples[99]).toBe(99);
        }
    });
});

describe('speakableText', () => {
    it('drops formatting, names code blocks and links instead of reading them', () => {
        const md = [
            '## Result',
            '',
            'Tests **pass** now, see [the PR](https://github.com/x/y/pull/1) or https://ci.example.com/run/9',
            '',
            '```ts',
            'const x = 1;',
            '```',
            '- fixed `parseDialogue`',
            '- kept snake_case_names',
            '> quoted _note_',
        ].join('\n');
        expect(speakableText(md, 1000)).toBe(
            'Result. Tests pass now, see the PR or (link). (code block). fixed parseDialogue. kept snake_case_names. quoted note.');
    });

    it('reads mentions by name and images by their alt text', () => {
        const id = '01HZX5V3K8Q2W7M4N6P9R0S1T2';
        expect(mentionedIds(`<@${id}> and <@${id}>`)).toEqual([id]);
        expect(speakableText(`<@${id}> look: ![chart of latency](/files/1)`, 500, new Map([[id, 'eryk']])))
            .toBe('@eryk look: (image: chart of latency).');
        expect(speakableText(`<@${id}> hi`, 500)).toBe('@someone hi.');
    });

    it('turns tables into short phrases and skips their rule lines', () => {
        expect(speakableText('| a | b |\n|---|---|\n| 1 | 2 |', 500)).toBe('a, b. 1, 2.');
    });

    it('cuts long text at a sentence and says so', () => {
        const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
        const out = speakableText(text, 200);
        expect(out.endsWith('is here. The rest is in the message.')).toBe(true);
        expect(out.length).toBeLessThanOrEqual(200 + ' The rest is in the message.'.length);
    });

    it('cuts at a word when there is no sentence end', () => {
        const out = speakableText('word '.repeat(100), 101);
        expect(out).toMatch(/^(word ){19}word The rest is in the message\.$/);
    });

    it('returns nothing for a message that is only formatting', () => {
        expect(speakableText('---\n\n***', 500)).toBe('');
    });
});

describe('voiceEngines', () => {
    const on = { enabled: true };
    const off = { enabled: false };

    it('prefers the server routes, then the browser fallbacks the admin allows', () => {
        expect(voiceEngines(DEFAULT_VOICE_SETTINGS, { stt: on, tts: on })).toEqual({ input: 'server', output: 'browser' });
        expect(voiceEngines({ ...DEFAULT_VOICE_SETTINGS, readAloudServer: true }, { stt: on, tts: on })).toEqual({ input: 'server', output: 'server' });
        expect(voiceEngines({ ...DEFAULT_VOICE_SETTINGS, readAloudServer: true }, { stt: off, tts: off })).toEqual({ input: 'off', output: 'browser' });
        expect(voiceEngines({ ...DEFAULT_VOICE_SETTINGS, browserSttFallback: true }, { stt: off, tts: off })).toEqual({ input: 'browser', output: 'browser' });
        expect(voiceEngines({ ...DEFAULT_VOICE_SETTINGS, browserTtsFallback: false }, { stt: off, tts: on })).toEqual({ input: 'off', output: 'off' });
    });

    it('is off in a direction the admin switched off, whatever is configured', () => {
        expect(voiceEngines({ ...DEFAULT_VOICE_SETTINGS, voiceInputEnabled: false, readAloudEnabled: false, readAloudServer: true }, { stt: on, tts: on }))
            .toEqual({ input: 'off', output: 'off' });
    });

    it('reads defaults for servers without a settings row', () => {
        expect(voiceSettingsFromRow(undefined)).toEqual(DEFAULT_VOICE_SETTINGS);
        expect(voiceSettingsFromRow({ voice_input_enabled: false, browser_stt_fallback: true, max_recording_seconds: 30, stt_language: 'de', read_aloud_enabled: true, read_aloud_server: true, browser_tts_fallback: false, read_aloud_voice: 'af_heart', read_aloud_max_chars: 800 }))
            .toEqual({ voiceInputEnabled: false, browserSttFallback: true, maxRecordingSeconds: 30, sttLanguage: 'de', readAloudEnabled: true, readAloudServer: true, browserTtsFallback: false, readAloudVoice: 'af_heart', readAloudMaxChars: 800 });
    });
});

describe('speech cache', () => {
    it('keeps recent entries within its count and byte limits', () => {
        clearSpeechCache();
        cacheSpeech('a', { data: Buffer.alloc(10), mime: 'audio/mpeg' });
        expect(cachedSpeech('a')?.data.length).toBe(10);
        for (let i = 0; i < 70; i++) cacheSpeech(`k${i}`, { data: Buffer.alloc(10), mime: 'audio/mpeg' });
        expect(cachedSpeech('a')).toBeUndefined();
        expect(cachedSpeech('k69')).toBeDefined();
        expect(cachedSpeech('k5')).toBeUndefined();
        // Oversized clips are not kept
        cacheSpeech('big', { data: Buffer.alloc(9 * 1024 * 1024), mime: 'audio/mpeg' });
        expect(cachedSpeech('big')).toBeUndefined();
        clearSpeechCache();
    });
});
