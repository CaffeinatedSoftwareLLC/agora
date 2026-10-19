import { describe, it, expect, vi } from 'vitest';
import { registerTools } from '../src/tools.js';
import { CursorTracker } from '../src/cursor.js';
import { AgoraApi, AgoraApiError } from '../src/api.js';

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

describe('[pass]', () => {
    it('is never posted to Agora', async () => {
        const { api, call } = setup();
        const out = await call('chat_send', { message: '  [pass] ' });
        expect(out.content[0].text).toMatch(/Not posted/);
        await call('chat_send', { message: '[PASS]', thread: 'T1' });
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(api.sendReply).not.toHaveBeenCalled();
    });
});

describe('session tools', () => {
    it('sets the start dial and can later turn an existing session off', async () => {
        const { api, call } = setup([{ ...live, lurkMode: 'quiet' }]);
        await call('session_start', { profile: 'codex', lurk: 'quiet' });
        expect(api.agentCommand).toHaveBeenCalledWith('ch1', expect.objectContaining({ command: 'start', lurkMode: 'quiet' }));
        await call('session_lurk', { profile: 'codex', lurk: 'off' });
        expect(api.agentCommand).toHaveBeenCalledWith('ch1', { command: 'lurk', profile: 'codex', lurkMode: null });
    });
    it('shows branch @ sha', async () => {
        const { call } = setup([{ ...live, branch: 'agora/codex/S1', headSha: 'a'.repeat(40) }]);
        expect((await call('session_list', {})).content[0].text).toContain('agora/codex/S1 @ aaaaaaaaaaaa');
    });
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
        expect(api.sendMessage).toHaveBeenCalledWith('ch1', '@Codex review PR 62', expect.any(String), undefined, { requireDirect: true });
    });

    it('says so when there is no live session to wake', async () => {
        const { api, call } = setup([{ ...live, state: 'shelved' }]);
        const out = await call('session_wake', { profile: 'codex', message: 'x' });
        expect(out.content[0].text).toMatch(/No live codex session/);
        expect(api.sendMessage).not.toHaveBeenCalled();
    });
});

describe('callers without can_direct (#75)', () => {
    const refused = () => new AgoraApiError('Agora API 403', 403, 'cannot_direct',
        { error: 'cannot_direct', username: 'Claude', channel: 'general', message: "Claude can't direct agents in #general" });

    it('session_wake fails with a clear message instead of saying it woke the agent', async () => {
        const { api, call } = setup([live]);
        api.sendMessage.mockRejectedValueOnce(refused());
        const err = await call('session_wake', { profile: 'codex', message: 'review' }).catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/^Claude can't direct agents in #general; ask the server owner to grant DirectAgents .* or @ the agent yourself/);
        expect((err as Error).message).not.toMatch(/Woke/);
    });

    it('session_start and session_end explain it the same way', async () => {
        const { api, call } = setup([live]);
        api.agentCommand.mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused());
        for (const tool of ['session_start', 'session_end']) {
            const err = await call(tool, { profile: 'codex' }).catch((e: Error) => e);
            expect((err as Error).message).toMatch(/^Claude can't direct agents in #general/);
        }
    });

    it('passes other errors through unchanged', async () => {
        const { api, call } = setup([live]);
        const other = new AgoraApiError('Agora API 403 POST x: denied', 403, 'Channel access denied', null);
        api.sendMessage.mockRejectedValueOnce(other);
        await expect(call('session_wake', { profile: 'codex', message: 'x' })).rejects.toBe(other);
    });
});

describe('AgoraApi errors', () => {
    it('carry the status and the error code, and send require_direct only when asked', async () => {
        const bodies: any[] = [];
        const fetchMock = vi.fn(async (_url: string, init: any) => {
            bodies.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ error: 'cannot_direct', username: 'Claude' }), { status: 403 });
        });
        vi.stubGlobal('fetch', fetchMock);
        try {
            const api = new AgoraApi('http://agora', 'tok');
            const err = await api.sendMessage('ch1', 'hi', undefined, undefined, { requireDirect: true }).catch(e => e);
            expect(err).toBeInstanceOf(AgoraApiError);
            expect(err).toMatchObject({ status: 403, code: 'cannot_direct' });
            expect(err.message).toMatch(/^Agora API 403 POST \/channels\/ch1\/messages/);
            await api.sendMessage('ch1', 'hi').catch(() => {});
            expect(bodies).toEqual([{ content: 'hi', require_direct: true }, { content: 'hi' }]);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
