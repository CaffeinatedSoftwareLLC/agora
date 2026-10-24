import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Launch } from '../src/adapters.js';
import { opencodeModel, prepare } from '../src/adapters.js';
import { configSchema, loadConfig } from '../src/config.js';
import { ProcessRunner } from '../src/process.js';
import { ACP_FATAL, CREDIT_MESSAGE, type AcpPlan } from '../src/acp/session.js';
import { ruleForCall } from '../src/acp/permissions.js';
import { creditLine, KEY_URL } from '../src/openrouter.js';
import { profileReport } from '../src/terms.js';
import { claim, config, tempDir } from './helpers.js';

/** opencode over ACP on an OpenRouter key (README, "opencode and OpenRouter"). */

const fixture = resolve('test/fixtures/fake-acp-agent.mjs');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); while (cleanups.length) await cleanups.pop()!(); });

async function repo() {
    const t = await tempDir(); cleanups.push(t.cleanup);
    await promisify(execFile)('git', ['init'], { cwd: t.dir });
    await promisify(execFile)('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: t.dir });
    return t.dir;
}
/** The test profile without the defaults parsing filled in, so opencode's own apply. */
function bare(dir: string) {
    const { protocol: _p, auth: _a, acpArgs: _g, apiKeyEnv: _k, ...rest } = config(dir).profiles.builder;
    return rest;
}
function opencode(dir: string, profile: object = {}) {
    return configSchema.parse({ ...config(dir), profiles: { builder: { ...bare(dir), adapter: 'opencode', ...profile } } });
}
function delivery(model: string | null = 'qwen/qwen3-coder') {
    const c = claim(); c.profile.adapter = 'opencode'; c.profile.model = model; c.profile.effort = null; c.profile.authMode = 'api_key';
    return c;
}
async function run(agentEnv: Record<string, string>, plan: Partial<AcpPlan> = {}, cwd?: string) {
    const t = await tempDir(); cleanups.push(t.cleanup);
    const log = join(t.dir, 'acp.log');
    const launch: Launch = {
        executable: process.execPath, args: [fixture], cwd: cwd ?? t.dir, env: { PATH: process.env.PATH, ACP_LOG: log, ...agentEnv },
        adapter: 'opencode', stdin: '', cleanup: async () => {},
        acp: { prompt: 'Do the task', nativeSessionId: null, model: null, effort: null, authMethod: null, rules: [], mcpServers: [], rpcTimeoutMs: 5000, ...plan },
    };
    const result = await new ProcessRunner().start(launch).result;
    const messages = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    return { result, messages };
}

describe('opencode profiles', () => {
    it('defaults to ACP on OPENROUTER_API_KEY and refuses anything else', async () => {
        const t = await tempDir(); cleanups.push(t.cleanup);
        const p = opencode(t.dir).profiles.builder;
        expect(p).toMatchObject({ protocol: 'acp', acpArgs: ['acp'], auth: 'api_key', apiKeyEnv: 'OPENROUTER_API_KEY' });
        expect(profileReport({ builder: p })).toEqual([{ name: 'builder', adapter: 'opencode', authMode: 'api_key', apiKeyEnv: 'OPENROUTER_API_KEY', runApproval: false }]);

        const base = config(t.dir); const path = join(t.dir, 'host.local.json'); await writeFile(base.mcp.entrypoint, '');
        const load = async (profile: object) => {
            await writeFile(path, JSON.stringify({ ...base, profiles: { builder: { ...bare(t.dir), adapter: 'opencode', ...profile } } }));
            try { await loadConfig(path); return 'ok'; } catch (e) { return (e as Error).message; }
        };
        expect(await load({})).toContain('OPENROUTER_API_KEY is not set');
        vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-secret');
        expect(await load({})).toBe('ok');
        expect(await load({ protocol: 'cli' })).toContain('opencode is hosted only over ACP');
        expect(await load({ auth: 'subscription' })).toContain('opencode is hosted only over ACP');
        expect(await load({ apiKeyEnv: 'ANTHROPIC_API_KEY' })).toContain('apiKeyEnv set to one of OPENROUTER_API_KEY');
        // The cap is the key's own credit limit, not a host setting
        expect(await load({ caps: { maxBudgetUsd: 5 } })).toContain('ACP has no verified USD cap');
        // A failed load never echoes the key
        expect(await load({ protocol: 'cli' })).not.toContain('sk-or-secret');
    });

    it('prepares a turn: own state dirs, project config off, only OpenRouter, the profile model, every tool asks', async () => {
        vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-secret');
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-other');
        const dir = await repo();
        const c = opencode(dir);
        const d = delivery(); d.profile.toolPresets = ['readonly'];
        const launch = await prepare(c, d); cleanups.push(launch.cleanup);
        expect(launch.args).toEqual(['acp']); expect(launch.stdin).toBe('');
        const state = c.profiles.builder.stateDir;
        expect(launch.env).toMatchObject({ OPENROUTER_API_KEY: 'sk-or-secret', XDG_CONFIG_HOME: join(state, 'config'), XDG_DATA_HOME: join(state, 'data'),
            XDG_CACHE_HOME: join(state, 'cache'), XDG_STATE_HOME: join(state, 'state'), OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_PURE: '1',
            OPENCODE_DISABLE_CLAUDE_CODE: '1' });
        expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
        const inline = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
        expect(inline).toEqual({ model: 'openrouter/qwen/qwen3-coder', small_model: 'openrouter/qwen/qwen3-coder', enabled_providers: ['openrouter'],
            share: 'disabled', autoupdate: false, permission: { '*': 'ask', todowrite: 'allow', todoread: 'allow' } });
        // opencode reads the key itself: no authenticate call, which would be its terminal login
        expect(launch.acp).toMatchObject({ authMethod: null, model: 'openrouter/qwen/qwen3-coder', effort: null });
        expect(launch.acp!.rules).toEqual(expect.arrayContaining(['Read', 'mcp__agora__chat_send']));
        expect(launch.acp!.prompt).not.toContain('sk-or-secret');
        expect(JSON.stringify(launch.acp!.mcpServers)).not.toContain('sk-or-secret');

        // opencode's own default would be an OpenCode Zen model
        await expect(prepare(c, delivery(null))).rejects.toThrow('opencode_model_required');
        expect(opencodeModel('openrouter/qwen/qwen3-coder', 'openrouter')).toBe('openrouter/qwen/qwen3-coder');
        expect(opencodeModel('anthropic/claude-sonnet-4.5', 'openrouter')).toBe('openrouter/anthropic/claude-sonnet-4.5');
    });

    it('answers opencode-shaped permission requests from the rules', async () => {
        const t = await tempDir(); cleanups.push(t.cleanup);
        const file = join(t.dir, 'a.txt'); await writeFile(file, 'hi');
        // opencode sends the input in an update, then asks with empty locations and raw input
        const { result, messages } = await run({ ACP_TOOLS: JSON.stringify([
            { kind: 'read', title: 'read', rawInput: {}, update: { kind: 'read', title: 'read', locations: [{ path: file }], rawInput: { filePath: file } },
                ask: { kind: 'read', title: 'read', locations: [], rawInput: {} } },
            { kind: 'other', title: 'agora_chat_send', rawInput: {}, update: { rawInput: { content: 'hi' } }, ask: { kind: 'other', title: 'agora_chat_send', rawInput: {} } },
            { kind: 'other', title: 'agora_thread_close', rawInput: {}, ask: { kind: 'other', title: 'agora_thread_close', rawInput: {} } },
            // A write outside the worktree: opencode first asks for the directory
            { kind: 'edit', title: 'write', rawInput: {}, ask: { kind: 'other', title: '/elsewhere', locations: [{ path: '/elsewhere/x.txt' }], rawInput: { filepath: '/elsewhere/x.txt', parentDir: '/elsewhere' } } },
        ]) }, { rules: ['Read', 'mcp__agora__chat_send'] }, t.dir);
        const answers = messages.filter(m => m.permission).map(m => m.answer.outcome.optionId);
        expect(answers).toEqual(['yes', 'yes', 'no', 'no']);
        expect(result.deniedTools).toEqual(['mcp__agora__thread_close']);
    });

    it('reports an OpenRouter key out of credit as credit_exhausted, not a generic failure', async () => {
        for (const message of [
            'Internal error: This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 120.',
            'Internal error: Insufficient credits. Add more using https://openrouter.ai/settings/credits',
            'Internal error: Key limit exceeded (monthly limit). Manage it using https://openrouter.ai/settings/keys',
            'Internal error: Budget limit exceeded (weekly limit). $52.00 of $50.00 used.',
        ]) {
            const { result } = await run({ ACP_PROMPT_ERROR: JSON.stringify({ code: -32603, message, data: { service: 'session', errorName: 'APIError' } }) });
            expect(result).toMatchObject({ success: false, error: 'credit_exhausted', errorMessage: CREDIT_MESSAGE });
            expect(result.rateLimit).toBeUndefined();
        }
        expect(ACP_FATAL.has('credit_exhausted')).toBe(true);
        // Credit held by requests still in flight frees up: an ordinary, retryable failure
        const inFlight = await run({ ACP_PROMPT_ERROR: JSON.stringify({ code: -32603, message: 'Internal error: Request would exceed available credits given current in-flight requests' }) });
        expect(inFlight.result.error).toBe('acp_request_failed');
    });

    it('maps opencode MCP titles to Agora rules, and nothing else', () => {
        expect(ruleForCall({ kind: 'other', title: 'agora_chat_send' })).toBe('mcp__agora__chat_send');
        expect(ruleForCall({ kind: 'other', title: 'agora_chat_send {"content":"x"}' })).toBeNull();
        expect(ruleForCall({ kind: 'other', title: 'evil_chat_send' })).toBeNull();
        expect(ruleForCall({ kind: 'other', title: 'todowrite' })).toBeNull();
    });
});

describe('OpenRouter credit limit at start', () => {
    const reply = (status: number, body: unknown) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
    it('reports the key limit and what is left, without the key', async () => {
        const t = await tempDir(); cleanups.push(t.cleanup);
        const p = opencode(t.dir).profiles.builder;
        const env = { OPENROUTER_API_KEY: 'sk-or-secret' };
        const fetcher = reply(200, { data: { label: 'sk-or-v1-abc...', limit: 10, limit_remaining: 7.5, limit_reset: 'monthly', usage: 2.5 } });
        const line = await creditLine('builder', p, env, fetcher as unknown as typeof fetch);
        expect(line).toBe('Profile builder: OpenRouter key credit limit $10.00, $7.50 left, resets monthly.');
        expect(fetcher.mock.calls[0][0]).toBe(KEY_URL);
        expect((fetcher.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-secret');
        expect(line).not.toContain('sk-or');

        expect(await creditLine('builder', p, env, reply(200, { data: { limit: null, limit_remaining: null, limit_reset: null } }) as unknown as typeof fetch))
            .toContain('has no credit limit');
        expect(await creditLine('builder', p, env, reply(401, { error: { message: 'bad key sk-or-secret' } }) as unknown as typeof fetch))
            .toBe("Profile builder: could not read the OpenRouter key's credit limit (HTTP 401).");
        expect(await creditLine('builder', p, env, reply(200, { nope: true }) as unknown as typeof fetch)).toBe("Profile builder: could not read the OpenRouter key's credit limit.");
        // No key, or not an opencode profile: nothing to ask
        expect(await creditLine('builder', p, {}, reply(200, {}) as unknown as typeof fetch)).toBeNull();
        expect(await creditLine('builder', config(t.dir).profiles.builder, env, reply(200, {}) as unknown as typeof fetch)).toBeNull();
    });
});
