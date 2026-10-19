import { AgentPresence } from '../../src/lib/agent-presence';

const BOT = 'B'.repeat(26);
const C1 = '1'.repeat(26);
const C2 = '2'.repeat(26);

describe('bring-your-own-session presence', () => {
    it('a channel socket is listening while connected', () => {
        const p = new AgentPresence();
        expect(p.connect(BOT, 'claude', 's1', 'channel', [C1, C2])).toEqual([
            { userId: BOT, username: 'claude', channelId: C1, status: 'listening', mode: 'channel' },
            { userId: BOT, username: 'claude', channelId: C2, status: 'listening', mode: 'channel' },
        ]);
        expect(p.setListening(BOT, 's1', false)).toEqual([]);
        expect(p.disconnect(BOT, 's1').map(e => e.status)).toEqual(['offline', 'offline']);
        expect(p.status(BOT)).toEqual({ status: 'offline', mode: null });
    });

    it('an mcp socket is connected, and listening only during a wait', () => {
        const p = new AgentPresence();
        expect(p.connect(BOT, 'codex', 's1', 'mcp', [C1])[0]).toMatchObject({ status: 'connected', mode: 'mcp' });
        expect(p.setListening(BOT, 's1', true)[0]).toMatchObject({ status: 'listening' });
        expect(p.setListening(BOT, 's1', true)).toEqual([]);
        expect(p.setListening(BOT, 's1', false)[0]).toMatchObject({ status: 'connected' });
    });

    it('reports only changes when the same bot has several sockets', () => {
        const p = new AgentPresence();
        p.connect(BOT, 'claude', 's1', 'mcp', [C1]);
        expect(p.connect(BOT, 'claude', 's2', 'mcp', [C1])).toEqual([]);
        expect(p.disconnect(BOT, 's1')).toEqual([]);
        expect(p.disconnect(BOT, 's2')[0]).toMatchObject({ status: 'offline' });
        expect(p.disconnect(BOT, 's2')).toEqual([]);
    });

    it('lists connected agents in the channels a person can see', () => {
        const p = new AgentPresence();
        p.connect(BOT, 'claude', 's1', 'channel', [C1, C2]);
        expect(p.inChannels([C2, 'other'])).toEqual([{ userId: BOT, username: 'claude', channelId: C2, status: 'listening', mode: 'channel' }]);
        expect(p.inChannels([])).toEqual([]);
    });
});
