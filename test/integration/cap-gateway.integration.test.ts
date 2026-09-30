import { vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { buildCapGateway } from '../../src/gateway/cap-gateway';
import { hashToken } from '../../src/runtime/runner';
import { resolveLimits } from '../../src/runtime/limits';
import { isForwardable, EVENT_CHANNEL } from '../../src/lib/event-bridge';

/** WBS 3.4: capability gateway — auth, declared capabilities, caps, budgets, chat, messages, files. */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let gw: Awaited<ReturnType<typeof buildCapGateway>>;
let redis: Redis;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let botId: string;
let threadId: string;
const published: any[] = [];
let sub: Redis;

async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 40; i++) {
        if (await check()) return;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('waitFor timed out');
}

/** Create a running run with a live token; returns the bearer token. */
async function makeRun(opts: { capabilities?: string[]; limits?: Record<string, number>; status?: string; expired?: boolean; revoked?: boolean; thread?: string | null } = {}) {
    const runId = generateUlid();
    await ctx.db.query(
        `INSERT INTO exec_runs (id, server_id, channel_id, thread_id, submitted_by, code, code_sha256, limits, gate_decision, status, requested_capabilities)
         VALUES ($1, $2, $3, $4, $5, 'x', $6, $7, 'auto_run', $8, $9)`,
        [runId, serverId, channelId, opts.thread === undefined ? threadId : opts.thread, botId, 'a'.repeat(64),
         JSON.stringify({ ...resolveLimits('standard'), ...opts.limits }), opts.status ?? 'running', opts.capabilities ?? ['chat']]
    );
    const token = `art_${randomBytes(32).toString('base64url')}`;
    await ctx.db.query(
        `INSERT INTO exec_run_tokens (token_hash, run_id, server_id, capabilities, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, NOW() + ($5 || ' seconds')::interval, $6)`,
        [hashToken(token), runId, serverId, opts.capabilities ?? ['chat'], opts.expired ? '-5' : '300', opts.revoked ? new Date() : null]
    );
    return { runId, token, auth: { authorization: `Bearer ${token}` } };
}

async function pausedReason(): Promise<string | null> {
    const row = (await ctx.db.query('SELECT bot_paused_at, bot_paused_reason FROM users WHERE id = $1', [botId])).rows[0];
    return row.bot_paused_at ? row.bot_paused_reason : null;
}

async function resumeBot() {
    await ctx.db.query('UPDATE users SET bot_paused_at = NULL, bot_paused_reason = NULL WHERE id = $1', [botId]);
}

function sse(events: unknown[]) {
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'gwowner');
    ({ serverId, generalChannelId: channelId } = await createServer(ctx.request, owner.auth, 'Gateway Server'));

    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'runbot' });
    botId = bot.body.id;
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM users WHERE id = $1', [botId])).rows.length > 0);
    await ctx.request.post(`/channels/${channelId}/bots/${botId}`).set(owner.auth);
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM bot_channel_access WHERE bot_id = $1', [botId])).rows.length > 0);

    const parent = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'run thread' });
    threadId = parent.body.id;
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM messages WHERE id = $1', [threadId])).rows.length > 0);

    // Chat route: Gemini with a key (provider calls are mocked)
    const prov = await ctx.request.post(`/servers/${serverId}/ai/providers`).set(owner.auth).send({ adapter: 'gemini', apiKey: 'gw-gem-key' });
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM ai_providers WHERE id = $1', [prov.body.id])).rows.length > 0);
    await ctx.request.put(`/servers/${serverId}/ai/routes/chat`).set(owner.auth).send({ providerId: prov.body.id, model: 'gemini-3.8-flash' });
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM ai_capability_routes WHERE server_id = $1', [serverId])).rows.length > 0);

    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
    await sub.subscribe(EVENT_CHANNEL);
    sub.on('message', (_c, raw) => published.push(JSON.parse(raw)));

    gw = await buildCapGateway({ db: ctx.db, redis });
});

