import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { PoolClient } from 'pg';
vi.mock('../../src/routes/ai-config', () => ({ requireAdmin: async () => {} }));
import { aiProviderRoutes } from '../../src/routes/ai-providers';
import { openaiAdapter } from '../../src/ai/adapters/openai';
import { tavilyAdapter } from '../../src/ai/adapters/tavily';
afterEach(() => vi.restoreAllMocks());
async function fixture(routes: Array<{ capability: string; model: string }> = [], adapter = 'openai', baseUrl: string | null = null) {
    const app = Fastify();
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM ai_providers')
        ? [{ id: 'P', adapter, base_url: baseUrl, api_key_enc: null }]
        : sql.includes('FROM ai_capability_routes') ? routes : [] }));
    app.addHook('onRequest', async request => { request.dbClient = { query } as unknown as PoolClient; });
    await app.register(aiProviderRoutes); await app.ready();
    return { app, post: (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/servers/S/ai/providers/P/test', payload: body }) };
}

it('old Test clients infer speech capability from the configured provider route', async () => {
    const spy = vi.spyOn(openaiAdapter, 'testConnection').mockResolvedValue({ ok: true });
    const f = await fixture([{ capability: 'tts', model: 'kokoro' }]);
    try {
        expect((await f.post({ model: 'kokoro' })).json()).toEqual({ ok: true });
        expect(spy).toHaveBeenCalledWith({ apiKey: undefined, baseUrl: undefined }, 'kokoro', 'tts');
    } finally { await f.app.close(); }
});

it('an omitted model uses the selected speech route model', async () => {
    const spy = vi.spyOn(openaiAdapter, 'testConnection').mockResolvedValue({ ok: true });
    const f = await fixture([{ capability: 'stt', model: 'whisper' }]);
    try {
        expect((await f.post({})).statusCode).toBe(200);
        expect(spy).toHaveBeenCalledWith(expect.anything(), 'whisper', 'stt');
    } finally { await f.app.close(); }
});

it('an explicit speech capability works before routes or model names are saved', async () => {
    const spy = vi.spyOn(openaiAdapter, 'testConnection').mockResolvedValue({ ok: true });
    const f = await fixture();
    try {
        expect((await f.post({ capability: 'stt' })).json()).toEqual({ ok: true });
        expect(spy).toHaveBeenCalledWith(expect.anything(), '', 'stt');
    } finally { await f.app.close(); }
});

it('rejects capabilities the adapter does not support', async () => {
    const spy = vi.spyOn(openaiAdapter, 'testConnection').mockResolvedValue({ ok: true });
    const f = await fixture();
    try {
        expect((await f.post({ model: 'm', capability: 'image' })).statusCode).toBe(400);
        expect(spy).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
});

it('preserves default Test behavior for a search-only adapter', async () => {
    const spy = vi.spyOn(tavilyAdapter, 'testConnection').mockResolvedValue({ ok: true });
    const f = await fixture([], 'tavily');
    try {
        expect((await f.post({})).json()).toEqual({ ok: true });
        expect(spy).toHaveBeenCalledWith(expect.anything(), 'basic', 'search');
    } finally { await f.app.close(); }
});

it('chat still requires a model if there is no default or route', async () => {
    const spy = vi.spyOn(openaiAdapter, 'testConnection').mockResolvedValue({ ok: true });
    const f = await fixture();
    try {
        expect((await f.post({ capability: 'chat' })).statusCode).toBe(400);
        expect(spy).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
});

it('keeps the private-base-URL guard ahead of a speech test', async () => {
    const spy = vi.spyOn(openaiAdapter, 'testConnection').mockResolvedValue({ ok: true });
    const f = await fixture([], 'openai', 'http://127.0.0.1:8000/v1');
    try {
        expect((await f.post({ capability: 'tts' })).json()).toMatchObject({ ok: false, error: expect.stringContaining('private') });
        expect(spy).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
});
