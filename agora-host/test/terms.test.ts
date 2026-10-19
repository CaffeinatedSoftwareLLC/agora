import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema, loadConfig } from '../src/config.js';
import { childEnv, verifyProfile } from '../src/adapters.js';
import { Scheduler } from '../src/scheduler.js';
import { checkTerms, describeAuth, needsRunApproval, profileReport, TermsRefusal, HostConfigError } from '../src/terms.js';
import type { HostApi } from '../src/types.js';
import { claim, config, tempDir } from './helpers.js';

/** Provider-terms guardrails on the host (src/terms.ts, docs/provider-terms.md). */

const raw = (dir: string, profile: Record<string, unknown>) => {
    const base = config(dir);
    return { instance: base.instance, hostToken: base.hostToken, mcp: base.mcp, botTokens: base.botTokens,
        profiles: { builder: { adapter: 'codex', executable: process.execPath, workdir: dir, workdirAlias: 'agora', stateDir: join(dir, 'state'), ...profile } } };
};

async function load(profile: Record<string, unknown>): Promise<string> {
    const t = await tempDir();
    try {
        const data = raw(t.dir, profile); const path = join(t.dir, 'host.local.json');
        await writeFile(data.mcp.entrypoint, ''); await writeFile(path, JSON.stringify(data));
        await loadConfig(path); return 'ok';
    } catch (e) {
        expect(e).toBeInstanceOf(HostConfigError);
        return (e as Error).message;
    } finally { await t.cleanup(); }
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('auth mode configuration', () => {
    it('defaults to subscription and validates the API key variable per CLI', () => {
        expect(config().profiles.builder.auth).toBe('subscription');
        const p = raw(process.cwd(), {}).profiles.builder;
        const ok = (extra: object) => configSchema.safeParse({ ...raw(process.cwd(), {}), profiles: { builder: { ...p, ...extra } } }).success;
        expect(ok({ auth: 'api_key', apiKeyEnv: 'CODEX_API_KEY' })).toBe(true);
        expect(ok({ auth: 'api_key', apiKeyEnv: 'OPENAI_API_KEY' })).toBe(true);
        expect(ok({ auth: 'api_key' })).toBe(false);
        expect(ok({ auth: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY' })).toBe(false);
        expect(ok({ auth: 'api_key', apiKeyEnv: 'PATH' })).toBe(false);
        expect(ok({ adapter: 'claude', auth: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY' })).toBe(true);
        expect(ok({ apiKeyEnv: 'CODEX_API_KEY' })).toBe(false);
        expect(ok({ allowSubscriptionAtOwnRisk: true })).toBe(false);
        expect(ok({ auth: 'oauth' })).toBe(false);
    });

    it('needs the API key variable set at start, and never prints its value', async () => {
        vi.stubEnv('CODEX_API_KEY', '');
        expect(await load({ auth: 'api_key', apiKeyEnv: 'CODEX_API_KEY' })).toMatch(/CODEX_API_KEY is not set/);
        vi.stubEnv('CODEX_API_KEY', 'sk-DO_NOT_PRINT');
        expect(await load({ auth: 'api_key', apiKeyEnv: 'CODEX_API_KEY' })).toBe('ok');
        const message = await load({ auth: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY' });
        expect(message).toMatch(/needs apiKeyEnv set to one of CODEX_API_KEY, OPENAI_API_KEY/);
        expect(message).not.toContain('DO_NOT_PRINT');
    });

    it('refuses a Gemini profile on account login, quoting Google\'s terms', async () => {
        const message = await load({ adapter: 'gemini' });
        expect(message).toMatch(/must use auth "api_key"/);
        expect(message).toContain('Using third party software, tools, or services to access the Service');
        expect(message).toContain('docs/provider-terms.md');
        vi.stubEnv('GEMINI_API_KEY', 'key');
        expect(await load({ adapter: 'gemini', auth: 'api_key', apiKeyEnv: 'GEMINI_API_KEY' })).toBe('ok');
        expect(await load({ adapter: 'gemini', allowSubscriptionAtOwnRisk: true })).toBe('ok');
    });

    it('forces run approval for Gemini at own risk, and the host runs Gemini only over ACP', async () => {
        const gemini = configSchema.parse(raw(process.cwd(), { adapter: 'gemini', allowSubscriptionAtOwnRisk: true })).profiles.builder;
        expect(needsRunApproval(gemini)).toBe(true);
        expect(needsRunApproval(config().profiles.builder)).toBe(false);
        await expect(verifyProfile(gemini)).rejects.toThrow(/hosted only over ACP with an API key/);
    });
});

describe('child environment', () => {
    it('passes only the profile\'s own key variable in api_key mode', () => {
        const p = { ...config().profiles.builder, auth: 'api_key' as const, apiKeyEnv: 'CODEX_API_KEY' };
        const env = childEnv(p, { Path: 'p', CODEX_API_KEY: 'k1', OPENAI_API_KEY: 'k2', ANTHROPIC_API_KEY: 'k3' });
        expect(env).toEqual({ Path: 'p', CODEX_HOME: p.stateDir, CODEX_API_KEY: 'k1' });
        expect(childEnv(config().profiles.builder, { Path: 'p', CODEX_API_KEY: 'k1' })).toEqual({ Path: 'p', CODEX_HOME: p.stateDir });
    });

    it('reports modes to Agora by variable name only', () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-secret');
        const profiles = { a: config().profiles.builder, b: { ...config().profiles.builder, adapter: 'claude' as const, auth: 'api_key' as const, apiKeyEnv: 'ANTHROPIC_API_KEY', requireRunApproval: true } };
        const report = profileReport(profiles);
        expect(report).toEqual([
            { name: 'a', adapter: 'codex', authMode: 'subscription', apiKeyEnv: null, runApproval: false },
            { name: 'b', adapter: 'claude', authMode: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY', runApproval: true },
        ]);
        expect(JSON.stringify(report)).not.toContain('sk-secret');
        expect(describeAuth('a', profiles.a)).toMatch(/only the server owner can wake it/);
        expect(describeAuth('b', profiles.b)).toMatch(/API key from ANTHROPIC_API_KEY; every run needs the owner's approval/);
    });
});

describe('claim checks', () => {
    const local = () => config().profiles.builder;
    const code = (fn: () => void) => { try { fn(); return null; } catch (e) { return (e as TermsRefusal).code; } };

    it('a subscription profile runs owner messages, commands and hand-offs in owner sessions', () => {
        expect(code(() => checkTerms(local(), claim()))).toBeNull();
        const owner = claim(); owner.inbox[0] = { ...owner.inbox[0], reason: 'direct', authorBot: false, authority: 'owner' };
        expect(code(() => checkTerms(local(), owner))).toBeNull();
        const lurk = claim(); lurk.inbox[0] = { ...lurk.inbox[0], reason: 'lurk', authorBot: false, authority: 'owner' };
        expect(code(() => checkTerms(local(), lurk))).toBeNull();
        const start = claim(); start.inbox[0] = { ...start.inbox[0], reason: 'command', authorId: null, authorBot: false };
        expect(code(() => checkTerms(local(), start))).toBeNull();
    });

    it('refuses a director, a bot message, a person posing as a hand-off, or a session the owner did not start', () => {
        const director = claim(); director.inbox[0] = { ...director.inbox[0], reason: 'direct', authorBot: false, authority: 'director' };
        expect(code(() => checkTerms(local(), director))).toBe('subscription_owner_only');
        const lurk = claim(); lurk.inbox[0] = { ...lurk.inbox[0], reason: 'lurk', authorBot: true, authority: null };
        expect(code(() => checkTerms(local(), lurk))).toBe('subscription_owner_only');
        const human = claim(); human.inbox[0] = { ...human.inbox[0], reason: 'handoff', authorBot: false };
        expect(code(() => checkTerms(local(), human))).toBe('subscription_owner_only');
        const theirs = claim(); theirs.session.startedByOwner = false;
        expect(code(() => checkTerms(local(), theirs))).toBe('subscription_owner_only');
        // The server's view doesn't loosen the local rule
        const stale = director; stale.profile.authMode = 'api_key';
        expect(code(() => checkTerms(local(), stale))).toBe('subscription_owner_only');
    });

    it('an api_key profile keeps the server\'s rules; run approval needs the owner\'s yes', () => {
        const p = { ...local(), auth: 'api_key' as const, apiKeyEnv: 'CODEX_API_KEY' };
        const director = claim(); director.session.startedByOwner = false;
        director.inbox[0] = { ...director.inbox[0], reason: 'direct', authorBot: false, authority: 'director' };
        expect(code(() => checkTerms(p, director))).toBeNull();
        expect(code(() => checkTerms({ ...p, requireRunApproval: true }, director))).toBe('run_not_approved');
        director.run.ownerApproved = true;
        expect(code(() => checkTerms({ ...p, requireRunApproval: true }, director))).toBeNull();
    });

    it('the scheduler reports a refusal by its code and never retries it', async () => {
        const api = { claim: vi.fn(async () => null), heartbeat: vi.fn(), complete: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
        const runner = { start: vi.fn() };
        const log = vi.fn();
        const scheduler = new Scheduler(config(), api as unknown as HostApi, runner as any, { now: () => Date.now(), tickMs: 10, log,
            prepare: async () => { throw new TermsRefusal('subscription_owner_only', 'no'); } });
        await scheduler.submit(claim(), Date.now());
        expect(runner.start).not.toHaveBeenCalled();
        expect(api.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ error: 'subscription_owner_only', retryable: false }), expect.anything());
        expect(log).toHaveBeenCalledWith('subscription_owner_only');
    });
});

describe('never touches CLI login files', () => {
    // Guardrail: the host must never read, copy or relay a CLI's own login or OAuth tokens
    it('has no reference to CLI credential files in its source', async () => {
        const dir = join(__dirname, '../src');
        const forbidden = /auth\.json|\.credentials\.json|oauth_creds|credentials\.db|accounts\.json|google_accounts|keychain/i;
        // Sign in with ChatGPT (src/siwc) keeps Agora's own OAuth registration, not a CLI's login
        for (const file of (await readdir(dir, { recursive: true })).filter(f => f.endsWith('.ts'))) {
            const text = await readFile(join(dir, file), 'utf8');
            expect(forbidden.test(text), file).toBe(false);
        }
    });
});
