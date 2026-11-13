import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, HttpError } from '../src/client.js';
import { Scheduler } from '../src/scheduler.js';
import type { HostApi } from '../src/types.js';
import { claudeCommandArgs, executeSessionCommand, parseClaudeCommand, runClaudeCommand, runCodexCompact, SESSION_COMMAND_TABLE, tokenCount,
    type CommandLaunch, type SessionCommand } from '../src/session-commands.js';
import { config, id } from './helpers.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const launchOf = (script: string, mode: string, stdin = ''): CommandLaunch =>
    ({ executable: process.execPath, args: [fixture(script)], cwd: process.cwd(), env: { ...process.env, FAKE_MODE: mode }, stdin });
const cmd = (over: Partial<SessionCommand> = {}): SessionCommand => ({ id: id(20), claimToken: 'claim-token-1', sessionId: id(2), profile: 'builder', adapter: 'claude',
    workdirAlias: 'agora', nativeSessionId: 'e226743b-163a-46d5-83fd-06200f51bd18', command: 'compact', arg: null, ...over });

describe('the command table', () => {
    it('names only what the host can run', () => {
        expect(SESSION_COMMAND_TABLE.claude).toEqual(['compact', 'context', 'clear']);
        expect(SESSION_COMMAND_TABLE.codex).toEqual(['compact', 'clear']);
        for (const a of ['gemini', 'opencode', 'omp', 'devin']) expect(SESSION_COMMAND_TABLE[a]).toEqual(['clear']);
    });
    it('reads 72.2k and 1m as numbers', () => {
        expect(tokenCount('72.2k')).toBe(72200); expect(tokenCount('1m')).toBe(1000000); expect(tokenCount('950')).toBe(950); expect(tokenCount('x')).toBeNull();
    });
});

describe('Claude commands through a fake claude -p', () => {
    it('builds the headless arguments without MCP, schema or tool lists, and resumes the conversation', () => {
        const args = claudeCommandArgs('e226743b-163a-46d5-83fd-06200f51bd18', false);
        expect(args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'manual', '--permission-prompts', 'none', '--resume', 'e226743b-163a-46d5-83fd-06200f51bd18']);
        expect(claudeCommandArgs('e226743b-163a-46d5-83fd-06200f51bd18', true)).toContain('--dangerously-skip-permissions');
    });
    it('compact: reports the token counts from compact_boundary, and sends the word on stdin as one prompt', async () => {
        const out = await runClaudeCommand('compact', launchOf('fake-claude-command.mjs', 'compact', '/compact'));
        expect(out).toEqual({ success: true, result: { tokensBefore: 72447, tokensAfter: 14640 } });
    });
    it('compact: the CLI answering "not enough messages" is a failure with its words', async () => {
        const out = await runClaudeCommand('compact', launchOf('fake-claude-command.mjs', 'too-short', '/compact'));
        expect(out).toEqual({ success: false, result: { error: 'compact_failed', message: 'Not enough messages to compact.' } });
    });
    it('compact: no boundary at all is compact_failed', () => {
        expect(parseClaudeCommand('compact', '{"type":"result","is_error":false,"num_turns":0}\n', 0)).toEqual({ success: false, result: { error: 'compact_failed' } });
    });
    it('context: takes only the CLI own (synthetic) answer, and reads the token line', async () => {
        const out = await runClaudeCommand('context', launchOf('fake-claude-command.mjs', 'context', '/context'));
        expect(out.success).toBe(true);
        expect(out.result).toMatchObject({ contextTokens: 72200, contextWindow: 1000000 });
        expect(out.result.text).toContain('72.2k / 1m (7%)');
    });
    it('context: a real model turn means it was not taken as a command', async () => {
        const out = await runClaudeCommand('context', launchOf('fake-claude-command.mjs', 'model-turn', '/context'));
        expect(out).toEqual({ success: false, result: { error: 'not_a_command' } });
    });
    it('reports a crash, a missing program and a hang by short codes', async () => {
        expect((await runClaudeCommand('compact', launchOf('fake-claude-command.mjs', 'crash'))).result.error).toBe('compact_failed');
        expect((await runClaudeCommand('compact', { ...launchOf('fake-claude-command.mjs', 'x'), executable: join(process.cwd(), 'no-such-program') })).result.error).toBe('spawn_failed');
        expect((await runClaudeCommand('compact', launchOf('fake-claude-command.mjs', 'hang'), undefined, undefined, 300)).result.error).toBe('timeout');
        const abort = new AbortController(); setTimeout(() => abort.abort(), 200);
        expect((await runClaudeCommand('compact', launchOf('fake-claude-command.mjs', 'hang'), abort.signal)).result.error).toBe('aborted');
    }, 20000);
});

