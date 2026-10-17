import { describe, it, expect, vi } from 'vitest';
import { registerTools } from '../src/tools.js';
import { CursorTracker } from '../src/cursor.js';

type Handler = (args: any, extra?: any) => Promise<{ content: Array<{ text: string }> }>;

function setup(sessions: any[] = []) {
    const api = {
        getMe: async () => ({ id: 'self', username: 'claude', serverId: 's1', bot: true, channels: [{ id: 'ch1', name: 'general', channelType: 'text' }] }),
        getCursors: async () => [],
        sendMessage: vi.fn(async (_ch: string, content: string, _idem?: string, clientKey?: string) =>
            ({ id: 'm1', content, replayed: clientKey === 'seen' })),
        sendReply: vi.fn(async () => ({ id: 'r1' })),
        agentCommand: vi.fn(async (_ch: string, body: any) => body.command === 'sessions'
            ? { sessions }
            : { action: 'started', session: sessions[0] }),
    } as any;
    const handlers = new Map<string, Handler>();
    const server = { tool: (name: string, ...rest: unknown[]) => handlers.set(name, rest[rest.length - 1] as Handler) };
    registerTools(server as never, api, new CursorTracker(api), { defaultChannel: 'general' });
    return { api, call: (name: string, args: any) => handlers.get(name)!(args) };
}

const live = { id: 'S1', profile: 'codex', botId: 'B1', botUsername: 'Codex', state: 'live', endReason: null, wakesUsed: 2, tokensUsed: 900, lastActiveAt: 't' };

describe('client_key', () => {
    it('is passed to the server and a replay is reported as not posted again', async () => {
        const { api, call } = setup();
        await call('chat_send', { message: 'hi', client_key: 'dk_1:1' });
        expect(api.sendMessage).toHaveBeenCalledWith('ch1', 'hi', expect.any(String), 'dk_1:1');
        const out = await call('chat_send', { message: 'hi', client_key: 'seen' });
        expect(out.content[0].text).toMatch(/not posted again/);
        await call('chat_send', { message: 'in thread', thread: 'T1', client_key: 'dk_1:2' });
        expect(api.sendReply).toHaveBeenCalledWith('ch1', 'T1', 'in thread', expect.any(String), 'dk_1:2');
    });
});

describe('session tools', () => {
    it('lists sessions', async () => {
        const { call } = setup([live]);
        const out = await call('session_list', {});
        expect(out.content[0].text).toContain('S1 codex (@Codex) live, 2 wakes, 900 tokens');
    });

    it('starts with the on_live choice', async () => {
        const { api, call } = setup([live]);
        await call('session_start', { profile: 'codex', on_live: 'shelve' });
        expect(api.agentCommand).toHaveBeenCalledWith('ch1', { command: 'start', profile: 'codex', onLive: 'shelve', fresh: undefined });
    });

    it('wakes a live agent by mentioning its bot', async () => {
        const { api, call } = setup([live]);
        await call('session_wake', { profile: 'codex', message: 'review PR 62' });
        expect(api.sendMessage).toHaveBeenCalledWith('ch1', '@Codex review PR 62', expect.any(String), undefined);
    });

    it('says so when there is no live session to wake', async () => {
        const { api, call } = setup([{ ...live, state: 'shelved' }]);
        const out = await call('session_wake', { profile: 'codex', message: 'x' });
        expect(out.content[0].text).toMatch(/No live codex session/);
        expect(api.sendMessage).not.toHaveBeenCalled();
    });
});