afterAll(async () => {
    vi.unstubAllGlobals();
    await gw.close();
    redis.disconnect();
    sub.disconnect();
    await ctx.close();
});

describe('authentication', () => {
    test('rejects missing, malformed, and unknown tokens', async () => {
        expect((await gw.inject({ method: 'POST', url: '/v1/capabilities/chat' })).statusCode).toBe(401);
        expect((await gw.inject({ method: 'POST', url: '/v1/capabilities/chat', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
        expect((await gw.inject({ method: 'POST', url: '/v1/capabilities/chat', headers: { authorization: `Bearer art_${'x'.repeat(43)}` } })).statusCode).toBe(401);
        // Unknown tokens belong to no run, so no bot is tripped
        expect(await pausedReason()).toBeNull();
    });

    test('rejects revoked, expired, and finished-run tokens and trips the leaking run bot', async () => {
        for (const opts of [{ revoked: true }, { expired: true }, { status: 'succeeded' }]) {
            const { runId, auth } = await makeRun(opts);
            const res = await gw.inject({ method: 'POST', url: '/v1/capabilities/chat', headers: auth, payload: {} });
            expect(res.statusCode, JSON.stringify(opts)).toBe(401);
            expect(await pausedReason(), JSON.stringify(opts)).toBe(`Tripwire: a run token was used outside its run (run ${runId})`);
            await resumeBot();
        }
    });

    test('a paused submitting bot is 423', async () => {
        const { auth } = await makeRun();
        await ctx.db.query('UPDATE users SET bot_paused_at = NOW() WHERE id = $1', [botId]);
        try {
            const res = await gw.inject({ method: 'POST', url: '/v1/capabilities/chat', headers: auth, payload: {} });
            expect(res.statusCode).toBe(423);
        } finally {
            await ctx.db.query('UPDATE users SET bot_paused_at = NULL WHERE id = $1', [botId]);
        }
    });

    test('health needs no token', async () => {
        expect((await gw.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    });
});

describe('capabilities', () => {
    test('unknown capability 404, undeclared 403, unimplemented 501', async () => {
        const { auth } = await makeRun({ capabilities: ['chat', 'decide'] });
        expect((await gw.inject({ method: 'POST', url: '/v1/capabilities/teleport', headers: auth, payload: {} })).statusCode).toBe(404);
        expect((await gw.inject({ method: 'POST', url: '/v1/capabilities/image', headers: auth, payload: {} })).json().code).toBe('not_declared');
        expect((await gw.inject({ method: 'POST', url: '/v1/capabilities/decide', headers: auth, payload: {} })).statusCode).toBe(501);
    });

    test('chat calls the routed provider with the server key and records usage against the run', async () => {
        const fetchMock = vi.fn(async () => sse([
            { candidates: [{ content: { parts: [{ text: 'Hi from ' }] } }] },
            { candidates: [{ content: { parts: [{ text: 'Gemini' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } },
        ]));
        vi.stubGlobal('fetch', fetchMock);
        try {
            const { runId, auth } = await makeRun();
            const res = await gw.inject({
                method: 'POST', url: '/v1/capabilities/chat', headers: auth,
                payload: { messages: [{ role: 'user', content: 'hello' }], system: 'be brief' },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ text: 'Hi from Gemini', usage: { inputTokens: 5, outputTokens: 3 } });

            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
            expect(url).toContain('/models/gemini-3.8-flash:streamGenerateContent');
            expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('gw-gem-key');

            const usage = await ctx.db.query('SELECT capability, run_id, input_tokens, output_tokens FROM ai_usage_events WHERE run_id = $1', [runId]);
            expect(usage.rows).toEqual([{ capability: 'chat', run_id: runId, input_tokens: 5, output_tokens: 3 }]);
            expect((await ctx.db.query('SELECT capability_calls FROM exec_runs WHERE id = $1', [runId])).rows[0].capability_calls).toBe(1);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    test('invalid chat input is 400 and does not consume a call', async () => {
        const { runId, auth } = await makeRun();
        const res = await gw.inject({ method: 'POST', url: '/v1/capabilities/chat', headers: auth, payload: { messages: [{ role: 'system', content: 'x' }] } });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('invalid_input');
        expect((await ctx.db.query('SELECT capability_calls FROM exec_runs WHERE id = $1', [runId])).rows[0].capability_calls).toBe(0);
    });

    test('per-run call cap', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => sse([])));
        try {
            const { runId, auth } = await makeRun({ limits: { capabilityCalls: 2 } });
            const call = () => gw.inject({ method: 'POST', url: '/v1/capabilities/chat', headers: auth, payload: { messages: [{ role: 'user', content: 'x' }] } });
            expect((await call()).statusCode).toBe(200);
            expect((await call()).statusCode).toBe(200);
            published.length = 0;
            const third = await call();
            expect(third.statusCode).toBe(429);
            expect(third.json().code).toBe('call_limit');

            // Tripwire: the bot is paused, the thread gets a notice, and further calls are 423
            expect(await pausedReason()).toMatch(/^Tripwire: a run hit its capability-call limit/);
            const notice = await ctx.db.query(
                "SELECT thread_id, author_id, system_data FROM messages WHERE system_event = 'runtime_tripwire' AND system_data->>'runId' = $1",
                [runId]
            );
            expect(notice.rows).toHaveLength(1);
            expect(notice.rows[0].thread_id.trim()).toBe(threadId);
            expect(notice.rows[0].author_id).toBeNull();
            expect(notice.rows[0].system_data).toMatchObject({ kind: 'runtime_tripwire', trigger: 'call_cap', status: 'paused', botId });
            await waitFor(async () => published.some(e => e.event === 'Message' && e.data.systemEvent === 'runtime_tripwire'));
            expect((await call()).statusCode).toBe(423);

            const audit = await ctx.db.query("SELECT actor_id FROM audit_log WHERE action = 'bot_pause_tripwire' AND target_id = $1", [botId]);
            expect(audit.rows.length).toBeGreaterThan(0);
        } finally {
            vi.unstubAllGlobals();
            await resumeBot();
        }
    });

    test('a second trip on an already-paused bot posts no second notice', async () => {
        const { runId } = await makeRun();
        const { tripBot } = await import('../../src/runtime/tripwires');
        expect((await tripBot(ctx.db, runId, 'call_cap')).paused).toBe(true);
        const again = await tripBot(ctx.db, runId, 'token_misuse');
        expect(again).toEqual({ paused: false, events: [] });
        expect(await pausedReason()).toMatch(/capability-call limit/);
        const notices = await ctx.db.query("SELECT 1 FROM messages WHERE system_event = 'runtime_tripwire' AND system_data->>'runId' = $1", [runId]);
        expect(notices.rows).toHaveLength(1);
        await resumeBot();
    });

    test('route budget and disabled routes', async () => {
        const { auth } = await makeRun();
        await ctx.db.query("UPDATE ai_capability_routes SET daily_request_limit = 1 WHERE server_id = $1", [serverId]);
        await ctx.db.query(
            `INSERT INTO ai_usage_events (id, server_id, provider, model, latency_ms, capability) VALUES ($1, $2, 'gemini', 'm', 1, 'chat')`,
            [generateUlid(), serverId]
        );
        const over = await gw.inject({ method: 'POST', url: '/v1/capabilities/chat', headers: auth, payload: { messages: [{ role: 'user', content: 'x' }] } });
        expect(over.json().code).toBe('budget_exceeded');

        await ctx.db.query("UPDATE ai_capability_routes SET daily_request_limit = NULL, enabled = false WHERE server_id = $1", [serverId]);
        const off = await gw.inject({ method: 'POST', url: '/v1/capabilities/chat', headers: auth, payload: { messages: [{ role: 'user', content: 'x' }] } });
        expect(off.statusCode).toBe(503);
        expect(off.json().code).toBe('capability_unavailable');
        await ctx.db.query("UPDATE ai_capability_routes SET enabled = true WHERE server_id = $1", [serverId]);
    });
});

describe('search, image, and tts (Phase 4)', () => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const cap = (name: string, auth: Record<string, string>, payload: unknown) =>
        gw.inject({ method: 'POST', url: `/v1/capabilities/${name}`, headers: auth, payload: payload as any });

    beforeAll(async () => {
        const gem = (await ctx.db.query("SELECT id FROM ai_providers WHERE server_id = $1 AND adapter = 'gemini'", [serverId])).rows[0].id.trim();
        for (const [capability, model] of [['search', 'gemini-3.8-flash'], ['image', 'gemini-3.1-flash-image'], ['tts', 'gemini-3.8-flash-tts']]) {
            const res = await ctx.request.put(`/servers/${serverId}/ai/routes/${capability}`).set(owner.auth).send({ providerId: gem, model, enabled: true });
            expect(res.status).toBe(200);
        }
        await waitFor(async () => (await ctx.db.query('SELECT 1 FROM ai_capability_routes WHERE server_id = $1 AND capability = $2', [serverId, 'tts'])).rows.length > 0);
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    test('gemini search: the grounded answer is posted verbatim with Search Suggestions, and returned to the run', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json({
            candidates: [{
                content: { parts: [{ text: 'Deno 2.9 shipped in September.' }] },
                groundingMetadata: {
                    webSearchQueries: ['deno latest release'],
                    searchEntryPoint: { renderedContent: '<style>.c{}</style><div class="c"><a href="https://www.google.com/search?q=deno">deno</a></div>' },
                    groundingChunks: [{ web: { uri: 'https://deno.com/blog', title: 'deno.com' } }],
                },
            }],
            usageMetadata: { promptTokenCount: 8, toolUsePromptTokenCount: 30, candidatesTokenCount: 9 },
        })));
        published.length = 0;
        const { runId, auth } = await makeRun({ capabilities: ['search'] });
        const res = await cap('search', auth, { query: 'latest deno release' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toMatchObject({
            answer: 'Deno 2.9 shipped in September.',
            citations: [{ url: 'https://deno.com/blog', title: 'deno.com' }],
            usage: { inputTokens: 38, outputTokens: 9 },
        });

        const msg = (await ctx.db.query('SELECT id, content, thread_id, author_id, system_event, system_data FROM messages WHERE id = $1', [body.displayedIn])).rows[0];
        expect(msg.system_event).toBe('runtime_search');
        expect(msg.content).toBe('Deno 2.9 shipped in September.');
        expect(msg.thread_id.trim()).toBe(threadId);
        expect(msg.author_id).toBeNull();
        expect(msg.system_data).toMatchObject({
            kind: 'runtime_search', runId, query: 'latest deno release', queries: ['deno latest release'],
            citations: [{ url: 'https://deno.com/blog', title: 'deno.com' }],
        });
        expect(msg.system_data.suggestionsHtml).toContain('google.com/search');
        await waitFor(async () => published.some(e => e.event === 'Message' && e.data.systemEvent === 'runtime_search'));

        const usage = await ctx.db.query('SELECT capability, input_tokens, output_tokens, error FROM ai_usage_events WHERE run_id = $1', [runId]);
        expect(usage.rows).toEqual([{ capability: 'search', input_tokens: 38, output_tokens: 9, error: null }]);
    });

    test('image returns base64 bytes and MIME type', async () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const fetchMock = vi.fn(async () => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] }));
        vi.stubGlobal('fetch', fetchMock);
        const { auth } = await makeRun({ capabilities: ['image'] });
        const res = await cap('image', auth, { prompt: 'a monstera under grow lights', aspectRatio: '4:3', imageSize: '1K' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ data: png.toString('base64'), mime: 'image/png' });
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toContain('/models/gemini-3.1-flash-image:generateContent');
        expect(JSON.parse(init.body as string).generationConfig.imageConfig).toEqual({ aspectRatio: '4:3', imageSize: '1K' });
    });

    test('tts returns WAV audio', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(100).toString('base64') } }] } }],
        })));
        const { auth } = await makeRun({ capabilities: ['tts'] });
        const res = await cap('tts', auth, { text: 'Joe: hi\nJane: hello', speakers: [{ speaker: 'Joe', voice: 'Kore' }, { speaker: 'Jane', voice: 'Puck' }] });
        expect(res.statusCode).toBe(200);
        const audio = Buffer.from(res.json().data, 'base64');
        expect(res.json().mime).toBe('audio/wav');
        expect(audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
        expect(audio.length).toBe(144);
    });

    test('invalid inputs are 400 and consume no call', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { runId, auth } = await makeRun({ capabilities: ['search', 'image', 'tts'] });
        const bad: [string, unknown][] = [
            ['search', { query: '' }],
            ['search', { query: 'x', maxResults: 50 }],
            ['search', { query: 'x', region: 'us' }],
            ['image', { prompt: 'x', aspectRatio: 'wide' }],
            ['image', { prompt: 'x', imageSize: '8K' }],
            ['tts', { text: 'x', voice: 'Kore', speakers: [{ speaker: 'A', voice: 'Puck' }] }],
            ['tts', { text: 'x', speakers: [{ speaker: 'A', voice: 'P' }, { speaker: 'B', voice: 'Q' }, { speaker: 'C', voice: 'R' }] }],
            ['tts', { text: 'x', voice: '<script>' }],
        ];
        for (const [name, payload] of bad) {
            const res = await cap(name, auth, payload);
            expect(res.statusCode, JSON.stringify(payload)).toBe(400);
            expect(res.json().code).toBe('invalid_input');
        }
        expect(fetchMock).not.toHaveBeenCalled();
        expect((await ctx.db.query('SELECT capability_calls FROM exec_runs WHERE id = $1', [runId])).rows[0].capability_calls).toBe(0);
    });

    test('provider failure is 502 and recorded against the run', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'quota exceeded' } }, 429)));
        const { runId, auth } = await makeRun({ capabilities: ['image'] });
        const res = await cap('image', auth, { prompt: 'x' });
        expect(res.statusCode).toBe(502);
        expect(res.json()).toEqual({ error: 'Gemini API 429: quota exceeded', code: 'provider_error' });
        const usage = await ctx.db.query('SELECT error FROM ai_usage_events WHERE run_id = $1', [runId]);
        expect(usage.rows).toEqual([{ error: 'Gemini API 429: quota exceeded' }]);
    });

    test('tavily search returns results to the run without posting', async () => {
        const prov = await ctx.request.post(`/servers/${serverId}/ai/providers`).set(owner.auth).send({ adapter: 'tavily', apiKey: 'tvly-test' });
        expect(prov.status).toBe(201);
        await waitFor(async () => (await ctx.db.query('SELECT 1 FROM ai_providers WHERE id = $1', [prov.body.id])).rows.length > 0);
        const route = await ctx.request.put(`/servers/${serverId}/ai/routes/search`).set(owner.auth).send({ providerId: prov.body.id, model: 'basic', enabled: true });
        expect(route.status).toBe(200);
        await waitFor(async () => (await ctx.db.query('SELECT 1 FROM ai_capability_routes WHERE server_id = $1 AND provider_id = $2', [serverId, prov.body.id])).rows.length > 0);

        const fetchMock = vi.fn(async () => json({ answer: 'Use a well-draining mix.', results: [{ title: 'NC State Extension', url: 'https://plants.ces.ncsu.edu/x', content: 'Soil…' }] }));
        vi.stubGlobal('fetch', fetchMock);
        const { runId, auth } = await makeRun({ capabilities: ['search'] });
        const res = await cap('search', auth, { query: 'monstera soil', maxResults: 3 });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            answer: 'Use a well-draining mix.',
            citations: [{ url: 'https://plants.ces.ncsu.edu/x', title: 'NC State Extension', snippet: 'Soil…' }],
            usage: { inputTokens: 0, outputTokens: 0 },
        });
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://api.tavily.com/search');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tvly-test');
        const posted = await ctx.db.query("SELECT 1 FROM messages WHERE system_event = 'runtime_search' AND system_data->>'runId' = $1", [runId]);
        expect(posted.rows).toHaveLength(0);
    });
});

