/**
 * Helpers for the fake-host specs: a director user, run-tagged channels with agent bots,
 * session/run/message queries for exact before/after assertions, and UI login.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { Api } from './api';
import { e2eEnv, SECRETS_DIR, SEED_FILE } from './env';
import { waitFor, type FakeHost } from './fake-host';
import type { Seed } from './seed-types';

export interface Director { id: string; username: string; password: string; token: string; api: Api; roleId: string }

/**
 * fkdirector-e2e: registered once per instance (password derived from the instance's member
 * password, so reruns can log in), then given a run-tagged role with DirectAgents (owner only).
 */
export async function ensureDirector(seed: Seed): Promise<Director> {
    const env = e2eEnv();
    const base = new Api(env.apiURL);
    const owner = base.with(`Bearer ${seed.secrets.ownerToken}`);
    const password = 'Dir-' + crypto.createHash('sha256').update(`${env.raw.E2E_MEMBER_PASSWORD}:director-e2e`).digest('hex').slice(0, 24);
    // Not plain director-e2e: another harness may own that name with its own password
    const username = 'fkdirector-e2e';
    const login = async () => {
        const r = await base.req('POST', '/auth/login', { login: username, password });
        return r.status === 200 ? (r.data.accessToken as string) : null;
    };
    let token = await login();
    if (!token) {
        await base.ok('POST', '/auth/register', { username, email: 'fkdirector-e2e@example.test', password }, [201]);
        token = await login();
        if (!token) throw new Error('director-e2e login failed after register');
    }
    const api = base.with(`Bearer ${token}`);
    const me = (await api.ok('GET', '/auth/session')) as any;
    const id = me.user.id.trim();
    const role = (await owner.ok('POST', `/servers/${seed.serverId}/roles`, { name: `Directors-${seed.runTag}-${crypto.randomBytes(2).toString('hex')}`, permissions: String(1n << 29n) }, [201])) as any;
    await owner.ok('PUT', `/servers/${seed.serverId}/members/${id}/roles/${role.id.trim()}`, undefined, [200]);
    addSecret('directorPassword', password); addSecret('directorToken', token);
    return { id, username, password, token, api, roleId: role.id.trim() };
}

