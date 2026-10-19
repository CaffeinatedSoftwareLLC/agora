import { vi } from 'vitest';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { pcmToWav } from '../../src/ai/adapters/audio';
import { clearSpeechCache } from '../../src/ai/voice';

/**
 * Voice in and out (cloud handoff C4): admin settings, the engines a member's client
 * is told to use, push-to-talk transcription through the `stt` route, and messages
 * read aloud through the `tts` route. Provider calls are mocked fetches against the
 * OpenAI Audio API shape (what Kokoro-FastAPI and speaches serve locally).
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let outsider: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let providerId: string;

const TONE_WAV = (() => {
    const rate = 24000;
    const pcm = Buffer.alloc(rate * 2 / 4); // 0.25 s
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 8000), i * 2);
    return pcmToWav(pcm, rate);
})();

/** /audio/transcriptions → `text`; /audio/speech → a short WAV. */
function mockAudioApi(opts: { text?: string; fail?: boolean } = {}) {
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) => {
        if (opts.fail) return new Response(JSON.stringify({ error: { message: 'model is loading' } }), { status: 503 });
        if (String(url).endsWith('/audio/transcriptions')) {
            return new Response(JSON.stringify({ text: opts.text ?? 'please rerun the failing test' }), { headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(new Uint8Array(TONE_WAV), { headers: { 'Content-Type': 'audio/wav' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const voiceUrl = `/servers/:serverId/ai/voice`;
const adminVoice = () => voiceUrl.replace(':serverId', serverId);

async function putRoute(capability: 'stt' | 'tts', extra: Record<string, unknown> = {}) {
    const model = capability === 'stt' ? 'Systran/faster-whisper-small' : 'kokoro';
    const res = await ctx.request.put(`/servers/${serverId}/ai/routes/${capability}`).set(owner.auth)
        .send({ providerId, model, enabled: true, ...extra });
    expect(res.status).toBe(200);
}

async function post(content: string, auth = owner.auth): Promise<string> {
    const res = await ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content });
    expect(res.status).toBe(201);
    return res.body.id;
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'voiceowner');
    member = await authedUser(ctx.request, 'voicemember');
    outsider = await authedUser(ctx.request, 'voiceoutsider');
    const server = await createServer(ctx.request, owner.auth, 'Voice Server');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    const provider = await ctx.request.post(`/servers/${serverId}/ai/providers`).set(owner.auth)
        .send({ adapter: 'openai', label: 'Audio API', apiKey: 'sk-test' });
    expect(provider.status).toBe(201);
    providerId = provider.body.id;
});

afterEach(() => {
    vi.unstubAllGlobals();
    clearSpeechCache();
});

afterAll(async () => {
    await ctx.close();
});

describe('admin voice settings', () => {
    it('starts at the defaults: browser voices out, no voice input without a transcription route', async () => {
        const res = await ctx.request.get(adminVoice()).set(owner.auth);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            voiceInputEnabled: true, browserSttFallback: false, maxRecordingSeconds: 120, sttLanguage: null,
            readAloudEnabled: true, readAloudServer: false, browserTtsFallback: true, readAloudVoice: null, readAloudMaxChars: 1500,
            routes: { stt: { configured: false, enabled: false }, tts: { configured: false, enabled: false } },
            engines: { input: 'off', output: 'browser' },
        });
        expect(res.body.warnings).toEqual([expect.stringContaining('no microphone button')]);
    });

    it('is for administrators only', async () => {
        expect((await ctx.request.get(adminVoice()).set(member.auth)).status).toBe(403);
        expect((await ctx.request.patch(adminVoice()).set(member.auth).send({ readAloudServer: true })).status).toBe(403);
        expect((await ctx.request.get(adminVoice()).set(outsider.auth)).status).toBe(403);
    });

    it('validates values', async () => {
        for (const body of [{}, { sttLanguage: 'English' }, { readAloudVoice: 'a voice; drop' }, { maxRecordingSeconds: 2 }, { readAloudMaxChars: 50 }, { readAloudMaxChars: 5000 }, { nope: true }]) {
            const res = await ctx.request.patch(adminVoice()).set(owner.auth).send(body);
            expect(res.status, JSON.stringify(body)).toBe(400);
        }
    });

    it('saves a subset, reports the engines and records the change in the AI audit trail', async () => {
        const res = await ctx.request.patch(adminVoice()).set(owner.auth)
            .send({ readAloudServer: true, readAloudVoice: 'af_heart', sttLanguage: 'en', readAloudMaxChars: 600 });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ readAloudServer: true, readAloudVoice: 'af_heart', sttLanguage: 'en', readAloudMaxChars: 600, voiceInputEnabled: true });
        // No Speech route yet: members fall back to the browser, and the admin is told
        expect(res.body.engines).toEqual({ input: 'off', output: 'browser' });
        expect(res.body.warnings).toEqual(expect.arrayContaining([expect.stringContaining('no Speech route')]));

        const changes = await ctx.request.get(`/servers/${serverId}/ai/changes`).set(owner.auth);
        const entry = changes.body.find((c: any) => c.action === 'ai_voice_update');
        expect(entry.changes.changed.sort()).toEqual(['readAloudMaxChars', 'readAloudServer', 'readAloudVoice', 'sttLanguage']);
        expect(entry.changes.after).toMatchObject({ readAloudServer: true, readAloudVoice: 'af_heart' });
    });

    it('routes stt and tts to the OpenAI-compatible adapter only where it can serve them', async () => {
        const gemini = await ctx.request.post(`/servers/${serverId}/ai/providers`).set(owner.auth).send({ adapter: 'gemini', label: 'Gem', apiKey: 'g' });
        const refused = await ctx.request.put(`/servers/${serverId}/ai/routes/stt`).set(owner.auth).send({ providerId: gemini.body.id, model: 'x', enabled: true });
        expect(refused.status).toBe(400);
        expect(refused.body.error).toContain('does not support "stt"');
        await ctx.request.delete(`/servers/${serverId}/ai/providers/${gemini.body.id}`).set(owner.auth);

        await putRoute('stt');
        await putRoute('tts');
        const res = await ctx.request.get(adminVoice()).set(owner.auth);
        expect(res.body.routes.stt).toMatchObject({ configured: true, enabled: true, adapter: 'openai', model: 'Systran/faster-whisper-small' });
        expect(res.body.engines).toEqual({ input: 'server', output: 'server' });
        expect(res.body.warnings).toEqual([]);
    });
});

