import { vi } from 'vitest';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { configureDecisions, jevReply, jsonResponse, stubJev, type JevCall } from '../decision-helpers';
import { internalBus } from '../../src/ai/internal-bus';

/**
 * Assistant intent routing (docs/planning/jev-wbs.md, A.1–A.2): explicit mentions go
 * through the real assistant handler; the decision model and Gemini are stubbed `fetch`.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let botId: string;
let geminiId: string;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(r => setTimeout(r, 30));
    }
    throw new Error('waitFor timed out');
}

const SCRIPT = 'Alex: Here is the overview.\nSam: One open item remains.';
const CHAT_ANSWER = 'Plain written answer.';

function tonePcmBase64(seconds: number, rate = 24000): string {
    const pcm = Buffer.alloc(rate * seconds * 2);
    for (let i = 0; i < rate * seconds; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 330 * i) / rate) * 9000), i * 2);
    return pcm.toString('base64');
}

/** Gemini: a script when asked for one, otherwise a chat answer; PCM audio for speech. */
function gemini(url: string, init?: RequestInit): Response {
    if (url.includes(':streamGenerateContent')) {
        const wantsScript = String(init?.body).includes('Write the script now');
        const event = { candidates: [{ content: { parts: [{ text: wantsScript ? SCRIPT : CHAT_ANSWER }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
        return new Response(`data: ${JSON.stringify(event)}\n\n`);
    }
    return jsonResponse({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: tonePcmBase64(1) } }] } }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 5 },
    });
}

/** Stub both providers; `intent` is what the decision model answers. */
const stub = (intent: (call: JevCall) => unknown) => stubJev(intent, gemini);
const answers = (choice: string, confidence = 0.97) => () => jevReply({ intent: { choice, confidence } });

let seq = 0;
/** Fire a mention the way app.ts does after the request commits. Returns the message id. */
async function mention(text: string, opts: { threadId?: string; messageId?: string; bot?: string } = {}): Promise<string> {
    const content = `<@${opts.bot ?? botId}> ${text}`;
    const messageId = opts.messageId ?? `01RT${(Date.now() + seq++).toString(36).toUpperCase().padStart(22, '0')}`.slice(0, 26);
    await ctx.db.query(
        'INSERT INTO messages (id, channel_id, author_id, content, thread_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
        [messageId, channelId, owner.userId, content, opts.threadId ?? null]
    );
    internalBus.emit('assistantMention', {
        channelId, messageId, content, author: { id: owner.userId, username: 'rtowner' }, botId: opts.bot ?? botId,
        timestamp: new Date().toISOString(), ...(opts.threadId ? { threadId: opts.threadId } : {}),
    });
    return messageId;
}

/** The bot's final reply after `sinceId`: 'chat', 'audio' or 'audio_error'. */
async function handledBy(sinceId: string): Promise<'chat' | 'audio' | 'audio_error'> {
    let content = '';
    await waitFor(async () => {
        const res = await ctx.db.query(
            `SELECT content FROM messages WHERE channel_id = $1 AND author_id = $2 AND id > $3
               AND content <> '...' AND content NOT LIKE '🎙️ Writing%' AND content NOT LIKE '🎙️ Recording%'
             ORDER BY id LIMIT 1`,
            [channelId, botId, sinceId]
        );
        content = res.rows[0]?.content ?? '';
        return !!content;
    });
    if (content === CHAT_ANSWER) return 'chat';
    if (content.startsWith('🎙️ **Audio overview**')) return 'audio';
    if (content.startsWith('⚠️ Couldn\'t make an audio overview')) return 'audio_error';
    throw new Error(`Unexpected bot reply: ${content}`);
}

/** A marker message, so `handledBy` only sees replies made after it. */
async function marker(): Promise<string> {
    const res = await ctx.db.query('SELECT gen_ulid() AS id');
    await new Promise(r => setTimeout(r, 3));
    return res.rows[0].id;
}

const routingRows = async () =>
    (await ctx.db.query("SELECT * FROM ai_usage_events WHERE server_id = $1 AND decision_use = 'routing' ORDER BY id", [serverId])).rows;

