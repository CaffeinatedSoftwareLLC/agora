import { describe, it, expect } from 'vitest';
import { pcmToMp3, wavToPcm, durationSeconds } from '../../src/ai/mp3';
import { pcmToWav } from '../../src/ai/adapters/audio';

/** WBS 5.1: WAV → MP3 for audio overviews. */

function tone(seconds: number, rate = 24000): Buffer {
    const pcm = Buffer.alloc(rate * seconds * 2);
    for (let i = 0; i < rate * seconds; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2);
    return pcm;
}

describe('wavToPcm', () => {
    it('reads format and samples, skipping unknown chunks', () => {
        const wav = pcmToWav(tone(1), 24000);
        // Insert a LIST chunk between fmt and data, as some encoders do
        const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')]);
        const withList = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
        for (const w of [wav, withList]) {
            const pcm = wavToPcm(w);
            expect(pcm.sampleRate).toBe(24000);
            expect(pcm.channels).toBe(1);
            expect(pcm.samples.length).toBe(24000);
            expect(durationSeconds(pcm)).toBe(1);
        }
    });

    it('rejects non-WAV and non-16-bit input', () => {
        expect(() => wavToPcm(Buffer.from('ID3 not a wav'))).toThrow('not a WAV');
        const eightBit = pcmToWav(tone(1), 24000, 1, 8);
        expect(() => wavToPcm(eightBit)).toThrow('16-bit');
    });
});

describe('pcmToMp3', () => {
    it('encodes an MPEG audio stream that the file validator accepts', async () => {
        const mp3 = pcmToMp3(wavToPcm(pcmToWav(tone(3), 24000)));
        // 64 kbps × 3 s ≈ 24 KB
        expect(mp3.length).toBeGreaterThan(18_000);
        expect(mp3.length).toBeLessThan(32_000);
        const { fileTypeFromBuffer } = await import('file-type');
        expect(await fileTypeFromBuffer(mp3)).toMatchObject({ ext: 'mp3', mime: 'audio/mpeg' });
    });

    it('downmixes stereo', () => {
        const stereo = new Int16Array(24000 * 2).fill(1000);
        const mp3 = pcmToMp3({ samples: stereo, sampleRate: 24000, channels: 2 });
        expect(mp3.length).toBeGreaterThan(1000);
    });
});
