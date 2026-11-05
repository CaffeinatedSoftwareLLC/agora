import { describe, it, expect } from 'vitest';
import {
    isAudioOverviewRequest, formatTranscript, parseScript, overviewMessage, formatClock, scriptRequest,
    MAX_SCRIPT_CHARS, OVERVIEW_SPEAKERS, overviewSpeakers,
    fairShare, MAX_LINE_CHARS, MAX_TRANSCRIPT_CHARS, THREAD_FLOOR_CHARS, REPLY_PREFIX, type TranscriptRow,
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

    // #40: channel overviews include thread replies, grouped under their parent
    it('groups thread replies under their parent, even when other messages came in between', () => {
        expect(formatTranscript([
            { id: 'P1', username: 'ana', content: 'Release plan: ship Friday?' },
            { id: 'P2', username: 'carl', content: 'Lunch?' },
            { id: 'R1', threadId: 'P1', username: 'ben', content: 'Only if QA signs off.' },
            { id: 'R2', threadId: 'P1', username: 'ana', content: 'OK, Friday pending QA.' },
        ])).toBe([
            'ana: Release plan: ship Friday?',
            `${REPLY_PREFIX}ben: Only if QA signs off.`,
            `${REPLY_PREFIX}ana: OK, Friday pending QA.`,
            'carl: Lunch?',
        ].join('\n'));
    });

    it('keeps replies whose parent is not in the rows together, under a stand-in line', () => {
        expect(formatTranscript([
            { id: 'R1', threadId: 'GONE', username: 'ben', content: 'Still here.' },
            { id: 'P2', username: 'carl', content: 'Hi.' },
        ])).toBe(`(a message that is not shown)\n${REPLY_PREFIX}ben: Still here.\ncarl: Hi.`);
    });

    it('puts each message on one line and cuts very long messages', () => {
        const t = formatTranscript([
            { id: 'P1', username: 'ana', content: 'line one\n\n  line two' },
            { id: 'R1', threadId: 'P1', username: 'bot', content: 'y'.repeat(MAX_LINE_CHARS * 3) },
        ]);
        const [first, second] = t.split('\n');
        expect(first).toBe('ana: line one line two');
        expect(second).toBe(`${REPLY_PREFIX}bot: ${'y'.repeat(MAX_LINE_CHARS)}…`);
    });

    it('one noisy thread keeps its start and its latest replies, and does not crowd out the rest', () => {
        const rows: TranscriptRow[] = [{ id: 'A', username: 'agent', content: 'Collab session: refactor storage' }];
        for (let i = 0; i < 2000; i++) {
            rows.push({ id: `A${String(i).padStart(4, '0')}`, threadId: 'A', username: i % 2 ? 'codex' : 'claude', content: `turn ${i} ${'z'.repeat(200)}` });
        }
        for (let t = 0; t < 5; t++) {
            rows.push({ id: `T${t}`, username: 'ana', content: `topic ${t}` });
            for (let r = 0; r < 3; r++) rows.push({ id: `T${t}R${r}`, threadId: `T${t}`, username: 'ben', content: `topic ${t} reply ${r}` });
        }
        const t = formatTranscript(rows);
        expect(t.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
        expect(t.startsWith('agent: Collab session: refactor storage\n')).toBe(true);
        expect(t).toContain(`claude: turn 0 `);            // the thread's start
        expect(t).toContain(`codex: turn 1999 `);          // and its most recent reply
        expect(t).toMatch(/\[thread\] … \d+ replies skipped …/);
        for (let n = 0; n < 5; n++) {                      // every quiet thread is whole
            for (let r = 0; r < 3; r++) expect(t).toContain(`${REPLY_PREFIX}ben: topic ${n} reply ${r}`);
        }
        // The noisy thread still used most of the room the quiet ones left
        expect(t.length).toBeGreaterThan(MAX_TRANSCRIPT_CHARS * 0.9);
    });

    it('drops the oldest top-level messages before any kept thread falls below its floor', () => {
        const rows: TranscriptRow[] = [];
        for (let t = 0; t < 60; t++) {
            rows.push({ id: `P${String(t).padStart(2, '0')}`, username: 'ana', content: `topic ${t}` });
            for (let r = 0; r < 40; r++) {
                rows.push({ id: `P${String(t).padStart(2, '0')}R${String(r).padStart(2, '0')}`, threadId: `P${String(t).padStart(2, '0')}`, username: 'ben', content: `t${t} r${r} ${'q'.repeat(100)}` });
            }
        }
        const t = formatTranscript(rows);
        expect(t.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
        expect(t).toContain('ana: topic 59');
        expect(t).not.toContain('ana: topic 0\n');
        // Each kept thread has at least the floor's worth of replies
        const blocks = t.split(/\n(?=ana: )/);
        for (const block of blocks) {
            const replies = block.split('\n').slice(1).join('\n');
            expect(replies.length).toBeGreaterThanOrEqual(THREAD_FLOOR_CHARS - 200);
        }
    });
});

describe('fairShare', () => {
    it('lets small threads keep everything and splits the rest among the busy ones', () => {
        expect(fairShare([100, 200, 5000], 1000)).toBe(700);
        expect(fairShare([100, 5000, 5000], 1000)).toBe(450);
        expect(fairShare([100, 200], 1000)).toBe(Infinity);
        expect(fairShare([0, 0], 10)).toBe(Infinity);
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

describe('overviewSpeakers', () => {
    it('uses Gemini voices on Gemini and Audio API voices on an OpenAI-compatible Speech route (OpenAI, Kokoro)', () => {
        expect(overviewSpeakers('gemini')).toEqual(OVERVIEW_SPEAKERS);
        expect(overviewSpeakers('openai')).toEqual([{ speaker: 'Alex', voice: 'nova' }, { speaker: 'Sam', voice: 'onyx' }]);
    });
});
