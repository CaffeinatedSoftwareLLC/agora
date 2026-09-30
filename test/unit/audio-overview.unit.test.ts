import { describe, it, expect } from 'vitest';
import {
    isAudioOverviewRequest, formatTranscript, parseScript, overviewMessage, formatClock, scriptRequest,
    MAX_SCRIPT_CHARS,
} from '../../src/ai/audio-overview';

/** WBS 5.1: audio overview intent, transcript, and script handling. */

describe('isAudioOverviewRequest', () => {
    it.each([
        ['<@01ABC> make an audio overview of this thread', true],
        ['@AI-Assistant can you do a podcast about this?', true],
        ['audio summary please', true],
        ['Voice recap of the discussion', true],
        ['<@01ABC> summarize this thread', false],
        ['what is the audio codec here?', false],
        ['@podcast-bot hello', false], // a mention named podcast isn't a request
    ])('%s → %s', (text, expected) => {
        expect(isAudioOverviewRequest(text)).toBe(expected);
    });
});

describe('formatTranscript', () => {
    it('formats name: text oldest first and skips placeholders and blanks', () => {
        expect(formatTranscript([
            { username: 'ana', content: 'Ship Friday?' },
            { username: 'bot', content: '...' },
            { username: 'ben', content: '  ' },
            { username: 'ben', content: 'Only if QA signs off.' },
        ])).toBe('ana: Ship Friday?\nben: Only if QA signs off.');
    });

    it('keeps the most recent messages within the size cap', () => {
        const rows = Array.from({ length: 2000 }, (_, i) => ({ username: 'u', content: `message ${i} ${'x'.repeat(50)}` }));
        const t = formatTranscript(rows);
        expect(t.length).toBeLessThanOrEqual(60_000);
        expect(t.endsWith(`message 1999 ${'x'.repeat(50)}`)).toBe(true);
        expect(t).not.toContain('message 0 ');
    });
});

describe('parseScript', () => {
    it('keeps host lines, tolerating bullets, bold names, and stage directions', () => {
        const raw = [
            'Here is your script:',
            '**Alex:** Welcome back! [upbeat music]',
            '- Sam: Thanks, Alex. (laughs) Big week.',
            'SAM: They decided to *ship on Friday*.',
            'Narrator: this line is dropped',
            'Alex:',
            'Alex: [pause]',
        ].join('\n');
        expect(parseScript(raw)).toEqual([
            { speaker: 'Alex', text: 'Welcome back!' },
            { speaker: 'Sam', text: 'Thanks, Alex. Big week.' },
            { speaker: 'Sam', text: 'They decided to ship on Friday.' },
        ]);
    });

    it('drops a last line cut off mid-sentence (reply hit the token limit)', () => {
        const raw = 'Alex: Welcome back.\nSam: It started with a weather question!\nAlex: It pointed them to the National Weather Service in';
        expect(parseScript(raw)).toEqual([
            { speaker: 'Alex', text: 'Welcome back.' },
            { speaker: 'Sam', text: 'It started with a weather question!' },
        ]);
        expect(parseScript('Alex: Done.\nSam: "That\'s all."')).toHaveLength(2);
    });

    it('stops at the script size cap', () => {
        const raw = Array.from({ length: 200 }, (_, i) => `${i % 2 ? 'Sam' : 'Alex'}: ${'word '.repeat(20)}`).join('\n');
        const lines = parseScript(raw);
        const size = lines.reduce((n, l) => n + l.speaker.length + 2 + l.text.length + 1, 0);
        expect(size).toBeLessThanOrEqual(MAX_SCRIPT_CHARS);
        expect(lines.length).toBeGreaterThan(10);
    });
});

describe('script and message text', () => {
    it('script request carries the transcript and the listener\'s ask without mentions', () => {
        const [msg] = scriptRequest('ana: hi', '<@01ABC> audio overview, focus on the release date');
        expect(msg.role).toBe('user');
        expect(msg.content).toContain('ana: hi');
        expect(msg.content).toContain('"audio overview, focus on the release date"');
    });

    it('final message has title, length, and transcript', () => {
        expect(formatClock(161.4)).toBe('2:41');
        expect(formatClock(59.6)).toBe('1:00');
        expect(overviewMessage(95, [{ speaker: 'Alex', text: 'Hi.' }], true))
            .toBe('🎙️ **Audio overview** of this thread (1:35), voiced by AI.\n\n**Alex:** Hi.');
        expect(overviewMessage(null, [{ speaker: 'Alex', text: 'A.' }, { speaker: 'Sam', text: 'B.' }], false))
            .toBe('🎙️ **Audio overview** of this channel, voiced by AI.\n\n**Alex:** A.\n\n**Sam:** B.');
    });
});