const setRouting = (uses: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ctx.request.patch(`/servers/${serverId}/ai/decisions`).set(owner.auth).send({ uses: { routing: uses }, ...extra });

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'rtowner');
    ({ serverId, generalChannelId: channelId } = await createServer(ctx.request, owner.auth, 'Routing Server'));

    const cfg = await ctx.request.put(`/servers/${serverId}/ai-config`).set(owner.auth).send({ provider: 'gemini', model: 'gemini-3.8-flash', apiKey: 'rt-gem-key' });
    expect(cfg.status).toBe(200);
    botId = cfg.body.botId;
    geminiId = cfg.body.providerId;
    await ctx.request.post(`/channels/${channelId}/bots/${botId}`).set(owner.auth);
    const tts = await ctx.request.put(`/servers/${serverId}/ai/routes/tts`).set(owner.auth).send({ providerId: geminiId, model: 'gemini-3.8-flash-tts', enabled: true });
    expect(tts.status).toBe(200);
});

afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => { await ctx.close(); });

describe('no decision model (today\'s behaviour)', () => {
    test('keywords route to the audio overview, everything else to chat, with zero decision calls', async () => {
        const { calls } = stub(answers('chat'));

        let since = await marker();
        await mention('make an audio overview of this channel');
        expect(await handledBy(since)).toBe('audio');

        since = await marker();
        await mention('read me a recap out loud');   // no keyword: chat, as before
        expect(await handledBy(since)).toBe('chat');

        expect(calls).toHaveLength(0);
        expect(await routingRows()).toHaveLength(0);
    });

    test('a decision model that is configured but not switched on for routing is not called either', async () => {
        await configureDecisions(ctx.request, owner.auth, serverId, { settings: { uses: { search_screening: { enabled: true } } } });
        const { calls } = stub(answers('audio_overview'));
        const since = await marker();
        await mention('read me a recap out loud');
        expect(await handledBy(since)).toBe('chat');
        expect(calls).toHaveLength(0);
    });
});

describe('routing switched on', () => {
    beforeAll(async () => {
        expect((await setRouting({ enabled: true })).status).toBe(200);
    });

    test('the model routes a request the keywords would miss, and sees only the bounded request', async () => {
        const { calls } = stub(answers('audio_overview'));
        const since = await marker();
        await mention(`read me a recap out loud ${'x'.repeat(5000)}`);
        expect(await handledBy(since)).toBe('audio');

        expect(calls).toHaveLength(1);
        const { state, questions } = calls[0];
        expect(Object.keys(state)).toEqual(['request']);
        expect(state.request).not.toContain(botId);              // the mention itself is stripped
        expect(state.request.startsWith('read me a recap out loud')).toBe(true);
        expect(state.request.length).toBe(2000);
        expect(questions.intent.type).toBe('choice');
        expect(Object.keys(questions.intent.criteria)).toEqual(['chat', 'audio_overview']);   // only handlers that exist

        const rows = await routingRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].user_id.trim()).toBe(owner.userId);
    });

    test('the model can overrule the keywords', async () => {
        stub(answers('chat'));
        const since = await marker();
        await mention('what is a good bitrate for a podcast?');   // "podcast" is a keyword
        expect(await handledBy(since)).toBe('chat');
    });

    test('low confidence falls back to chat, whatever was chosen', async () => {
        stub(answers('audio_overview', 0.4));
        const since = await marker();
        await mention('recap please');
        expect(await handledBy(since)).toBe('chat');

        // The threshold is a setting
        await setRouting({}, { routingMinConfidence: 0.3 });
        stub(answers('audio_overview', 0.4));
        const again = await marker();
        await mention('recap please');
        expect(await handledBy(again)).toBe('audio');
        await setRouting({}, { routingMinConfidence: 0.6 });
    });

    test('a handler that was not offered cannot be selected', async () => {
        stub(answers('search'));   // not offered: the answer fails validation
        const since = await marker();
        await mention('search the web for gVisor');
        expect(await handledBy(since)).toBe('chat');
        const rows = await routingRows();
        expect(rows.at(-1).error).toContain('not offered');
    });

    test('provider failure, timeout and a spent budget all fall back to the keyword rules', async () => {
        stub(() => jsonResponse({ detail: 'upstream broke' }, 500));
        let since = await marker();
        await mention('make an audio overview please');
        expect(await handledBy(since)).toBe('audio');
        since = await marker();
        await mention('explain deferred constraints');
        expect(await handledBy(since)).toBe('chat');

        await setRouting({ dailyRequests: 1 });   // already used today
        const { calls } = stub(answers('chat'));
        since = await marker();
        await mention('give me a voice summary');
        expect(await handledBy(since)).toBe('audio');
        expect(calls).toHaveLength(0);
        await setRouting({ dailyRequests: null });
    });

    test('with the Speech route off, the audio handler is not offered and no call is made', async () => {
        await ctx.request.put(`/servers/${serverId}/ai/routes/tts`).set(owner.auth).send({ providerId: geminiId, model: 'gemini-3.8-flash-tts', enabled: false });
        const { calls } = stub(answers('audio_overview'));

        let since = await marker();
        await mention('explain deferred constraints');
        expect(await handledBy(since)).toBe('chat');

        // The keyword still reaches the audio handler, which explains what is missing, as before
        since = await marker();
        await mention('make an audio overview');
        expect(await handledBy(since)).toBe('audio_error');

        expect(calls).toHaveLength(0);
        await ctx.request.put(`/servers/${serverId}/ai/routes/tts`).set(owner.auth).send({ providerId: geminiId, model: 'gemini-3.8-flash-tts', enabled: true });
    });
});

