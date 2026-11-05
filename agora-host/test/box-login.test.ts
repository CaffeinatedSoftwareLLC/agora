import { fileURLToPath } from 'node:url';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boxLoginLoop, handleBoxLogin, parsePrompt, plainText, type BoxLoginOptions } from '../src/box-login.js';
import { boxMode } from '../src/box.js';
import { Client, HttpError } from '../src/client.js';
import type { Config } from '../src/config.js';
import type { BoxLoginReport, BoxLoginRequest, HostApi } from '../src/types.js';
import { config, id, tempDir } from './helpers.js';

const unix = process.platform !== 'win32';
const FAKE_CLI = fileURLToPath(new URL('../../box/fake/fake-cli.mjs', import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
const saved = { marker: boxMode.marker, flag: process.env.AGORA_HOST_IN_BOX };
afterEach(async () => {
    boxMode.marker = saved.marker;
    if (saved.flag === undefined) delete process.env.AGORA_HOST_IN_BOX; else process.env.AGORA_HOST_IN_BOX = saved.flag;
    for (const c of cleanups.splice(0).reverse()) await c();
});

// Recorded from codex-cli 0.166.0 `login --device-auth` (code replaced), 2026-11-04
const CODEX_OUTPUT = '\nWelcome to Codex [v\x1b[90m0.166.0\x1b[0m]\n\x1b[90mOpenAI\'s command-line coding agent\x1b[0m\n\n'
    + 'Follow these steps to sign in with ChatGPT using device code authorization:\n\n'
    + '1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n'
    + '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mWXYZ-23456\x1b[0m\n\n';

describe('login prompt parsing', () => {
    it('finds the Codex device URL and code', () => {
        expect(parsePrompt('codex', CODEX_OUTPUT)).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'WXYZ-23456' });
    });
    it('waits for a code or URL that is still being printed', () => {
        const cut = CODEX_OUTPUT.indexOf('WXYZ-234') + 'WXYZ-234'.length;
        expect(parsePrompt('codex', CODEX_OUTPUT.slice(0, cut))).toBeNull();
        expect(parsePrompt('claude', 'visit: https://claude.ai/oauth/authorize?code=tr')).toBeNull();
    });
    it('reads a Claude URL from an OSC 8 hyperlink and ignores other hosts', () => {
        const link = 'https://claude.ai/oauth/authorize?code=true&state=s1';
        expect(parsePrompt('claude', `Go to \x1b]8;;${link}\x07here\x1b]8;;\x07\nPaste code here > `)).toEqual({ url: link, code: null });
        expect(parsePrompt('claude', 'visit https://evil.example/claude.ai and https://claude.ai.evil.example/x\n')).toBeNull();
        expect(parsePrompt('codex', 'https://auth.openai.com.evil.example/codex/device\n   ABCD-EFGHJ\n')).toBeNull();
        expect(plainText('\x1b[1mbold\x1b[0m')).toBe('bold');
    });
});

describe('box login client', () => {
    it('claims, reports and reads the pasted code on the host routes', async () => {
        const calls: Array<{ method: string; url: string; body: unknown }> = [];
        const replies = [
            new Response(JSON.stringify({ id: id(1), adapter: 'claude', profile: 'box-one' }), { status: 200 }),
            new Response(null, { status: 204 }),
            new Response(JSON.stringify({ ok: true }), { status: 200 }),
            new Response(JSON.stringify({ code: 'abc#def' }), { status: 200 }),
            new Response(null, { status: 204 }),
            new Response(JSON.stringify({ error: 'login_closed' }), { status: 409 }),
        ];
        const fetcher = (async (url: URL, init: RequestInit) => {
            calls.push({ method: init.method!, url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined });
            return replies.shift()!;
        }) as unknown as typeof fetch;
        const client = new Client('http://edge:8080/', 'ah_host.secret', fetcher, undefined, 1);
        expect(await client.claimBoxLogin()).toEqual({ id: id(1), adapter: 'claude', profile: 'box-one' });
        expect(await client.claimBoxLogin()).toBeNull();
        await client.reportBoxLogin(id(1), { status: 'awaiting_code', verificationUrl: 'https://claude.ai/x' });
        expect(await client.boxLoginCode(id(1))).toBe('abc#def');
        expect(await client.boxLoginCode(id(1))).toBeNull();
        await expect(client.reportBoxLogin(id(1), { status: 'failed', error: 'login_timeout' })).rejects.toMatchObject({ status: 409 });
        expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
            'GET http://edge:8080/agent-hosts/@me/box-login', 'GET http://edge:8080/agent-hosts/@me/box-login',
            `POST http://edge:8080/agent-hosts/@me/box-login/${id(1)}`, `GET http://edge:8080/agent-hosts/@me/box-login/${id(1)}/code`,
            `GET http://edge:8080/agent-hosts/@me/box-login/${id(1)}/code`, `POST http://edge:8080/agent-hosts/@me/box-login/${id(1)}`]);
        expect(calls[2].body).toEqual({ status: 'awaiting_code', verificationUrl: 'https://claude.ai/x' });
    });
});