describe('GET /channels/:id/voice', () => {
    it('tells a member which engines to use', async () => {
        const res = await ctx.request.get(`/channels/${channelId}/voice`).set(member.auth);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ input: 'server', output: 'server', maxRecordingSeconds: 120, language: 'en', maxChars: 600 });
    });

    it('is refused to non-members and bots', async () => {
        // Row-level security hides the channel from non-members, so it is not found
        expect((await ctx.request.get(`/channels/${channelId}/voice`).set(outsider.auth)).status).toBe(404);
        const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'voicebot' });
        const token = await ctx.request.post(`/servers/${serverId}/bots/${bot.body.id}/tokens`).set(owner.auth).send({});
        const res = await ctx.request.get(`/channels/${channelId}/voice`).set({ Authorization: `Bot ${token.body.token}` });
        expect(res.status).toBe(403);
    });
});

describe('POST /channels/:id/voice/transcribe', () => {
    const url = () => `/channels/${channelId}/voice/transcribe`;

    it('transcribes a recorded clip through the stt route and records usage', async () => {
        const fetchMock = mockAudioApi({ text: '  please rerun the failing test ' });
        const res = await ctx.request.post(url()).set(member.auth).set('Content-Type', 'audio/webm;codecs=opus').send(Buffer.from('opus-bytes'));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ text: 'please rerun the failing test' });

        const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(calledUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
        const form = init.body as FormData;
        expect(form.get('language')).toBe('en');
        expect((form.get('file') as File).name).toBe('speech.webm');

        const usage = await ctx.db.query("SELECT user_id, channel_id, model, error FROM ai_usage_events WHERE server_id = $1 AND capability = 'stt'", [serverId]);
        expect(usage.rows).toHaveLength(1);
        expect(usage.rows[0]).toMatchObject({ model: 'Systran/faster-whisper-small', error: null });
        expect(usage.rows[0].user_id.trim()).toBe(member.userId);
    });

    it('refuses other content types and empty clips', async () => {
        mockAudioApi();
        expect((await ctx.request.post(url()).set(member.auth).set('Content-Type', 'video/quicktime').send(Buffer.from('x'))).status).toBe(415);
        expect((await ctx.request.post(url()).set(member.auth).send({ audio: 'x' })).status).toBe(415);
        expect((await ctx.request.post(url()).set(member.auth).set('Content-Type', 'audio/webm').send(Buffer.alloc(0))).status).toBe(400);
    });

    it('is refused to people who cannot send in the channel', async () => {
        mockAudioApi();
        const outside = await ctx.request.post(url()).set(outsider.auth).set('Content-Type', 'audio/webm').send(Buffer.from('x'));
        expect(outside.status).toBe(404);
        // A member whose roles lack Send Messages in the channel
        const server = await ctx.db.query('SELECT everyone_role_id FROM servers WHERE id = $1', [serverId]);
        await ctx.request.put(`/channels/${channelId}/overrides/roles/${server.rows[0].everyone_role_id.trim()}`).set(owner.auth)
            .send({ allow: '0', deny: String(1n << 11n) });
        const muted = await ctx.request.post(url()).set(member.auth).set('Content-Type', 'audio/webm').send(Buffer.from('x'));
        expect(muted.status).toBe(403);
        await ctx.request.delete(`/channels/${channelId}/overrides/roles/${server.rows[0].everyone_role_id.trim()}`).set(owner.auth);
    });

    it('reports provider failures as 502 and records them', async () => {
        mockAudioApi({ fail: true });
        const res = await ctx.request.post(url()).set(member.auth).set('Content-Type', 'audio/mp4').send(Buffer.from('aac'));
        expect(res.status).toBe(502);
        expect(res.body.error).toContain('model is loading');
        const failed = await ctx.db.query("SELECT 1 FROM ai_usage_events WHERE server_id = $1 AND capability = 'stt' AND error IS NOT NULL", [serverId]);
        expect(failed.rows).toHaveLength(1);
    });

    it('keeps to the route\'s daily budget', async () => {
        await putRoute('stt', { dailyRequestLimit: 2 }); // two calls already today
        const fetchMock = mockAudioApi();
        const res = await ctx.request.post(url()).set(member.auth).set('Content-Type', 'audio/ogg').send(Buffer.from('ogg'));
        expect(res.status).toBe(429);
        expect(res.body.code).toBe('budget_exceeded');
        expect(fetchMock).not.toHaveBeenCalled();
        await putRoute('stt');
    });

    it('stops when the admin turns voice input off', async () => {
        await ctx.request.patch(adminVoice()).set(owner.auth).send({ voiceInputEnabled: false });
        const fetchMock = mockAudioApi();
        const res = await ctx.request.post(url()).set(member.auth).set('Content-Type', 'audio/webm').send(Buffer.from('x'));
        expect(res.status).toBe(403);
        expect(fetchMock).not.toHaveBeenCalled();
        expect((await ctx.request.get(`/channels/${channelId}/voice`).set(member.auth)).body.input).toBe('off');
        await ctx.request.patch(adminVoice()).set(owner.auth).send({ voiceInputEnabled: true });
    });
});

