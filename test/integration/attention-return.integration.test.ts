import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { AgoraApi } from '../../agora-mcp/src/api';
import { CursorTracker } from '../../agora-mcp/src/cursor';
import { registerTools } from '../../agora-mcp/src/tools';

/**
 * An agent that stops and comes back later must still get what was addressed to it while it
 * was away: a YIELD or an @mention it hasn't answered. Each `session()` is a fresh agora-mcp
 * (new CursorTracker), as after a restart; the server keeps the bot's cursors.
 */

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }>;

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let baseUrl: string;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;

async function channel(name: string): Promise<string> {
    const res = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name, channelType: 3 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id;
}

async function makeBot(username: string, channels: string[]) {
    const created = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username });
    expect(created.status).toBe(201);
    const token = await ctx.request.post(`/servers/${serverId}/bots/${created.body.id}/tokens`).set(owner.auth).send({});
    for (const ch of channels) expect((await ctx.request.post(`/channels/${ch}/bots/${created.body.id}`).set(owner.auth)).status).toBe(201);
    return { id: created.body.id as string, token: token.body.token as string, auth: { Authorization: `Bot ${token.body.token}` } };
}

/** A fresh agora-mcp for this bot: the real tools, a new cursor tracker. */
function session(token: string) {
    const api = new AgoraApi(baseUrl, token);
    const handlers = new Map<string, Handler>();
    const server = { tool: (name: string, ...rest: unknown[]) => handlers.set(name, rest[rest.length - 1] as Handler) };
    registerTools(server as never, api, new CursorTracker(api), { defaultChannel: 'general' });
    const signal = new AbortController().signal;
    return async (name: string, args: Record<string, unknown> = {}) =>
        (await handlers.get(name)!(args, { signal, sendNotification: async () => {}, _meta: {} })).content[0].text;
}

let general: string, other: string;
let codex: Awaited<ReturnType<typeof makeBot>>, claude: Awaited<ReturnType<typeof makeBot>>;

beforeAll(async () => {
    ctx = await setupTestApp(); await cleanDatabase(ctx.db);
    await new Promise<void>(resolve => ctx.app.server.listen(0, '127.0.0.1', () => resolve()));
    const addr = ctx.app.server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    owner = await authedUser(ctx.request, 'returnowner');
    ({ serverId, generalChannelId: general } = await createServer(ctx.request, owner.auth, 'Return'));
    other = await channel('other');
    codex = await makeBot('RetCodex', [general, other]);
    claude = await makeBot('RetClaude', [general, other]);
});
afterAll(async () => { await ctx.close(); });

const post = async (auth: Record<string, string>, ch: string, content: string, thread?: string) => {
    const res = await ctx.request.post(thread ? `/channels/${ch}/messages/${thread}/replies` : `/channels/${ch}/messages`).set(auth).send({ content });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
};
const turn = (to: string) => `[AGORA/v1 MODE=fix STATE=TURN]\nYour turn: review the relay commit.\n[YIELD to=${to}]`;

