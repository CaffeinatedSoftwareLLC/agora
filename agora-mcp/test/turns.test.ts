import { describe, expect, it } from 'vitest';
import type { Message } from '../src/api.js';
import { mentions, protocolOf, TurnTracker, ulidSuccessor } from '../src/turns.js';

/** Which threads an agent owes a reply in, from what its tools showed it. */

const ME = { id: 'B-codex', username: 'Codex' };
let seq = 0;
const msg = (content: string, extra: Partial<Message> = {}): Message => ({
    id: `01M6M3${String(++seq).padStart(20, '0')}`, content, authorId: 'B-claude', authorUsername: 'Claude', authorBot: true,
    channelId: 'C', createdAt: '2026-11-04T20:00:00Z', ...extra,
});
const start = (participants: string, last = '') => `[AGORA/v1 MODE=review STATE=START]\nDesign review\nparticipants: [${participants}]${last ? `\n${last}` : ''}`;
const turn = (to: string) => `[AGORA/v1 MODE=review STATE=TURN]\nmy part\n[YIELD to=${to}]`;

describe('protocolOf / mentions', () => {
    it('reads the header, the last-line YIELD or WAIT, and START participants', () => {
        expect(protocolOf(start('Claude, @Codex', '[YIELD to=Codex]'))).toEqual({ state: 'START', yieldTo: 'Codex', waitingOn: undefined, participants: ['Claude', 'Codex'] });
        expect(protocolOf('[AGORA/v1 MODE=fix STATE=WAIT]\nx\n[WAIT on=Codex for=build]')?.waitingOn).toBe('Codex');
        expect(protocolOf('plain text [YIELD to=Codex]')).toBeNull();
    });
    it('finds an @mention as a word only', () => {
        expect(mentions('@codex please look', 'Codex')).toBe(true);
        expect(mentions('ping @Codex.', 'Codex')).toBe(true);
        expect(mentions('@Codexer', 'Codex')).toBe(false);
        expect(mentions('mail me@Codex', 'Codex')).toBe(false);
    });
});

describe('TurnTracker', () => {
    it('owes a thread whose top-level START lists the agent, and the agent\'s own reply settles it', () => {
        const t = new TurnTracker();
        const root = msg(start('Claude, Codex'));
        t.observe('C', [root], ME);
        expect(t.pending('C')).toEqual({ threadId: root.id, messageId: root.id, why: 'start' });
        t.observe('C', [msg('ACK', { authorId: ME.id, threadId: root.id })], ME);
        expect(t.pending('C')).toBeUndefined();
    });

    it('owes a YIELD, a WAIT naming it and an in-thread @mention; a YIELD to someone else or DONE settles it', () => {
        const t = new TurnTracker();
        const y = msg(turn('Codex'), { threadId: 'T1' });
        t.observe('C', [y], ME);
        expect(t.pending('C')).toMatchObject({ threadId: 'T1', why: 'yield' });
        t.observe('C', [msg(turn('Gemini'), { threadId: 'T1' })], ME);
        expect(t.pending('C')).toBeUndefined();

        t.observe('C', [msg('[AGORA/v1 MODE=fix STATE=WAIT]\nx\n[WAIT on=codex]', { threadId: 'T2' })], ME);
        expect(t.pending('C')).toMatchObject({ threadId: 'T2', why: 'wait' });
        t.observe('C', [msg('[AGORA/v1 MODE=fix STATE=DONE]\nshipped', { threadId: 'T2' })], ME);
        expect(t.pending('C')).toBeUndefined();

        t.observe('C', [msg('@Codex can you check this?', { threadId: 'T3', authorBot: false })], ME);
        expect(t.pending('C')).toMatchObject({ threadId: 'T3', why: 'mention' });
        t.settle('C', 'T3');
        expect(t.pending('C')).toBeUndefined();
    });

    it('ignores top-level plain mentions, the agent\'s own posts, other channels and deleted posts', () => {
        const t = new TurnTracker();
        t.observe('C', [msg('@Codex hi there')], ME);
        t.observe('C', [msg(turn('Codex'), { threadId: 'T1', authorId: ME.id })], ME);
        t.observe('C', [msg(turn('Codex'), { threadId: 'T2', deletedAt: '2026-11-04T20:01:00Z' })], ME);
        t.observe('D', [msg(turn('Codex'), { threadId: 'T3' })], ME);
        expect(t.pending('C')).toBeUndefined();
        expect(t.pending('D')).toMatchObject({ threadId: 'T3' });
    });

    it('reports the most recent owed thread and remembers protocol threads', () => {
        const t = new TurnTracker();
        const a = msg(turn('Codex'), { threadId: 'TA' });
        const b = msg(turn('Codex'), { threadId: 'TB' });
        t.observe('C', [b, a], ME);
        expect(t.pending('C')?.threadId).toBe('TB');
        expect(t.isProtocolThread('TA')).toBe(true);
        expect(t.isProtocolThread('TX')).toBe(false);
    });
});

it('ulidSuccessor gives the next ULID, carrying', () => {
    expect(ulidSuccessor('01M6M30K2P5CS4MCN0P3DZHYQH')).toBe('01M6M30K2P5CS4MCN0P3DZHYQJ');
    expect(ulidSuccessor('01M6M30K2P5CS4MCN0P3DZHYQZ')).toBe('01M6M30K2P5CS4MCN0P3DZHYR0');
});