describe('POST /channels/:id/messages/:msgId/speech', () => {
    const url = (msgId: string) => `/channels/${channelId}/messages/${msgId}/speech`;

    it('voices the message as speakable text with the configured voice and returns MP3', async () => {
        const fetchMock = mockAudioApi();
        const msgId = await post(`<@${member.userId}> done: **tests pass**, see https://ci.example.com/1\n\n\`\`\`\nnpm test\n\`\`\``);
        const res = await ctx.request.post(url(msgId)).set(member.auth).buffer(true)
            .parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('audio/mpeg');
        expect(res.body.length).toBeGreaterThan(100);
        expect(res.body[0]).toBe(0xff); // an MP3 frame, not the WAV the engine returned

        const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(calledUrl).toBe('https://api.openai.com/v1/audio/speech');
        expect(JSON.parse(init.body as string)).toEqual({
            model: 'kokoro', voice: 'af_heart', response_format: 'wav',
            input: '@voicemember done: tests pass, see (link). (code block).',
        });

        const usage = await ctx.db.query("SELECT message_id FROM ai_usage_events WHERE server_id = $1 AND capability = 'tts'", [serverId]);
        expect(usage.rows.map((r: any) => r.message_id.trim())).toEqual([msgId]);
    });

    it('voices a message once and serves repeats from the cache', async () => {
        const fetchMock = mockAudioApi();
        const msgId = await post('Build finished.');
        expect((await ctx.request.post(url(msgId)).set(member.auth)).status).toBe(200);
        expect((await ctx.request.post(url(msgId)).set(owner.auth)).status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('voices a message again when its text changed (streamed replies are not marked edited)', async () => {
        const fetchMock = mockAudioApi();
        const msgId = await post('First draft.');
        expect((await ctx.request.post(url(msgId)).set(member.auth)).status).toBe(200);
        await ctx.db.query('UPDATE messages SET content = $1 WHERE id = $2', ['Final answer.', msgId]);
        expect((await ctx.request.post(url(msgId)).set(member.auth)).status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).input).toBe('Final answer.');
    });

    it('refuses missing, deleted, other-channel and system messages', async () => {
        mockAudioApi();
        const other = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: 'other', channelType: 3 });
        const elsewhere = await ctx.request.post(`/channels/${other.body.id}/messages`).set(owner.auth).send({ content: 'hi' });
        expect((await ctx.request.post(url(elsewhere.body.id)).set(member.auth)).status).toBe(404);
        expect((await ctx.request.post(url('01ZZZZZZZZZZZZZZZZZZZZZZZZ')).set(member.auth)).status).toBe(404);

        const deleted = await post('to be removed');
        await ctx.request.delete(`/channels/${channelId}/messages/${deleted}`).set(owner.auth);
        expect((await ctx.request.post(url(deleted)).set(member.auth)).status).toBe(404);

        const sys = await ctx.db.query(
            "INSERT INTO messages (id, channel_id, author_id, content, system_event) VALUES ('01SYSVOICE0000000000000000', $1, NULL, 'Session started', 'agent_session') RETURNING id",
            [channelId]
        );
        const res = await ctx.request.post(url(sys.rows[0].id.trim())).set(member.auth);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('nothing_to_read');
    });

    it('is refused to non-members', async () => {
        mockAudioApi();
        const msgId = await post('secret');
        expect((await ctx.request.post(url(msgId)).set(outsider.auth)).status).toBe(404);
    });

    it('is off unless the admin chose the server voice for read-aloud', async () => {
        await ctx.request.patch(adminVoice()).set(owner.auth).send({ readAloudServer: false });
        const fetchMock = mockAudioApi();
        const msgId = await post('Hello');
        const res = await ctx.request.post(url(msgId)).set(member.auth);
        expect(res.status).toBe(403);
        expect(fetchMock).not.toHaveBeenCalled();
        expect((await ctx.request.get(`/channels/${channelId}/voice`).set(member.auth)).body.output).toBe('browser');
        await ctx.request.patch(adminVoice()).set(owner.auth).send({ readAloudServer: true });
    });

    it('answers 503 when the Speech route is disabled', async () => {
        await putRoute('tts', { enabled: false });
        mockAudioApi();
        const msgId = await post('Hello again');
        const res = await ctx.request.post(url(msgId)).set(member.auth);
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('voice_unavailable');
        await putRoute('tts');
    });
});

describe('read-aloud preference', () => {
    it('is saved per person with known values only', async () => {
        const saved = await ctx.request.patch('/users/@me/preferences').set(member.auth).send({ readAloud: 'phone' });
        expect(saved.status).toBe(200);
        expect(saved.body).toMatchObject({ readAloud: 'phone' });
        expect((await ctx.request.patch('/users/@me/preferences').set(member.auth).send({ readAloud: 'loud' })).status).toBe(400);
        expect((await ctx.request.get('/users/@me/preferences').set(owner.auth)).body.readAloud).toBeUndefined();
    });
});