/** A host API that records reports and hands out pasted codes. */
function fakeApi(codes: Array<string | null | Error> = []) {
    const reports: BoxLoginReport[] = [];
    let codeCalls = 0;
    const api: HostApi = {
        claim: async () => null, heartbeat: async () => ({ cancel: false, leaseUntil: '' }), complete: async () => {}, fail: async () => {},
        reportBoxLogin: async (_id, body) => { reports.push(body); },
        boxLoginCode: async () => { codeCalls++; const next = codes.length > 1 ? codes.shift()! : codes[0] ?? null; if (next instanceof Error) throw next; return next; },
    };
    return { api, reports, codeCalls: () => codeCalls };
}
function options(logs: string[], extra: Partial<BoxLoginOptions> = {}): BoxLoginOptions {
    return { signal: new AbortController().signal, log: c => logs.push(c), pause: async () => {}, stopping: () => false,
        codePollMs: 50, timeoutMs: 20000, promptTimeoutMs: 5000, ...extra };
}
async function boxProfile(adapter: 'codex' | 'claude', script?: string): Promise<{ c: Config; state: string }> {
    const t = await tempDir(); cleanups.push(t.cleanup);
    const c = config(t.dir);
    const exe = join(t.dir, `${adapter}.mjs`);
    if (script) await writeFile(exe, script); else await copyFile(FAKE_CLI, exe);
    await chmod(exe, 0o755);
    c.profiles['box-one'] = { ...c.profiles.builder, adapter, executable: exe, stateDir: join(t.dir, 'state', 'box-one'), auth: 'subscription' };
    return { c, state: c.profiles['box-one'].stateDir };
}
const req = (adapter: 'codex' | 'claude'): BoxLoginRequest => ({ id: id(1), adapter, profile: 'box-one' });
/** Every log line is a fixed code: never a URL, a code or CLI output. */
const onlyCodes = (logs: string[]) => expect(logs.every(l => /^[a-z_]+$/.test(l))).toBe(true);

