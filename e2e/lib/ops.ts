/**
 * Shared steps for the crash and outage specs (beta-test-plan §3.5 OP-02 / OP-03): requests
 * that give up instead of hanging, the end-of-test health check, and the stub chat provider.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { Api } from './api';
import { E2E_DIR, e2eEnv } from './env';
import { waitFor } from './fake-host';
import { allRunning, logs, removeStub, startStub } from './containers';
import type { Seed } from './seed-types';

export interface TimedResult { status: number | null; ms: number; data: any }

/**
 * One request with a client-side deadline. `status: null` means no answer within `ms` (the API
 * hung). Never throws for HTTP errors or the deadline.
 */
export async function timedReq(api: Api, method: string, p: string, body: unknown, ms: number, extra: Record<string, string> = {}): Promise<TimedResult> {
    const headers: Record<string, string> = { ...extra };
    if (api.auth) headers.Authorization = api.auth;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const started = Date.now();
    try {
        const res = await fetch(api.base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(ms) });
        const text = await res.text();
        let data: any = text;
        try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, ms: Date.now() - started, data };
    } catch {
        return { status: null, ms: Date.now() - started, data: null };
    }
}

/**
 * The instance is healthy again: every agora-e2e container runs unpaused, API and web answer
 * /health, and an authenticated read works (that path needs Postgres and Redis). Waits up to
 * `timeoutMs` for it, then fails with what is still wrong.
 */
export async function expectHealthy(seed: Seed, timeoutMs = 60_000) {
    const { apiURL, baseURL } = e2eEnv();
    const owner = new Api(apiURL).with(`Bearer ${seed.secrets.ownerToken}`);
    let last = '';
    await waitFor('instance healthy', async () => {
        const bad = await allRunning();
        const api = await timedReq(new Api(apiURL), 'GET', '/health', undefined, 5_000);
        const web = await timedReq(new Api(baseURL), 'GET', '/health', undefined, 5_000);
        const session = await timedReq(owner, 'GET', '/auth/session', undefined, 5_000);
        last = JSON.stringify({ containers: bad, api: api.status, web: web.status, session: session.status });
        return bad.length === 0 && api.status === 200 && web.status === 200 && session.status === 200;
    }, timeoutMs, 1000).catch(() => { throw new Error(`instance not healthy after ${timeoutMs / 1000} s: ${last}`); });
}

// ---- stub chat provider (OP-03.provider-down, OP-03.ws-loss) ----

const STUB_DIR = path.join(E2E_DIR, 'fake-provider');
export type StubMode = 'ok' | 'slow' | 'r429' | 'hang';

export interface StubProvider {
    tag: string; stub: string; providerId: string; botId: string; botUsername: string;
    /** Point the chat provider at a stub mode, or at a closed port (`dead`). */
    use(mode: StubMode | 'dead'): Promise<void>;
    /** Requests the stub has seen for a mode (this run's tag only). */
    hits(mode: StubMode): Promise<number>;
    /** Per-capability chat usage totals (GET /servers/:id/ai/usage). */
    usage(): Promise<{ requests: number; errors: number; tokens: number; costMicros: number }>;
    restore(): Promise<void>;
}

/**
 * Start the stub container and route the seeded server's chat capability to it through an
 * OpenAI-compatible provider. Private base URLs are allowed for the test and the previous
 * setting, chat route and assistant state are put back by restore().
 */
