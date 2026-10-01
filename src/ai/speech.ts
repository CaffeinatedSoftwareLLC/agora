import type { Adapter, DialogueRequest, MediaResult, ProviderCredentials, SpeechLine, SpeechSpeaker } from './adapters';
import { pcmToWav } from './adapters/audio';
import { wavToPcm, type Pcm } from './mp3';

/**
 * Multi-speaker speech for any speech adapter: one native call when the adapter has
 * `ttsDialogue` (Gemini), otherwise each line is voiced with `tts` and the WAVs are
 * joined with a short pause (issue #33; lets single-voice engines such as a local
 * Kokoro voice a two-host overview).
 */

/** Silence between turns when lines are voiced separately. */
export const TURN_PAUSE_SEC = 0.3;
/** Parallel single-voice calls when joining lines (speech preview models have low rate limits). */
const LINE_CONCURRENCY = 2;
/** Turns accepted from agent-supplied dialogue text. */
export const MAX_DIALOGUE_LINES = 100;

/**
 * Split "Name: text" dialogue into turns. A line without a label continues the
 * previous turn; a name-like label that isn't a declared speaker is an error, so
 * a typo can't silently give one host the other's lines.
 */
export function parseDialogue(text: string, speakers: SpeechSpeaker[]): { ok: true; lines: SpeechLine[] } | { ok: false; error: string } {
    const names = new Map(speakers.map(s => [s.speaker.toLowerCase(), s.speaker]));
    const declared = speakers.map(s => s.speaker).join(', ');
    const lines: SpeechLine[] = [];
    for (const raw of text.split('\n')) {
        const row = raw.trim();
        if (!row) continue;
        // "Name:" then a space or the end of the line (so "https://…" isn't a label)
        const m = /^([A-Za-z0-9_ .-]{1,40}?)\s*:(?:\s+(.*))?$/.exec(row);
        const speaker = m && names.get(m[1].toLowerCase());
        if (speaker) {
            lines.push({ speaker, text: (m[2] ?? '').trim() });
        } else if (m && !m[1].includes(' ')) {
            return { ok: false, error: `"${m[1]}" is not a declared speaker (${declared})` };
        } else if (lines.length) {
            const last = lines[lines.length - 1];
            last.text = last.text ? `${last.text} ${row}` : row;
        } else {
            return { ok: false, error: `text must start with a speaker label, e.g. "${speakers[0].speaker}: …"` };
        }
    }
    const turns = lines.filter(l => l.text);
    if (!turns.length) return { ok: false, error: 'text has no dialogue lines' };
    if (turns.length > MAX_DIALOGUE_LINES) return { ok: false, error: `text has more than ${MAX_DIALOGUE_LINES} dialogue lines` };
    return { ok: true, lines: turns };
}

/** Voice `req.lines` with their speakers' voices; returns WAV (or the provider's format for one call). */
export async function synthesizeDialogue(adapter: Adapter, creds: ProviderCredentials, req: DialogueRequest): Promise<MediaResult> {
    const voices = new Map(req.speakers.map(s => [s.speaker, s.voice]));
    const unknown = req.lines.find(l => !voices.has(l.speaker));
    if (unknown) throw new Error(`"${unknown.speaker}" is not a declared speaker`);
    if (!req.lines.length) throw new Error('No dialogue lines to voice');

    // One voice needs no multi-speaker support (and Gemini's requires exactly two speakers)
    const used = new Set(req.lines.map(l => l.speaker));
    if (used.size === 1) {
        const [speaker] = used;
        return adapter.tts!(creds, { model: req.model, text: req.lines.map(l => l.text).join('\n'), voice: voices.get(speaker)! });
    }
    if (adapter.ttsDialogue) {
        return adapter.ttsDialogue(creds, { ...req, speakers: req.speakers.filter(s => used.has(s.speaker)) });
    }

    const results: MediaResult[] = new Array(req.lines.length);
    let next = 0;
    const worker = async () => {
        while (next < req.lines.length) {
            const i = next++;
            const line = req.lines[i];
            results[i] = await adapter.tts!(creds, { model: req.model, text: line.text, voice: voices.get(line.speaker)! });
        }
    };
    await Promise.all(Array.from({ length: Math.min(LINE_CONCURRENCY, req.lines.length) }, worker));
    return joinWavs(results);
}

function joinWavs(parts: MediaResult[]): MediaResult {
    const pcms: Pcm[] = parts.map(p => {
        if (p.mime !== 'audio/wav') throw new Error(`Can't join ${p.mime} audio line by line; the speech provider must return WAV`);
        return wavToPcm(p.data);
    });
    const { sampleRate, channels } = pcms[0];
    if (pcms.some(p => p.sampleRate !== sampleRate || p.channels !== channels)) throw new Error('The speech provider returned lines in different audio formats');

    const pause = new Int16Array(Math.round(sampleRate * TURN_PAUSE_SEC) * channels);
    const chunks: Buffer[] = [];
    pcms.forEach((p, i) => {
        if (i > 0) chunks.push(int16Bytes(pause));
        chunks.push(int16Bytes(p.samples));
    });
    return {
        data: pcmToWav(Buffer.concat(chunks), sampleRate, channels),
        mime: 'audio/wav',
        usage: parts.reduce((u, p) => ({ inputTokens: u.inputTokens + p.usage.inputTokens, outputTokens: u.outputTokens + p.usage.outputTokens }), { inputTokens: 0, outputTokens: 0 }),
    };
}

function int16Bytes(samples: Int16Array): Buffer {
    const out = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], i * 2);
    return out;
}
