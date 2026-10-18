import { describe, it, expect } from 'vitest';
import { channelTypeName, registerTools } from '../src/tools.js';
import { CursorTracker } from '../src/cursor.js';

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }>;

function channelList(channels: { id: string; name: string; channelType: unknown }[]) {
    const api = {
        getMe: async () => ({ id: 'self', username: 'claude', serverId: 's1', bot: true, channels }),
        getCursors: async () => [],
    } as any;
    const handlers = new Map<string, Handler>();
    const server = { tool: (name: string, ...rest: unknown[]) => handlers.set(name, rest[rest.length - 1] as Handler) };
    registerTools(server as never, api, new CursorTracker(api), { defaultChannel: 'general' });
    return handlers.get('channel_list')!;
}

describe('channel_list (#74)', () => {
    it('lists channels whose channelType is a number (the SMALLINT the API returns)', async () => {
        const out = (await channelList([
            { id: 'ch1', name: 'general', channelType: 3 },
            { id: 'ch2', name: 'Lounge', channelType: 4 },
            { id: 'ch3', name: 'Projects', channelType: 5 },
        ])({}, {})).content[0].text;
        expect(out).toBe('Channels:\n#general (text, id: ch1)\n#Lounge (voice, id: ch2)\n#Projects (category, id: ch3)');
    });

    it('names unknown types without throwing', () => {
        expect(channelTypeName(9)).toBe('type 9');
        expect(channelTypeName('3')).toBe('text');
        expect(channelTypeName(undefined)).toBe('type undefined');
    });
});
