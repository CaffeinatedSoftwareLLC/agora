import { describe, it, expect, vi } from 'vitest';
import { registerTools } from '../src/tools.js';
import { CursorTracker } from '../src/cursor.js';
import { AgoraApiError } from '../src/api.js';

type Handler = (args: any, extra?: any) => Promise<{ content: Array<{ text: string }> }>;

const card = {
    id: 'T1', channelId: 'ch1', title: 'Fix\nlogin', description: '', status: 'in_progress', profile: { id: 'P1', name: 'codex' },
    threadId: 'TH1', session: { id: 'S2', state: 'live', running: true, branch: 'agora/codex/S2', headSha: 'b'.repeat(40), tokensUsed: 5, tokenBudget: 10 },
    prUrl: 'https://github.com/o/r/pull/3', prState: 'open',
};

function setup(overrides: Record<string, unknown> = {}) {
    const api = {
        getMe: async () => ({ id: 'self', username: 'codex', serverId: 's1', bot: true, channels: [{ id: 'ch1', name: 'general', channelType: 'text' }] }),
        getCursors: async () => [],
        tasks: vi.fn(async () => ({ cards: [card], canManage: false })),
        createTask: vi.fn(async () => ({ action: 'started', card })),
        updateTask: vi.fn(async () => ({ card })),
        startTask: vi.fn(async () => ({ action: 'kept', card })),
        startSubtask: vi.fn(async () => ({ action: 'started', session: { id: 'S3', profile: 'codex', threadId: 'TH3', tokenBudget: 1500 } })),
        agentCommand: vi.fn(async () => ({ sessions: [
            { id: 'S2', profile: 'codex', botUsername: 'Codex', state: 'live', threadId: 'TH1', wakesUsed: 0, tokensUsed: 0, lastActiveAt: 't' },
        ] })),
        sendMessage: vi.fn(),
        ...overrides,
    } as any;
    const handlers = new Map<string, Handler>();
    const server = { tool: (name: string, ...rest: unknown[]) => handlers.set(name, rest[rest.length - 1] as Handler) };
    registerTools(server as never, api, new CursorTracker(api), { defaultChannel: 'general' });
    return { api, call: (name: string, args: any) => handlers.get(name)!(args) };
}

describe('task board tools', () => {
    it('lists cards on one line each, with session, branch, thread and PR', async () => {
        const { call } = setup();
        const text = (await call('task_list', {})).content[0].text;
        expect(text).toContain('T1 [in_progress] Fix login → codex, session S2 live (working), agora/codex/S2 @ bbbbbbbbbbbb, thread TH1, PR open https://github.com/o/r/pull/3');
    });

    it('creates, updates and starts cards with only the fields given', async () => {
        const { api, call } = setup();
        await call('task_create', { title: 'Fix login', assignee: 'codex', start: true });
        expect(api.createTask).toHaveBeenCalledWith('ch1', { title: 'Fix login', description: undefined, profile: 'codex', start: true });
        await call('task_update', { task: 'T1', status: 'review' });
        expect(api.updateTask).toHaveBeenCalledWith('ch1', 'T1', { status: 'review' });
        await call('task_update', { task: 'T1', assignee: null });
        expect(api.updateTask).toHaveBeenLastCalledWith('ch1', 'T1', { profile: null });
        expect((await call('task_start', { task: 'T1' })).content[0].text).toMatch(/^Card session kept/);
    });

    it('explains a missing can_direct instead of failing silently', async () => {
        const { call } = setup({ createTask: vi.fn(async () => { throw new AgoraApiError('403', 403, 'cannot_direct', { username: 'codex' }); }) });
        await expect(call('task_create', { title: 'x' })).rejects.toThrow(/can't direct agents in #general/);
    });

    it('session_wake ignores a card session: it hears only its own thread', async () => {
        const { api, call } = setup();
        const text = (await call('session_wake', { profile: 'codex', message: 'hi' })).content[0].text;
        expect(text).toMatch(/No live codex session/);
        expect(api.sendMessage).not.toHaveBeenCalled();
    });
});

describe('subtask_start', () => {
    it('sends the brief with the parent session and reports the child', async () => {
        const { api, call } = setup();
        const out = await call('subtask_start', { parent_session_id: 'S1', title: 'Tests', brief: 'Write them', thread: 'TH0', token_budget: 1500, client_key: 'dk_1:2' });
        expect(api.startSubtask).toHaveBeenCalledWith('ch1', { parentSessionId: 'S1', title: 'Tests', brief: 'Write them', reportThreadId: 'TH0', tokenBudget: 1500, client_key: 'dk_1:2' });
        expect(out.content[0].text).toContain('Subtask started: session S3 (codex) in thread TH3, token budget 1500');
        expect(out.content[0].text).toContain('finish your turn');
    });

    it('omits what the agent left out', async () => {
        const { api, call } = setup();
        await call('subtask_start', { parent_session_id: 'S1', title: 'Tests', brief: 'Write them' });
        expect(api.startSubtask).toHaveBeenCalledWith('ch1', { parentSessionId: 'S1', title: 'Tests', brief: 'Write them' });
    });
});
