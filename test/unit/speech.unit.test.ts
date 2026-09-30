import { describe, it, expect, vi } from 'vitest';
import type { Adapter, MediaResult, SpeechRequest } from '../../src/ai/adapters';
import { pcmToWav } from '../../src/ai/adapters/audio';
import { wavToPcm } from '../../src/ai/mp3';
import { parseDialogue, synthesizeDialogue, TURN_PAUSE_SEC, MAX_DIALOGUE_LINES } from '../../src/ai/speech';

const SPEAKERS = [{ speaker: 'Joe', voice: 'Kore' }, { speaker: 'Jane', voice: 'Puck' }];

/** A WAV of `samples` copies of `value` (so each line's audio is recognisable). */
function wav(value: number, samples: number, rate = 24000): Buffer {
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) pcm.writeInt16LE(value, i * 2);
    return pcmToWav(pcm, rate);
}

function fakeAdapter(tts: (req: SpeechRequest) => Promise<MediaResult>, extra: Partial<Adapter> = {}): Adapter {
    return {
        id: 'fake', label: 'Fake', capabilities: ['tts'], requiresApiKey: false, supportsBaseUrl: false,
        defaultBaseUrl: '', defaultModels: {}, testConnection: async () => ({ ok: true }),
        tts: vi.fn((_creds, req: SpeechRequest) => tts(req)), ...extra,
    };
}

describe('parseDialogue', () => {
    it('splits labelled lines, matching speaker names case-insensitively', () => {
        expect(parseDialogue('Joe: hi\n\njane:  hey there ', SPEAKERS)).toEqual({
            ok: true,
            lines: [{ speaker: 'Joe', text: 'hi' }, { speaker: 'Jane', text: 'hey there' }],
        });
    });

    it('joins unlabelled lines onto the current turn, and ignores URLs and times as labels', () => {
        const res = parseDialogue('Joe:\nsee https://example.com\nat 10:30\nJane: ok', SPEAKERS);
        expect(res).toEqual({
            ok: true,
            lines: [{ speaker: 'Joe', text: 'see https://example.com at 10:30' }, { speaker: 'Jane', text: 'ok' }],
        });
    });

    it('rejects undeclared speakers, unlabelled openings, empty and oversized dialogue', () => {
        expect(parseDialogue('Joe: hi\nBob: hello', SPEAKERS)).toEqual({ ok: false, error: '"Bob" is not a declared speaker (Joe, Jane)' });
        expect(parseDialogue('hello\nJoe: hi', SPEAKERS)).toEqual({ ok: false, error: 'text must start with a speaker label, e.g. "Joe: …"' });
        expect(parseDialogue('Joe:\nJane:', SPEAKERS)).toEqual({ ok: false, error: 'text has no dialogue lines' });
        const long = Array.from({ length: MAX_DIALOGUE_LINES + 1 }, (_, i) => `${i % 2 ? 'Jane' : 'Joe'}: line ${i}`).join('\n');
        expect(parseDialogue(long, SPEAKERS).ok).toBe(false);
    });

    it('accepts speaker names with spaces', () => {
        expect(parseDialogue('Dr. Ann Lee: hi', [{ speaker: 'Dr. Ann Lee', voice: 'Kore' }]))
            .toEqual({ ok: true, lines: [{ speaker: 'Dr. Ann Lee', text: 'hi' }] });
    });
});

