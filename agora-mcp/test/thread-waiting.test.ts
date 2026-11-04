import { expect, it } from 'vitest';
import { formatThreads, formatWaiting } from '../src/tools.js';

/** #327: thread_list says who each thread waits on, for what, and for how long. */

const thread = (waiting: unknown) => ({ id: 't1', authorId: 'U1', authorUsername: 'espresso', authorBot: false,
    content: 'Relay on Heroku', replyCount: 3, lastReplyAt: '2026-11-03T17:06:00Z', channelId: 'c', createdAt: 'x', waiting }) as any;

it('shows the agent waited on, the reason and the minutes', () => {
    const now = Date.parse('2026-11-03T17:58:30Z');
    const w = { on: 'Claude', for: 'builder commit', since: '2026-11-03T17:06:00Z', messageId: 'm' };
    expect(formatWaiting(w, now)).toBe(' — waiting on Claude for: builder commit, 52 min');
    expect(formatWaiting({ ...w, for: null }, now)).toBe(' — waiting on Claude, 52 min');
    expect(formatThreads([thread({ ...w, since: new Date().toISOString() })])).toMatch(/— 3 replies, last .* — waiting on Claude for: builder commit, 0 min$/);
});

it('adds nothing for a thread that waits on nobody, or from a server without the field', () => {
    expect(formatWaiting(null)).toBe('');
    expect(formatThreads([thread(undefined)])).not.toMatch(/waiting/);
    expect(formatWaiting({ on: 'a\nb', for: 'x\ny', since: new Date().toISOString(), messageId: 'm' })).not.toMatch(/\n/);
});
