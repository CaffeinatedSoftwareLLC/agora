import { vi } from 'vitest';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { configureDecisions, jevReply, jsonResponse, stubJev } from '../decision-helpers';
import { decide, decisionReady } from '../../src/ai/decide';
import type { DecideQuestion } from '../../src/ai/adapters';

/**
 * Decision model foundation (docs/planning/jev-wbs.md, J0): settings API, and the
 * internal decide service with its typed outcomes, usage ledger and per-use budgets.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;

const url = () => `/servers/${serverId}/ai/decisions`;
const QUESTIONS: Record<string, DecideQuestion> = { q: { type: 'noul', instructions: 'Is this a test?' } };

const usageRows = async (sid = serverId) =>
    (await ctx.db.query("SELECT * FROM ai_usage_events WHERE server_id = $1 AND capability = 'decide' ORDER BY id", [sid])).rows;

/** A fresh server per group, so budgets and settings never leak between tests. */
async function freshServer(name: string) {
    ({ serverId } = await createServer(ctx.request, owner.auth, name));
    return serverId;
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'decowner');
    member = await authedUser(ctx.request, 'decmember');
    await freshServer('Decisions');
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
});

afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => { await ctx.close(); });

describe('settings API', () => {
    test('non-admins, non-members and bots cannot read or change settings', async () => {
        expect((await ctx.request.get(url()).set(member.auth)).status).toBe(403);
        expect((await ctx.request.patch(url()).set(member.auth).send({ screeningStrict: true })).status).toBe(403);
        const outsider = await authedUser(ctx.request, 'decoutsider');
        expect((await ctx.request.get(url()).set(outsider.auth)).status).toBe(403);
        expect((await ctx.request.get(url())).status).toBe(401);
    });

    test('a server starts with every use off and no row', async () => {
        const res = await ctx.request.get(url()).set(owner.auth);
        expect(res.status).toBe(200);
        expect(res.body.uses).toEqual({
            routing: { enabled: false, sharePct: 25, dailyRequests: null },
            search_screening: { enabled: false, sharePct: 25, dailyRequests: null },
            file_tagging: { enabled: false, sharePct: 25, dailyRequests: null },
            file_ranking: { enabled: false, sharePct: 25, dailyRequests: null },
        });
        expect(res.body).toMatchObject({ screeningStrict: false, routingMinConfidence: 0.6, tagThreshold: 0.5 });
        expect(res.body.screeningFlagThreshold).toBeCloseTo(0.7);
        expect(res.body.route).toEqual({ configured: false, enabled: false, provider: null, adapter: null, model: null });
        expect(res.body.warnings).toEqual([]);
        expect((await ctx.db.query('SELECT 1 FROM ai_decision_settings WHERE server_id = $1', [serverId])).rows).toHaveLength(0);
    });

    test('PATCH changes a subset, keeps the rest, and is audited with only what changed', async () => {
        const res = await ctx.request.patch(url()).set(owner.auth)
            .send({ uses: { search_screening: { enabled: true, dailyRequests: 500 } }, screeningStrict: true });
        expect(res.status).toBe(200);
        expect(res.body.uses.search_screening).toEqual({ enabled: true, sharePct: 25, dailyRequests: 500 });
        expect(res.body.uses.routing.enabled).toBe(false);
        expect(res.body.screeningStrict).toBe(true);
        // On, but nothing to decide with
        expect(res.body.warnings.join(' ')).toContain('no decision model is configured');

        const changes = await ctx.request.get(`/servers/${serverId}/ai/changes`).set(owner.auth);
        const entry = changes.body.find((c: any) => c.action === 'ai_decision_update');
        expect(entry.actor.username).toBe('decowner');
        expect(entry.changes.changed.sort()).toEqual(['screeningStrict', 'search_screening.dailyRequests', 'search_screening.enabled']);
        expect(entry.changes.after).toEqual({ 'search_screening.enabled': true, 'search_screening.dailyRequests': 500, screeningStrict: true });
    });

    test('a PATCH that changes nothing writes no audit entry', async () => {
        const count = async () => (await ctx.db.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE server_id = $1 AND action = 'ai_decision_update'", [serverId])).rows[0].n;
        const before = await count();
        expect((await ctx.request.patch(url()).set(owner.auth).send({ screeningStrict: true })).status).toBe(200);
        expect(await count()).toBe(before);
    });

    test('rejects shares over 100%, inverted thresholds, unknown fields and out-of-range values', async () => {
        const over = await ctx.request.patch(url()).set(owner.auth).send({ uses: { file_tagging: { sharePct: 60 } } });
        expect(over.status).toBe(400);
        expect(over.body.error).toContain('135%');
        const inverted = await ctx.request.patch(url()).set(owner.auth).send({ screeningSuspectThreshold: 0.9 });
        expect(inverted.status).toBe(400);
        expect((await ctx.request.patch(url()).set(owner.auth).send({ uses: { bribery: { enabled: true } } })).status).toBe(400);
        expect((await ctx.request.patch(url()).set(owner.auth).send({ tagThreshold: 1.5 })).status).toBe(400);
        expect((await ctx.request.patch(url()).set(owner.auth).send({ uses: { routing: { dailyRequests: 0 } } })).status).toBe(400);
        expect((await ctx.request.patch(url()).set(owner.auth).send({})).status).toBe(400);
        // Nothing above was saved
        const now = await ctx.request.get(url()).set(owner.auth);
        expect(now.body.uses.file_tagging.sharePct).toBe(25);
        expect(now.body.screeningSuspectThreshold).toBeCloseTo(0.35);
    });

    test('shares can be rebalanced in one request', async () => {
        const res = await ctx.request.patch(url()).set(owner.auth)
            .send({ uses: { file_tagging: { sharePct: 55 }, file_ranking: { sharePct: 5 }, routing: { sharePct: 15 } } });
        expect(res.status).toBe(200);
        expect([res.body.uses.file_tagging.sharePct, res.body.uses.file_ranking.sharePct, res.body.uses.routing.sharePct]).toEqual([55, 5, 15]);
    });

    test('shows the decide route once configured, and never the key', async () => {
        await configureDecisions(ctx.request, owner.auth, serverId);
        const res = await ctx.request.get(url()).set(owner.auth);
        expect(res.body.route).toEqual({ configured: true, enabled: true, provider: 'TypeSafe Jev (decisions)', adapter: 'typesafe', model: 'jev-latest' });
        expect(JSON.stringify(res.body)).not.toContain('ts-test-key');
        expect(res.body.warnings).toEqual([]);
    });

    test('warns when strict screening meets a Gemini search route', async () => {
        const gemini = await ctx.request.post(`/servers/${serverId}/ai/providers`).set(owner.auth).send({ adapter: 'gemini', apiKey: 'g' });
        await ctx.request.put(`/servers/${serverId}/ai/routes/search`).set(owner.auth).send({ providerId: gemini.body.id, model: 'gemini-3.8-flash', enabled: true });
        const res = await ctx.request.get(url()).set(owner.auth);
        expect(res.body.warnings).toHaveLength(1);
        expect(res.body.warnings[0]).toContain('every search will be refused');
    });

    test('the provider test endpoint makes one small decision call', async () => {
        const { calls } = stubJev(() => jevReply({ ok: 1 }));
        const providers = await ctx.request.get(`/servers/${serverId}/ai/providers`).set(owner.auth);
        const typesafe = providers.body.find((p: any) => p.adapter === 'typesafe');
        const res = await ctx.request.post(`/servers/${serverId}/ai/providers/${typesafe.id}/test`).set(owner.auth).send({});
        expect(res.body).toEqual({ ok: true });
        expect(calls).toHaveLength(1);
        expect(calls[0].model).toBe('jev-latest');
    });

    test('a decide route cannot point at a provider that makes no decisions', async () => {
        const providers = await ctx.request.get(`/servers/${serverId}/ai/providers`).set(owner.auth);
        const gemini = providers.body.find((p: any) => p.adapter === 'gemini');
        const res = await ctx.request.put(`/servers/${serverId}/ai/routes/decide`).set(owner.auth).send({ providerId: gemini.id, model: 'x' });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('does not support "decide"');
    });
});

describe('decide service: off means off', () => {
    test('no settings and no route: disabled, zero calls, nothing recorded', async () => {
        await freshServer('Off 1');
        const { fetchMock } = stubJev(() => jevReply({ q: 0.5 }));
        const out = await decide(ctx.db, { serverId, use: 'routing', state: 'x', questions: QUESTIONS });
        expect(out).toMatchObject({ status: 'disabled', retryable: false });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(await usageRows()).toHaveLength(0);
    });

    test('use on but no route: unconfigured, zero calls', async () => {
        await freshServer('Off 2');
        await ctx.request.patch(url()).set(owner.auth).send({ uses: { routing: { enabled: true } } });
        const { fetchMock } = stubJev(() => jevReply({ q: 0.5 }));
        expect(await decide(ctx.db, { serverId, use: 'routing', state: 'x', questions: QUESTIONS })).toMatchObject({ status: 'unconfigured' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('route configured but the use is off, the share is 0, the route is off, or the provider is off: zero calls', async () => {
        await freshServer('Off 3');
        const { providerId } = await configureDecisions(ctx.request, owner.auth, serverId, { settings: { uses: { routing: { enabled: true } } } });
        const { fetchMock } = stubJev(() => jevReply({ q: 0.5 }));

        // Another use is still off
        expect(await decide(ctx.db, { serverId, use: 'file_tagging', state: 'x', questions: QUESTIONS })).toMatchObject({ status: 'disabled' });

        await ctx.request.patch(url()).set(owner.auth).send({ uses: { routing: { sharePct: 0 } } });
        expect(await decide(ctx.db, { serverId, use: 'routing', state: 'x', questions: QUESTIONS })).toMatchObject({ status: 'disabled' });
        await ctx.request.patch(url()).set(owner.auth).send({ uses: { routing: { sharePct: 25 } } });

        await ctx.request.put(`/servers/${serverId}/ai/routes/decide`).set(owner.auth).send({ providerId, model: 'jev-latest', enabled: false });
        expect(await decide(ctx.db, { serverId, use: 'routing', state: 'x', questions: QUESTIONS })).toMatchObject({ status: 'disabled' });
        await ctx.request.put(`/servers/${serverId}/ai/routes/decide`).set(owner.auth).send({ providerId, model: 'jev-latest', enabled: true });

        await ctx.request.patch(`/servers/${serverId}/ai/providers/${providerId}`).set(owner.auth).send({ enabled: false });
        expect(await decide(ctx.db, { serverId, use: 'routing', state: 'x', questions: QUESTIONS })).toMatchObject({ status: 'unconfigured' });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(await usageRows()).toHaveLength(0);
    });
});

describe('decide service: calls, ledger, failures', () => {
    beforeAll(async () => {
        await freshServer('Calls');
        await configureDecisions(ctx.request, owner.auth, serverId, {
            route: { inputPriceMicrosPerMtok: 42_000 },
            settings: { uses: { routing: { enabled: true }, search_screening: { enabled: true } } },
        });
    });

    test('ok: validated answers, usage recorded under the use and the model that answered', async () => {
        const { calls } = stubJev(() => jevReply({ q: 0.93 }, { input_tokens: 1_000_000, output_tokens: 5 }));
        const out = await decide(ctx.db, { serverId, use: 'search_screening', state: { text: 'hello' }, questions: QUESTIONS, userId: owner.userId });
        expect(out).toMatchObject({ status: 'ok', model: 'jev-1.13.0', usage: { inputTokens: 1_000_000, outputTokens: 5 }, answers: { q: { type: 'noul', probability: 0.93 } } });
        expect(calls[0]).toEqual({ model: 'jev-latest', state: { text: 'hello' }, questions: QUESTIONS });

        const [row] = await usageRows();
        expect(row).toMatchObject({ decision_use: 'search_screening', model: 'jev-1.13.0', provider: 'typesafe', input_tokens: 1_000_000, error: null });
        expect(Number(row.cost_micros)).toBe(42_000);
        expect(row.user_id.trim()).toBe(owner.userId);
    });

    test('a malformed answer is invalid_response, recorded as an error, and never returned as a verdict', async () => {
        stubJev(() => ({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 7 } }, usage: { input_tokens: 10, output_tokens: 1 } }));
        const out = await decide(ctx.db, { serverId, use: 'routing', state: 'x', questions: QUESTIONS });
        expect(out).toMatchObject({ status: 'invalid_response', retryable: false });
        expect(out).not.toHaveProperty('answers');
        const rows = await usageRows();
        expect(rows.at(-1)).toMatchObject({ decision_use: 'routing' });
        expect(rows.at(-1).error).toContain('invalid answer');
    });

    test('a wrong key is a permanent provider_error; a rate limit is retryable; the key never reaches the ledger', async () => {
        stubJev(() => jsonResponse({ detail: { message: 'Cannot authenticate with the server.' } }, 401));
        expect(await decide(ctx.db, { serverId, use: 'routing', state: 'x', questions: QUESTIONS }))
            .toEqual({ status: 'provider_error', reason: 'TypeSafe API 401: Cannot authenticate with the server.', retryable: false });

        stubJev(() => jsonResponse({ detail: 'slow down' }, 429, { 'Retry-After': '60' }));
        expect(await decide(ctx.db, { serverId, use: 'routing', state: 'x', questions: QUESTIONS, timeoutMs: 300 }))
            .toMatchObject({ status: 'provider_error', retryable: true });

        const rows = await usageRows();
        expect(JSON.stringify(rows)).not.toContain('ts-test-key');
        expect(rows.filter((r: any) => r.error).length).toBeGreaterThanOrEqual(3);
    });

    test('a hung provider is cut off at the deadline', async () => {
        vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        })));
        const started = Date.now();
        const out = await decide(ctx.db, { serverId, use: 'routing', state: 'x', questions: QUESTIONS, timeoutMs: 250 });
        expect(out).toMatchObject({ status: 'provider_error', retryable: true });
        expect(Date.now() - started).toBeLessThan(1500);
    });

    test('an oversized request is refused before any call', async () => {
        const { fetchMock } = stubJev(() => jevReply({ q: 0.5 }));
        const before = (await usageRows()).length;
        const out = await decide(ctx.db, { serverId, use: 'routing', state: 'a'.repeat(100_000), questions: QUESTIONS });
        expect(out).toMatchObject({ status: 'too_large', retryable: false });
        expect(fetchMock).not.toHaveBeenCalled();
        expect((await usageRows()).length).toBe(before);
    });

    test('concurrent calls each get their own answer', async () => {
        stubJev(async (call) => {
            await new Promise(r => setTimeout(r, 20 + Math.random() * 40));
            return jevReply({ q: Number(call.state) / 100 });
        });
        const outs = await Promise.all(Array.from({ length: 8 }, (_, i) =>
            decide(ctx.db, { serverId, use: 'routing', state: String(i), questions: QUESTIONS })));
        outs.forEach((out, i) => expect(out).toMatchObject({ status: 'ok', answers: { q: { probability: i / 100 } } }));
    });
});