describe('Codex compact through a fake app server', () => {
    const run = (mode: string, timeoutMs?: number, signal?: AbortSignal) =>
        runCodexCompact({ ...launchOf('fake-codex-compact.mjs', mode), threadId: '01a1d63d-7bd8-7d51-ba19-45c0d2d2de0d' }, signal, undefined, timeoutMs);
    it('resumes the thread, starts the compaction and waits for its turn', async () => {
        expect(await run('ok')).toEqual({ success: true, result: {} });
    });
    it('is a failure when the turn fails, when no compaction item completed, or when the thread is gone', async () => {
        expect((await run('failed')).result.error).toBe('compact_failed');
        expect((await run('no-item')).result.error).toBe('compact_failed');
        expect((await run('no-thread')).result.error).toBe('app_server_failed');
    });
    it('refuses a server request instead of waiting on it', async () => { expect((await run('ask')).success).toBe(true); });
    it('times out and stops the process', async () => { expect((await run('hang', 400)).result.error).toBe('timeout'); }, 20000);
});

describe('executeSessionCommand', () => {
    const deps = (script: string, mode: string) => ({ launch: async () => launchOf(script, mode, '/x') });
    it('refuses an argument, an unsupported command and an adapter without it, before anything runs', async () => {
        const never = { launch: async () => { throw new Error('must not launch'); } };
        expect((await executeSessionCommand(config(), cmd({ arg: 'x' }), undefined, never)).result.error).toBe('bad_argument');
        expect((await executeSessionCommand(config(), cmd({ adapter: 'codex', command: 'context' }), undefined, never)).result.error).toBe('unsupported');
        expect((await executeSessionCommand(config(), cmd({ adapter: 'gemini', command: 'compact' }), undefined, never)).result.error).toBe('unsupported');
        expect((await executeSessionCommand(config(), cmd({ adapter: 'unknown' }), undefined, never)).result.error).toBe('unsupported');
    });
    it('clear succeeds without starting anything, for every adapter', async () => {
        const never = { launch: async () => { throw new Error('must not launch'); } };
        for (const adapter of Object.keys(SESSION_COMMAND_TABLE)) expect(await executeSessionCommand(config(), cmd({ adapter, command: 'clear', nativeSessionId: null }), undefined, never)).toEqual({ success: true, result: {} });
    });
    it('has nothing to compact without a conversation', async () => {
        expect((await executeSessionCommand(config(), cmd({ nativeSessionId: null }), undefined, deps('fake-claude-command.mjs', 'compact'))).result.error).toBe('no_conversation');
    });
    it('runs claude compact and context, and codex compact', async () => {
        expect((await executeSessionCommand(config(), cmd(), undefined, deps('fake-claude-command.mjs', 'compact'))).result).toEqual({ tokensBefore: 72447, tokensAfter: 14640 });
        expect((await executeSessionCommand(config(), cmd({ command: 'context' }), undefined, deps('fake-claude-command.mjs', 'context'))).result.contextTokens).toBe(72200);
        expect(await executeSessionCommand(config(), cmd({ adapter: 'codex', nativeSessionId: '01a1d63d-7bd8-7d51-ba19-45c0d2d2de0d' }), undefined, deps('fake-codex-compact.mjs', 'ok'))).toEqual({ success: true, result: {} });
    });
    it('turns a launch problem into a short code, and an unmapped profile is refused for real', async () => {
        expect((await executeSessionCommand(config(), cmd(), undefined, { launch: async () => { throw new Error('C:\\secret\\path failed'); } })).result.error).toBe('launch_failed');
        expect((await executeSessionCommand(config(), cmd({ profile: 'nobody' }))).result.error).toBe('unmapped_profile');
        expect((await executeSessionCommand(config(), cmd({ adapter: 'codex', nativeSessionId: 'not-a-uuid' }))).result.error).toBe('invalid_native_session_id');
    });
});