export async function setupStubProvider(seed: Seed): Promise<StubProvider> {
    const owner = new Api(e2eEnv().apiURL).with(`Bearer ${seed.secrets.ownerToken}`);
    const sid = seed.serverId;
    const tag = `p${seed.runTag}${crypto.randomBytes(2).toString('hex')}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    const stub = `agora-e2e-provstub-${tag}`.slice(0, 60);

    const prevPrivate = ((await owner.ok('GET', '/admin/settings/ai')) as any).allowPrivateBaseUrls === true;
    const prevRoute = ((await owner.ok('GET', `/servers/${sid}/ai/routes`)) as any[]).find(r => r.capability === 'chat') ?? null;
    const prevConfig = (await owner.ok('GET', `/servers/${sid}/ai-config`)) as any;
    let providerId = '';

    const restore = async () => {
        const errors: string[] = [];
        const step = async (what: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { errors.push(`${what}: ${(e as Error).message}`); } };
        if (prevRoute) {
            await step('chat route', () => owner.ok('PUT', `/servers/${sid}/ai/routes/chat`, {
                providerId: prevRoute.providerId, model: prevRoute.model, enabled: prevRoute.enabled,
                dailyRequestLimit: prevRoute.dailyRequestLimit, dailyTokenLimit: prevRoute.dailyTokenLimit, dailyCostLimitMicros: prevRoute.dailyCostLimitMicros,
                inputPriceMicrosPerMtok: prevRoute.inputPriceMicrosPerMtok, outputPriceMicrosPerMtok: prevRoute.outputPriceMicrosPerMtok,
            }));
        } else {
            await step('chat route', () => owner.ok('DELETE', `/servers/${sid}/ai/routes/chat`, undefined, [200, 404]));
        }
        if (providerId) await step('provider', () => owner.ok('DELETE', `/servers/${sid}/ai/providers/${providerId}`, undefined, [200, 204, 404]));
        await step('assistant', () => owner.ok('PATCH', `/servers/${sid}/ai-config`, { enabled: prevConfig.configured ? !!prevConfig.enabled : false }));
        await step('private base urls', () => owner.ok('PATCH', '/admin/settings/ai', { allowPrivateBaseUrls: prevPrivate }));
        await step('stub', () => removeStub(stub));
        if (errors.length) throw new Error(`stub provider restore incomplete: ${errors.join('; ')}`);
    };

    try {
        await startStub(stub, { image: 'agora-e2e-server:e2e', mountDir: STUB_DIR, cmd: ['node', '/stub/provider-stub.mjs'], env: { STUB_SLOW_MS: '500' } });
        await waitFor('stub ready', async () => (await logs(stub)).includes('READY'), 20_000, 500);
        await owner.ok('PATCH', '/admin/settings/ai', { allowPrivateBaseUrls: true });
        const base = (mode: StubMode | 'dead') => mode === 'dead' ? `http://${stub}:9/dead/${tag}/v1` : `http://${stub}:8080/${mode}/${tag}/v1`;
        const p = (await owner.ok('POST', `/servers/${sid}/ai/providers`, { adapter: 'openai', label: `e2e-stub-${tag}`, baseUrl: base('ok') }, [201])) as any;
        providerId = String(p.id).trim();
        // Prices set, so a charged request would show a cost (the ok control checks it does)
        await owner.ok('PUT', `/servers/${sid}/ai/routes/chat`, { providerId, model: 'stub-model', enabled: true,
            inputPriceMicrosPerMtok: 1_000_000, outputPriceMicrosPerMtok: 2_000_000 });
        const botId = String(((await owner.ok('POST', `/servers/${sid}/ai-config/assistant`)) as any).botId).trim();
        await owner.ok('PATCH', `/servers/${sid}/ai-config`, { enabled: true });
        const botUsername: string = ((await owner.ok('GET', `/servers/${sid}/bots/${botId}`)) as any).username;

        return {
            tag, stub, providerId, botId, botUsername,
            async use(mode) { await owner.ok('PATCH', `/servers/${sid}/ai/providers/${providerId}`, { baseUrl: base(mode) }); },
            async hits(mode) { return (await logs(stub)).split(/\r?\n/).filter(l => l === `HIT ${mode} ${tag}`).length; },
            async usage() {
                const u = (await owner.ok('GET', `/servers/${sid}/ai/usage?days=1`)) as any;
                const chat = (u.capabilities as any[]).find(c => c.capability === 'chat');
                return { requests: chat?.requests ?? 0, errors: chat?.errors ?? 0, tokens: (chat?.inputTokens ?? 0) + (chat?.outputTokens ?? 0), costMicros: chat?.costMicros ?? 0 };
            },
            restore,
        };
    } catch (e) {
        await restore().catch(() => undefined);
        throw e;
    }
}

/** A channel the assistant bot can read and post in. */
export async function assistantChannel(seed: Seed, botId: string, name: string): Promise<{ id: string; name: string }> {
    const owner = new Api(e2eEnv().apiURL).with(`Bearer ${seed.secrets.ownerToken}`);
    const id: string = ((await owner.ok('POST', `/servers/${seed.serverId}/channels`, { name, channelType: 3 }, [201])) as any).id.trim();
    await owner.ok('POST', `/channels/${id}/bots/${botId}`, undefined, [200, 201]);
    return { id, name };
}

/** Wait until the assistant's reply to a prompt is final (no longer the "..." placeholder). */
export async function assistantReply(api: Api, channelId: string, botId: string, after: string, timeoutMs: number): Promise<any> {
    return waitFor('assistant reply', async () => {
        const msgs = (await api.ok('GET', `/channels/${channelId}/messages?limit=20`)) as any[];
        return msgs.find(m => String(m.authorId ?? m.author_id ?? '').trim() === botId && String(m.id).trim() > after && m.content !== '...');
    }, timeoutMs, 700);
}

