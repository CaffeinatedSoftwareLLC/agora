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
        const { auth } = await makeRun({ capabilities: ['chat', 'search'] });
        expect((await gw.inject({ method: 'POST', url: '/v1/capabilities/teleport', headers: auth, payload: {} })).statusCode).toBe(404);
        expect((await gw.inject({ method: 'POST', url: '/v1/capabilities/image', headers: auth, payload: {} })).json().code).toBe('not_declared');
        expect((await gw.inject({ method: 'POST', url: '/v1/capabilities/search', headers: auth, payload: {} })).statusCode).toBe(501);
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
