import { describe, expect, it, vi } from 'vitest';
import { closedThreadLabel, formatMessages, formatThreads, registerTools } from '../src/tools.js';
import { CursorTracker } from '../src/cursor.js';
import type { Message, ThreadSummary } from '../src/api.js';

/** #132: thread_list tells a stale collaboration from the current one, and thread_close says why it ended. */

function setup(extra: Record<string, unknown> = {}) {
    const api = { getMe: async () => ({ id: 'self', username: 'codex', serverId: 's', bot: true, channels: [{ id: 'ch1', name: 'general', channelType: 3 }] }),
        getCursors: async () => [], ...extra } as any;
    const handlers = new Map<string, (args: any) => Promise<any>>(), schemas = new Map<string, any>();
    const server = { tool: (name: string, _d: string, schema: unknown, handler: any) => { handlers.set(name, handler); schemas.set(name, schema); } };
    registerTools(server as never, api, new CursorTracker(api), { defaultChannel: 'general' });
    return { api, schemas, call: (tool: string, args: any) => handlers.get(tool)!(args) };
}

const thread = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
    id: 'OLD', content: 'Beta test plan', authorId: 'u1', authorUsername: 'claude', authorBot: true, channelId: 'ch1',
    createdAt: '2026-10-20T10:00:00Z', replyCount: 6, lastReplyAt: '2026-10-20T11:00:00Z', ...over,
});

describe('thread_list (#132)', () => {
    it('marks an older open thread that has a newer request for the agent, and shows the latest protocol state', () => {
        const out = formatThreads([
            thread({ newerRequestId: 'NEW', latestProtocol: { state: 'TURN', yieldTo: 'codex', messageId: 'P', authorUsername: 'claude' } }),
            thread({ id: 'CUR', content: 'PR 131 review', newerRequestId: null }),
        ]);
        const [old, current] = out.split('\n');
        expect(old).toContain('latest: STATE=TURN by claude');
        expect(old).toContain('NOTE: a newer request for you (message NEW) came after this thread\'s last reply; read it before resuming this thread');
        expect(current).not.toContain('NOTE');
    });

    it('lists closed threads with how they ended and where the work moved', async () => {
        const listThreads = vi.fn(async () => [thread({ threadClosedAt: '2026-10-20T12:00:00Z', closeReason: 'superseded', successorId: 'NEW', closedByUsername: 'codex' })]);
        const { call } = setup({ listThreads });
        const text = (await call('thread_list', { closed: true })).content[0].text;
        expect(listThreads).toHaveBeenCalledWith('ch1', { limit: 10, state: 'closed' });
        expect(text).toContain('#general — 1 recently closed thread(s)');
        expect(text).toContain('(OLD) claude [BOT] (user u1): Beta test plan — closed as superseded by codex 2026-10-20T12:00:00Z; the work continues in thread NEW');

        await call('thread_list', {});
        expect(listThreads).toHaveBeenLastCalledWith('ch1', { limit: 10 });
        expect(formatThreads([], true)).toBe('No closed threads.');
    });
});

describe('thread_close (#132)', () => {
    it('passes the reason and successor and reports them', async () => {
        const setThreadClosed = vi.fn(async () => ({ id: 'OLD', threadClosedAt: 'now', closeReason: 'superseded' as const, successorId: 'NEW' }));
        const { call, schemas } = setup({ setThreadClosed });
        const text = (await call('thread_close', { thread: 'OLD', successor: 'NEW' })).content[0].text;
        expect(setThreadClosed).toHaveBeenCalledWith('ch1', 'OLD', true, { reason: undefined, successor: 'NEW' });
        expect(text).toMatch(/closed as superseded; the work continues in thread NEW$/);
        expect(schemas.get('thread_close').reason.safeParse('finished').success).toBe(false);
        expect(schemas.get('thread_close').reason.safeParse('done').success).toBe(true);

        await call('thread_close', { thread: 'OLD', reopen: true, reason: 'done' });
        expect(setThreadClosed).toHaveBeenLastCalledWith('ch1', 'OLD', false, undefined);
    });

    it('works against a server that answers without the new fields', async () => {
        const { call } = setup({ setThreadClosed: vi.fn(async () => ({ id: 'OLD', threadClosedAt: 'now' })) });
        expect((await call('thread_close', { thread: 'OLD', reason: 'done' })).content[0].text).toMatch(/ closed$/);
    });
});

describe('closed threads in channel reads (#132)', () => {
    it('labels a closed parent with its reason and successor', () => {
        const m: Message = { id: 'OLD', content: 'Beta test plan', authorId: 'u1', authorUsername: 'claude', authorBot: true, channelId: 'ch1',
            createdAt: '2026-10-20T10:00:00Z', replyCount: 6, threadClosedAt: 'x', threadCloseReason: 'superseded', threadSuccessorId: 'NEW' };
        expect(formatMessages([m])).toMatch(/\[thread closed as superseded → continues in thread NEW: 6 replies\]$/);
        expect(closedThreadLabel({})).toBe('thread closed');
        expect(closedThreadLabel({ threadCloseReason: 'done' })).toBe('thread closed as done');
    });
});
