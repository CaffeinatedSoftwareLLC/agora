import { vi } from 'vitest';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { internalBus } from '../../src/ai/internal-bus';

/**
 * WBS 5.1: "@assistant make an audio overview of this thread" through the real
 * assistant handler, routing, Gemini adapter (fetch mocked), MP3 encoding, and
 * file storage.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let botId: string;
let providerId: string;
const emitted: { room: string; event: string; data: any }[] = [];

async function waitFor(check: () => Promise<boolean>, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('waitFor timed out');
}

function tonePcmBase64(seconds: number, rate = 24000): string {
    const pcm = Buffer.alloc(rate * seconds * 2);
    for (let i = 0; i < rate * seconds; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 330 * i) / rate) * 9000), i * 2);
    return pcm.toString('base64');
}

const SCRIPT = [
    'Alex: Welcome to the overview of the release thread.',
    'Sam: The team agreed to ship on Friday if QA signs off.',
    'Alex: Ben still owes the migration notes.',
    'Sam: That is the one open item.',
].join('\n');

/** Gemini: streamGenerateContent → script; generateContent → PCM audio. */
function mockGemini(opts: { script?: string } = {}) {
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) => {
        if (String(url).includes(':streamGenerateContent')) {
            const events = [
                { candidates: [{ content: { parts: [{ text: opts.script ?? SCRIPT }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 60 } },
            ];
            return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
        }
        return new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: tonePcmBase64(2) } }] } }],
            usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 50 },
        }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

async function newThread(): Promise<string> {
    const parent = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'Release plan: ship Friday?' });
    const threadId = parent.body.id;
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM messages WHERE id = $1', [threadId])).rows.length > 0);
    const reply = await ctx.request.post(`/channels/${channelId}/messages/${threadId}/replies`).set(owner.auth).send({ content: 'Only if QA signs off. Ben owes migration notes.' });
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM messages WHERE id = $1', [reply.body.id])).rows.length > 0);
    return threadId;
}

/** Fire the mention the way app.ts does after the request commits. */
async function askForOverview(threadId: string | undefined, content = `<@${botId}> make an audio overview of this thread`) {
    const messageId = `01TEST${Date.now().toString(36).toUpperCase().padEnd(20, '0')}`.slice(0, 26);
    await ctx.db.query('INSERT INTO messages (id, channel_id, author_id, content, thread_id) VALUES ($1, $2, $3, $4, $5)', [messageId, channelId, owner.userId, content, threadId ?? null]);
    internalBus.emit('assistantMention', {
        channelId, messageId, content, author: { id: owner.userId, username: 'aoowner' }, botId,
        timestamp: new Date().toISOString(), ...(threadId ? { threadId } : {}),
    });
}

/** The bot's reply in the thread once it is final (not a progress status). */
async function finalReply(threadId: string): Promise<{ id: string; content: string }> {
    let row: any;
    await waitFor(async () => {
        const res = await ctx.db.query(
            "SELECT id, content FROM messages WHERE thread_id = $1 AND author_id = $2 AND content NOT LIKE '🎙️ Writing%' AND content NOT LIKE '🎙️ Recording%'",
            [threadId, botId]
        );
        row = res.rows[0];
        return !!row;
    });
    return { id: row.id.trim(), content: row.content };
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'aoowner');
    ({ serverId, generalChannelId: channelId } = await createServer(ctx.request, owner.auth, 'Overview Server'));

    const cfg = await ctx.request.put(`/servers/${serverId}/ai-config`).set(owner.auth).send({ provider: 'gemini', model: 'gemini-3.8-flash', apiKey: 'ao-gem-key' });
    expect(cfg.status).toBe(200);
    botId = cfg.body.botId;
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM ai_provider_config WHERE bot_id = $1', [botId])).rows.length > 0);
    await ctx.request.post(`/channels/${channelId}/bots/${botId}`).set(owner.auth);
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM bot_channel_access WHERE bot_id = $1', [botId])).rows.length > 0);
    providerId = (await ctx.db.query("SELECT id FROM ai_providers WHERE server_id = $1 AND adapter = 'gemini'", [serverId])).rows[0].id.trim();

    const io = (ctx.app as any).io;
    const originalTo = io.to.bind(io);
    vi.spyOn(io, 'to').mockImplementation(((room: string) => {
        const target = originalTo(room);
        return { emit: (event: string, data: any) => { emitted.push({ room, event, data }); return target.emit(event, data); } };
    }) as any);
});

