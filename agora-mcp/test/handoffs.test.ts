import { afterEach, expect, it, vi } from 'vitest';
import { registerTools } from '../src/tools.js';
import { CursorTracker } from '../src/cursor.js';
import { AgoraApi, AgoraApiError } from '../src/api.js';

const T = 'T'.repeat(26), O = 'O'.repeat(26), SHA = 'a'.repeat(40);
const offer = (over: object = {}) => ({ id: O, channelId: 'ch1', threadId: T, messageId: 'M', fromSessionId: 's1', toSessionId: 's2',
    from: 'claude', to: 'codex', summary: 'half done', branch: 'agora/claude/S', headSha: SHA, senderRunning: false,
    reservationIds: ['r1'], transferredIds: [], paths: ['src/upload/'], status: 'pending', reason: null, expiresAt: '2026-10-20T12:30:00.000Z', ...over });

afterEach(() => vi.unstubAllGlobals());
function setup() {
    const api = { getMe: async () => ({ id: 'self', username: 'claude', serverId: 's', bot: true,
        channels: [{ id: 'ch1', name: 'general', channelType: 3 }, { id: 'ch2', name: 'other', channelType: 3 }] }),
        getCursors: async () => [],
        handoffOffer: vi.fn(async () => ({ offer: offer() })),
        handoffAnswer: vi.fn(async (_c: string, _o: string, body: any) => body.action === 'accept'
            ? { offer: offer({ status: 'accepted', transferredIds: ['r1'] }), alreadyAccepted: false, transferred: ['r1'], skipped: ['r2'] }
            : { offer: offer({ status: body.action === 'decline' ? 'declined' : 'cancelled', reason: body.reason ?? null }) }) } as any;
    const handlers = new Map<string, (args: any) => Promise<any>>(), schemas = new Map<string, any>();
    const server = { tool: (name: string, _d: string, schema: unknown, handler: any) => { handlers.set(name, handler); schemas.set(name, schema); } };
    registerTools(server as never, api, new CursorTracker(api), { defaultChannel: 'general' });
    return { api, schemas, call: (tool: string, args: any) => handlers.get(tool)!(args) };
}

it('handoff_offer sends thread, recipient, summary and TTL and reports the pinned branch@sha', async () => {
    const { api, call } = setup();
    const out = await call('handoff_offer', { thread: T, to: 'codex', summary: 'half done', expires_in_seconds: 600 });
    expect(api.handoffOffer).toHaveBeenCalledWith('ch1', { threadId: T, to: 'codex', summary: 'half done', ttlSeconds: 600 });
    const text = out.content[0].text as string;
    expect(text).toContain(`Offer ${O} [pending] claude → codex`);
    expect(text).toContain(`agora/claude/S @ ${SHA}`);
    expect(text).toContain('src/upload/');
    expect(text).toContain('you still own the work');
});

it('says when the pinned commit predates the sender turn in progress', async () => {
    const { api, call } = setup();
    api.handoffOffer.mockResolvedValueOnce({ offer: offer({ senderRunning: true }) });
    expect((await call('handoff_offer', { thread: T, to: 'codex', summary: 'x' })).content[0].text).toContain('turn in progress is not in it');
});

it('accept, decline and cancel map to the offer actions on the chosen channel', async () => {
    const { api, call } = setup();
    const accepted = (await call('handoff_accept', { channel: 'other', offer_id: O })).content[0].text as string;
    expect(api.handoffAnswer).toHaveBeenLastCalledWith('ch2', O, { action: 'accept' });
    expect(accepted).toContain('You now own this. Moved 1 reservation(s) to you. 1 had lapsed');
    await call('handoff_decline', { offer_id: O, reason: 'busy' });
    expect(api.handoffAnswer).toHaveBeenLastCalledWith('ch1', O, { action: 'decline', reason: 'busy' });
    expect((await call('handoff_cancel', { offer_id: O })).content[0].text).toContain('[cancelled]');
    expect(api.handoffAnswer).toHaveBeenLastCalledWith('ch1', O, { action: 'cancel' });
});

it('reports a repeated accept as already owned, and validates inputs', async () => {
    const { api, schemas, call } = setup();
    api.handoffAnswer.mockResolvedValueOnce({ offer: offer({ status: 'accepted' }), alreadyAccepted: true, transferred: [], skipped: [] });
    expect((await call('handoff_accept', { offer_id: O })).content[0].text).toContain('Already accepted');
    expect(schemas.get('handoff_offer').expires_in_seconds.safeParse(30).success).toBe(false);
    expect(schemas.get('handoff_offer').thread.safeParse('short').success).toBe(false);
    expect(schemas.get('handoff_accept').offer_id.safeParse(O).success).toBe(true);
});

it('surfaces server refusals unchanged', async () => {
    const { api, call } = setup();
    const err = new AgoraApiError('plan_owner_only', 403, 'plan_owner_only', { error: 'plan_owner_only' });
    api.handoffOffer.mockRejectedValueOnce(err);
    await expect(call('handoff_offer', { thread: T, to: 'codex', summary: 'x' })).rejects.toBe(err);
});

it('calls the handoff routes with the bot token', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ offer: offer() }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const api = new AgoraApi('http://agora', 'bot_token');
    await api.handoffOffer('ch', { threadId: T, to: 'codex', summary: 's' });
    await api.handoffAnswer('ch', O, { action: 'accept' });
    expect(fetcher.mock.calls[0]).toMatchObject(['http://agora/channels/ch/handoffs', { method: 'POST', body: JSON.stringify({ threadId: T, to: 'codex', summary: 's' }) }]);
    expect(fetcher.mock.calls[1]).toMatchObject([`http://agora/channels/ch/handoffs/${O}`, { method: 'POST', body: JSON.stringify({ action: 'accept' }) }]);
});