function addSecret(key: string, value: string) {
    try {
        const s = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
        s.secrets.extra = { ...(s.secrets.extra ?? {}), [key]: value };
        fs.writeFileSync(SEED_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
    } catch { /* no seed */ }
}

/** A browser context logged in through the real login page (storageState kept under secrets/). */
export async function loginContext(browser: Browser, username: string, password: string, contextOptions: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
    const file = path.join(SECRETS_DIR, `state-${username}.json`);
    if (fs.existsSync(file)) return browser.newContext({ ...contextOptions, storageState: file });
    // An empty state: in a test, browser.newContext() inherits the project's storageState (the owner)
    const ctx = await browser.newContext({ ...contextOptions, baseURL: e2eEnv().baseURL, storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.getByLabel('Username or email').fill(username);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/app/, { timeout: 20_000 });
    await page.getByPlaceholder(/^Message #/).waitFor({ timeout: 20_000 });
    await ctx.storageState({ path: file });
    await page.close();
    return ctx;
}

/** A run-tagged channel holding the given fake agents' bots. */
export async function agentChannel(seed: Seed, fh: FakeHost, label: string, keys: string[]): Promise<{ id: string; name: string }> {
    const owner = new Api(e2eEnv().apiURL).with(`Bearer ${seed.secrets.ownerToken}`);
    const name = `${label}-${fh.tag}`;
    const id: string = ((await owner.ok('POST', `/servers/${seed.serverId}/channels`, { name, channelType: 3 }, [201])) as any).id.trim();
    for (const k of keys) await owner.ok('POST', `/channels/${id}/bots/${fh.agents[k].botId}`, undefined, [200, 201]);
    return { id, name };
}

export const trimId = (s: unknown) => String(s ?? '').trim();

export async function sessions(api: Api, channelId: string): Promise<any[]> {
    return ((await api.ok('POST', `/channels/${channelId}/agent-commands`, { command: 'sessions' })) as any).sessions;
}
export async function sessionOf(api: Api, channelId: string, profile: string, sessionId?: string): Promise<any | undefined> {
    const all = (await sessions(api, channelId)).filter(s => s.profile === profile && s.kind !== 'terminal');
    return sessionId ? all.find(s => trimId(s.id) === sessionId) : all.find(s => s.state === 'live') ?? all[0];
}
/** Newest first, as the API returns them. */
export async function messages(api: Api, channelId: string, limit = 50): Promise<any[]> {
    return (await api.ok('GET', `/channels/${channelId}/messages?limit=${limit}`)) as any[];
}
export async function replies(api: Api, channelId: string, threadId: string): Promise<any[]> {
    const r = (await api.ok('GET', `/channels/${channelId}/messages/${threadId}/replies?limit=100`)) as any;
    return Array.isArray(r) ? r : (r.replies ?? r.messages ?? []);
}
export async function waitMessage(api: Api, channelId: string, pred: (m: any) => boolean, what: string, timeoutMs = 45_000): Promise<any> {
    return waitFor(what, async () => (await messages(api, channelId)).find(pred), timeoutMs, 700);
}
export async function waitReply(api: Api, channelId: string, threadId: string, pred: (m: any) => boolean, what: string, timeoutMs = 45_000): Promise<any> {
    return waitFor(what, async () => (await replies(api, channelId, threadId)).find(pred), timeoutMs, 700);
}
/** Wait until the fake CLI has finished `count` runs for this agent; returns the traces. */
export async function waitRuns(fh: FakeHost, key: string, count: number, timeoutMs = 60_000): Promise<any[]> {
    return waitFor(`${count} fake run(s) for ${key}`, async () => { const t = fh.traces(key); return t.length >= count ? t : null; }, timeoutMs, 500);
}
/** Wait until the session's latest run is no longer claimed (the host reported it). */
export async function waitIdle(api: Api, channelId: string, profile: string, sessionId: string, timeoutMs = 60_000) {
    return waitFor(`${profile} idle`, async () => {
        const s = await sessionOf(api, channelId, profile, sessionId);
        return s && !s.running && s.run && s.run.status !== 'claimed' ? s : null;
    }, timeoutMs, 700);
}

export async function startSession(api: Api, channelId: string, profile: string): Promise<string> {
    const r = (await api.ok('POST', `/channels/${channelId}/agent-commands`, { command: 'start', profile }, [201])) as any;
    return trimId(r.session.id);
}

/** Send a composer message (or slash command) through the UI. */
export async function compose(page: Page, channelName: string, text: string, opts: { refused?: boolean } = {}) {
    const box = page.getByPlaceholder(`Message #${channelName}`);
    await box.fill(text);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Send message' }).click();
    // A refused slash command keeps its text in the box for a retry
    if (!opts.refused) await expect(box).toHaveValue('');
}

/** The console strip chip that opens an agent's session sheet. */
export function agentChip(page: Page, profile: string) {
    return page.getByRole('toolbar', { name: 'Agents and active threads' }).getByRole('button', { name: new RegExp(`^${profile}: .*Open session controls$`) });
}
export function sheet(page: Page, profile: string) {
    return page.getByRole('dialog', { name: `Agent: ${profile}` });
}

/** Upload a small text file into a channel as the given user; returns the file id. */
export async function uploadFile(api: Api, channelId: string, name: string, text: string): Promise<string> {
    const form = new FormData();
    form.append('channel_id', channelId);
    form.append('file', new Blob([text], { type: 'text/plain' }), name);
    const r = await api.req('POST', '/files/upload', form);
    if (r.status !== 201) throw new Error(`upload -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    const id = trimId(r.data.id);
    await api.ok('POST', `/channels/${channelId}/messages`, { content: `Shared ${name}`, attachments: [id] }, [201]);
    return id;
}

/**
 * A system notice in the channel or a thread panel, expanding collapsed "N system notices"
 * runs while waiting (consecutive notices collapse into one row, UI-02.notice-drawer).
 */
export async function expectNotice(page: Page, text: string | RegExp, timeoutMs = 45_000, scope?: Locator) {
    const root = scope ?? page.locator('body');
    // The channel list is virtualized ([data-index] rows); a thread panel is a plain list
    const target = (scope ? scope : root.locator('[data-index]')).getByText(text).first();
    await expect.poll(async () => {
        for (const t of await root.getByRole('button', { name: /^(?:\W*\d+ system notices$|\d+ notices$|\d+ agent updates)/ }).all()) {
            if ((await t.getAttribute('aria-expanded').catch(() => null)) === 'false') await t.click().catch(() => undefined);
        }
        return target.isVisible();
    }, { timeout: timeoutMs, intervals: [500] }).toBe(true);
    return target;
}
