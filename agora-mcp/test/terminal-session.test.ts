import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ioMock = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), emit: vi.fn(), disconnect: vi.fn() })));
vi.mock('socket.io-client', () => ({ io: ioMock }));

import { ActivityReporter, connectSocket } from '../src/socket.js';
import { registerTools, withActivity } from '../src/tools.js';
import { CursorTracker } from '../src/cursor.js';
import type { AgoraApi } from '../src/api.js';

/**
 * Terminal sessions (#112): agora-mcp's presence socket makes Agora attach a terminal
 * session, and tool calls report working/idle with a tool-call count.
 */

function fakeSocket() {
    const handlers = new Map<string, (...args: any[]) => void>();
    const emitted: [string, any][] = [];
    return {
        handlers, emitted,
        on: (event: string, h: (...args: any[]) => void) => { handlers.set(event, h); },
        emit: (event: string, data: any) => { emitted.push([event, data]); },
        disconnect: () => {},
    };
}

describe('presence socket → terminal session', () => {
    it('connects as a bot with its mode, which is what makes Agora attach a terminal session', () => {
        connectSocket('http://agora.test', 'bot-token', 'mcp');
        expect(ioMock).toHaveBeenCalledWith('http://agora.test', expect.objectContaining({
            transports: ['websocket'], auth: { type: 'bot', token: 'bot-token', mode: 'mcp' },
        }));
    });

    it('remembers the sessions Agora attached, and repeats its state to a fresh one', () => {
        const socket = fakeSocket();
        const reporter = new ActivityReporter();
        reporter.attach(socket);
        socket.handlers.get('TerminalSession')!({ sessions: [{ channelId: 'ch1', sessionId: 's1' }] });
        expect(reporter.sessions).toEqual([{ channelId: 'ch1', sessionId: 's1' }]);
        expect(socket.emitted).toEqual([]);

        reporter.toolStart('chat_read');
        socket.handlers.get('TerminalSession')!({ sessions: [{ channelId: 'ch1', sessionId: 's2' }] });
        expect(socket.emitted.at(-1)).toEqual(['Activity', { working: true, toolCalls: 1 }]);
        expect(reporter.sessions[0].sessionId).toBe('s2');
    });
});

describe('working / idle reporting', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('a tool call is working; idle after idleMs without one', async () => {
        const socket = fakeSocket();
        const reporter = new ActivityReporter({ idleMs: 1000 });
        reporter.attach(socket);
        reporter.toolStart('chat_send');
        expect(socket.emitted).toEqual([['Activity', { working: true, toolCalls: 1 }]]);
        reporter.toolEnd('chat_send');
        await vi.advanceTimersByTimeAsync(999);
        expect(reporter.state.working).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(socket.emitted.at(-1)).toEqual(['Activity', { working: false, toolCalls: 1 }]);
    });

    it('chat_wait is listening, not work: idle at once and not counted', () => {
        const socket = fakeSocket();
        const reporter = new ActivityReporter({ idleMs: 60_000 });
        reporter.attach(socket);
        reporter.toolStart('file_read');
        reporter.toolEnd('file_read');
        reporter.toolStart('chat_wait');
        expect(socket.emitted).toEqual([
            ['Activity', { working: true, toolCalls: 1 }],
            ['Activity', { working: false, toolCalls: 1 }],
        ]);
        reporter.toolEnd('chat_wait');
        expect(reporter.state).toEqual({ working: false, toolCalls: 1 });
    });

    it('stays working while calls overlap, and throttles count updates', () => {
        let now = 0;
        const socket = fakeSocket();
        const reporter = new ActivityReporter({ idleMs: 1000, now: () => now, minIntervalMs: 5000 });
        reporter.attach(socket);
        reporter.toolStart('a'); reporter.toolStart('b');
        reporter.toolEnd('a');
        expect(socket.emitted).toHaveLength(1);
        now = 6000;
        reporter.toolStart('c');
        expect(socket.emitted.at(-1)).toEqual(['Activity', { working: true, toolCalls: 3 }]);
    });

    it('registered tools report their calls through withActivity', async () => {
        const calls: string[] = [];
        const handlers = new Map<string, (...a: any[]) => Promise<any>>();
        const server = { tool: (name: string, ...rest: unknown[]) => { handlers.set(name, rest[rest.length - 1] as any); } };
        const api = {
            getMe: vi.fn().mockResolvedValue({ id: 'self', username: 'claude', serverId: 's1', bot: true, channels: [{ id: 'ch1', name: 'general', channelType: 'text' }] }),
            getChannelReservations: vi.fn().mockResolvedValue({ reservations: [] }),
        } as unknown as AgoraApi;
        registerTools(server as never, api, new CursorTracker(api), {
            defaultChannel: 'general',
            activity: { toolStart: n => calls.push(`start:${n}`), toolEnd: n => calls.push(`end:${n}`) },
        });
        await handlers.get('channel_list')!({}, {}).catch(() => {});
        expect(calls).toEqual(['start:channel_list', 'end:channel_list']);

        // withActivity keeps the original server's `this`
        const target = { tools: [] as string[], tool(this: any, name: string) { this.tools.push(name); } };
        withActivity(target as never, { toolStart() {}, toolEnd() {} }).tool('x' as never, (async () => ({})) as never);
        expect(target.tools).toEqual(['x']);
    });
});