afterAll(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await ctx.close();
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('audio overview', () => {
    test('without a Speech route it explains what is missing', async () => {
        mockGemini();
        const threadId = await newThread();
        await askForOverview(threadId);
        const reply = await finalReply(threadId);
        expect(reply.content).toBe('⚠️ Couldn\'t make an audio overview: Audio overviews need a Speech route. No provider is configured for "tts".');
    });

    test('writes a two-host script, voices it, and posts an MP3 with the transcript', async () => {
        const route = await ctx.request.put(`/servers/${serverId}/ai/routes/tts`).set(owner.auth).send({ providerId, model: 'gemini-3.8-flash-tts', enabled: true });
        expect(route.status).toBe(200);
        await waitFor(async () => (await ctx.db.query("SELECT 1 FROM ai_capability_routes WHERE server_id = $1 AND capability = 'tts'", [serverId])).rows.length > 0);

        const fetchMock = mockGemini();
        const threadId = await newThread();
        emitted.length = 0;
        await askForOverview(threadId);
        const reply = await finalReply(threadId);

        expect(reply.content).toBe([
            '🎙️ **Audio overview** of this thread (0:02), voiced by AI.',
            '**Alex:** Welcome to the overview of the release thread.',
            '**Sam:** The team agreed to ship on Friday if QA signs off.',
            '**Alex:** Ben still owes the migration notes.',
            '**Sam:** That is the one open item.',
        ].join('\n\n'));

        // The script prompt carried the thread; the speech call used two voices
        const [chatCall, ttsCall] = fetchMock.mock.calls as unknown as [string, RequestInit][];
        expect(chatCall[0]).toContain('/models/gemini-3.8-flash:streamGenerateContent');
        const chatBody = JSON.parse(chatCall[1].body as string);
        expect(chatBody.contents[0].parts[0].text).toContain('aoowner: Release plan: ship Friday?');
        expect(chatBody.contents[0].parts[0].text).toContain('Ben owes migration notes');
        expect(chatBody.systemInstruction.parts[0].text).toContain('Alex and Sam');
        expect(ttsCall[0]).toContain('/models/gemini-3.8-flash-tts:generateContent');
        const ttsBody = JSON.parse(ttsCall[1].body as string);
        // #33: one part per line, each tagged with its speaker, and no untagged preamble
        expect(ttsBody.contents).toEqual([{
            role: 'user',
            parts: [
                { text: 'Welcome to the overview of the release thread.', speechMetadata: { speaker: 'Alex' } },
                { text: 'The team agreed to ship on Friday if QA signs off.', speechMetadata: { speaker: 'Sam' } },
                { text: 'Ben still owes the migration notes.', speechMetadata: { speaker: 'Alex' } },
                { text: 'That is the one open item.', speechMetadata: { speaker: 'Sam' } },
            ],
        }]);
        expect(ttsBody.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs).toEqual([
            { speaker: 'Alex', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
            { speaker: 'Sam', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        ]);

        // MP3 stored and attached to the reply
        const file = (await ctx.db.query('SELECT id, filename, mime_type, size_bytes FROM files WHERE message_id = $1', [reply.id])).rows[0];
        expect(file.filename).toMatch(/^audio-overview-\d{4}-\d{2}-\d{2}\.mp3$/);
        expect(file.mime_type).toBe('audio/mpeg');
        expect(Number(file.size_bytes)).toBeGreaterThan(10_000);

        // Clients got progress, then the final text with the attachment
        const stream = emitted.filter(e => e.event === 'BotMessageStream' && e.data.messageId === reply.id);
        expect(stream.map(e => e.data.streaming)).toEqual([true, false]);
        expect(stream[0].data.content).toBe('🎙️ Recording the audio overview…');
        expect(stream[1].data.content).toBe(reply.content);
        expect(stream[1].data.threadId).toBe(threadId);
        expect(stream[1].data.attachments).toEqual([expect.objectContaining({ id: file.id.trim(), mime: 'audio/mpeg', name: file.filename })]);

        // Usage for both steps
        const usage = await ctx.db.query('SELECT capability, input_tokens, output_tokens, error FROM ai_usage_events WHERE server_id = $1 ORDER BY created_at', [serverId]);
        expect(usage.rows.slice(-2)).toEqual([
            { capability: 'chat', input_tokens: 120, output_tokens: 60, error: null },
            { capability: 'tts', input_tokens: 80, output_tokens: 50, error: null },
        ]);
    });

    test('a reply without host lines is reported, and nothing is recorded', async () => {
        const fetchMock = mockGemini({ script: 'Sorry, I can only write summaries in prose.' });
        const threadId = await newThread();
        await askForOverview(threadId);
        const reply = await finalReply(threadId);
        expect(reply.content).toBe('⚠️ Couldn\'t make an audio overview: The chat model did not return a usable two-host script');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('an ordinary mention still gets a normal chat reply', async () => {
        const fetchMock = mockGemini({ script: 'Friday, pending QA.' });
        const threadId = await newThread();
        await askForOverview(threadId, `<@${botId}> when do we ship?`);
        const reply = await finalReply(threadId);
        expect(reply.content).toBe('Friday, pending QA.');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
