import fs from 'node:fs';
import vm from 'node:vm';
import type { Mp3Encoder as Mp3EncoderType } from '@breezystack/lamejs';

/**
 * WAV → MP3 for audio overviews. MP3 is in the default allowed file types (WAV
 * isn't) and is ~6× smaller at 64 kbps mono.
 *
 * @breezystack/lamejs (LGPL-3.0, pure JS, no dependencies) ships ESM plus an IIFE
 * build that its `require` export points at; the IIFE only declares a `lamejs`
 * variable, and this project compiles `import()` to `require()`. So load the
 * package's own IIFE file once and take the variable it defines.
 */
type Lame = { Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => Mp3EncoderType };
let lame: Lame | null = null;

function loadLame(): Lame {
    if (!lame) {
        const file = require.resolve('@breezystack/lamejs');
        const source = fs.readFileSync(file, 'utf8');
        lame = vm.runInThisContext(`(function () {\n${source}\nreturn lamejs;\n})()`, { filename: file }) as Lame;
    }
    return lame;
}

export interface Pcm {
    samples: Int16Array;
    sampleRate: number;
    channels: number;
}

/** Read 16-bit PCM from a RIFF/WAVE buffer (walks chunks; tolerates extra chunks). */
export function wavToPcm(wav: Buffer): Pcm {
    if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Audio is not a WAV file');
    }
    let offset = 12;
    let format: { channels: number; sampleRate: number; bits: number; audioFormat: number } | null = null;
    while (offset + 8 <= wav.length) {
        const id = wav.toString('ascii', offset, offset + 4);
        const size = wav.readUInt32LE(offset + 4);
        const body = offset + 8;
        if (id === 'fmt ') {
            format = {
                audioFormat: wav.readUInt16LE(body),
                channels: wav.readUInt16LE(body + 2),
                sampleRate: wav.readUInt32LE(body + 4),
                bits: wav.readUInt16LE(body + 14),
            };
        } else if (id === 'data') {
            if (!format) throw new Error('WAV data chunk before fmt chunk');
            if (format.audioFormat !== 1 || format.bits !== 16) throw new Error('Only 16-bit PCM WAV is supported');
            const end = Math.min(body + size, wav.length);
            const bytes = wav.subarray(body, end - ((end - body) % 2));
            // Copy into an aligned buffer; Buffer slices may start at odd offsets
            const samples = new Int16Array(bytes.length / 2);
            for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
            return { samples, sampleRate: format.sampleRate, channels: format.channels };
        }
        offset = body + size + (size % 2);
    }
    throw new Error('WAV has no data chunk');
}

/** Encode PCM as MP3 (stereo input is downmixed to mono). */
export function pcmToMp3(pcm: Pcm, kbps = 64): Buffer {
    let mono = pcm.samples;
    if (pcm.channels === 2) {
        mono = new Int16Array(Math.floor(pcm.samples.length / 2));
        for (let i = 0; i < mono.length; i++) mono[i] = (pcm.samples[2 * i] + pcm.samples[2 * i + 1]) >> 1;
    } else if (pcm.channels !== 1) {
        throw new Error(`Unsupported channel count ${pcm.channels}`);
    }
    const encoder = new (loadLame().Mp3Encoder)(1, pcm.sampleRate, kbps);
    const chunks: Buffer[] = [];
    const BLOCK = 1152 * 16;
    for (let i = 0; i < mono.length; i += BLOCK) {
        const out = encoder.encodeBuffer(mono.subarray(i, i + BLOCK));
        if (out.length) chunks.push(Buffer.from(out.buffer, out.byteOffset, out.length));
    }
    const tail = encoder.flush();
    if (tail.length) chunks.push(Buffer.from(tail.buffer, tail.byteOffset, tail.length));
    return Buffer.concat(chunks);
}

export function durationSeconds(pcm: Pcm): number {
    return pcm.samples.length / pcm.channels / pcm.sampleRate;
}
