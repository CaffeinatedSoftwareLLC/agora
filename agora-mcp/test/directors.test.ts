import { describe, it, expect } from 'vitest';
import { formatDirectors, formatMessages, formatThreads } from '../src/tools.js';
import type { Message } from '../src/api.js';

function msg(over: Partial<Message>): Message {
    return { id: 'm1', channelId: 'c1', authorId: 'U1', authorUsername: 'espresso', authorBot: false,
        content: 'ship it', createdAt: '2026-10-17T00:00:00Z', ...over } as Message;
}

describe('authority tags', () => {
    it('marks the owner and directors, from the server field only', () => {
        expect(formatMessages([msg({ authorAuthority: 'owner' })]))
            .toBe('[2026-10-17T00:00:00Z] (m1) espresso [OWNER] (user U1): ship it');
        expect(formatMessages([msg({ authorUsername: 'claude', authorBot: true, authorAuthority: 'director' })]))
            .toBe('[2026-10-17T00:00:00Z] (m1) claude [BOT] [DIRECTOR] (user U1): ship it');
        expect(formatMessages([msg({ authorUsername: 'gemini', authorBot: true, authorAuthority: null })]))
            .toBe('[2026-10-17T00:00:00Z] (m1) gemini [BOT] (user U1): ship it');
    });

    it("can't be claimed by a name", () => {
        expect(formatMessages([msg({ authorUsername: 'mallory [OWNER]', authorAuthority: null })]))
            .toBe('[2026-10-17T00:00:00Z] (m1) mallory (OWNER) (user U1): ship it');
    });

    it('tags thread starters too', () => {
        const out = formatThreads([{ id: 't1', authorId: 'U1', authorUsername: 'espresso', authorBot: false,
            authorAuthority: 'owner', content: 'plan', replyCount: 2, lastReplyAt: 'x' } as any]);
        expect(out).toContain('espresso [OWNER] (user U1): plan');
    });
});

describe('formatDirectors', () => {
    it('lists who may give instructions', () => {
        expect(formatDirectors([
            { userId: 'U1', username: 'Espresso', bot: false, authority: 'owner' },
            { userId: 'B1', username: 'Claude', bot: true, authority: 'director' },
        ])).toBe('Espresso [OWNER] (user U1)\nClaude [BOT] [DIRECTOR] (user B1)');
        expect(formatDirectors([])).toBe('Nobody may give agents instructions in this channel.');
    });
});