describe('an agent that comes back', () => {
    it('gets a YIELD sent while it was away, after waiting in that channel before', async () => {
        const first = session(codex.token);
        expect(await first('chat_wait', { channel: 'general', timeout: 1 })).toMatch(/no new messages/);
        // Codex stops. Claude starts a thread and hands it to Codex.
        const thread = await post(claude.auth, general, 'Relay on Heroku');
        const y = await post(claude.auth, general, turn('RetCodex'), thread.id);
        const back = session(codex.token);
        const out = await back('chat_wait', { channel: 'general', timeout: 2 });
        expect(out).toContain(y.id);
    });

    it('gets a YIELD sent in a channel it had never waited in', async () => {
        const thread = await post(claude.auth, other, 'Relay on Heroku');
        const y = await post(claude.auth, other, turn('RetCodex'), thread.id);
        const back = session(codex.token);
        const out = await back('chat_wait', { channel: 'other', timeout: 2 });
        expect(out).toContain(y.id);
    });

    /** A channel the bot has access to but never waited in, with Claude in it too. */
    async function freshChannel(botName: string) {
        const fresh = await channel(`fresh-${botName.toLowerCase()}`);
        const bot = await makeBot(botName, [fresh]);
        expect((await ctx.request.post(`/channels/${fresh}/bots/${claude.id}`).set(owner.auth)).status).toBe(201);
        const feed = async () => ((await ctx.request.get(`/channels/${fresh}/attention`).set(bot.auth)).body as { id: string }[]).map(m => m.id);
        return { fresh, bot, feed };
    }

    it('on first use, delivers a YIELD from up to 24 h back even if the bot posted in another thread since', async () => {
        const { fresh, bot, feed } = await freshChannel('RetGemini');
        const ancient = await post(owner.auth, fresh, '@RetGemini an old request');
        await ctx.db.query("UPDATE messages SET created_at = NOW() - INTERVAL '25 hours' WHERE id = $1", [ancient.id]);
        const a = await post(owner.auth, fresh, 'Job A');
        const pending = await post(claude.auth, fresh, turn('RetGemini'), a.id);
        // The bot posts a status in thread B without ever reading attention: not an acknowledgement of A
        const b = await post(owner.auth, fresh, 'Job B');
        await post(bot.auth, fresh, 'Status on B: still building.', b.id);
        const mention = await post(owner.auth, fresh, '@RetGemini and this one, please', a.id);

        expect(await feed()).toEqual([pending.id, mention.id]);
        const out = await session(bot.token)('chat_wait', { channel: fresh, timeout: 2 });
        expect(out).toContain(pending.id);
        expect(out).toContain(mention.id);
    });

    it('judges age per message: an imported row with a new id and an old date neither arrives nor hides a newer YIELD', async () => {
        const { fresh, bot, feed } = await freshChannel('RetMistral');
        const a = await post(owner.auth, fresh, 'Job A');
        const pending = await post(claude.auth, fresh, turn('RetMistral'), a.id);
        const imported = await post(owner.auth, fresh, '@RetMistral imported from the old instance');
        await ctx.db.query("UPDATE messages SET created_at = NOW() - INTERVAL '25 hours' WHERE id = $1", [imported.id]);
        expect(await feed()).toEqual([pending.id]);
    });

    it('keeps old pending attention across pages: acknowledging page one never hides page two', async () => {
        const { fresh, bot, feed } = await freshChannel('RetLlama');
        expect(await feed()).toEqual([]);
        // The cursor was made ten days ago; 110 mentions came in over the days the agent was away
        await ctx.db.query(`UPDATE bot_attention_cursors SET replay_from = NOW() - INTERVAL '11 days', updated_at = NOW() - INTERVAL '10 days'
            WHERE bot_id = $1 AND channel_id = $2`, [bot.id, fresh]);
        const ids: string[] = [];
        for (let i = 0; i < 110; i++) ids.push((await post(owner.auth, fresh, `@RetLlama job ${i}`)).id);
        await ctx.db.query("UPDATE messages SET created_at = NOW() - INTERVAL '9 days' WHERE id = ANY($1)", [ids]);

        const page = async () => ((await ctx.request.get(`/channels/${fresh}/attention?limit=100`).set(bot.auth)).body as { id: string }[]).map(m => m.id);
        const one = await page();
        expect(one).toEqual(ids.slice(0, 100));
        expect((await ctx.request.put(`/bots/@me/attention-cursors/${fresh}`).set(bot.auth).send({ lastReadId: one[99] })).status).toBe(200);
        expect(await page()).toEqual(ids.slice(100));
    });

    it('an explicit first-use after replays older than 24 h, and keeps doing so until acknowledged', async () => {
        const { fresh, bot } = await freshChannel('RetPhi');
        const old = await post(owner.auth, fresh, '@RetPhi from three days ago');
        await ctx.db.query("UPDATE messages SET created_at = NOW() - INTERVAL '3 days' WHERE id = $1", [old.id]);
        const read = async (q = '') => ((await ctx.request.get(`/channels/${fresh}/attention${q}`).set(bot.auth)).body as { id: string }[]).map(m => m.id);
        expect(await read('?after=00000000000000000000000000')).toEqual([old.id]);
        expect(await read()).toEqual([old.id]);
    });

    it('says that what arrived while it was away is a notification to check, not to skip', async () => {
        const first = session(codex.token);
        await first('chat_wait', { channel: 'general', timeout: 1 });
        const thread = await post(claude.auth, general, 'Relay on Heroku');
        const y = await post(claude.auth, general, turn('RetCodex'), thread.id);
        await ctx.db.query("UPDATE messages SET created_at = NOW() - INTERVAL '40 minutes' WHERE id = $1", [y.id]);
        const out = await session(codex.token)('chat_wait', { channel: 'general', timeout: 2 });
        expect(out).toContain(y.id);
        expect(out).toMatch(/addressed to you while you were away \(the oldest 40 min ago\)/);
    });

    it('gets an @mention sent while it was away, after reading the channel first', async () => {
        const first = session(codex.token);
        await first('chat_wait', { channel: 'general', timeout: 1 });
        const m = await post(owner.auth, general, '@RetCodex please pick up the relay review');
        const back = session(codex.token);
        const read = await back('chat_read', { channel: 'general' });
        const out = await back('chat_wait', { channel: 'general', timeout: 2 });
        expect(read + out).toContain(m.id);
    });
});
