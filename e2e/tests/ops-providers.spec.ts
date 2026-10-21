/**
 * AI providers in Settings → AI (beta-test-plan §3.5 OP-06). For each provider: save, Test,
 * one tiny invoke, a bad key, a 429, a timeout and a wrong endpoint, then the fix, checking at
 * each step what Settings → AI shows and that no API response or socket frame carries a key.
 *
 * - Real keys: Anthropic, OpenAI and Gemini use the AGORA_TEST_*_KEY test keys
 *   (lib/agent-keys.ts), only with E2E_AGENT_LIVE=1. They stay in memory: never in a title,
 *   annotation, assertion message or file. Each test registers them with `sensitive.addInMemory`
 *   (scrubbed failure text, no failure screenshot) and the end-of-run leak scan gets them from
 *   agentKeysForScan(). Tracing is off for this file (a trace would record the typed key).
 *   Screenshots are taken only after checking the page shows no key.
 * - Spend: per real provider one invoke (cheapest model, "reply OK") and a few Test calls
 *   (max_tokens 1). The bad-key, 429, timeout and wrong-endpoint states point the provider at
 *   a fake key or at the provider stub (fake-provider/provider-stub.mjs), so a real key is
 *   never sent to the stub.
 * - Anthropic, Gemini, Tavily and TypeSafe take no base URL (the API refuses one, checked), so
 *   the stub can't stand in front of them: their 429/timeout/wrong-endpoint cases are
 *   not_applicable. The timeout case (Node's 300 s fetch timeout) runs once, for OpenAI.
 * - Providers without a key or a reachable server (OpenAI-compatible/Ollama, Kokoro, Whisper,
 *   Tavily, TypeSafe Jev) are covered with fake keys and the stub.
 * - Everything this file creates is deleted in afterAll, and the instance's previous state
 *   (allow private base URLs, the assistant's enabled flag, voice settings, routes) is put back
 *   and read back; the result goes to artifacts/<run>/op06-cleanup.jsonl (one line per worker).
 * - Per-test evidence (UI texts, timings, counts) goes to artifacts/<run>/op06-evidence.jsonl.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, apis, openChannel, loadSeed } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { artifactsDir, e2eEnv, E2E_DIR } from '../lib/env';
import { waitFor } from '../lib/fake-host';
import { freshChannel, rowWith } from '../lib/helpers';
import { trimId } from '../lib/agents';
import { logs, readOnlyQuery, removeStub, startStub } from '../lib/containers';
import { assistantChannel, assistantReply, timedReq } from '../lib/ops';
import { liveGate, testKey, type AgentAdapter } from '../lib/agent-keys';
import type { Api } from '../lib/api';
import type { Sensitive } from '../lib/sensitive';
import type { Seed } from '../lib/seed-types';

const LIVE = liveGate();
const PREFIX = 'e2e-op06-';
const PROVIDER_FIELDS = ['adapter', 'baseUrl', 'capabilities', 'createdAt', 'enabled', 'hasApiKey', 'id', 'label', 'updatedAt'];

/** Fake keys: never real, never shaped like a provider key (so the pattern scan stays meaningful). */
const fakeKey = (what: string) => `e2e-invalid-${what}-${crypto.randomBytes(12).toString('hex')}`;

// ---- key watch: every JSON body and socket frame the page receives, plus the API sweeps ----