describe('results cards (4.1)', () => {
    const card = {
        title: 'CI #42',
        summary: '4 of 5 passed; test_create returned 500.',
        summarySource: 'model',
        totals: { passed: 4, failed: 1, skipped: 0, durationMs: 1234 },
        suites: [{ name: 'tests.test_api', passed: 3, failed: 1, skipped: 0, durationMs: 1000 }, { name: 'tests.test_util', passed: 1, failed: 0, skipped: 0 }],
        failures: [{ name: 'test_create', suite: 'tests.test_api', message: 'assert 500 == 201' }],
    };
    const post = (auth: Record<string, string>, payload: unknown) =>
        gw.inject({ method: 'POST', url: '/v1/reports', headers: auth, payload: payload as any });

    test('posts a bot-authored card with the attachment into the run\'s thread', async () => {
        published.length = 0;
        const { runId, auth } = await makeRun();
        const res = await post(auth, { ...card, attachment: { name: 'ci-42.md', content: '# CI #42\n\nfull report' } });
        expect(res.statusCode).toBe(201);
        const { id, fileId } = res.json();
        expect(fileId).toBeTruthy();

        const msg = (await ctx.db.query('SELECT author_id, thread_id, content, system_event, system_data FROM messages WHERE id = $1', [id])).rows[0];
        expect(msg.author_id.trim()).toBe(botId);
        expect(msg.thread_id.trim()).toBe(threadId);
        expect(msg.system_event).toBe('runtime_report');
        expect(msg.system_data).toEqual({
            kind: 'runtime_report', runId, title: 'CI #42', summary: card.summary, summarySource: 'model',
            totals: card.totals, suites: card.suites, failures: card.failures,
        });
        expect(msg.content).toBe('❌ CI #42: 4 passed, 1 failed, 0 skipped\n\n4 of 5 passed; test_create returned 500.');

        const file = (await ctx.db.query('SELECT message_id, filename FROM files WHERE id = $1', [fileId])).rows[0];
        expect(file.message_id.trim()).toBe(id);
        expect(file.filename).toBe('ci-42.md');
        const run = (await ctx.db.query('SELECT capability_calls, artifact_count FROM exec_runs WHERE id = $1', [runId])).rows[0];
        expect(run).toEqual({ capability_calls: 1, artifact_count: 1 });

        await waitFor(async () => published.some(e => e.event === 'Message' && e.data.id === id));
        const event = published.find(e => e.event === 'Message' && e.data.id === id);
        expect(event.data).toMatchObject({ systemEvent: 'runtime_report', authorId: botId, threadId });
        expect(event.data.systemData.totals).toEqual(card.totals);
        expect(event.data.attachments).toHaveLength(1);
    });

    test('a card without an attachment and a passing run', async () => {
        const { auth } = await makeRun();
        const res = await post(auth, { title: 'Nightly', totals: { passed: 10, failed: 0, skipped: 2 } });
        expect(res.statusCode).toBe(201);
        expect(res.json().fileId).toBeUndefined();
        const msg = (await ctx.db.query('SELECT content, system_data FROM messages WHERE id = $1', [res.json().id])).rows[0];
        expect(msg.content).toBe('✅ Nightly: 10 passed, 0 failed, 2 skipped');
        expect(msg.system_data).toMatchObject({ suites: [], failures: [], summary: null });
    });

    test('the message API returns the card data to clients', async () => {
        const { auth } = await makeRun();
        const { id } = (await post(auth, { title: 'API check', totals: { passed: 1, failed: 0, skipped: 0 } })).json();
        const res = await ctx.request.get(`/channels/${channelId}/messages/${threadId}/replies`).set(owner.auth);
        const found = (res.body.messages ?? res.body).find((m: any) => m.id === id);
        expect(found).toMatchObject({ systemEvent: 'runtime_report', systemData: { title: 'API check' } });
    });

    test('invalid cards are 400 and consume no call', async () => {
        const { runId, auth } = await makeRun();
        const bad = [
            { totals: card.totals },
            { title: 'x', totals: { passed: 1, failed: 0 } },
            { title: 'x', totals: { passed: -1, failed: 0, skipped: 0 } },
            { title: 'x', totals: card.totals, failures: Array.from({ length: 21 }, (_, i) => ({ name: `t${i}`, message: 'm' })) },
            { title: 'x', totals: card.totals, summarySource: 'human' },
        ];
        for (const payload of bad) expect((await post(auth, payload)).statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
        expect((await ctx.db.query('SELECT capability_calls FROM exec_runs WHERE id = $1', [runId])).rows[0].capability_calls).toBe(0);
    });

    test('unknown fields are stripped, never stored', async () => {
        const { auth } = await makeRun();
        const res = await post(auth, { title: 'x', totals: card.totals, html: '<script>', suites: [{ name: 'a', passed: 1, failed: 0, skipped: 0, color: 'red' }] });
        expect(res.statusCode).toBe(201);
        const data = (await ctx.db.query('SELECT system_data FROM messages WHERE id = $1', [res.json().id])).rows[0].system_data;
        expect(data.html).toBeUndefined();
        expect(data.suites).toEqual([{ name: 'a', passed: 1, failed: 0, skipped: 0 }]);
    });

    test('a rejected attachment returns file_rejected, releases the slot, and posts nothing', async () => {
        const { runId, auth } = await makeRun();
        const res = await post(auth, { ...card, attachment: { name: 'report.html', content: '<h1>hi</h1>' } });
        expect(res.statusCode).toBe(415);
        expect(res.json().code).toBe('file_rejected');
        expect((await ctx.db.query('SELECT artifact_count FROM exec_runs WHERE id = $1', [runId])).rows[0].artifact_count).toBe(0);
        const posted = await ctx.db.query("SELECT 1 FROM messages WHERE system_event = 'runtime_report' AND system_data->>'runId' = $1", [runId]);
        expect(posted.rows).toHaveLength(0);
    });

    test('attachments count against the artifact limit', async () => {
        const { auth } = await makeRun({ limits: { artifacts: 1 } });
        expect((await post(auth, { ...card, attachment: { name: 'a.md', content: 'a' } })).statusCode).toBe(201);
        const second = await post(auth, { ...card, attachment: { name: 'b.md', content: 'b' } });
        expect(second.statusCode).toBe(429);
        expect(second.json().code).toBe('artifact_limit');
    });
});

describe('messages and files', () => {
    test('postMessage lands in the run\'s thread as the submitting bot and publishes events', async () => {
        published.length = 0;
        const { auth } = await makeRun();
        const res = await gw.inject({ method: 'POST', url: '/v1/messages', headers: auth, payload: { content: 'run finished' } });
        expect(res.statusCode).toBe(201);
        const msg = (await ctx.db.query('SELECT author_id, thread_id, content FROM messages WHERE id = $1', [res.json().id])).rows[0];
        expect(msg).toMatchObject({ content: 'run finished' });
        expect(msg.author_id.trim()).toBe(botId);
        expect(msg.thread_id.trim()).toBe(threadId);

        await waitFor(async () => published.some(e => e.event === 'Message'));
        expect(published.find(e => e.event === 'Message')).toMatchObject({ room: `channel:${channelId}`, data: { content: 'run finished', threadId } });
        expect(published.some(e => e.event === 'ThreadMetadataUpdate')).toBe(true);
    });

    test('files are validated, stored, and attached to a thread message', async () => {
        const { runId, auth } = await makeRun();
        const res = await gw.inject({
            method: 'POST', url: '/v1/files',
            headers: { ...auth, 'content-type': 'text/plain', 'x-agora-filename': encodeURIComponent('results.txt'), 'x-agora-message': encodeURIComponent('Here are the results') },
            payload: Buffer.from('all tests passed\n'),
        });
        expect(res.statusCode).toBe(201);
        const file = res.json();
        expect(file).toMatchObject({ name: 'results.txt', mime: 'text/plain' });

        const row = (await ctx.db.query('SELECT uploader_id, message_id FROM files WHERE id = $1', [file.id])).rows[0];
        expect(row.uploader_id.trim()).toBe(botId);
        const msg = (await ctx.db.query('SELECT content, thread_id FROM messages WHERE id = $1', [row.message_id])).rows[0];
        expect(msg.content).toBe('Here are the results');
        expect(msg.thread_id.trim()).toBe(threadId);
        expect((await ctx.db.query('SELECT artifact_count FROM exec_runs WHERE id = $1', [runId])).rows[0].artifact_count).toBe(1);
    });

    test('a .json file is stored raw, not parsed as a request body', async () => {
        const { auth } = await makeRun();
        const res = await gw.inject({
            method: 'POST', url: '/v1/files',
            headers: { ...auth, 'content-type': 'application/json', 'x-agora-filename': 'data.json' },
            payload: Buffer.from('{"a":1}'),
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().mime).toBe('application/json');
    });

    test('disallowed files are rejected and the artifact slot is released', async () => {
        const { runId, auth } = await makeRun();
        const res = await gw.inject({
            method: 'POST', url: '/v1/files',
            headers: { ...auth, 'content-type': 'application/octet-stream', 'x-agora-filename': 'payload.exe' },
            payload: Buffer.from('MZ\x90\x00'),
        });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.json().code).toBe('file_rejected');
        expect((await ctx.db.query('SELECT artifact_count FROM exec_runs WHERE id = $1', [runId])).rows[0].artifact_count).toBe(0);
    });

    test('artifact cap, missing filename, empty body', async () => {
        const { auth } = await makeRun({ limits: { artifacts: 1 } });
        const post = (name: string, body = 'x') => gw.inject({
            method: 'POST', url: '/v1/files',
            headers: { ...auth, 'content-type': 'text/plain', ...(name ? { 'x-agora-filename': name } : {}) },
            payload: Buffer.from(body),
        });
        expect((await post('a.txt')).statusCode).toBe(201);
        expect((await post('b.txt')).json().code).toBe('artifact_limit');
        const { auth: auth2 } = await makeRun();
        const noName = await gw.inject({ method: 'POST', url: '/v1/files', headers: { ...auth2, 'content-type': 'text/plain' }, payload: Buffer.from('x') });
        expect(noName.json().code).toBe('bad_filename');
    });

    test('closed thread rejects posts', async () => {
        const parent = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'soon closed' });
        await waitFor(async () => (await ctx.db.query('SELECT 1 FROM messages WHERE id = $1', [parent.body.id])).rows.length > 0);
        await ctx.db.query('UPDATE messages SET thread_closed_at = NOW() WHERE id = $1', [parent.body.id]);
        const { auth } = await makeRun({ thread: parent.body.id });
        const res = await gw.inject({ method: 'POST', url: '/v1/messages', headers: auth, payload: { content: 'late' } });
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('thread_closed');
    });
});

describe('event bridge allowlist', () => {
    test('only allowlisted events and channel rooms are forwarded', () => {
        expect(isForwardable({ room: 'channel:01ARZ3NDEKTSV4RRFFQ69G5FAV', event: 'Message', data: {} })).toBe(true);
        expect(isForwardable({ room: 'user:01ARZ3NDEKTSV4RRFFQ69G5FAV', event: 'Message', data: {} })).toBe(false);
        expect(isForwardable({ room: 'channel:01ARZ3NDEKTSV4RRFFQ69G5FAV', event: 'Ready', data: {} })).toBe(false);
        expect(isForwardable({ room: 'channel:*', event: 'Message', data: {} })).toBe(false);
    });
});