describe('synthesizeDialogue', () => {
    const lines = [{ speaker: 'Joe', text: 'one' }, { speaker: 'Jane', text: 'two' }, { speaker: 'Joe', text: 'three' }];

    it('uses the adapter\'s native multi-speaker call when it has one', async () => {
        const native = vi.fn(async () => ({ data: wav(1, 10), mime: 'audio/wav', usage: { inputTokens: 5, outputTokens: 7 } }));
        const adapter = fakeAdapter(async () => { throw new Error('unused'); }, { ttsDialogue: native });
        const res = await synthesizeDialogue(adapter, {}, { model: 'm', lines, speakers: SPEAKERS });
        expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
        expect(native).toHaveBeenCalledWith({}, { model: 'm', lines, speakers: SPEAKERS });
        expect(adapter.tts).not.toHaveBeenCalled();
    });

    it('otherwise voices each line with its speaker\'s voice and joins them in order with a pause', async () => {
        const values: Record<string, number> = { one: 100, two: 200, three: 300 };
        const adapter = fakeAdapter(async (req) => {
            await new Promise(r => setTimeout(r, req.text === 'one' ? 20 : 0)); // finish out of order
            return { data: wav(values[req.text], 50), mime: 'audio/wav', usage: { inputTokens: 1, outputTokens: 2 } };
        });
        const res = await synthesizeDialogue(adapter, { apiKey: 'k' }, { model: 'm', lines, speakers: SPEAKERS });

        expect((adapter.tts as any).mock.calls.map((c: any[]) => [c[1].text, c[1].voice])).toEqual([['one', 'Kore'], ['two', 'Puck'], ['three', 'Kore']]);
        expect(res.mime).toBe('audio/wav');
        expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 6 });
        const pcm = wavToPcm(res.data);
        const gap = Math.round(24000 * TURN_PAUSE_SEC);
        expect(pcm.sampleRate).toBe(24000);
        expect(pcm.samples.length).toBe(150 + 2 * gap);
        expect([pcm.samples[0], pcm.samples[49], pcm.samples[50], pcm.samples[50 + gap], pcm.samples[100 + 2 * gap]]).toEqual([100, 100, 0, 200, 300]);
    });

    it('a single speaker is one single-voice call', async () => {
        const adapter = fakeAdapter(async () => ({ data: wav(1, 10), mime: 'audio/wav', usage: { inputTokens: 0, outputTokens: 0 } }), { ttsDialogue: vi.fn() });
        await synthesizeDialogue(adapter, {}, { model: 'm', lines: [{ speaker: 'Jane', text: 'a' }, { speaker: 'Jane', text: 'b' }], speakers: SPEAKERS });
        expect(adapter.tts).toHaveBeenCalledWith({}, { model: 'm', text: 'a\nb', voice: 'Puck' });
        expect(adapter.ttsDialogue).not.toHaveBeenCalled();
    });

    it('fails on undeclared speakers, non-WAV lines, and mismatched formats', async () => {
        const ok = fakeAdapter(async () => ({ data: wav(1, 10), mime: 'audio/wav', usage: { inputTokens: 0, outputTokens: 0 } }));
        await expect(synthesizeDialogue(ok, {}, { model: 'm', lines: [{ speaker: 'Bob', text: 'x' }], speakers: SPEAKERS })).rejects.toThrow('"Bob" is not a declared speaker');

        const mp3 = fakeAdapter(async () => ({ data: Buffer.from('ID3'), mime: 'audio/mpeg', usage: { inputTokens: 0, outputTokens: 0 } }));
        await expect(synthesizeDialogue(mp3, {}, { model: 'm', lines, speakers: SPEAKERS })).rejects.toThrow('must return WAV');

        const mixed = fakeAdapter(async (req) => ({ data: wav(1, 10, req.voice === 'Kore' ? 24000 : 16000), mime: 'audio/wav', usage: { inputTokens: 0, outputTokens: 0 } }));
        await expect(synthesizeDialogue(mixed, {}, { model: 'm', lines, speakers: SPEAKERS })).rejects.toThrow('different audio formats');
    });

    it('a failed line fails the whole dialogue', async () => {
        const adapter = fakeAdapter(async (req) => {
            if (req.text === 'two') throw new Error('Gemini API 429: quota');
            return { data: wav(1, 10), mime: 'audio/wav', usage: { inputTokens: 0, outputTokens: 0 } };
        });
        await expect(synthesizeDialogue(adapter, {}, { model: 'm', lines, speakers: SPEAKERS })).rejects.toThrow('429');
    });
});
