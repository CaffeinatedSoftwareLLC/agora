import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_ARGS, startAppServer, type AppServerPlan } from '../src/siwc/appserver.js';
import { cardAsker, splitCommand, type Ask, type Decision } from '../src/siwc/approvals.js';
import { appServerRules, type Launch } from '../src/adapters.js';
import { resolvePermissions } from '../src/presets.js';
import type { HostApi } from '../src/types.js';
import { claim, tempDir } from './helpers.js';

/**
 * Codex app-server approvals become tool-request cards (#93), against a fake app-server that
 * sends the requests the way codex 0.163 does (item/started, then the request; turn/started
 * before the turn/start response; serverRequest/resolved after an answer).
 */

let tmp: Awaited<ReturnType<typeof tempDir>>;
beforeEach(async () => { tmp = await tempDir(); });
afterEach(async () => { await tmp.cleanup(); });

const fixture = join(__dirname, 'fixtures', 'fake-app-server.mjs');
interface FakeRequest { id: number; method: string; params?: Record<string, unknown>; item?: unknown; resolveAfterMs?: number; otherTurn?: boolean }

async function run(requests: FakeRequest[], plan: Partial<AppServerPlan> = {}, opts: { kill?: (running: ReturnType<typeof startAppServer>) => void; env?: NodeJS.ProcessEnv } = {}) {
    const log = join(tmp.dir, 'fake.log');
    const launch: Launch & { appServer: AppServerPlan } = {
        executable: process.execPath, args: [fixture, 'app-server', '--listen', 'stdio://', ...PROVIDER_ARGS], cwd: tmp.dir,
        env: { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot, ACCESS_TOKEN: 'at', FAKE_LOG: log, FAKE_REQUESTS: JSON.stringify(requests), ...opts.env },
        stdin: '', adapter: 'codex', cleanup: async () => {},
        appServer: { threadId: null, prompt: 'Do the work', outputSchema: { type: 'object' }, model: null, effort: null, sandbox: 'workspace-write',
            refresh: async () => 'at', rpcTimeoutMs: 10000, rules: [], roots: [], ...plan },
    };
    const running = startAppServer(launch);
    opts.kill?.(running);
    const result = await running.result;
    const lines = (await readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    const answers = (rpcId: number) => lines.filter(l => l.id === rpcId && l.method === null);
    return { result, lines, answers };
}

const command = (id: number, cmd: string, extra: Record<string, unknown> = {}): FakeRequest =>
    ({ id, method: 'item/commandExecution/requestApproval', params: { itemId: `exec-${id}`, kind: 'command', command: cmd, ...extra } });
const fileChange = (id: number, paths: string[], extra: Record<string, unknown> = {}): FakeRequest => ({
    id, method: 'item/fileChange/requestApproval', params: { itemId: `patch-${id}`, reason: null, grantRoot: null, ...extra },
    item: { type: 'fileChange', id: `patch-${id}`, status: 'inProgress', changes: paths.map(path => ({ path, kind: { type: 'add' }, diff: 'hi\n' })) },
});
const asker = (decision: Decision) => vi.fn<Ask>(async () => decision);

describe('splitCommand', () => {
    it('reads the display form codex 0.163 sends on Windows', () => {
        expect(splitCommand(`"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command 'Set-Content -LiteralPath hello.txt -Value hi'`))
            .toEqual(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-Command', 'Set-Content -LiteralPath hello.txt -Value hi']);
        expect(splitCommand(`"C:\\\\Windows\\\\system32\\\\cmd.exe" /c 'curl -sI https://example.com'`))
            .toEqual(['C:\\Windows\\system32\\cmd.exe', '/c', 'curl -sI https://example.com']);
        expect(splitCommand(`/bin/bash -lc 'git status'`)).toEqual(['/bin/bash', '-lc', 'git status']);
    });
    it('refuses unbalanced quoting', () => {
        expect(splitCommand(`bash -lc 'git status`)).toBeNull();
        expect(splitCommand(`"unterminated`)).toBeNull();
    });
});

describe('app-server approval requests', () => {
    it('approves a command the rules allow, once, without a card', async () => {
        const ask = asker('deny');
        const { answers, result } = await run([command(1, 'git status', { cwd: tmp.dir })], { rules: ['Bash(git:*)'], ask });
        expect(answers(1)).toHaveLength(1);
        expect(answers(1)[0].result).toEqual({ decision: 'accept' });
        expect(ask).not.toHaveBeenCalled();
        expect(result.deniedTools).toBeUndefined();
    });

    it.each([['once', 'accept'], ['always', 'accept'], ['deny', 'decline']] as const)('relays a card decided "%s" as %s, never acceptForSession', async (decision, expected) => {
        const ask = asker(decision);
        const { answers, result } = await run([command(2, 'git push origin main', { cwd: tmp.dir })], { rules: ['Bash(git status:*)'], ask });
        expect(ask).toHaveBeenCalledOnce();
        const [req, signal] = ask.mock.calls[0];
        expect(req).toMatchObject({ tool: 'Bash(git:*)', detail: 'git push origin main' });
        expect(req.key).toMatch(/^[0-9a-f]{64}$/);
        expect(signal.aborted).toBe(false);
        expect(answers(2)[0].result).toEqual({ decision: expected });
        // The card was answered: no second, after-run card
        expect(result.deniedTools).toBeUndefined();
    });

    it('binds each card to its own request: two requests for the same tool get two keys', async () => {
        const ask = asker('once');
        await run([command(3, 'git fetch', { cwd: tmp.dir }), command(4, 'git fetch', { cwd: tmp.dir })], { ask });
        const keys = ask.mock.calls.map(c => c[0].key);
        expect(keys).toHaveLength(2);
        expect(new Set(keys).size).toBe(2);
    });

    it('shows the owner the whole command and its cwd, however long, and declines one too long to show', async () => {
        const long = `git log --format=${'x'.repeat(240)} && git push --force origin main`;
        const ask = asker('deny');
        await run([command(30, long, { cwd: tmp.dir })], { ask });
        expect(ask.mock.calls[0][0].detail).toBe(long);
        expect(ask.mock.calls[0][0].detail!.endsWith('git push --force origin main')).toBe(true);
        expect(ask.mock.calls[0][0].cwd).toBe(tmp.dir);
        const huge = await run([command(31, `git log ${'y'.repeat(9000)}`, { cwd: tmp.dir })], { ask: asker('once') });
        expect(huge.answers(31)[0].result).toEqual({ decision: 'decline' });
    });

    it('declines a request from another turn without a card', async () => {
        const ask = asker('once');
        const { answers } = await run([{ ...command(5, 'git push', { cwd: tmp.dir }), otherTurn: true }], { rules: ['Bash(git:*)'], ask });
        expect(answers(5)[0].result).toEqual({ decision: 'decline' });
        expect(ask).not.toHaveBeenCalled();
    });

    it('declines a command that starts outside the worktree, even when its rule is allowed', async () => {
        const ask = asker('once');
        const { answers } = await run([command(6, 'git status', { cwd: join(tmp.dir, '..') })], { rules: ['Bash(git:*)'], ask });
        expect(answers(6)[0].result).toEqual({ decision: 'decline' });
        expect(ask).not.toHaveBeenCalled();
    });

    it('asks for the whole shell when the program is not a trusted executable (a cmdlet)', async () => {
        const ask = asker('deny');
        const ps = `"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command 'Set-Content -LiteralPath hello.txt -Value hi'`;
        await run([command(7, ps, { cwd: tmp.dir })], { rules: ['Bash(Set-Content:*)'], ask });
        expect(ask.mock.calls[0][0].tool).toBe('Bash');
    });

    it('treats a managed-network prompt as a network request for its host', async () => {
        const ask = asker('once');
        const { answers } = await run([command(8, 'curl -sI https://example.com', { cwd: tmp.dir, networkApprovalContext: { host: 'example.com', protocol: 'https' } })], { ask });
        expect(ask.mock.calls[0][0]).toMatchObject({ tool: 'WebFetch(domain:example.com)', detail: 'network access to example.com' });
        expect(answers(8)[0].result).toEqual({ decision: 'accept' });
        const allowed = await run([command(9, 'curl -sI https://example.com', { cwd: tmp.dir, networkApprovalContext: { host: 'example.com', protocol: 'https' } })], { rules: ['network'], ask: asker('deny') });
        expect(allowed.answers(9)[0].result).toEqual({ decision: 'accept' });
    });

    it('declines a stdin write and a prompt that does not offer a one-time accept', async () => {
        const ask = asker('once');
        const { answers } = await run([
            command(10, 'git status', { cwd: tmp.dir, kind: 'writeStdin' }),
            command(11, 'git status', { cwd: tmp.dir, availableDecisions: ['acceptForSession', 'decline'] }),
        ], { rules: ['Bash(git:*)'], ask });
        expect(answers(10)[0].result).toEqual({ decision: 'decline' });
        expect(answers(11)[0].result).toEqual({ decision: 'decline' });
        expect(ask).not.toHaveBeenCalled();
    });

    it('approves a file change inside the worktree under the write rule, else asks for write', async () => {
        const inside = join(tmp.dir, 'src', 'a.ts');
        const allowed = await run([fileChange(12, [inside])], { rules: ['write'], ask: asker('deny') });
        expect(allowed.answers(12)[0].result).toEqual({ decision: 'accept' });
        const ask = asker('once');
        const carded = await run([fileChange(13, [inside])], { ask });
        expect(ask.mock.calls[0][0]).toMatchObject({ tool: 'write', detail: `edit ${join('src', 'a.ts')}` });
        expect(carded.answers(13)[0].result).toEqual({ decision: 'accept' });
    });

    it('declines a file change outside the worktree without a card, whatever the rules', async () => {
        const ask = asker('once');
        const { answers } = await run([
            fileChange(14, [join(tmp.dir, '..', 'outside.txt')]),
            fileChange(15, [join(tmp.dir, 'ok.txt')], { grantRoot: join(tmp.dir, '..') }),
            { id: 16, method: 'item/fileChange/requestApproval', params: { itemId: 'never-started' } },
        ], { rules: ['write'], ask });
        for (const rpcId of [14, 15, 16]) expect(answers(rpcId)[0].result).toEqual({ decision: 'decline' });
        expect(ask).not.toHaveBeenCalled();
    });

    it('grants a permission request only what the rules or a card allow, for this turn', async () => {
        const { answers } = await run([
            { id: 17, method: 'item/permissions/requestApproval', params: { itemId: 'p17', cwd: tmp.dir, reason: null, permissions: { network: { enabled: true } } } },
            { id: 18, method: 'item/permissions/requestApproval', params: { itemId: 'p18', cwd: tmp.dir, reason: null,
                permissions: { fileSystem: { read: null, write: [join(tmp.dir, '..')] } } } },
        ], { rules: ['network', 'write'], ask: asker('once') });
        expect(answers(17)[0].result).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
        expect(answers(18)[0].result).toEqual({ permissions: {}, scope: 'turn' });
    });

    it('answers unknown and unsupported request types with a denial', async () => {
        const { answers } = await run([
            { id: 19, method: 'mcpServer/elicitation/request', params: { serverName: 'x' } },
            { id: 20, method: 'item/tool/requestUserInput', params: {} },
            { id: 21, method: 'something/new', params: {} },
            { id: 22, method: 'execCommandApproval', params: {} },
        ], { ask: asker('once') });
        expect(answers(19)[0].result).toEqual({ action: 'decline' });
        expect(answers(20)[0].error.code).toBe(-32601);
        expect(answers(21)[0].error.code).toBe(-32601);
        expect(answers(22)[0].result).toEqual({ decision: 'denied' });
    });

    it('without a card flow (older server) declines and reports the rule for the after-run card', async () => {
        const { answers, result } = await run([command(23, 'gh pr list', { cwd: tmp.dir })]);
        expect(answers(23)[0].result).toEqual({ decision: 'decline' });
        expect(result.deniedTools).toEqual(['Bash(gh:*)']);
    });

    it('never answers a request Codex resolved itself, and closes its card', async () => {
        let seen: AbortSignal | undefined;
        const ask = vi.fn<Ask>((_req, signal) => { seen = signal; return new Promise(resolve => signal.addEventListener('abort', () => resolve('once'))); });
        const { answers } = await run([{ ...command(24, 'git push', { cwd: tmp.dir }), resolveAfterMs: 300 }], { ask }, { env: { FAKE_LINGER_MS: '600' } });
        expect(seen?.aborted).toBe(true);
        expect(seen?.reason).toBe('resolved');
        expect(answers(24)).toHaveLength(0);
    });

    it('answers a repeated request id only once', async () => {
        const ask = vi.fn<Ask>(() => new Promise(resolve => setTimeout(() => resolve('once'), 50)));
        const { answers } = await run([command(25, 'git push', { cwd: tmp.dir }), command(25, 'git push --force', { cwd: tmp.dir })], { ask });
        expect(ask).toHaveBeenCalledOnce();
        expect(answers(25)).toHaveLength(1);
    });

    it('a stopped run aborts held requests and sends no answer', async () => {
        let seen: AbortSignal | undefined;
        const ask = vi.fn<Ask>((_req, signal) => { seen = signal; return new Promise(resolve => signal.addEventListener('abort', () => resolve('deny'))); });
        const { answers, result } = await run([command(26, 'git push', { cwd: tmp.dir })], { ask }, {
            kill: running => { const t = setInterval(() => { if (ask.mock.calls.length) { clearInterval(t); running.kill().catch(() => {}); /* taskkill may be refused in a restricted environment: the abort is what is tested */ } }, 10); },
        });
        expect(result.success).toBe(false);
        expect(seen?.reason).toBe('stopped');
        expect(answers(26)).toHaveLength(0);
    });
});

describe('card flow over the host API', () => {
    function api(statuses: string[], opened = 'pending') {
        const toolRequest = vi.fn(async (_c: unknown, _id: string, close?: string) => ({ status: close ? (statuses.at(-1) === 'pending' ? 'expired' : statuses.at(-1)!) : statuses.shift() ?? 'pending' }));
        const openToolRequest = vi.fn(async () => ({ id: '01J00000000000000000000099', status: opened }));
        return { openToolRequest, toolRequest } as unknown as HostApi & { openToolRequest: typeof openToolRequest; toolRequest: typeof toolRequest };
    }
    const req = { tool: 'Bash(gh:*)', key: 'a'.repeat(64), detail: 'gh pr list' };

    it('posts the card and relays the decision', async () => {
        const a = api(['pending', 'once']);
        const ask = cardAsker(a, claim(), { waitMs: 5000, pollMs: 5 })!;
        await expect(ask(req, new AbortController().signal)).resolves.toBe('once');
        expect(a.openToolRequest).toHaveBeenCalledWith(expect.anything(), { tool: 'Bash(gh:*)', requestKey: 'a'.repeat(64), waitSeconds: 10, detail: 'gh pr list', cwd: null });
    });
    it('denies after the wait, closing the card as timed out', async () => {
        const a = api(['pending']);
        const ask = cardAsker(a, claim(), { waitMs: 40, pollMs: 5 })!;
        await expect(ask(req, new AbortController().signal)).resolves.toBe('deny');
        expect(a.toolRequest).toHaveBeenLastCalledWith(expect.anything(), '01J00000000000000000000099', 'timeout');
    });
    it('closes the card with the abort reason', async () => {
        const a = api(['pending']);
        const ask = cardAsker(a, claim(), { waitMs: 5000, pollMs: 5 })!;
        const ctl = new AbortController();
        setTimeout(() => ctl.abort('resolved'), 20);
        await expect(ask(req, ctl.signal)).resolves.toBe('deny');
        expect(a.toolRequest).toHaveBeenLastCalledWith(expect.anything(), '01J00000000000000000000099', 'resolved');
    });
    it('treats a denied, expired or unknown status as deny, and an "always" already on the profile as allowed', async () => {
        await expect(cardAsker(api(['denied']), claim(), { waitMs: 5000, pollMs: 5 })!(req, new AbortController().signal)).resolves.toBe('deny');
        await expect(cardAsker(api(['weird']), claim(), { waitMs: 5000, pollMs: 5 })!(req, new AbortController().signal)).resolves.toBe('deny');
        await expect(cardAsker(api([], 'always'), claim(), { waitMs: 5000, pollMs: 5 })!(req, new AbortController().signal)).resolves.toBe('always');
    });
    it('is unavailable on a server without live tool requests', () => {
        expect(cardAsker({} as HostApi, claim(), { waitMs: 1000 })).toBeUndefined();
    });
});

describe('approval rules for Codex', () => {
    it('uses the owner\'s rules and preset capabilities, not a preset\'s Claude rules', () => {
        const perms = resolvePermissions('read-only', ['dev'], ['Bash(gh:*)']);
        const rules = appServerRules(['Bash(gh:*)'], perms, ['chat_send']);
        expect(rules).toEqual(expect.arrayContaining(['Bash(gh:*)', 'mcp__agora__chat_send', 'write', 'network']));
        expect(rules).not.toContain('Bash(node:*)');
        expect(appServerRules([], resolvePermissions('read-only', ['readonly'], []), [])).not.toContain('write');
    });
});