describe.skipIf(!unix)('box login relay (fake CLIs)', () => {
    it('Codex: reports the device URL and code, then success; the login lands in CODEX_HOME', async () => {
        const { c, state } = await boxProfile('codex');
        await mkdir(state, { recursive: true }); await writeFile(join(state, '.fake-login-delay-ms'), '300');
        const { api, reports } = fakeApi(); const logs: string[] = [];
        await handleBoxLogin(c, api, req('codex'), options(logs));
        expect(reports).toHaveLength(2);
        expect(reports[0]).toMatchObject({ status: 'awaiting_user', verificationUrl: 'https://auth.openai.com/codex/device' });
        expect(reports[0].userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{5}$/);
        expect(reports[1]).toEqual({ status: 'succeeded' });
        expect(existsSync(join(state, '.fake-login'))).toBe(true);
        const call = JSON.parse(await readFile(join(state, '.fake-last-call.json'), 'utf8'));
        expect(call.args).toEqual(['-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', '-c', 'check_for_update_on_startup=false', 'login', '--device-auth']);
        expect(call.envNames).toContain('CODEX_HOME');
        for (const secret of ['AGORA_HOST_TOKEN', 'AGORA_BOT_TOKEN']) expect(call.envNames).not.toContain(secret);
        expect(logs).toEqual(['box_login_started', 'box_login_succeeded']); onlyCodes(logs);
    });
    it('Codex: a failed login is reported as failed', async () => {
        const { c, state } = await boxProfile('codex');
        await mkdir(state, { recursive: true });
        await writeFile(join(state, '.fake-login-delay-ms'), '100'); await writeFile(join(state, '.fake-login-fail'), '');
        const { api, reports } = fakeApi(); const logs: string[] = [];
        await handleBoxLogin(c, api, req('codex'), options(logs));
        expect(reports.map(r => r.status)).toEqual(['awaiting_user', 'failed']);
        expect(reports[1].error).toBe('login_failed');
        expect(existsSync(join(state, '.fake-login'))).toBe(false);
    });
    it('Codex: stopped after the login time is up', async () => {
        const { c, state } = await boxProfile('codex');
        await mkdir(state, { recursive: true }); await writeFile(join(state, '.fake-login-delay-ms'), '60000');
        const { api, reports } = fakeApi(); const logs: string[] = [];
        await handleBoxLogin(c, api, req('codex'), options(logs, { timeoutMs: 1500 }));
        expect(reports.map(r => r.error ?? r.status)).toEqual(['awaiting_user', 'login_timeout']);
        expect(existsSync(join(state, '.fake-login'))).toBe(false);
    });
    it('Claude: reports the URL, writes the pasted code to the CLI, then success', async () => {
        const { c, state } = await boxProfile('claude');
        const { api, reports, codeCalls } = fakeApi([null, null, 'abc123#state']); const logs: string[] = [];
        await handleBoxLogin(c, api, req('claude'), options(logs));
        expect(reports[0]).toMatchObject({ status: 'awaiting_code' });
        expect(reports[0].verificationUrl).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?code=true&client_id=fake&state=[0-9a-f-]{36}$/);
        expect(reports[0].userCode).toBeUndefined();
        expect(reports[1]).toEqual({ status: 'succeeded' });
        expect(codeCalls()).toBeGreaterThanOrEqual(3);
        expect(existsSync(join(state, '.fake-login'))).toBe(true);
        const call = JSON.parse(await readFile(join(state, '.fake-last-call.json'), 'utf8'));
        expect(call.args).toEqual(['auth', 'login', '--claudeai']);
        expect(call.envNames).toContain('CLAUDE_CONFIG_DIR');
        onlyCodes(logs);
    });
    it('Claude: a wrong code fails the login', async () => {
        const { c } = await boxProfile('claude');
        const { api, reports } = fakeApi(['wrong']); const logs: string[] = [];
        await handleBoxLogin(c, api, req('claude'), options(logs));
        expect(reports.map(r => r.error ?? r.status)).toEqual(['awaiting_code', 'login_failed']);
    });
    it('Claude: a code with a line break is never written', async () => {
        const { c } = await boxProfile('claude');
        const { api, reports } = fakeApi(['abc\nrm -rf ~']); const logs: string[] = [];
        await handleBoxLogin(c, api, req('claude'), options(logs));
        expect(reports.map(r => r.error ?? r.status)).toEqual(['awaiting_code', 'invalid_code']);
    });
    it('a login the owner cancelled stops the CLI with no more reports', async () => {
        const { c, state } = await boxProfile('claude');
        const { api, reports } = fakeApi([new HttpError(409)]); const logs: string[] = [];
        await handleBoxLogin(c, api, req('claude'), options(logs));
        expect(reports.map(r => r.status)).toEqual(['awaiting_code']);
        expect(logs).toContain('box_login_closed');
        expect(existsSync(join(state, '.fake-login'))).toBe(false);
    });
    it('a CLI that never prints a prompt is stopped', async () => {
        const { c } = await boxProfile('codex', '#!/usr/bin/env node\nconsole.log("starting");\nsetTimeout(() => {}, 60000);\n');
        const { api, reports } = fakeApi(); const logs: string[] = [];
        const started = Date.now();
        await handleBoxLogin(c, api, req('codex'), options(logs, { promptTimeoutMs: 500 }));
        expect(reports).toEqual([{ status: 'failed', error: 'login_prompt_not_found' }]);
        expect(Date.now() - started).toBeLessThan(5000);
    });
    it('the host stopping stops the login and says so', async () => {
        const { c, state } = await boxProfile('codex');
        await mkdir(state, { recursive: true }); await writeFile(join(state, '.fake-login-delay-ms'), '60000');
        const abort = new AbortController();
        const { api, reports } = fakeApi(); const logs: string[] = [];
        const done = handleBoxLogin(c, api, req('codex'), options(logs, { signal: abort.signal }));
        while (!reports.length) await new Promise(r => setTimeout(r, 20));
        abort.abort();
        await done;
        expect(reports.map(r => r.error ?? r.status)).toEqual(['awaiting_user', 'host_stopped']);
    });
});

describe('box login requests', () => {
    it('refuses an unknown profile, another adapter and an API-key profile', async () => {
        const t = await tempDir(); cleanups.push(t.cleanup);
        const c = config(t.dir);
        c.profiles['box-one'] = { ...c.profiles.builder, auth: 'api_key', apiKeyEnv: 'CODEX_API_KEY' };
        const { api, reports } = fakeApi(); const logs: string[] = [];
        await handleBoxLogin(c, api, { id: id(1), adapter: 'codex', profile: 'nope' }, options(logs));
        await handleBoxLogin(c, api, { id: id(1), adapter: 'claude', profile: 'builder' }, options(logs));
        await handleBoxLogin(c, api, { id: id(1), adapter: 'codex', profile: 'box-one' }, options(logs));
        expect(reports.map(r => r.error)).toEqual(['profile_unavailable', 'profile_unavailable', 'login_not_supported']);
    });
    it('polls only in box mode', async () => {
        const t = await tempDir(); cleanups.push(t.cleanup);
        let claims = 0;
        const api: HostApi = { ...fakeApi().api, claimBoxLogin: async () => { claims++; return null; } };
        delete process.env.AGORA_HOST_IN_BOX;
        await boxLoginLoop(config(t.dir), api, options([]));
        expect(claims).toBe(0);
        const marker = join(t.dir, 'agora-box'); await writeFile(marker, '1'); boxMode.marker = marker;
        process.env.AGORA_HOST_IN_BOX = '1';
        let stop = false; const logs: string[] = [];
        await boxLoginLoop(config(t.dir), api, options(logs, { stopping: () => stop, pause: async () => { if (claims >= 3) stop = true; } }));
        expect(claims).toBe(3);
        // A server without box logins: stop polling
        await boxLoginLoop(config(t.dir), { ...api, claimBoxLogin: async () => { throw new HttpError(404); } }, options(logs));
        expect(logs).toContain('box_login_unsupported');
        await rm(marker);
    });
});
