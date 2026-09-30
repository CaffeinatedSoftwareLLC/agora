/**
 * Raw PCM → WAV. Gemini TTS returns headerless 16-bit PCM (`audio/L16;codec=pcm;rate=24000`)
 * from generateContent; browsers and the file validator need a RIFF container.
 */

/** Sample rate from a PCM MIME type (`rate=24000`), or null if the type isn't raw PCM. */
export function pcmRate(mime: string): number | null {
    const lower = mime.toLowerCase();
    if (!lower.startsWith('audio/l16') && !lower.startsWith('audio/pcm') && !lower.includes('codec=pcm')) return null;
    const rate = /rate=(\d+)/.exec(lower);
    return rate ? Number(rate[1]) : 24000;
}

export function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
    const blockAlign = channels * (bitsPerSample / 8);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);            // fmt chunk size
    header.writeUInt16LE(1, 20);             // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * blockAlign, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}
