import { afterEach, expect, it, vi } from 'vitest';
import { registerTools } from '../src/tools.js';
import { CursorTracker } from '../src/cursor.js';
import { AgoraApi, AgoraApiError } from '../src/api.js';

afterEach(() => vi.unstubAllGlobals());
function setup() {
    const api = { getMe: async () => ({ id: 'self', username: 'agent', serverId: 's', bot: true,
        channels: [{ id: 'ch1', name: 'general', channelType: 3 }, { id: 'ch2', name: 'other', channelType: 3 }] }),
        getCursors: async () => [], fileReservation: vi.fn(async () => ({ reservation: { id: 'r1', paths: ['src/'] } })),
        fileReservations: vi.fn(async () => ({ reservations: [{ id: 'r1', holder: 'agent', sessionId: 's1' }] })) } as any;
    const handlers = new Map<string, (args: any) => Promise<any>>(), schemas = new Map<string, any>();
    const server = { tool: (name: string, _description: string, schema: unknown, handler: any) => { handlers.set(name, handler); schemas.set(name, schema); } };
    registerTools(server as never, api, new CursorTracker(api), { defaultChannel: 'general' });
    return { api, schemas, call: (tool: string, args: any) => handlers.get(tool)!(args) };
}
it('maps all four tools to the selected/default channel and preserves IDs, prefixes, TTL and force', async () => {
    const { api, call } = setup();
    const out = await call('file_reserve', { paths: ['SRC\\'], ttl_seconds: 120, reason: 'fix', thread: 't1' });
    expect(api.fileReservation).toHaveBeenLastCalledWith('ch1', { action: 'reserve', paths: ['SRC\\'], ttlSeconds: 120, reason: 'fix', threadId: 't1' });
    expect(out.content[0].text).toContain('r1');
    await call('file_renew', { channel: 'other', reservation_id: 'r1' });
    expect(api.fileReservation).toHaveBeenLastCalledWith('ch2', { action: 'renew', reservationId: 'r1', ttlSeconds: undefined });
    await call('file_release', { reservation_id: 'r1', force: true });
    expect(api.fileReservation).toHaveBeenLastCalledWith('ch1', { action: 'release', reservationId: 'r1', force: true });
    await call('file_release', {});
    expect(api.fileReservation).toHaveBeenLastCalledWith('ch1', { action: 'release', reservationId: undefined, force: undefined });
    expect((await call('file_reservations', {})).content[0].text).toContain('s1');
    expect(api.fileReservations).toHaveBeenCalledWith('ch1');
});
it('validates bounded TTLs and keeps conflict holder information actionable', async () => {
    const { api, schemas, call } = setup();
    expect(schemas.get('file_reserve').ttl_seconds.safeParse(3601).success).toBe(false);
    expect(schemas.get('file_renew').ttl_seconds.safeParse(0).success).toBe(false);
    const conflict = new AgoraApiError('reservation_conflict holder: other-agent session S2', 409, 'reservation_conflict', { holder: { sessionId: 'S2' } });
    api.fileReservation.mockRejectedValueOnce(conflict);
    await expect(call('file_reserve', { paths: ['src/'] })).rejects.toBe(conflict);
});
it('sends authenticated API calls and retains structured conflict details', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ reservations: [] }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const api = new AgoraApi('http://agora', 'bot_token');
    await api.fileReservation('ch', { action: 'reserve', paths: ['src/'], ttlSeconds: 900 });
    await api.fileReservations('ch');
    expect(fetcher.mock.calls[0]).toMatchObject(['http://agora/channels/ch/file-reservations', { method: 'POST', body: JSON.stringify({ action: 'reserve', paths: ['src/'], ttlSeconds: 900 }) }]);
    expect(fetcher.mock.calls[1]).toMatchObject(['http://agora/channels/ch/file-reservations', { method: 'GET' }]);
});