class KeyWatch {
    private values: string[] = [];
    checked = 0;
    hits: string[] = [];
    add(v: string) { if (v && v.length >= 8 && !this.values.includes(v)) this.values.push(v); }
    has(text: string) { return this.values.some(v => text.includes(v)); }
    check(where: string, text: string) {
        this.checked++;
        if (this.has(text) && !this.hits.includes(where)) this.hits.push(where);
    }
    attach(page: Page) {
        const origin = new URL(e2eEnv().baseURL).origin;
        page.on('response', async r => {
            let u: URL;
            try { u = new URL(r.url()); } catch { return; }
            if (u.origin !== origin || !(r.headers()['content-type'] ?? '').includes('json')) return;
            try { this.check(`${r.request().method()} ${u.pathname}`, await r.text()); } catch { /* page moved on */ }
        });
        page.on('websocket', ws => ws.on('framereceived', f => this.check('socket frame', typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8'))));
    }
}
const watch = new KeyWatch();

// ---- shared state (one worker, so module state lives for the whole file) ----

let seed: Seed;
let owner: Api;
let sid = '';
let tag = '';
let stub = '';
let botId = '';
let botUsername = '';
const created = new Map<string, string>(); // label -> provider id
let prev: { allowPrivate: boolean; configEnabled: boolean; configured: boolean; routes: any[]; voice: Record<string, unknown> } | null = null;

const stubBase = (mode: string) => `http://${stub}:8080/${mode}/${tag}/v1`;
const stubHits = async (mode: string) => (await logs(stub)).split(/\r?\n/).filter(l => l === `HIT ${mode} ${tag}`).length;

/** Register every value this test could show, before anything runs. */
function guard(sensitive: Sensitive, ...values: string[]) {
    for (const v of values) { sensitive.addInMemory(v); watch.add(v); }
}
function realKey(a: AgentAdapter) { return testKey(a); }

/** One request; errors name the path and status only (a body could echo a key). */
async function call(method: string, p: string, body?: unknown, expectStatus: number[] = [200]) {
    const r = await owner.req(method, p, body);
    const text = JSON.stringify(r.data ?? null);
    watch.check(`${method} ${p.replace(/\?.*$/, '')}`, text);
    if (!expectStatus.includes(r.status)) {
        throw new Error(`${method} ${p} -> ${r.status}${watch.has(text) ? '' : ` ${text.slice(0, 200)}`}`);
    }
    return r.data as any;
}

/** Every AI settings read the UI makes, checked for keys; provider rows carry no key field. */
async function sweep() {
    const paths = [`/servers/${sid}/ai/providers`, `/servers/${sid}/ai/routes`, `/servers/${sid}/ai-config`, `/servers/${sid}/ai/changes?limit=200`,
        `/servers/${sid}/ai/usage?days=1`, `/servers/${sid}/ai/voice`, `/servers/${sid}/ai/decisions`, `/servers/${sid}/ai/adapters`, '/admin/settings/ai'];
    for (const p of paths) await call('GET', p);
    for (const p of (await call('GET', `/servers/${sid}/ai/providers`)) as any[]) {
        expect(Object.keys(p).sort(), 'a provider row has exactly the public fields').toEqual(PROVIDER_FIELDS);
    }
}
function expectNoKeyReturned() {
    expect(watch.hits, 'API responses or socket frames that contained a key (paths only)').toEqual([]);
    expect(watch.checked).toBeGreaterThan(0);
}

/** The stored key is encrypted: the column holds neither the key nor its base64. */
async function expectStoredEncrypted(providerId: string, key: string) {
    if (!/^[0-9A-Z]{26}$/.test(providerId)) throw new Error('not a provider id');
    const [row] = await readOnlyQuery(`SELECT api_key_enc, api_key_iv IS NOT NULL AND api_key_tag IS NOT NULL FROM ai_providers WHERE id = '${providerId}'`);
    const [enc, ivTag] = row.split('\t');
    expect(ivTag, 'IV and auth tag stored').toBe('t');
    expect(enc.length).toBeGreaterThan(0);
    expect(enc.includes(key) || enc.includes(Buffer.from(key).toString('base64')), 'the key column is ciphertext').toBe(false);
}

async function providerByLabel(label: string) {
    return ((await call('GET', `/servers/${sid}/ai/providers`)) as any[]).find(p => p.label === label);
}

// ---- Settings → AI page ----

async function openSettings(page: Page) {
    await page.goto('/settings/ai');
    await expect(page.getByRole('heading', { name: 'Providers', level: 3 })).toBeVisible({ timeout: 20_000 });
}
const rowOf = (page: Page, label: string) =>
    page.getByLabel(`Test model for ${label}`, { exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');

/** Neither the page text nor any input value holds a key (checked here, the key never goes to the page). */
async function expectNoKeyOnScreen(page: Page) {
    const text = await page.evaluate(() => (document.body?.innerText ?? '') + '\n'
        + Array.from(document.querySelectorAll('input, textarea')).map(e => (e as HTMLInputElement).value).join('\n'));
    expect(watch.has(text), 'a key is on screen').toBe(false);
}
async function safeSnap(page: Page, ti: any, id: string, step: string, expectation: string, ready: any) {
    await ready.waitFor({ state: 'visible', timeout: 15_000 });
    await expectNoKeyOnScreen(page);
    await snap(page, ti, id, step, expectation, { ready });
}

async function addProvider(page: Page, o: { type: string; label: string; key?: string; baseUrl?: string }) {
    await openSettings(page);
    await page.getByRole('button', { name: 'Add provider' }).click();
    await page.locator('#ai-adapter').selectOption({ label: o.type });
    await page.getByLabel('Label', { exact: true }).fill(o.label);
    if (o.key) await page.getByLabel(/^API key/).fill(o.key);
    if (o.baseUrl) await page.getByLabel('Base URL (optional)').fill(o.baseUrl);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const row = rowOf(page, o.label);
    await expect(row, 'the new provider is listed').toBeVisible({ timeout: 15_000 });
    // The form closed, so its key field (and the typed key) is gone from the page
    await expect(page.getByLabel(/^API key/)).toHaveCount(0);
    const p = await providerByLabel(o.label);
    expect(p, 'the provider is stored').toBeTruthy();
    created.set(o.label, p.id);
    return { row, provider: p };
}

interface TestResult { ok: boolean; text: string; ms: number }

/** Click Test on a freshly loaded page and read the result line. */
async function runTest(page: Page, label: string, model: string, timeoutMs = 60_000): Promise<TestResult> {
    await openSettings(page);
    const row = rowOf(page, label);
    await row.getByLabel(`Test model for ${label}`, { exact: true }).fill(model);
    const started = Date.now();
    await row.getByRole('button', { name: 'Test', exact: true }).click();
    const result = row.locator('span.break-all');
    await expect(result).toBeVisible({ timeout: timeoutMs });
    const text = (await result.innerText()).trim();
    return { ok: ((await result.getAttribute('class')) ?? '').includes('text-online'), text, ms: Date.now() - started };
}

async function replaceKey(page: Page, label: string, key: string) {
    await openSettings(page);
    const row = rowOf(page, label);
    await row.getByRole('button', { name: /^(Replace key|Add key)$/ }).click();
    await row.getByLabel(`New API key for ${label}`).fill(key);
    await row.getByRole('button', { name: 'Save key' }).click();
    await expect(row.getByLabel(`New API key for ${label}`), 'the key field closes after saving').toHaveCount(0, { timeout: 15_000 });
    await expect(row.getByText('Key saved')).toBeVisible();
}

/** Settings → AI → Capabilities: point a capability at a provider and save. */
async function setRoute(page: Page, capability: 'Chat' | 'Speech' | 'Transcription', providerLabel: string, model: string) {
    await openSettings(page);
    const sel = page.getByLabel(`${capability} provider`, { exact: true });
    const row = sel.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
    await sel.selectOption({ label: providerLabel });
    await row.getByLabel(`${capability} model`, { exact: true }).fill(model);
    const on = row.getByRole('checkbox', { name: 'On' });
    if (!(await on.isChecked())) await on.check();
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    const cap = capability === 'Chat' ? 'chat' : capability === 'Speech' ? 'tts' : 'stt';
    const id = created.get(providerLabel);
    return waitFor(`${cap} route saved`, async () => ((await call('GET', `/servers/${sid}/ai/routes`)) as any[])
        .find(r => r.capability === cap && r.providerId === id && r.model === model && r.enabled), 15_000, 500);
}

async function setPrivateUrls(page: Page, on: boolean) {
    await openSettings(page);
    const box = page.getByRole('checkbox', { name: /Allow private network base URLs/ });
    // Controlled by the saved setting: it changes once the PATCH answers
    if ((await box.isChecked()) !== on) await box.click();
    await expect(box).toBeChecked({ checked: on, timeout: 10_000 });
    await waitFor('private base URL setting', async () => ((await call('GET', '/admin/settings/ai')) as any).allowPrivateBaseUrls === on, 10_000, 300);
}

async function usage(capability: string) {
    const u = (await call('GET', `/servers/${sid}/ai/usage?days=1`)) as any;
    const c = (u.capabilities as any[]).find(x => x.capability === capability);
    return { requests: c?.requests ?? 0, errors: c?.errors ?? 0, tokens: (c?.inputTokens ?? 0) + (c?.outputTokens ?? 0) };
}

async function ensureAssistant() {
    if (!botId) {
        botId = trimId(((await call('POST', `/servers/${sid}/ai-config/assistant`)) as any).botId);
        botUsername = ((await call('GET', `/servers/${sid}/bots/${botId}`)) as any).username;
    }
    await call('PATCH', `/servers/${sid}/ai-config`, { enabled: true });
}

/** One chat invoke through the assistant: the reply, the usage delta and the reply on screen. */
async function invoke(page: Page, name: string, prompt: string) {
    await ensureAssistant();
    const ch = await assistantChannel(seed, botId, `${PREFIX}${name}-${tag}`.slice(0, 60));
    await openChannel(page, ch.id, ch.name);
    const before = await usage('chat');
    const q = trimId(((await call('POST', `/channels/${ch.id}/messages`, { content: `@${botUsername} ${prompt}` }, [201])) as any).id);
    const started = Date.now();
    const reply = await assistantReply(owner, ch.id, botId, q, 90_000);
    const ms = Date.now() - started;
    const after = await waitFor('usage recorded', async () => { const u = await usage('chat'); return u.requests > before.requests ? u : null; }, 20_000, 500);
    const content = String(reply.content);
    await expect(rowWith(page, content.slice(0, 40)).first(), 'the reply is shown in the channel').toBeVisible({ timeout: 20_000 });
    return { content, ms, delta: { requests: after.requests - before.requests, errors: after.errors - before.errors, tokens: after.tokens - before.tokens }, ch };
}

function na(id: string, what: string, reason: string) {
    test(`[${id}] ${what}`, () => { test.skip(true, `not_applicable: ${reason}`); });
}

// ---- the file ----

// A trace records typed values: the real keys must not reach one
test.use({ trace: 'off' });

test.describe('AI providers (OP-06)', () => {
    test.skip(!process.env.E2E_OPS, 'not_applicable: provider scenarios run with E2E_OPS=1');
    test.describe.configure({ timeout: 180_000 });

    test.beforeAll(async () => {
        seed = loadSeed();
        owner = apis(seed).owner;
        sid = seed.serverId;
        tag = `o6${seed.runTag}${crypto.randomBytes(2).toString('hex')}`.toLowerCase().replace(/[^a-z0-9]/g, '');
        const config = (await call('GET', `/servers/${sid}/ai-config`)) as any;
        const voice = (await call('GET', `/servers/${sid}/ai/voice`)) as any;
        prev = {
            allowPrivate: ((await call('GET', '/admin/settings/ai')) as any).allowPrivateBaseUrls === true,
            configured: !!config.configured, configEnabled: !!config.enabled,
            routes: (await call('GET', `/servers/${sid}/ai/routes`)) as any[],
            voice: { voiceInputEnabled: voice.voiceInputEnabled, readAloudEnabled: voice.readAloudEnabled, readAloudServer: voice.readAloudServer },
        };
        // Leftovers of an earlier run of this file
        for (const p of (await call('GET', `/servers/${sid}/ai/providers`)) as any[]) {
            if (String(p.label).startsWith(PREFIX)) await call('DELETE', `/servers/${sid}/ai/providers/${p.id}`, undefined, [200, 404]);
        }
        stub = `agora-e2e-provstub-${tag}`.slice(0, 60);
        await startStub(stub, { image: 'agora-e2e-server:e2e', mountDir: path.join(E2E_DIR, 'fake-provider'), cmd: ['node', '/stub/provider-stub.mjs'] });
        await waitFor('stub ready', async () => (await logs(stub)).includes('READY'), 20_000, 500);
    });

    // Per-test evidence (the annotations: UI texts, timings, counts) for the run's report; the
    // texts were checked for keys before they were annotated, and the leak scan reads this file
    test.afterEach(async ({}, ti) => {
        const id = /\[([A-Z]+-\d+[^\]]*)\]/.exec(ti.title)?.[1];
        const line = { id, status: ti.status, ms: ti.duration, notes: ti.annotations.filter(a => a.type !== 'skip' && a.description).map(a => `${a.type}: ${a.description ?? ''}`),
            errors: ti.errors.map(e => String(e.message ?? '').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 600)) };
        const text = JSON.stringify(line);
        fs.mkdirSync(artifactsDir(), { recursive: true });
        fs.appendFileSync(path.join(artifactsDir(), 'op06-evidence.jsonl'), (watch.has(text) ? JSON.stringify({ id, status: ti.status, withheld: 'contained a key' }) : text) + '\n');
    });

    test.afterAll(async () => {
        const report: Record<string, unknown> = { deleted: [], errors: [] };
        const errors = report.errors as string[];
        const step = async (what: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { errors.push(`${what}: ${(e as Error).message}`); } };
        await step('providers', async () => {
            for (const p of (await call('GET', `/servers/${sid}/ai/providers`)) as any[]) {
                if (!String(p.label).startsWith(PREFIX)) continue;
                await call('DELETE', `/servers/${sid}/ai/providers/${p.id}`, undefined, [200, 404]);
                (report.deleted as string[]).push(`${p.label} (${p.adapter})`);
            }
        });
        if (prev) {
            const p = prev;
            // Routes that pointed at a deleted provider went with it; put back any that existed before
            await step('routes', async () => {
                const now = (await call('GET', `/servers/${sid}/ai/routes`)) as any[];
                for (const r of p.routes) {
                    const cur = now.find(x => x.capability === r.capability);
                    if (cur && cur.providerId === r.providerId && cur.model === r.model && cur.enabled === r.enabled) continue;
                    await call('PUT', `/servers/${sid}/ai/routes/${r.capability}`, {
                        providerId: r.providerId, model: r.model, enabled: r.enabled, dailyRequestLimit: r.dailyRequestLimit, dailyTokenLimit: r.dailyTokenLimit,
                        dailyCostLimitMicros: r.dailyCostLimitMicros, inputPriceMicrosPerMtok: r.inputPriceMicrosPerMtok, outputPriceMicrosPerMtok: r.outputPriceMicrosPerMtok,
                    });
                }
            });
            await step('assistant', async () => { if (p.configured || botId) await call('PATCH', `/servers/${sid}/ai-config`, { enabled: p.configured ? p.configEnabled : false }); });
            await step('voice', () => call('PATCH', `/servers/${sid}/ai/voice`, p.voice));
            await step('private base urls', () => call('PATCH', '/admin/settings/ai', { allowPrivateBaseUrls: p.allowPrivate }));
            // Read back
            await step('read back', async () => {
                const left = ((await call('GET', `/servers/${sid}/ai/providers`)) as any[]).filter(x => String(x.label).startsWith(PREFIX));
                const routes = ((await call('GET', `/servers/${sid}/ai/routes`)) as any[]).map(r => `${r.capability}:${r.providerId}:${r.model}:${r.enabled}`).sort();
                const voice = (await call('GET', `/servers/${sid}/ai/voice`)) as any;
                const config = (await call('GET', `/servers/${sid}/ai-config`)) as any;
                report.after = {
                    providersLeft: left.length,
                    routesMatch: JSON.stringify(routes) === JSON.stringify(p.routes.map(r => `${r.capability}:${r.providerId}:${r.model}:${r.enabled}`).sort()),
                    allowPrivateBaseUrls: ((await call('GET', '/admin/settings/ai')) as any).allowPrivateBaseUrls,
                    allowPrivateBefore: p.allowPrivate,
                    assistantEnabled: config.enabled ?? null, assistantEnabledBefore: p.configEnabled,
                    voiceMatch: Object.entries(p.voice).every(([k, v]) => voice[k] === v),
                    keyHits: watch.hits, responsesChecked: watch.checked,
                };
                if (left.length) errors.push(`${left.length} provider(s) left`);
            });
        }
        if (stub) await step('stub', () => removeStub(stub));
        fs.mkdirSync(artifactsDir(), { recursive: true });
        // One line per worker: a failed test restarts the worker, which runs this afterAll each time
        fs.appendFileSync(path.join(artifactsDir(), 'op06-cleanup.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...report }) + '\n');
        if (errors.length) throw new Error(`OP-06 cleanup incomplete: ${errors.join('; ')}`);
    });

    // ---- providers with a real test key ----

    const REAL = [
        { id: 'anthropic', adapter: 'claude' as AgentAdapter, type: 'Anthropic (Claude)', baseUrl: false,
            models: (process.env.E2E_ANTHROPIC_MODEL ?? 'claude-haiku-5-5').split(','),
            badKey: /^Claude API 401\b/, wrongModel: /^Claude API 404\b/ },
        { id: 'openai', adapter: 'codex' as AgentAdapter, type: 'OpenAI / OpenAI-compatible', baseUrl: true,
            models: (process.env.E2E_OPENAI_MODEL ?? 'gpt-6-luna').split(','),
            badKey: /^OpenAI API 401\b/, wrongModel: /^OpenAI API (400|404)\b/ },
        { id: 'gemini', adapter: 'gemini' as AgentAdapter, type: 'Google Gemini', baseUrl: false,
            models: (process.env.E2E_GEMINI_MODEL ?? 'gemini-3.5-flash-lite,gemini-3.8-flash').split(','),
            badKey: /^Gemini API (400|401|403)\b.*API key/i, wrongModel: /^Gemini API 404\b/ },
    ];

    for (const P of REAL) {
        test.describe(P.id, () => {
            test.describe.configure({ mode: 'serial' });
            test.skip(!LIVE.ok, LIVE.ok ? '' : LIVE.reason);
            const label = () => `${PREFIX}${P.id}-${tag}`;
            let model = P.models[0];
            let timeout: { uiText: string; uiMs: number; apiMs: number } | null = null;
            const bad = fakeKey(P.id);

            test.afterAll(async () => {
                // The real key leaves the e2e database as soon as its provider is done
                const id = created.get(label());
                if (id) await call('DELETE', `/servers/${sid}/ai/providers/${id}`, undefined, [200, 404]);
            });

            test(`[OP-06.${P.id}.save-test] saved through Settings → AI, Test says Connection OK, the key is never returned`, async ({ page, sensitive }, ti) => {
                const key = realKey(P.adapter);
                guard(sensitive, key);
                watch.attach(page);
                const { row, provider } = await addProvider(page, { type: P.type, label: label(), key });
                await expect(row.getByText('Key saved')).toBeVisible();
                expect(provider.hasApiKey).toBe(true);
                expect(provider.baseUrl).toBeNull();
                await expectStoredEncrypted(provider.id, key);

                let r!: TestResult;
                for (const m of P.models) {
                    r = await runTest(page, label(), m);
                    model = m;
                    if (r.ok || !/\b404\b/.test(r.text)) break;
                }
                ti.annotations.push({ type: 'test', description: `model ${model}: "${r.text}" after ${r.ms} ms` });
                expect(r.ok, `Test with ${model}: ${watch.has(r.text) ? '[contains a key]' : r.text}`).toBe(true);
                expect(r.text).toBe('Connection OK');
                await safeSnap(page, ti, `OP-06.${P.id}.save-test`, '01-connection-ok', `A provider row "${label()}" showing "Key saved" and a green "Connection OK"`, rowOf(page, label()).getByText('Connection OK'));
                await sweep();
                expectNoKeyReturned();
            });

            test(`[OP-06.${P.id}.invoke] one tiny chat invoke through the Chat route: a reply, usage recorded`, async ({ page, sensitive }, ti) => {
                guard(sensitive, realKey(P.adapter));
                watch.attach(page);
                const route = await setRoute(page, 'Chat', label(), model);
                expect(route.adapter).toBe(P.adapter === 'claude' ? 'anthropic' : P.adapter === 'codex' ? 'openai' : 'gemini');
                await openSettings(page);
                await expect(rowOf(page, label()).getByText('Chat', { exact: true }), 'the provider shows its Chat badge').toBeVisible();
                const r = await invoke(page, P.id, 'Reply with the single word OK and nothing else.');
                ti.annotations.push({ type: 'invoke', description: `${model}: reply "${r.content.slice(0, 60)}" after ${r.ms} ms; usage +${r.delta.requests} request, +${r.delta.tokens} tokens, +${r.delta.errors} errors` });
                expect(r.content, 'a model reply, not an error').not.toMatch(/^Error: /);
                expect(r.content.trim().length).toBeGreaterThan(0);
                expect(r.delta.requests).toBe(1);
                expect(r.delta.errors).toBe(0);
                expect(r.delta.tokens).toBeGreaterThan(0);
                await safeSnap(page, ti, `OP-06.${P.id}.invoke`, '01-reply', 'A channel with a question to the assistant and its short reply', rowWith(page, r.content.slice(0, 40)).first());
                // Settings → AI → Usage shows the request
                await openSettings(page);
                const usageRow = page.locator('table tr').filter({ has: page.getByRole('cell', { name: 'Chat', exact: true }) });
                await expect(usageRow.first()).toBeVisible();
                await sweep();
                expectNoKeyReturned();
            });

            test(`[OP-06.${P.id}.invalid-key] a wrong key: Test fails visibly with the provider's message`, async ({ page, sensitive }, ti) => {
                guard(sensitive, realKey(P.adapter), bad);
                watch.attach(page);
                await replaceKey(page, label(), bad);
                const r = await runTest(page, label(), model);
                ti.annotations.push({ type: 'test', description: `"${r.text.slice(0, 200)}" after ${r.ms} ms` });
                expect(r.ok).toBe(false);
                expect(r.text).toMatch(P.badKey);
                await expectStoredEncrypted(created.get(label())!, bad);
                await safeSnap(page, ti, `OP-06.${P.id}.invalid-key`, '01-test-failed', 'A provider row with a red error from the provider about an invalid API key', rowOf(page, label()).locator('span.break-all'));
                await sweep();
                expectNoKeyReturned();
            });

            na(`OP-06.${P.id}.revoked-key`, 'a revoked key', 'a revoked key cannot be simulated: revoking the only test key would end the run (the invalid-key case covers the error path)');

            if (!P.baseUrl) {
                test(`[OP-06.${P.id}.base-url-refused] no custom base URL: the API refuses one, so no stub can stand in`, async ({ sensitive }, ti) => {
                    guard(sensitive, realKey(P.adapter), bad);
                    const r = await owner.req('PATCH', `/servers/${sid}/ai/providers/${created.get(label())}`, { baseUrl: 'https://example.invalid/v1' });
                    watch.check('PATCH provider', JSON.stringify(r.data));
                    ti.annotations.push({ type: 'refused', description: `${r.status} ${JSON.stringify(r.data)}` });
                    expect(r.status).toBe(400);
                    expect(r.data.error).toBe(`${P.type} does not accept a custom base URL`);
                    expectNoKeyReturned();
                });
                const why = `the ${P.type} adapter takes no base URL (400 in OP-06.${P.id}.base-url-refused), so the provider stub can't be put in front of it; the same error path is covered for OpenAI and OpenAI-compatible`;
                na(`OP-06.${P.id}.429`, 'a 429 from the provider', why);
                na(`OP-06.${P.id}.timeout`, 'a provider that never answers', why);
                na(`OP-06.${P.id}.wrong-endpoint`, 'a wrong endpoint', `${why}; OP-06.${P.id}.fix checks a wrong model name instead`);
            } else {
                test(`[OP-06.${P.id}.429] base URL at a stub answering 429: Test shows the rate-limit message, one request`, async ({ page, sensitive }, ti) => {
                    guard(sensitive, realKey(P.adapter), bad);
                    watch.attach(page);
                    await setPrivateUrls(page, true);
                    // The stored key is the fake one now (invalid-key), so no real key goes to the stub
                    await call('PATCH', `/servers/${sid}/ai/providers/${created.get(label())}`, { baseUrl: stubBase('r429') });
                    const before = await stubHits('r429');
                    const r = await runTest(page, label(), model);
                    ti.annotations.push({ type: 'test', description: `"${r.text}" after ${r.ms} ms` });
                    expect(r.ok).toBe(false);
                    expect(r.text).toBe('OpenAI API 429: Rate limit reached (stub)');
                    await expect(rowOf(page, label()).getByText(stubBase('r429')), 'the row shows the base URL').toBeVisible();
                    expect(await stubHits('r429') - before, 'Test makes one request, no retry').toBe(1);
                    await safeSnap(page, ti, `OP-06.${P.id}.429`, '01-rate-limited', 'A provider row with its stub base URL and the red error "OpenAI API 429: Rate limit reached (stub)"', rowOf(page, label()).locator('span.break-all'));
                    await sweep();
                    expectNoKeyReturned();
                });

                test(`[OP-06.${P.id}.wrong-endpoint] a base URL with no API behind it, and one that does not resolve`, async ({ page, sensitive }, ti) => {
                    guard(sensitive, realKey(P.adapter), bad);
                    watch.attach(page);
                    await call('PATCH', `/servers/${sid}/ai/providers/${created.get(label())}`, { baseUrl: stubBase('nf') });
                    const nf = await runTest(page, label(), model);
                    await call('PATCH', `/servers/${sid}/ai/providers/${created.get(label())}`, { baseUrl: `http://agora-e2e-nohost-${tag}:8080/v1` });
                    const dns = await runTest(page, label(), model);
                    ti.annotations.push({ type: 'test', description: `404 endpoint: "${nf.text}" after ${nf.ms} ms; unresolvable host: "${dns.text}" after ${dns.ms} ms` });
                    expect(nf.ok).toBe(false);
                    expect(nf.text).toBe('OpenAI API 404');
                    expect(dns.ok).toBe(false);
                    expect(dns.text).toMatch(/^fetch failed \((ENOTFOUND|EAI_AGAIN)\)$/);
                    await safeSnap(page, ti, `OP-06.${P.id}.wrong-endpoint`, '01-unresolvable', 'A provider row with a red "fetch failed" error for a host that does not exist', rowOf(page, label()).locator('span.break-all'));
                    await sweep();
                    expectNoKeyReturned();
                });

                test(`[OP-06.${P.id}.timeout] a provider that never answers: what Test shows, and when`, async ({ page, sensitive }, ti) => {
                    test.setTimeout(480_000);
                    guard(sensitive, realKey(P.adapter), bad);
                    watch.attach(page);
                    await call('PATCH', `/servers/${sid}/ai/providers/${created.get(label())}`, { baseUrl: stubBase('hang') });
                    const before = await stubHits('hang');
                    // Straight to the API too (no nginx in front), at the same time, so one wait covers both
                    const direct = timedReq(owner, 'POST', `/servers/${sid}/ai/providers/${created.get(label())}/test`, { model }, 420_000);
                    const ui = await runTest(page, label(), model, 420_000);
                    const api = await direct;
                    watch.check('POST provider test', JSON.stringify(api.data));
                    ti.annotations.push({ type: 'timeout', description: `UI (through nginx): "${ui.text}" after ${Math.round(ui.ms / 1000)} s; API direct: ${api.status} ${JSON.stringify(api.data)} after ${Math.round(api.ms / 1000)} s` });
                    expect(ui.ok).toBe(false);
                    expect(api.status, 'the API answers (no client deadline hit)').toBe(200);
                    expect(api.data?.ok).toBe(false);
                    expect(String(api.data?.error)).toMatch(/^fetch failed/);
                    expect(await stubHits('hang') - before, 'two requests (UI and direct), no retries').toBe(2);
                    timeout = { uiText: ui.text, uiMs: ui.ms, apiMs: api.ms };
                    await safeSnap(page, ti, `OP-06.${P.id}.timeout`, '01-after-wait', 'A provider row with a red error after the provider never answered', rowOf(page, label()).locator('span.break-all'));
                    await sweep();
                    expectNoKeyReturned();
                });
            }

            test(`[OP-06.${P.id}.fix] the real key (and endpoint) again: Test OK; a wrong model name fails visibly`, async ({ page, sensitive }, ti) => {
                const key = realKey(P.adapter);
                guard(sensitive, key, bad);
                watch.attach(page);
                if (P.baseUrl) await call('PATCH', `/servers/${sid}/ai/providers/${created.get(label())}`, { baseUrl: null });
                await replaceKey(page, label(), key);
                const r = await runTest(page, label(), model);
                expect(r.ok, `Test: ${watch.has(r.text) ? '[contains a key]' : r.text}`).toBe(true);
                await expect(rowOf(page, label()).getByText(/^http/), 'no base URL shown').toHaveCount(0);
                await safeSnap(page, ti, `OP-06.${P.id}.fix`, '01-connection-ok-again', `A provider row "${label()}" with "Key saved" and a green "Connection OK"`, rowOf(page, label()).getByText('Connection OK'));
                const wrong = await runTest(page, label(), 'e2e-no-such-model');
                ti.annotations.push({ type: 'test', description: `fixed: "${r.text}" after ${r.ms} ms; wrong model: "${wrong.text.slice(0, 200)}"` });
                expect(wrong.ok).toBe(false);
                expect(wrong.text).toMatch(P.wrongModel);
                await expectStoredEncrypted(created.get(label())!, key);
                await sweep();
                expectNoKeyReturned();
            });

            // After the fix, so a finding here doesn't skip it (serial groups stop at a failure)
            if (P.baseUrl) {
                test(`[OP-06.${P.id}.timeout-ui] after a provider timeout the admin sees the provider error, within 2 minutes`, async () => {
                    test.skip(!timeout, 'not_applicable: the timeout case did not run');
                    expect(timeout!.uiText, 'the UI shows the provider error, not a proxy error code').toMatch(/^fetch failed|timed? ?out/i);
                    expect(timeout!.apiMs, 'Test gives up within 2 minutes').toBeLessThan(120_000);
                });
            }
        });
    }

    // ---- OpenAI-compatible (Ollama, vLLM, ...): no server here, the stub stands in ----

    test.describe('openai-compatible', () => {
        test.describe.configure({ mode: 'serial' });
        const label = () => `${PREFIX}compat-${tag}`;
        const bad = fakeKey('compat');

        test('[OP-06.compat.private-url] a private base URL is refused until the instance allows it', async ({ page, sensitive }, ti) => {
            guard(sensitive, bad);
            watch.attach(page);
            await setPrivateUrls(page, false);
            await openSettings(page);
            await page.getByRole('button', { name: 'Add provider' }).click();
            await page.locator('#ai-adapter').selectOption({ label: 'OpenAI / OpenAI-compatible' });
            await page.getByLabel('Label', { exact: true }).fill(label());
            await page.getByLabel('Base URL (optional)').fill(stubBase('ok'));
            await page.getByRole('button', { name: 'Add', exact: true }).click();
            const err = page.locator('p.text-danger');
            await expect(err).toBeVisible({ timeout: 10_000 });
            const text = (await err.innerText()).trim();
            ti.annotations.push({ type: 'refused', description: text });
            expect(text).toMatch(/private|internal|not allowed/i);
            expect(await providerByLabel(label()), 'nothing saved').toBeUndefined();
            await safeSnap(page, ti, 'OP-06.compat.private-url', '01-refused', 'An add-provider form with a red error refusing a private network base URL', err);
            await setPrivateUrls(page, true);
            await expect(page.getByRole('checkbox', { name: /Allow private network base URLs/ })).toBeChecked();
        });

        test('[OP-06.compat.save-test] keyless OpenAI-compatible server: saved with "No key", Test OK', async ({ page, sensitive }, ti) => {
            guard(sensitive, bad);
            watch.attach(page);
            const { row, provider } = await addProvider(page, { type: 'OpenAI / OpenAI-compatible', label: label(), baseUrl: stubBase('ok') });
            await expect(row.getByText('No key')).toBeVisible();
            await expect(row.getByText(stubBase('ok'))).toBeVisible();
            expect(provider.hasApiKey).toBe(false);
            const r = await runTest(page, label(), 'stub-model');
            ti.annotations.push({ type: 'test', description: `"${r.text}" after ${r.ms} ms` });
            expect(r.ok).toBe(true);
            await safeSnap(page, ti, 'OP-06.compat.save-test', '01-connection-ok', 'An OpenAI-compatible provider row with "No key", its base URL and a green "Connection OK"', row.getByText('Connection OK'));
            await sweep();
            expectNoKeyReturned();
        });

        test('[OP-06.compat.invoke] chat through the stub (not a real model): the reply and usage', async ({ page, sensitive }, ti) => {
            guard(sensitive, bad);
            watch.attach(page);
            await setRoute(page, 'Chat', label(), 'stub-model');
            const r = await invoke(page, 'compat', 'say ok');
            ti.annotations.push({ type: 'invoke', description: `stub reply "${r.content}" after ${r.ms} ms; usage +${r.delta.requests}/${r.delta.tokens} tokens/${r.delta.errors} errors (real invoke n/a: no Ollama or other OpenAI-compatible server is reachable)` });
            expect(r.content).toBe(`${tag}-ok`);
            expect(r.delta).toEqual({ requests: 1, errors: 0, tokens: 10 });
            await sweep();
            expectNoKeyReturned();
        });

        test('[OP-06.compat.invalid-key] a key the server refuses: 401 shown, the key is never returned', async ({ page, sensitive }, ti) => {
            guard(sensitive, bad);
            watch.attach(page);
            await replaceKey(page, label(), bad);
            await call('PATCH', `/servers/${sid}/ai/providers/${created.get(label())}`, { baseUrl: stubBase('r401') });
            const r = await runTest(page, label(), 'stub-model');
            ti.annotations.push({ type: 'test', description: `"${r.text}" after ${r.ms} ms` });
            expect(r.ok).toBe(false);
            expect(r.text).toBe('OpenAI API 401: Incorrect API key provided (stub)');
            await expectStoredEncrypted(created.get(label())!, bad);
            await sweep();
            expectNoKeyReturned();
        });

        test('[OP-06.compat.429] a 429: the rate-limit message', async ({ page, sensitive }, ti) => {
            guard(sensitive, bad);
            watch.attach(page);
            await call('PATCH', `/servers/${sid}/ai/providers/${created.get(label())}`, { baseUrl: stubBase('r429') });
            const r = await runTest(page, label(), 'stub-model');
            ti.annotations.push({ type: 'test', description: `"${r.text}" after ${r.ms} ms` });
            expect(r.ok).toBe(false);
            expect(r.text).toBe('OpenAI API 429: Rate limit reached (stub)');
            expectNoKeyReturned();
        });

        test('[OP-06.compat.wrong-endpoint] a base URL with no API behind it: 404 shown', async ({ page, sensitive }, ti) => {
            guard(sensitive, bad);
            watch.attach(page);
            await call('PATCH', `/servers/${sid}/ai/providers/${created.get(label())}`, { baseUrl: stubBase('nf') });
            const r = await runTest(page, label(), 'stub-model');
            ti.annotations.push({ type: 'test', description: `"${r.text}" after ${r.ms} ms` });
            expect(r.ok).toBe(false);
            expect(r.text).toBe('OpenAI API 404');
            expectNoKeyReturned();
        });

        na('OP-06.compat.timeout', 'a server that never answers', 'measured once per run in OP-06.openai.timeout (same adapter and code path, src/ai/adapters/openai.ts testConnection); a second 300 s wait adds nothing');
        na('OP-06.compat.revoked-key', 'a revoked key', 'no real OpenAI-compatible server or key here; the 401 path is OP-06.compat.invalid-key');

        test('[OP-06.compat.fix] the working endpoint again: Test OK', async ({ page, sensitive }) => {
            guard(sensitive, bad);
            watch.attach(page);
            await call('PATCH', `/servers/${sid}/ai/providers/${created.get(label())}`, { baseUrl: stubBase('ok') });
            const r = await runTest(page, label(), 'stub-model');
            expect(r.ok).toBe(true);
            await sweep();
            expectNoKeyReturned();
        });
    });

    // ---- Kokoro (speech) and Whisper (transcription): OpenAI-compatible speech-only servers ----

    for (const S of [
        { id: 'kokoro', capability: 'Speech' as const, model: 'kokoro' },
        { id: 'whisper', capability: 'Transcription' as const, model: 'whisper-1' },
    ]) {
        test.describe(S.id, () => {
            test.describe.configure({ mode: 'serial' });
            const label = () => `${PREFIX}${S.id}-${tag}`;
            const bad = fakeKey(S.id);
            let testText = '';

            test(`[OP-06.${S.id}.save-test] a speech-only server (stub) saved with a fake key: key never returned; what Test says`, async ({ page, sensitive }, ti) => {
                guard(sensitive, bad);
                watch.attach(page);
                await setPrivateUrls(page, true);
                const { row, provider } = await addProvider(page, { type: 'OpenAI / OpenAI-compatible', label: label(), key: bad, baseUrl: stubBase('speech') });
                await expect(row.getByText('Key saved')).toBeVisible();
                expect(provider.hasApiKey).toBe(true);
                await expectStoredEncrypted(provider.id, bad);
                const r = await runTest(page, label(), S.model);
                ti.annotations.push({ type: 'test', description: `"${r.text}" after ${r.ms} ms` });
                await safeSnap(page, ti, `OP-06.${S.id}.save-test`, '01-test-result', `An OpenAI-compatible provider row for a ${S.capability.toLowerCase()} server with "Key saved" and the Test result`, row.locator('span.break-all'));
                await sweep();
                expectNoKeyReturned();
                testText = r.text;
            });

            test(`[OP-06.${S.id}.invoke] ${S.capability} through the stub (not a real ${S.id} server)`, async ({ page, sensitive }, ti) => {
                guard(sensitive, bad);
                watch.attach(page);
                await setRoute(page, S.capability, label(), S.model);
                const cap = S.id === 'kokoro' ? 'tts' : 'stt';
                const before = await usage(cap);
                const ch = await freshChannel(seed, `${PREFIX}${S.id}`);
                let detail = '';
                if (S.id === 'kokoro') {
                    await call('PATCH', `/servers/${sid}/ai/voice`, { readAloudEnabled: true, readAloudServer: true });
                    const m = trimId(((await call('POST', `/channels/${ch.id}/messages`, { content: `read this aloud ${tag}` }, [201])) as any).id);
                    const res = await fetch(`${e2eEnv().apiURL}/channels/${ch.id}/messages/${m}/speech`, { method: 'POST', headers: { Authorization: owner.auth! } });
                    const body = Buffer.from(await res.arrayBuffer());
                    detail = `speech: ${res.status} ${res.headers.get('content-type')} ${body.length} bytes`;
                    expect(res.status, detail).toBe(200);
                    expect(res.headers.get('content-type')).toContain('audio/');
                    expect(body.length).toBeGreaterThan(0);
                } else {
                    await call('PATCH', `/servers/${sid}/ai/voice`, { voiceInputEnabled: true });
                    const wav = silentWav(0.3);
                    const res = await fetch(`${e2eEnv().apiURL}/channels/${ch.id}/voice/transcribe`, { method: 'POST', headers: { Authorization: owner.auth!, 'Content-Type': 'audio/wav' }, body: wav });
                    const data: any = await res.json().catch(() => null);
                    watch.check('POST transcribe', JSON.stringify(data));
                    detail = `transcribe: ${res.status} ${JSON.stringify(data)}`;
                    expect(res.status, detail).toBe(200);
                    expect(data.text).toBe(`${tag} heard you`);
                }
                const after = await waitFor('usage recorded', async () => { const u = await usage(cap); return u.requests > before.requests ? u : null; }, 15_000, 500);
                ti.annotations.push({ type: 'invoke', description: `${detail}; ${cap} usage +${after.requests - before.requests} request(s), +${after.errors - before.errors} errors (real invoke n/a: no ${S.id} server is reachable)` });
                expect(after.errors - before.errors).toBe(0);
                await sweep();
                expectNoKeyReturned();
            });

            test(`[OP-06.${S.id}.test-agrees] Test on the ${S.capability.toLowerCase()} server that just worked says Connection OK`, async ({ sensitive }) => {
                guard(sensitive, bad);
                // Test always probes /chat/completions (src/ai/adapters/openai.ts testConnection), which a
                // speech-only server such as Kokoro-FastAPI or speaches does not serve
                expect(testText, 'the Test result shown for a working server').toBe('Connection OK');
            });

            const why = `no real ${S.id} server is reachable; this capability's error paths share the OpenAI adapter with OP-06.compat.* (src/ai/adapters/openai.ts)`;
            na(`OP-06.${S.id}.invalid-key`, 'a key the server refuses', why);
            na(`OP-06.${S.id}.revoked-key`, 'a revoked key', why);
            na(`OP-06.${S.id}.429`, 'a 429', why);
            na(`OP-06.${S.id}.timeout`, 'a server that never answers', `${why}; voice calls have their own 60 s deadline (VOICE_PROVIDER_TIMEOUT_MS)`);
            na(`OP-06.${S.id}.wrong-endpoint`, 'a wrong endpoint', why);
        });
    }

    // ---- Tavily (search) and TypeSafe Jev (decisions): no test key ----

    for (const K of [
        { id: 'tavily', type: 'Tavily (web search)', model: 'basic' },
        { id: 'jev', type: 'TypeSafe Jev (decisions)', model: 'jev-latest' },
    ]) {
        test.describe(K.id, () => {
            test.describe.configure({ mode: 'serial' });
            const label = () => `${PREFIX}${K.id}-${tag}`;
            const bad = fakeKey(K.id);

            test(`[OP-06.${K.id}.save-test] saved with a fake key: "Key saved", Test fails visibly, the key is never returned`, async ({ page, sensitive }, ti) => {
                guard(sensitive, bad);
                watch.attach(page);
                const { row, provider } = await addProvider(page, { type: K.type, label: label(), key: bad });
                await expect(row.getByText('Key saved')).toBeVisible();
                expect(provider.hasApiKey).toBe(true);
                await expectStoredEncrypted(provider.id, bad);
                const r = await runTest(page, label(), K.model, 30_000);
                ti.annotations.push({ type: 'test', description: `"${r.text.slice(0, 200)}" after ${r.ms} ms` });
                expect(r.ok).toBe(false);
                expect(r.text.length).toBeGreaterThan(0);
                expect(r.text, 'a provider error, not a generic one').not.toBe('Connection failed');
                await safeSnap(page, ti, `OP-06.${K.id}.save-test`, '01-test-failed', `A ${K.type} provider row with "Key saved" and a red error from the provider`, row.locator('span.break-all'));
                await sweep();
                expectNoKeyReturned();
            });

            test(`[OP-06.${K.id}.base-url-refused] no custom base URL: the API refuses one`, async ({ sensitive }, ti) => {
                guard(sensitive, bad);
                const r = await owner.req('PATCH', `/servers/${sid}/ai/providers/${created.get(label())}`, { baseUrl: 'https://example.invalid/v1' });
                watch.check('PATCH provider', JSON.stringify(r.data));
                ti.annotations.push({ type: 'refused', description: `${r.status} ${JSON.stringify(r.data)}` });
                expect(r.status).toBe(400);
                expect(r.data.error).toBe(`${K.type} does not accept a custom base URL`);
            });

            const why = `no ${K.id === 'tavily' ? 'Tavily' : 'TypeSafe (JEV)'} test key`;
            na(`OP-06.${K.id}.invoke`, 'a real invoke', why);
            na(`OP-06.${K.id}.invalid-key`, 'a wrong key', `${why}; save-test already shows the error for a wrong (fake) key`);
            na(`OP-06.${K.id}.revoked-key`, 'a revoked key', why);
            na(`OP-06.${K.id}.429`, 'a 429', `${why}, and the adapter takes no base URL, so the stub can't stand in`);
            na(`OP-06.${K.id}.timeout`, 'a provider that never answers', `the adapter takes no base URL, so the stub can't stand in`);
            na(`OP-06.${K.id}.wrong-endpoint`, 'a wrong endpoint', `the adapter takes no base URL (OP-06.${K.id}.base-url-refused)`);
            na(`OP-06.${K.id}.fix`, 'the real key again', why);
        });
    }
});

/** 16-bit mono PCM WAV of silence (a recording the transcribe route accepts). */
function silentWav(seconds: number) {
    const rate = 16000, n = Math.round(rate * seconds), b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'latin1');
    b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36, 'latin1'); b.writeUInt32LE(n * 2, 40);
    return b;
}