describe('decide service: budgets', () => {
    test('the route total applies to every use', async () => {
        await freshServer('Budget total');
        await configureDecisions(ctx.request, owner.auth, serverId, {
            route: { dailyRequestLimit: 2 },
            settings: { uses: { routing: { enabled: true, sharePct: 50 }, search_screening: { enabled: true, sharePct: 50 }, file_tagging: { sharePct: 0 }, file_ranking: { sharePct: 0 } } },
        });
        const { fetchMock } = stubJev(() => jevReply({ q: 0.5 }));
        expect((await decide(ctx.db, { serverId, use: 'routing', state: 'x', questions: QUESTIONS })).status).toBe('ok');
        expect((await decide(ctx.db, { serverId, use: 'search_screening', state: 'x', questions: QUESTIONS })).status).toBe('ok');
        const third = await decide(ctx.db, { serverId, use: 'search_screening', state: 'x', questions: QUESTIONS });
        expect(third).toMatchObject({ status: 'over_budget', retryable: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('a tagging backfill cannot use up the share of screening', async () => {
        await freshServer('Budget share');
        await configureDecisions(ctx.request, owner.auth, serverId, {
            route: { dailyRequestLimit: 20 },
            settings: { uses: {
                file_tagging: { enabled: true, sharePct: 25 }, search_screening: { enabled: true, sharePct: 25 },
            } },
        });
        const { fetchMock } = stubJev(() => jevReply({ q: 0.5 }));

        // Tagging's share of 20 requests is 5
        const tagging = [];
        for (let i = 0; i < 9; i++) tagging.push((await decide(ctx.db, { serverId, use: 'file_tagging', state: 'x', questions: QUESTIONS })).status);
        expect(tagging).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'over_budget', 'over_budget', 'over_budget', 'over_budget']);

        // Screening still has all of its own share
        for (let i = 0; i < 5; i++) {
            expect((await decide(ctx.db, { serverId, use: 'search_screening', state: 'x', questions: QUESTIONS })).status).toBe('ok');
        }
        const out = await decide(ctx.db, { serverId, use: 'search_screening', state: 'x', questions: QUESTIONS });
        expect(out).toMatchObject({ status: 'over_budget' });
        expect((out as any).reason).toContain('search screening');
        expect(fetchMock).toHaveBeenCalledTimes(10);

        const view = await ctx.request.get(url()).set(owner.auth);
        expect(view.body.today.file_tagging.requests).toBe(5);
        expect(view.body.today.search_screening.requests).toBe(5);
        expect(view.body.today.routing.requests).toBe(0);
    });

    test('token shares are enforced per use', async () => {
        await freshServer('Budget tokens');
        await configureDecisions(ctx.request, owner.auth, serverId, {
            route: { dailyTokenLimit: 1000 },
            settings: { uses: { file_tagging: { enabled: true, sharePct: 50 }, routing: { enabled: true, sharePct: 50 }, search_screening: { sharePct: 0 }, file_ranking: { sharePct: 0 } } },
        });
        stubJev(() => jevReply({ q: 0.5 }, { input_tokens: 490, output_tokens: 10 }));
        expect((await decide(ctx.db, { serverId, use: 'file_tagging', state: 'x', questions: QUESTIONS })).status).toBe('ok');
        expect(await decide(ctx.db, { serverId, use: 'file_tagging', state: 'x', questions: QUESTIONS })).toMatchObject({ status: 'over_budget' });
        expect((await decide(ctx.db, { serverId, use: 'routing', state: 'x', questions: QUESTIONS })).status).toBe('ok');
    });

    test('a route with no limits is isolated by the per-use request cap', async () => {
        await freshServer('Budget cap');
        await configureDecisions(ctx.request, owner.auth, serverId, {
            settings: { uses: { file_tagging: { enabled: true, dailyRequests: 2 }, routing: { enabled: true } } },
        });
        stubJev(() => jevReply({ q: 0.5 }));
        expect((await decide(ctx.db, { serverId, use: 'file_tagging', state: 'x', questions: QUESTIONS })).status).toBe('ok');
        expect((await decide(ctx.db, { serverId, use: 'file_tagging', state: 'x', questions: QUESTIONS })).status).toBe('ok');
        expect((await decide(ctx.db, { serverId, use: 'file_tagging', state: 'x', questions: QUESTIONS })).status).toBe('over_budget');
        for (let i = 0; i < 4; i++) expect((await decide(ctx.db, { serverId, use: 'routing', state: 'x', questions: QUESTIONS })).status).toBe('ok');
    });

    test('rows written before per-use tracking count toward the total only', async () => {
        await freshServer('Budget legacy');
        const { providerId } = await configureDecisions(ctx.request, owner.auth, serverId, {
            route: { dailyRequestLimit: 4 },
            settings: { uses: { routing: { enabled: true, sharePct: 50 }, file_tagging: { sharePct: 0 } } },
        });
        await ctx.db.query(
            `INSERT INTO ai_usage_events (id, server_id, provider, model, capability, provider_id)
             SELECT gen_ulid(), $1, 'typesafe', 'jev-1.13.0', 'decide', $2 FROM generate_series(1, 3)`,
            [serverId, providerId]
        );
        stubJev(() => jevReply({ q: 0.5 }));
        // Routing's share is 2 and it has used none, but only one request is left in the total
        expect((await decide(ctx.db, { serverId, use: 'routing', state: 'x', questions: QUESTIONS })).status).toBe('ok');
        expect((await decide(ctx.db, { serverId, use: 'routing', state: 'x', questions: QUESTIONS })).status).toBe('over_budget');
    });

    test('decisionReady answers without calling, and decide can reuse it', async () => {
        await freshServer('Ready');
        await configureDecisions(ctx.request, owner.auth, serverId, { settings: { uses: { file_ranking: { enabled: true } } } });
        const { fetchMock } = stubJev(() => jevReply({ q: 0.5 }));
        const ready = await decisionReady(ctx.db, serverId, 'file_ranking');
        expect(ready.ok).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        expect((await decide(ctx.db, { serverId, use: 'file_ranking', state: 'x', questions: QUESTIONS, ready })).status).toBe('ok');
        expect((await decisionReady(ctx.db, serverId, 'routing')).ok).toBe(false);
    });
});