describe('Client', () => {
    let server: Server | undefined;
    afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); server = undefined; } });
    async function fake(handler: (method: string, path: string, body: string) => { status: number; body?: unknown }) {
        server = createServer(async (req, res) => {
            let body = ''; for await (const chunk of req) body += chunk;
            const r = handler(req.method!, req.url!, body);
            res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(r.body === undefined ? '' : JSON.stringify(r.body));
        });
        await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
        return `http://127.0.0.1:${(server.address() as any).port}`;
    }
    const wire = { id: id(20), claimToken: 'claim-token-1', sessionId: id(2), profile: 'builder', adapter: 'claude', workdirAlias: 'agora',
        nativeSessionId: null, command: 'compact', arg: null };
    it('claims with v=1 and retries only the result report', async () => {
        let reports = 0; const seen: string[] = [];
        const url = await fake((method, path, body) => {
            seen.push(`${method} ${path}`);
            if (path.includes('/next')) return { status: 200, body: wire };
            reports++; expect(JSON.parse(body)).toEqual({ claimToken: 'claim-token-1', success: true, result: { tokensBefore: 5 } });
            return { status: reports === 1 ? 503 : 200, body: { ok: true } };
        });
        const client = new Client(url, 'ah_test', fetch, undefined, 1);
        const c = await client.claimSessionCommand();
        expect(c).toMatchObject({ command: 'compact', nativeSessionId: null, arg: null });
        await client.sessionCommandResult(c!, true, { tokensBefore: 5 });
        expect(reports).toBe(2);
        expect(seen[0]).toBe('GET /agent-hosts/@me/session-commands/next?v=1');
        expect(seen[1]).toBe(`POST /agent-hosts/@me/session-commands/${wire.id}/result`);
    });
    it('returns null on 204, rejects a command word it does not know, and does not retry a 409', async () => {
        let n = 0;
        const url = await fake((method) => { n++; if (method === 'GET' && n === 1) return { status: 204 }; if (method === 'GET') return { status: 200, body: { ...wire, command: 'format-disk' } }; return { status: 409, body: { error: 'x' } }; });
        const client = new Client(url, 'ah_test', fetch, undefined, 1);
        expect(await client.claimSessionCommand()).toBeNull();
        await expect(client.claimSessionCommand()).rejects.toThrow();
        await expect(client.sessionCommandResult(wire as any, false, { error: 'x' })).rejects.toBeInstanceOf(HttpError);
        expect(n).toBe(3);
    });
});

describe('the session command loop', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
    afterEach(() => { vi.useRealTimers(); });
    function setup(items: Array<SessionCommand | 'end' | 'unsupported'>, active?: string) {
        const sent: Array<{ cmd: SessionCommand; success: boolean; result: any }> = [];
        const queue = [...items]; let scheduler!: Scheduler;
        const api: Partial<HostApi> = {
            claim: vi.fn(async () => { await new Promise(r => setTimeout(r, 50)); return null; }),
            claimSessionCommand: vi.fn(async () => {
                const next = queue.shift();
                if (next === 'unsupported') throw new HttpError(404);
                if (next === 'end' || next === undefined) { void scheduler.stop(); return null; }
                return next;
            }),
            sessionCommandResult: vi.fn(async (c, success, result) => { sent.push({ cmd: c, success, result }); }),
            claimWorkspaceCommand: vi.fn(async () => { throw new HttpError(404); }), claimPreview: vi.fn(async () => { throw new HttpError(404); }), claimGithubCommand: vi.fn(async () => { throw new HttpError(404); }),
        };
        const logs: string[] = [];
        scheduler = new Scheduler(config(), api as HostApi, { start: vi.fn() } as any, { now: () => Date.now(), tickMs: 10, commandPollMs: 5, log: c => logs.push(c),
            commandDeps: { launch: async () => launchOf('fake-claude-command.mjs', 'compact', '/compact') } });
        if (active) (scheduler as any).active.set(active, { done: Promise.resolve() });
        return { scheduler, api, sent, logs };
    }
    // Real child processes need real timers
    it('runs a claimed command and reports its result', async () => {
        vi.useRealTimers();
        const s = setup([cmd(), 'end']);
        await s.scheduler.run();
        expect(s.sent).toHaveLength(1);
        expect(s.sent[0]).toMatchObject({ success: true, result: { tokensBefore: 72447, tokensAfter: 14640 } });
    });
    it('refuses a command for a session that has a run going (session_busy), without running it', async () => {
        vi.useRealTimers();
        const s = setup([cmd(), 'end'], id(2));
        await s.scheduler.run();
        expect(s.sent[0]).toMatchObject({ success: false, result: { error: 'session_busy' } });
        expect(s.logs).toContain('session_command_session_busy');
    });
    it('stops polling when the server is older and has no commands', async () => {
        vi.useRealTimers();
        const s = setup(['unsupported']);
        setTimeout(() => void s.scheduler.stop(), 300);
        await s.scheduler.run();
        expect(s.logs).toContain('session_commands_unsupported');
        expect(s.api.claimSessionCommand).toHaveBeenCalledTimes(1);
    });
    it('does nothing when the API has no command methods (an older client)', async () => {
        vi.useRealTimers();
        const s = setup([]); delete (s.api as any).claimSessionCommand;
        setTimeout(() => void s.scheduler.stop(), 200);
        await s.scheduler.run();
        expect(s.sent).toHaveLength(0);
    });
});
