import { vi } from 'vitest';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';

/**
 * Provider registry API: configured providers, capability routes, usage, and the
 * instance-level private base URL setting.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let otherServerId: string;

const base = () => `/servers/${serverId}/ai`;

async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 40; i++) {
        if (await check()) return;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('waitFor timed out');
}

const providerExists = (id: string) => async () =>
    (await ctx.db.query('SELECT 1 FROM ai_providers WHERE id = $1', [id])).rows.length > 0;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'provowner');
    member = await authedUser(ctx.request, 'provmember');
    ({ serverId } = await createServer(ctx.request, owner.auth, 'Provider Server'));
    ({ serverId: otherServerId } = await createServer(ctx.request, owner.auth, 'Other Server'));
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
});

afterAll(async () => {
    vi.unstubAllGlobals();
    await ctx.close();
});

describe('authorization', () => {
    test('non-admin member is forbidden', async () => {
        const res = await ctx.request.get(`${base()}/providers`).set(member.auth);
        expect(res.status).toBe(403);
    });
});

describe('adapters', () => {
    test('lists adapters with capabilities', async () => {
        const res = await ctx.request.get(`${base()}/adapters`).set(owner.auth);
        expect(res.status).toBe(200);
        const ids = res.body.map((a: any) => a.id);
        expect(ids).toEqual(expect.arrayContaining(['anthropic', 'openai', 'gemini']));
        const gemini = res.body.find((a: any) => a.id === 'gemini');
        expect(gemini).toMatchObject({ requiresApiKey: true, supportsBaseUrl: false, defaultModels: { chat: 'gemini-3.8-flash' } });
    });
});

describe('providers', () => {
    let geminiId: string;

    test('rejects unknown adapters and missing required keys', async () => {
        const unknown = await ctx.request.post(`${base()}/providers`).set(owner.auth).send({ adapter: 'skynet' });
        expect(unknown.status).toBe(400);
        const noKey = await ctx.request.post(`${base()}/providers`).set(owner.auth).send({ adapter: 'gemini' });
        expect(noKey.status).toBe(400);
        expect(noKey.body.error).toContain('requires an API key');
    });

    test('creates a provider; key is stored encrypted and never returned', async () => {
        const res = await ctx.request.post(`${base()}/providers`).set(owner.auth).send({ adapter: 'gemini', apiKey: 'g-secret-key' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ adapter: 'gemini', label: 'Google Gemini', hasApiKey: true, enabled: true, baseUrl: null });
        expect(JSON.stringify(res.body)).not.toContain('g-secret-key');
        geminiId = res.body.id;
        await waitFor(providerExists(geminiId));

        const row = await ctx.db.query('SELECT api_key_enc FROM ai_providers WHERE id = $1', [geminiId]);
        expect(row.rows[0].api_key_enc).toBeTruthy();
        expect(row.rows[0].api_key_enc).not.toContain('g-secret-key');
    });

    test('duplicate label is 409', async () => {
        const res = await ctx.request.post(`${base()}/providers`).set(owner.auth).send({ adapter: 'gemini', apiKey: 'k2' });
        expect(res.status).toBe(409);
    });

    test('base URL is rejected for adapters that do not support it', async () => {
        const res = await ctx.request.post(`${base()}/providers`).set(owner.auth)
            .send({ adapter: 'anthropic', apiKey: 'k', baseUrl: 'https://example.com' });
        expect(res.status).toBe(400);
    });

    test('private base URLs are blocked until an instance admin allows them', async () => {
        const blocked = await ctx.request.post(`${base()}/providers`).set(owner.auth)
            .send({ adapter: 'openai', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' });
        expect(blocked.status).toBe(400);
        expect(blocked.body.error).toContain('private');

        // Non-instance-admins can't flip the setting
        const denied = await ctx.request.patch('/admin/settings/ai').set(owner.auth).send({ allowPrivateBaseUrls: true });
        expect(denied.status).toBe(403);

        await ctx.db.query('UPDATE users SET is_instance_admin = true WHERE id = $1', [owner.userId]);
        const allow = await ctx.request.patch('/admin/settings/ai').set(owner.auth).send({ allowPrivateBaseUrls: true });
        expect(allow.status).toBe(200);
        await waitFor(async () => (await ctx.db.query(
            "SELECT 1 FROM instance_settings WHERE key = 'ai.allow_private_base_urls' AND value = 'true'::jsonb")).rows.length > 0);

        const ok = await ctx.request.post(`${base()}/providers`).set(owner.auth)
            .send({ adapter: 'openai', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' });
        expect(ok.status).toBe(201);
        expect(ok.body).toMatchObject({ hasApiKey: false, baseUrl: 'http://127.0.0.1:11434/v1' });

        const get = await ctx.request.get('/admin/settings/ai').set(owner.auth);
        expect(get.body).toEqual({ allowPrivateBaseUrls: true });
    });

    test('rename, rotate key, and disable', async () => {
        const res = await ctx.request.patch(`${base()}/providers/${geminiId}`).set(owner.auth)
            .send({ label: 'Gemini (team)', apiKey: 'g-rotated', enabled: false });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ label: 'Gemini (team)', enabled: false, hasApiKey: true });

        const clear = await ctx.request.patch(`${base()}/providers/${geminiId}`).set(owner.auth).send({ apiKey: null });
        expect(clear.status).toBe(400); // gemini requires a key

        await ctx.request.patch(`${base()}/providers/${geminiId}`).set(owner.auth).send({ enabled: true });
    });

    test('test endpoint uses the stored (decrypted) key', async () => {
        const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        try {
            const res = await ctx.request.post(`${base()}/providers/${geminiId}/test`).set(owner.auth).send({});
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ ok: true });
            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
            expect(url).toContain('/models/gemini-3.8-flash:generateContent');
            expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-rotated');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    test('providers from another server are not visible or editable', async () => {
        const res = await ctx.request.patch(`/servers/${otherServerId}/ai/providers/${geminiId}`).set(owner.auth).send({ enabled: false });
        expect(res.status).toBe(404);
    });

    describe('capability routes', () => {
        test('routes the chat capability to a provider, enabled by default', async () => {
            const res = await ctx.request.put(`${base()}/routes/chat`).set(owner.auth)
                .send({ providerId: geminiId, model: 'gemini-3.8-flash', dailyRequestLimit: 100, inputPriceMicrosPerMtok: 300000 });
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                capability: 'chat', providerId: geminiId, providerLabel: 'Gemini (team)', adapter: 'gemini',
                model: 'gemini-3.8-flash', enabled: true, dailyRequestLimit: 100, dailyTokenLimit: null,
                inputPriceMicrosPerMtok: 300000,
            });
        });

        test('rejects capabilities the adapter does not support', async () => {
            const res = await ctx.request.put(`${base()}/routes/decide`).set(owner.auth)
                .send({ providerId: geminiId, model: 'gemini-3.8-flash' });
            expect(res.status).toBe(400);
            expect(res.body.error).toContain('does not support');
        });

        test('rejects unknown capabilities and invalid limits', async () => {
            expect((await ctx.request.put(`${base()}/routes/telepathy`).set(owner.auth)
                .send({ providerId: geminiId, model: 'x' })).status).toBe(400);
            expect((await ctx.request.put(`${base()}/routes/chat`).set(owner.auth)
                .send({ providerId: geminiId, model: 'x', dailyRequestLimit: 0 })).status).toBe(400);
        });

        test('cannot route to another server\'s provider', async () => {
            const res = await ctx.request.put(`/servers/${otherServerId}/ai/routes/chat`).set(owner.auth)
                .send({ providerId: geminiId, model: 'gemini-3.8-flash' });
            expect(res.status).toBe(404);
        });

        test('lists routes and shows which capabilities a provider serves', async () => {
            await waitFor(async () => (await ctx.db.query(
                "SELECT 1 FROM ai_capability_routes WHERE server_id = $1 AND capability = 'chat'", [serverId])).rows.length > 0);
            const routes = await ctx.request.get(`${base()}/routes`).set(owner.auth);
            expect(routes.body.map((r: any) => r.capability)).toEqual(['chat']);

            const providers = await ctx.request.get(`${base()}/providers`).set(owner.auth);
            expect(providers.body.find((p: any) => p.id === geminiId).capabilities).toEqual(['chat']);
        });

        test('legacy ai-config GET reflects the chat route', async () => {
            // ai-config needs an assistant row to report configured
            await ctx.db.query(
                'INSERT INTO ai_provider_config (server_id) VALUES ($1) ON CONFLICT DO NOTHING', [serverId]);
            const res = await ctx.request.get(`/servers/${serverId}/ai-config`).set(owner.auth);
            expect(res.body).toMatchObject({ configured: true, provider: 'gemini', adapter: 'gemini', model: 'gemini-3.8-flash', providerId: geminiId });
        });

        test('deleting a provider removes its routes', async () => {
            const res = await ctx.request.delete(`${base()}/providers/${geminiId}`).set(owner.auth);
            expect(res.status).toBe(200);
            await waitFor(async () => !(await providerExists(geminiId)()));
            const routes = await ctx.db.query('SELECT 1 FROM ai_capability_routes WHERE provider_id = $1', [geminiId]);
            expect(routes.rows.length).toBe(0);
        });
    });
});

describe('assistant setup without a key', () => {
    test('POST ai-config/assistant creates the bot once (idempotent)', async () => {
        const { serverId: sid } = await createServer(ctx.request, owner.auth, 'Assistant Server');
        const first = await ctx.request.post(`/servers/${sid}/ai-config/assistant`).set(owner.auth);
        expect(first.status).toBe(200);
        expect(first.body.botId).toHaveLength(26);
        await waitFor(async () => (await ctx.db.query('SELECT 1 FROM ai_provider_config WHERE server_id = $1', [sid])).rows.length > 0);

        const second = await ctx.request.post(`/servers/${sid}/ai-config/assistant`).set(owner.auth);
        expect(second.body.botId).toBe(first.body.botId);

        const bots = await ctx.db.query('SELECT username FROM users WHERE server_id = $1 AND bot = true', [sid]);
        expect(bots.rows).toEqual([{ username: 'AI-Assistant' }]);
    });

    test('PATCH ai-config updates prompt and context size', async () => {
        const { serverId: sid } = await createServer(ctx.request, owner.auth, 'Assistant Server 2');
        await ctx.request.post(`/servers/${sid}/ai-config/assistant`).set(owner.auth);
        await waitFor(async () => (await ctx.db.query('SELECT 1 FROM ai_provider_config WHERE server_id = $1', [sid])).rows.length > 0);

        const res = await ctx.request.patch(`/servers/${sid}/ai-config`).set(owner.auth)
            .send({ systemPrompt: 'Answer in haiku.', maxContext: 12 });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ enabled: true, systemPrompt: 'Answer in haiku.', maxContext: 12 });

        const empty = await ctx.request.patch(`/servers/${sid}/ai-config`).set(owner.auth).send({});
        expect(empty.status).toBe(400);
    });
});

describe('usage', () => {
    test('reports per-capability totals and today\'s totals', async () => {
        await ctx.db.query(
            `INSERT INTO ai_usage_events (id, server_id, provider, model, input_tokens, output_tokens, latency_ms, capability, cost_micros)
             VALUES ('01USAGEAAAAAAAAAAAAAAAAAAA', $1, 'gemini', 'm', 100, 50, 10, 'chat', 45),
                    ('01USAGEBBBBBBBBBBBBBBBBBBB', $1, 'gemini', 'm', 10, 5, 10, 'chat', NULL)`,
            [serverId]
        );
        const res = await ctx.request.get(`${base()}/usage?days=7`).set(owner.auth);
        expect(res.status).toBe(200);
        expect(res.body.days).toBe(7);
        expect(res.body.capabilities).toEqual([{
            capability: 'chat', requests: 2, inputTokens: 110, outputTokens: 55, costMicros: 45, errors: 0,
            today: { requests: 2, tokens: 165, costMicros: 45 },
        }]);
    });
});
