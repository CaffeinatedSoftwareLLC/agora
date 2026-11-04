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

    it('on first use, skips what it answered (before its last post here) and what is older than 24 h', async () => {
        const fresh = await channel('fresh');
        const bot = await makeBot('RetGemini', [fresh]);
        expect((await ctx.request.post(`/channels/${fresh}/bots/${claude.id}`).set(owner.auth)).status).toBe(201);
        const ancient = await post(owner.auth, fresh, '@RetGemini an old request');
        await ctx.db.query("UPDATE messages SET created_at = NOW() - INTERVAL '25 hours' WHERE id = $1", [ancient.id]);
        const answeredThread = await post(owner.auth, fresh, 'Earlier job');
        const answered = await post(claude.auth, fresh, turn('RetGemini'), answeredThread.id);
        await post(bot.auth, fresh, 'Done with the earlier job.', answeredThread.id);
        const pendingThread = await post(owner.auth, fresh, 'New job');
        const pending = await post(claude.auth, fresh, turn('RetGemini'), pendingThread.id);
        const mention = await post(owner.auth, fresh, '@RetGemini and this one, please', pendingThread.id);

        // The first attention read starts after the bot's own last post, within 24 h
        const feed = await ctx.request.get(`/channels/${fresh}/attention`).set(bot.auth);
        expect(feed.body.map((m: { id: string }) => m.id)).toEqual([pending.id, mention.id]);
        expect(feed.body.map((m: { id: string }) => m.id)).not.toContain(answered.id);
        expect(feed.body.map((m: { id: string }) => m.id)).not.toContain(ancient.id);
        // and chat_wait hands both to the agent
        const out = await session(bot.token)('chat_wait', { channel: 'fresh', timeout: 2 });
        expect(out).toContain(pending.id);
        expect(out).toContain(mention.id);
    });

    it('says that what arrived while it was away is still its to answer', async () => {
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