describe('what never reaches the decision model', () => {
    test('ordinary messages make zero calls', async () => {
        const { calls } = stub(answers('chat'));
        const before = (await routingRows()).length;
        for (const content of ['just chatting, no mention', 'audio overview is a nice feature', '@someone-else hello']) {
            expect((await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content })).status).toBe(201);
        }
        await new Promise(r => setTimeout(r, 300));
        expect(calls).toHaveLength(0);
        expect((await routingRows()).length).toBe(before);
    });

    test('a real mention through the API makes exactly one call', async () => {
        const { calls } = stub(answers('chat'));
        const since = await marker();
        const bot = await ctx.db.query('SELECT username FROM users WHERE id = $1', [botId]);
        const res = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: `@${bot.rows[0].username} explain RLS` });
        expect(res.status).toBe(201);
        expect(await handledBy(since)).toBe('chat');
        expect(calls).toHaveLength(1);
        expect(calls[0].state.request).toBe('explain RLS');
    });

    test('a duplicate dispatch of the same message is routed once', async () => {
        const { calls } = stub(answers('chat'));
        const since = await marker();
        const messageId = await mention('explain savepoints');
        await mention('explain savepoints', { messageId });
        await mention('explain savepoints', { messageId });
        expect(await handledBy(since)).toBe('chat');
        await new Promise(r => setTimeout(r, 300));
        expect(calls).toHaveLength(1);
        const replies = await ctx.db.query('SELECT COUNT(*)::int AS n FROM messages WHERE channel_id = $1 AND author_id = $2 AND id > $3', [channelId, botId, since]);
        expect(replies.rows[0].n).toBe(1);
    });

    test('a mention in a closed thread, or in a channel the bot cannot access, makes zero calls', async () => {
        const { calls } = stub(answers('chat'));

        const parent = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'thread parent' });
        await ctx.request.post(`/channels/${channelId}/messages/${parent.body.id}/replies`).set(owner.auth).send({ content: 'a reply' });
        expect((await ctx.request.patch(`/channels/${channelId}/messages/${parent.body.id}/thread`).set(owner.auth).send({ closed: true })).status).toBe(200);
        await mention('explain this', { threadId: parent.body.id });

        await ctx.request.delete(`/channels/${channelId}/bots/${botId}`).set(owner.auth);
        await waitFor(async () => (await ctx.db.query('SELECT 1 FROM bot_channel_access WHERE bot_id = $1 AND channel_id = $2', [botId, channelId])).rows.length === 0);
        await mention('explain this too');

        await new Promise(r => setTimeout(r, 300));
        expect(calls).toHaveLength(0);
        await ctx.request.post(`/channels/${channelId}/bots/${botId}`).set(owner.auth);
    });
});
