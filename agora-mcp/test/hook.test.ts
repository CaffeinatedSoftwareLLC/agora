import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
    decideStop, hookCliArg, parseRollout, parseTranscript, readTranscriptTail, runHook, sessionStates,
    STOP_MARKER, TRANSCRIPT_TAIL_BYTES, type HookDeps, type HookInput,
} from '../src/hook.js';
import {
    ancestors, findHookStates, hookCli, hookStateDir, isClaudeClient, normalizePath, processRunning, projectKey, startHookState, sweepHookStates, writeHookState, type HookState,
} from '../src/hook-state.js';

const CHANNEL = '01J0000000000000000000CHAN';
const THREAD = '01J000000000000000000THRED';
const OTHER_THREAD = '01J0000000000000000000OTHR';

let root: string;
let stateDir: string;
let project: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agora-hook-'));
    stateDir = join(root, 'agora-home', 'hooks');
    project = join(root, 'work', 'proj');
    await mkdir(join(project, 'sub'), { recursive: true });
});
// startHookState sweeps and writes in the background without being awaited, so a write can land
// while the folder is being removed (ENOTEMPTY in CI). rm retries those errors with maxRetries.
const RM_RETRY = { maxRetries: 10, retryDelay: 50 } as const;
afterEach(async () => { await rm(root, { recursive: true, force: true, ...RM_RETRY }); });

/** What a running agora-mcp leaves for the hooks (src/hook-state.ts). */
const serverState = (over: Partial<HookState> = {}): HookState => ({
    instance: 'http://agora.test', token: 'bot_a.secret', defaultChannel: 'general', client: 'claude-code', server: 'agora',
    projectDir: project, pid: 4242, updatedAt: new Date().toISOString(), ...over,
});

// ─── Transcript fixtures (Claude Code's JSONL) ───

let ids = 0;
function toolUse(tool: string, input: Record<string, unknown>, result?: { text: string; error?: boolean }, server = 'agora'): string[] {
    const id = `toolu_${++ids}`;
    const lines = [JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: `mcp__${server}__${tool}`, input }] } })];
    if (result) {
        lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: result.error ?? false, content: [{ type: 'text', text: result.text }] }] } }));
    }
    return lines;
}
const said = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const userSaid = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
/** What Claude Code writes when a Stop hook blocks. */
const feedback = (reason = `${STOP_MARKER} keep listening`) => userSaid(`Stop hook feedback:\n[agora-mcp hook stop]: ${reason}`);
const transcript = (...lines: (string | string[])[]) => lines.flat().join('\n') + '\n';

// ─── A stub Agora ───

interface Stub {
    threads: { id: string; lastReplyAt: string }[][]; replies?: unknown[] | null; channels?: { id: string; name: string }[]; status?: number;
    /** X-Agora-Thread-State on the replies; absent like on a server without it. */
    threadState?: 'open' | 'closed';
}
function stubAgora(stub: Stub) {
    const calls: { url: string; init: RequestInit }[] = [];
    const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const path = url.replace('http://agora.test', '');
        if (stub.status) return json({ error: 'nope' }, stub.status);
        if (path === '/bots/@me') return json({ id: 'BOT', channels: stub.channels ?? [{ id: CHANNEL, name: 'general' }] });
        if (path.startsWith(`/channels/${CHANNEL}/threads`)) {
            const before = new URL(url).searchParams.get('before');
            const page = before ? Number(before.replace('t', '')) : 0;
            return json(stub.threads[page] ?? []);
        }
        if (path.startsWith(`/channels/${CHANNEL}/messages/`)) {
            return stub.replies === null ? json({ error: 'Message not found' }, 404)
                : json(stub.replies ?? [{ id: 'r' }], 200, stub.threadState ? { 'x-agora-thread-state': stub.threadState } : {});
        }
        if (path === '/bots/@me/terminal-sessions/end') return json({ ended: ['S'] });
        return json({ error: 'not found' }, 404);
    });
    return { fetcher: fetcher as unknown as typeof fetch, calls };
}

async function setup(lines: string, opts: { state?: Partial<HookState>; env?: NodeJS.ProcessEnv; stub?: Stub; running?: boolean } = {}) {
    await writeHookState(serverState(opts.state), stateDir);
    const path = join(root, 'session.jsonl');
    await writeFile(path, lines);
    const agora = stubAgora(opts.stub ?? { threads: [[{ id: THREAD, lastReplyAt: 't1' }]] });
    const deps: HookDeps = { env: opts.env ?? {}, fetch: agora.fetcher, stateDir, isRunning: () => opts.running ?? true, budgetMs: 2_000 };
    const input: HookInput = { session_id: 's', transcript_path: path, cwd: project, hook_event_name: 'Stop', permission_mode: 'default', stop_hook_active: false };
    return { deps, input, calls: agora.calls };
}

describe('the state file agora-mcp leaves for the hooks', () => {
    it('normalizes Windows paths and walks up from the session directory', () => {
        expect(normalizePath('C:\\Users\\Eryk\\proj\\')).toBe('c:/users/eryk/proj');
        expect(normalizePath('/home/eryk/Proj/')).toBe('/home/eryk/Proj');
        expect(ancestors('C:\\Users\\Eryk\\proj')).toEqual(['c:/users/eryk/proj', 'c:/users/eryk', 'c:/users', 'c:/']);
        expect(ancestors('/home/eryk')).toEqual(['/home/eryk', '/home', '/']);
        expect(projectKey('C:\\Users\\Eryk\\Proj')).toBe(projectKey('c:/users/eryk/proj/'));
    });

    it('is written atomically under the project key, private, and refreshed in place', async () => {
        const path = await writeHookState(serverState(), stateDir);
        expect(path).toBe(join(stateDir, `${projectKey(project)}.agora.4242.json`));
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(serverState({ updatedAt: expect.any(String) }));
        await writeHookState(serverState({ token: 'bot_b.secret' }), stateDir);
        expect(await readdir(stateDir)).toEqual([`${projectKey(project)}.agora.4242.json`]);
        expect(JSON.parse(await readFile(path, 'utf8')).token).toBe('bot_b.secret');
        if (process.platform !== 'win32') {
            expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
            expect((await stat(path)).mode & 0o777).toBe(0o600);
        }
    });

    it('agora-mcp writes it once a Claude client initialized, keyed by CLAUDE_PROJECT_DIR, and only then', async () => {
        const config = { instance: 'http://agora.test', token: 'bot_a.secret', defaultChannel: 'general' };
        // The client's name may only be readable after `oninitialized`: it is read on each write
        let name: string | null = null;
        const write = startHookState(config, () => name, { CLAUDE_PROJECT_DIR: project, AGORA_HOOK_SERVER: 'agora-tim' }, stateDir);
        expect(await write!()).toBe(false);
        name = 'claude-code';
        expect(await write!()).toBe(true);
        const [state] = findHookStates([join(project, 'sub')], () => true, stateDir);
        expect(state).toMatchObject({ ...config, client: 'claude-code', server: 'agora-tim', projectDir: project, pid: process.pid });

        // Another MCP client in the same folder, or a server name tools can't have, writes nothing
        const other = join(root, 'x');
        expect(await startHookState(config, () => 'cursor-vscode', { CLAUDE_PROJECT_DIR: other }, stateDir)!()).toBe(false);
        expect(startHookState(config, () => 'claude-code', { CLAUDE_PROJECT_DIR: other, AGORA_HOOK_SERVER: '../evil' }, stateDir)).toBeUndefined();
        expect(findHookStates([other], () => true, stateDir)).toEqual([]);
        expect(isClaudeClient('Claude Desktop')).toBe(true);
        expect(isClaudeClient('claude-ai')).toBe(true);
        expect(isClaudeClient('claudette')).toBe(false);
    });

    it('is found from CLAUDE_PROJECT_DIR first, then the cwd and its parents; stale or broken files are skipped', async () => {
        await writeHookState(serverState(), stateDir);
        const deps = (over: Partial<HookDeps> = {}): HookDeps => ({ env: {}, fetch, stateDir, isRunning: () => true, ...over });
        expect(sessionStates({ cwd: join(project, 'sub') }, deps())).toHaveLength(1);
        expect(sessionStates({ cwd: join(root, 'elsewhere') }, deps())).toEqual([]);
        expect(sessionStates({ cwd: join(root, 'elsewhere') }, deps({ env: { CLAUDE_PROJECT_DIR: project } }))).toHaveLength(1);

        // The server is gone: Stop ignores it
        expect(sessionStates({ cwd: project }, deps({ isRunning: () => false }))).toEqual([]);

        await writeFile(join(stateDir, `${projectKey(project)}.broken.json`), '{nope');
        await writeFile(join(stateDir, `${projectKey(project)}.other.json`), JSON.stringify({ ...serverState(), token: 'not-a-bot-token' }));
        expect(sessionStates({ cwd: project }, deps())).toHaveLength(1);
        expect(findHookStates([project], () => true, join(root, 'missing'))).toEqual([]);
        expect(processRunning(process.pid)).toBe(true);
        expect(processRunning(2 ** 30)).toBe(false);
    });
});

describe('reading the transcript', () => {
    it('targets the latest chat_wait/chat_send/thread_start/chat_read, skipping failed calls and other servers', () => {
        const state = parseTranscript(transcript(
            toolUse('chat_send', { channel: 'general', message: 'hi' }, { text: 'sent' }),
            toolUse('chat_wait', { channel: 'general', thread: THREAD }, { text: 'no new messages' }),
            toolUse('chat_read', { channel: 'random', thread: OTHER_THREAD }, { text: 'denied', error: true }),
            toolUse('chat_send', { channel: 'x', thread: OTHER_THREAD }, { text: 'ok' }, 'agora-tim'),
        ), 'agora');
        expect(state.target).toEqual({ channel: 'general', thread: THREAD });
        expect(state.closedTarget).toBe(false);

        // A subagent's Agora call (sidechain line) is not the session's
        const sidechain = JSON.stringify({ ...JSON.parse(toolUse('chat_send', { thread: OTHER_THREAD, message: 'x' })[0]), isSidechain: true });
        expect(parseTranscript(transcript(sidechain), 'agora').target).toBeUndefined();
    });

    it('takes a started thread\'s ID from the thread_start result', () => {
        const state = parseTranscript(transcript(
            toolUse('thread_start', { channel: 'general', message: 'topic' }, { text: `Thread started in #general (thread: ${THREAD}). Reply with chat_send thread="${THREAD}".` }),
        ), 'agora');
        expect(state.target).toEqual({ channel: 'general', thread: THREAD });
    });

    it('notices a closed thread, and a reopened one', () => {
        const closed = transcript(toolUse('chat_send', { thread: THREAD, message: 'bye' }, { text: 'ok' }), toolUse('thread_close', { thread: THREAD }, { text: 'closed' }));
        expect(parseTranscript(closed, 'agora').closedTarget).toBe(true);
        const other = transcript(toolUse('chat_send', { thread: THREAD, message: 'bye' }, { text: 'ok' }), toolUse('thread_close', { thread: OTHER_THREAD }, { text: 'closed' }));
        expect(parseTranscript(other, 'agora').closedTarget).toBe(false);
        const reopened = transcript(closed, toolUse('thread_close', { thread: THREAD, reopen: true }, { text: 'reopened' }));
        expect(parseTranscript(reopened, 'agora')).toMatchObject({ closedTarget: false, target: { thread: THREAD } });
    });

    it('finds our last continuation and a chat_wait after it, ignoring tool results that quote the marker', () => {
        const waited = parseTranscript(transcript(
            toolUse('chat_send', { thread: THREAD, message: 'x' }, { text: 'ok' }), feedback(),
            toolUse('chat_wait', { thread: THREAD }, { text: 'msgs' }),
        ), 'agora');
        expect(waited).toMatchObject({ waitedSinceContinuation: true });
        expect(waited.lastContinuation).toBeGreaterThan(0);

        const ignored = parseTranscript(transcript(
            toolUse('chat_wait', { thread: THREAD }, { text: 'msgs' }), feedback(),
            toolUse('Read', { file_path: 'hook.ts' }, { text: `export const STOP_MARKER = '${STOP_MARKER}'` }, 'other'),
        ), 'agora');
        expect(ignored.waitedSinceContinuation).toBe(false);
    });

    it('sees "done listening" said after the latest target', () => {
        expect(parseTranscript(transcript(toolUse('chat_wait', { thread: THREAD }, { text: 'm' }), said('All set, done listening.')), 'agora').doneListening).toBe(true);
        expect(parseTranscript(transcript(said('done listening'), toolUse('chat_wait', { thread: THREAD }, { text: 'm' })), 'agora').doneListening).toBe(false);
    });
});

describe('the Stop decision', () => {
    it('blocks while the thread is open, naming the exact chat_wait call', async () => {
        const { deps, input, calls } = await setup(transcript(toolUse('chat_send', { channel: 'general', thread: THREAD, message: 'x' }, { text: 'ok' })));
        const decision = await decideStop(input, deps);
        expect(decision?.decision).toBe('block');
        expect(decision?.reason).toContain(STOP_MARKER);
        expect(decision?.reason).toContain(`mcp__agora__chat_wait(channel="general", thread="${THREAD}"`);
        expect(decision?.reason).toContain('thread_close');
        expect(decision?.reason).toContain('AGORA_STOP_HOOK=off');
        // Bot auth, bound to Claude Code's client name
        expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bot bot_a.secret', 'X-Agora-Client': 'claude-code' });
    });

    it('allows when the thread is closed (not among open threads, has replies) or gone', async () => {
        const lines = transcript(toolUse('chat_wait', { channel: 'general', thread: THREAD }, { text: 'm' }));
        const closed = await setup(lines, { stub: { threads: [[{ id: OTHER_THREAD, lastReplyAt: 't1' }]], replies: [{ id: 'r' }] } });
        expect(await decideStop(closed.input, closed.deps)).toBeUndefined();
        const gone = await setup(lines, { stub: { threads: [[]], replies: null } });
        expect(await decideStop(gone.input, gone.deps)).toBeUndefined();
    });

    it('pages through open threads on a server without the thread-state header', async () => {
        const page = (n: number) => Array.from({ length: 10 }, (_, i) => ({ id: `${n}-${i}`, lastReplyAt: `t${n + 1}` }));
        const lines = transcript(toolUse('chat_wait', { thread: THREAD }, { text: 'm' }));
        const deep = await setup(lines, { stub: { threads: [page(0), page(1), [{ id: THREAD, lastReplyAt: 'x' }]] } });
        expect((await decideStop(deep.input, deep.deps))?.decision).toBe('block');
        // Not listed, no replies: open or closed can't be told, so the turn ends
        const unknown = await setup(lines, { stub: { threads: [[]], replies: [] } });
        expect(await decideStop(unknown.input, unknown.deps)).toBeUndefined();
    });

    it('takes the thread state from Agora: a new open thread blocks, a closed one with no replies does not', async () => {
        const lines = transcript(toolUse('thread_start', { channel: 'general', message: 'topic' }, { text: `Thread started in #general (thread: ${THREAD}).` }));
        const fresh = await setup(lines, { stub: { threads: [[]], replies: [], threadState: 'open' } });
        expect((await decideStop(fresh.input, fresh.deps))?.decision).toBe('block');
        const closed = await setup(lines, { stub: { threads: [[]], replies: [], threadState: 'closed' } });
        expect(await decideStop(closed.input, closed.deps)).toBeUndefined();
    });

    it('allows when no thread is involved (a channel has nothing to close), without asking Agora', async () => {
        const { deps, input, calls } = await setup(transcript(toolUse('chat_send', { channel: 'general', message: 'status' }, { text: 'ok' })));
        expect(await decideStop(input, deps)).toBeUndefined();
        const waited = await setup(transcript(toolUse('chat_wait', {}, { text: 'm' })));
        expect(await decideStop(waited.input, waited.deps)).toBeUndefined();
        expect([...calls, ...waited.calls]).toEqual([]);
    });

    it('resolves a channel given by ID to its name', async () => {
        const { deps, input } = await setup(transcript(toolUse('chat_wait', { thread: THREAD }, { text: 'm' })),
            { state: { defaultChannel: CHANNEL }, stub: { threads: [[{ id: THREAD, lastReplyAt: 't' }]], channels: [{ id: CHANNEL, name: 'dev' }] } });
        expect((await decideStop(input, deps))?.reason).toContain(`mcp__agora__chat_wait(channel="dev", thread="${THREAD}"`);
    });

    it('reads only the tail of a long transcript', async () => {
        // An Agora call older than the last TRANSCRIPT_TAIL_BYTES no longer holds the session
        const old = transcript(toolUse('chat_send', { thread: THREAD, message: 'x' }, { text: 'ok' }));
        const filler = said('x'.repeat(4096)) + '\n';
        const padding = filler.repeat(Math.ceil(TRANSCRIPT_TAIL_BYTES / filler.length) + 1);
        const longAgo = await setup(old + padding);
        expect(await decideStop(longAgo.input, longAgo.deps)).toBeUndefined();
        // The same call within the tail still does
        const recent = await setup(padding + old);
        expect((await decideStop(recent.input, recent.deps))?.decision).toBe('block');
        // A cut line at the start of the tail is dropped
        const tail = readTranscriptTail(recent.input.transcript_path!, old.length + 10);
        expect(tail).toBe(old);
    });

    it('allows when no agora-mcp of this project is running (missing or stale state file)', async () => {
        const lines = transcript(toolUse('chat_wait', { thread: THREAD }, { text: 'm' }));
        const stale = await setup(lines, { running: false });
        expect(await decideStop(stale.input, stale.deps)).toBeUndefined();
        const missing = await setup(lines);
        await rm(stateDir, { recursive: true, ...RM_RETRY });
        expect(await decideStop(missing.input, missing.deps)).toBeUndefined();
        expect([...stale.calls, ...missing.calls]).toEqual([]);
    });

    it('allows a session that never used Agora, without asking Agora', async () => {
        const { deps, input, calls } = await setup(transcript(toolUse('Bash', { command: 'ls' }, { text: '' }, 'other'), said('done')));
        expect(await decideStop(input, deps)).toBeUndefined();
        expect(calls).toEqual([]);
    });

    it('allows once the agent closed the thread or said it is done listening, and when turned off', async () => {
        const send = toolUse('chat_send', { thread: THREAD, message: 'x' }, { text: 'ok' });
        const closed = await setup(transcript(send, toolUse('thread_close', { thread: THREAD }, { text: 'closed' })));
        expect(await decideStop(closed.input, closed.deps)).toBeUndefined();
        const done = await setup(transcript(send));
        expect(await decideStop({ ...done.input, last_assistant_message: 'Done listening for now.' }, done.deps)).toBeUndefined();
        const off = await setup(transcript(send), { env: { AGORA_STOP_HOOK: 'off' } });
        expect(await decideStop(off.input, off.deps)).toBeUndefined();
    });

    it('after a continuation: allows if the agent ignored it, blocks again if it listened', async () => {
        const send = toolUse('chat_send', { thread: THREAD, message: 'x' }, { text: 'ok' });
        const ignored = await setup(transcript(send, feedback(), said('ok')));
        expect(await decideStop({ ...ignored.input, stop_hook_active: true }, ignored.deps)).toBeUndefined();
        const listened = await setup(transcript(send, feedback(), toolUse('chat_wait', { thread: THREAD }, { text: 'no new messages after 600s' })));
        expect((await decideStop({ ...listened.input, stop_hook_active: true }, listened.deps))?.decision).toBe('block');
    });

    it('uses the server name and client the state file gives, and the server the session used last', async () => {
        const { deps, input, calls } = await setup(transcript(
            toolUse('chat_wait', { thread: OTHER_THREAD }, { text: 'm' }),
            toolUse('chat_wait', { thread: THREAD }, { text: 'm' }, 'agora-tim'),
        ), { state: { server: 'agora-tim', token: 'bot_tim.secret', client: 'Claude Desktop' } });
        await writeHookState(serverState(), stateDir);
        const decision = await decideStop(input, deps);
        expect(decision?.reason).toContain(`mcp__agora-tim__chat_wait(channel="general", thread="${THREAD}"`);
        expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bot bot_tim.secret', 'X-Agora-Client': 'Claude Desktop' });
    });
});

describe('failing open', () => {
    it('prints nothing for garbage stdin, no state file, Agora errors or a hang', async () => {
        const lines = transcript(toolUse('chat_wait', { thread: THREAD }, { text: 'm' }));
        const ok = await setup(lines);
        expect(await runHook('stop', JSON.stringify(ok.input), ok.deps)).toContain('"decision":"block"');
        expect(await runHook('stop', 'not json{', ok.deps)).toBeUndefined();
        expect(await runHook('stop', '', ok.deps)).toBeUndefined();
        expect(await runHook('stop', 'null', ok.deps)).toBeUndefined();

        const noState = await setup(lines);
        await rm(stateDir, { recursive: true, ...RM_RETRY });
        expect(await runHook('stop', JSON.stringify(noState.input), noState.deps)).toBeUndefined();
        expect(await runHook('session-end', JSON.stringify(noState.input), noState.deps)).toBeUndefined();
        expect(noState.calls).toEqual([]);
        const denied = await setup(lines, { stub: { threads: [], status: 403 } });
        expect(await runHook('stop', JSON.stringify(denied.input), denied.deps)).toBeUndefined();

        const hang = await setup(lines);
        hang.deps.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
        hang.deps.budgetMs = 100;
        const started = Date.now();
        expect(await runHook('stop', JSON.stringify(hang.input), hang.deps)).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(await runHook('nonsense', JSON.stringify(hang.input), hang.deps)).toBeUndefined();
    });
});

describe('SessionEnd', () => {
    // Since 0.8.1 a no-op: neither CLI gives a hook a positive identity for the session's agora-mcp
    for (const cli of ['claude', 'codex'] as const) {
        it(`${cli}: makes no request and writes nothing, whatever it could find`, async () => {
            const call = cli === 'codex' ? codexCall('chat_wait', { thread: THREAD }, { text: 'm' }) : toolUse('chat_wait', { thread: THREAD }, { text: 'm' });
            const ctx = cli === 'codex' ? await codexSetup(transcript(call)) : await setup(transcript(call));
            const before = await readdir(hookStateDir(cli, stateDir));
            // Live server, fresh state file, a transcript that used it, a Stop that ran first, every reason
            await runHook('stop', JSON.stringify({ ...ctx.input, session_id: 's' }), ctx.deps);
            ctx.calls.length = 0;
            for (const reason of ['clear', 'resume', 'logout', 'prompt_input_exit', 'other', undefined]) {
                const input = { session_id: 's', transcript_path: ctx.input.transcript_path, cwd: project, hook_event_name: 'SessionEnd', reason };
                expect(await runHook('session-end', JSON.stringify(input), ctx.deps)).toBeUndefined();
                expect(await runHook('session-end', 'not json{', ctx.deps)).toBeUndefined();
            }
            ctx.deps.isRunning = () => false;
            await runHook('session-end', JSON.stringify({ session_id: 's', cwd: project, hook_event_name: 'SessionEnd', reason: 'other' }), ctx.deps);
            expect(ctx.calls).toEqual([]);
            // The Stop hook keeps no per-session records either
            expect(await readdir(hookStateDir(cli, stateDir))).toEqual(before);
        });
    }
});

describe('token-bearing leftovers in the hooks folder', () => {
    it('removes the temp file when a write fails, before or at the rename', async () => {
        // Serializing fails after the temp file is open
        await expect(writeHookState({ ...serverState(), pid: 1n } as unknown as HookState, stateDir)).rejects.toThrow();
        expect((await readdir(stateDir)).filter(n => n.endsWith('.tmp'))).toEqual([]);
        // The rename fails: a folder sits where the state file goes
        await mkdir(join(stateDir, `${projectKey(project)}.agora.4242.json`, 'x'), { recursive: true });
        await expect(writeHookState(serverState(), stateDir)).rejects.toThrow();
        expect((await readdir(stateDir)).filter(n => n.endsWith('.tmp'))).toEqual([]);
    });

    it('lets overlapping writes (the first write and a refresh) both succeed', async () => {
        const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => writeHookState(serverState({ token: `bot_${i}.secret` }), stateDir)));
        expect(results.map(r => r.status)).toEqual(Array(8).fill('fulfilled'));
        expect(await readdir(stateDir)).toEqual([`${projectKey(project)}.agora.4242.json`]);
    });

    it('sweeps old temp files and half-hour-old state files of servers that are gone', async () => {
        await mkdir(stateDir, { recursive: true });
        const ago = async (name: string, content: string, ms: number) => {
            await writeFile(join(stateDir, name), content);
            const when = new Date(Date.now() - ms);
            await utimes(join(stateDir, name), when, when);
        };
        const state = (pid: number) => JSON.stringify({ ...serverState(), pid });
        await ago('a.agora.json.1.tmp', 'x', 5 * 60_000);
        await ago('b.agora.json.2.tmp', 'x', 1_000);
        await ago('dead-old.agora.json', state(111), 40 * 60_000);
        await ago('dead-new.agora.json', state(111), 10 * 60_000);
        await ago('live-old.agora.json', state(222), 2 * 24 * 60 * 60_000);
        await ago('broken-old.agora.json', '{nope', 2 * 24 * 60 * 60_000);
        await sweepHookStates(stateDir, { isRunning: pid => pid === 222 });
        expect((await readdir(stateDir)).sort()).toEqual(['b.agora.json.2.tmp', 'dead-new.agora.json', 'live-old.agora.json']);
        // A missing folder is fine
        await sweepHookStates(join(root, 'missing'));
    });
});

// ─── Codex CLI (`agora-mcp hook stop --for codex`) ───

// Rollout lines as Codex 0.165 writes them (a real rollout's shapes, made-up content)
const rollout = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-11-02T10:00:00.000Z', type, payload });
let calls = 0;
/** A finished MCP call: an `McpToolCall` item, or with `legacy` an `mcp_tool_call_end` event. */
function codexCall(tool: string, args: Record<string, unknown>, result: { text: string; error?: boolean }, opts: { server?: string; legacy?: boolean } = {}): string {
    const server = opts.server ?? 'agora';
    const content = [{ type: 'text', text: result.text }];
    if (opts.legacy) {
        return rollout('event_msg', { type: 'mcp_tool_call_end', call_id: `call_${++calls}`, turn_id: 'turn', invocation: { server, tool, arguments: args },
            duration: { secs: 0, nanos: 1 }, result: result.error ? { Err: result.text } : { Ok: { content, isError: false } } });
    }
    return rollout('event_msg', { type: 'item_completed', thread_id: 'thr', turn_id: 'turn', item: { type: 'McpToolCall', id: `exec-${++calls}`, server, tool,
        arguments: args, status: result.error ? 'failed' : 'completed', result: { content, ...(result.error ? { isError: true } : {}) }, duration: { secs: 0, nanos: 1 } } });
}
/** A code-mode script: its text names tools, and its output can quote anything. */
const codexScript = (code: string, output: string) => [
    rollout('response_item', { type: 'custom_tool_call', status: 'completed', call_id: `call_${++calls}`, name: 'exec', input: code }),
    rollout('response_item', { type: 'custom_tool_call_output', call_id: `call_${calls}`, output: [{ type: 'input_text', text: output }] }),
];
const codexSaid = (text: string) => rollout('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** What Codex records when a Stop hook blocks: the reason as a user message. */
const codexContinuation = (reason = `${STOP_MARKER} The Agora thread is still open: call mcp__agora__chat_wait(thread="${THREAD}")`) =>
    rollout('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<hook_prompt hook_run_id="stop:0:/u/hooks.json">${xml(reason)}</hook_prompt>` }] });

const codexState = (over: Partial<HookState> = {}) => serverState({ client: 'codex-mcp-client', token: 'bot_codex.secret', ...over });

async function codexSetup(lines: string, opts: { state?: Partial<HookState>; env?: NodeJS.ProcessEnv; stub?: Stub; running?: boolean } = {}) {
    await writeHookState(codexState(opts.state), hookStateDir('codex', stateDir));
    const path = join(root, 'rollout-2026-11-02T10-00-00-thr.jsonl');
    await writeFile(path, lines);
    const agora = stubAgora(opts.stub ?? { threads: [[]], threadState: 'open' });
    const deps: HookDeps = { env: opts.env ?? {}, fetch: agora.fetcher, stateDir, isRunning: () => opts.running ?? true, budgetMs: 2_000, cli: 'codex' };
    // Codex's Stop input (hooks/schema/generated/stop.command.input.schema.json)
    const input: HookInput & Record<string, unknown> = { session_id: 'thr', turn_id: 'turn', transcript_path: path, cwd: project, hook_event_name: 'Stop',
        model: 'gpt-6', permission_mode: 'default', stop_hook_active: false, last_assistant_message: null };
    return { deps, input, calls: agora.calls };
}

describe('Codex CLI', () => {
    it('agora-mcp writes a Codex client\'s state file in its own folder, keyed by the working directory', async () => {
        const config = { instance: 'http://agora.test', token: 'bot_codex.secret', defaultChannel: 'general' };
        // A CLAUDE_PROJECT_DIR that reached the server names another project: ignored for Codex
        const write = startHookState(config, () => 'codex-mcp-client', { CLAUDE_PROJECT_DIR: project }, stateDir);
        expect(await write!()).toBe(true);
        const [state] = findHookStates([process.cwd()], () => true, hookStateDir('codex', stateDir));
        expect(state).toMatchObject({ ...config, client: 'codex-mcp-client', server: 'agora', projectDir: resolve(process.cwd()), pid: process.pid });
        // Not where Claude Code's hooks (or a 0.8.0 hook) look
        expect(findHookStates([process.cwd(), project], () => true, stateDir)).toEqual([]);
        expect(hookStateDir('codex', stateDir)).toBe(join(stateDir, 'codex'));
        expect([hookCli('codex-mcp-client'), hookCli('claude-code'), hookCli('codexx'), hookCli(null)]).toEqual(['codex', 'claude', undefined, undefined]);
    });

    it('sweeps token-bearing leftovers in the Codex folder too', async () => {
        const codexDir = hookStateDir('codex', stateDir);
        await mkdir(codexDir, { recursive: true });
        await writeFile(join(codexDir, 'a.agora.json.1.tmp'), 'x');
        const old = new Date(Date.now() - 5 * 60_000);
        await utimes(join(codexDir, 'a.agora.json.1.tmp'), old, old);
        startHookState({ instance: 'http://agora.test', token: 'bot_a.secret' }, () => 'someone-else', {}, stateDir);
        await vi.waitFor(async () => expect(await readdir(codexDir)).toEqual([]));
    });

    it('reads the rollout: the latest Agora call targets, failed calls and other servers do not, scripts are never read', () => {
        const state = parseRollout(transcript(
            codexCall('chat_send', { channel: 'general', message: 'hi' }, { text: 'sent' }),
            codexCall('chat_wait', { channel: 'general', thread: THREAD, until: 'turn' }, { text: 'no new messages' }),
            codexCall('chat_read', { channel: 'random', thread: OTHER_THREAD }, { text: 'Channel "random" not found', error: true }),
            // A call the user cancelled: failed, no result
            rollout('event_msg', { type: 'item_completed', item: { type: 'McpToolCall', id: 'exec-x', server: 'agora', tool: 'chat_wait',
                arguments: { thread: OTHER_THREAD }, status: 'failed', error: { message: 'user cancelled MCP tool call' } } }),
            codexCall('chat_send', { channel: 'x', thread: OTHER_THREAD, message: 'x' }, { text: 'ok' }, { server: 'agora-tim' }),
            // The script names a call it never made (the item above is what ran), and its output quotes one
            codexScript(`text(await tools.mcp__agora__chat_send({thread:"${OTHER_THREAD}",message:"x"}))`,
                JSON.stringify({ type: 'McpToolCall', server: 'agora', tool: 'chat_send', arguments: { thread: OTHER_THREAD } })),
        ), 'agora');
        expect(state.target).toEqual({ channel: 'general', thread: THREAD });
        expect(state.closedTarget).toBe(false);
        // Claude Code's parser finds nothing in a rollout, and the Codex one nothing in a Claude transcript
        expect(parseTranscript(transcript(codexCall('chat_wait', { thread: THREAD }, { text: 'm' })), 'agora').target).toBeUndefined();
        expect(parseRollout(transcript(toolUse('chat_wait', { thread: THREAD }, { text: 'm' })), 'agora').target).toBeUndefined();
    });

    it('reads the legacy mcp_tool_call_end form, a thread_start result and string arguments', () => {
        expect(parseRollout(transcript(
            codexCall('chat_wait', { thread: THREAD }, { text: 'm' }, { legacy: true }),
            codexCall('chat_send', { thread: OTHER_THREAD, message: 'x' }, { text: 'forbidden', error: true }, { legacy: true }),
        ), 'agora').target).toEqual({ channel: undefined, thread: THREAD });
        expect(parseRollout(transcript(
            codexCall('thread_start', { channel: 'general', message: 'topic' }, { text: `Thread started in #general (thread: ${THREAD}).` }),
        ), 'agora').target).toEqual({ channel: 'general', thread: THREAD });
        const stringArgs = JSON.parse(codexCall('chat_wait', {}, { text: 'm' }));
        stringArgs.payload.item.arguments = JSON.stringify({ channel: 'general', thread: THREAD });
        expect(parseRollout(JSON.stringify(stringArgs), 'agora').target).toEqual({ channel: 'general', thread: THREAD });
    });

    it('finds our continuation in the hook prompt, not in tool output or instructions, and "done listening" from the agent', () => {
        const waited = parseRollout(transcript(
            codexCall('chat_send', { thread: THREAD, message: 'x' }, { text: 'ok' }), codexContinuation(),
            codexCall('chat_wait', { thread: THREAD }, { text: 'msgs' }),
        ), 'agora');
        expect(waited).toMatchObject({ waitedSinceContinuation: true });
        expect(waited.lastContinuation).toBeGreaterThan(0);

        const developer = rollout('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: `AGENTS.md mentions ${STOP_MARKER}` }] });
        const ignored = parseRollout(transcript(
            codexCall('chat_wait', { thread: THREAD }, { text: 'msgs' }), codexContinuation(),
            codexScript('text(await tools.exec_command({cmd:"cat hook.ts"}))', `export const STOP_MARKER = '${STOP_MARKER}'`),
            codexCall('file_read', { path: 'hook.ts' }, { text: STOP_MARKER }), developer,
        ), 'agora');
        expect(ignored.waitedSinceContinuation).toBe(false);
        expect(ignored.lastContinuation).toBe(1);

        expect(parseRollout(transcript(codexCall('chat_wait', { thread: THREAD }, { text: 'm' }), codexSaid('All set, done listening.')), 'agora').doneListening).toBe(true);
        expect(parseRollout(transcript(codexSaid('done listening'), codexCall('chat_wait', { thread: THREAD }, { text: 'm' })), 'agora').doneListening).toBe(false);
    });

    it('blocks a Codex turn while its thread is open, in the output Codex takes, as the Codex client', async () => {
        const { deps, input, calls } = await codexSetup(transcript(codexCall('chat_send', { channel: 'general', thread: THREAD, message: 'x' }, { text: 'ok' })));
        const out = await runHook('stop', JSON.stringify(input), deps);
        const decision = JSON.parse(out!);
        // hooks/schema/generated/stop.command.output.schema.json: decision "block" + reason
        expect(Object.keys(decision).sort()).toEqual(['decision', 'reason']);
        expect(decision.decision).toBe('block');
        expect(decision.reason).toContain(`mcp__agora__chat_wait(channel="general", thread="${THREAD}"`);
        expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bot bot_codex.secret', 'X-Agora-Client': 'codex-mcp-client' });
    });

    it('lets a Codex turn end on the same rules', async () => {
        const send = codexCall('chat_send', { thread: THREAD, message: 'x' }, { text: 'ok' });
        const closed = await codexSetup(transcript(send, codexCall('thread_close', { thread: THREAD }, { text: 'closed' })));
        expect(await decideStop(closed.input, closed.deps)).toBeUndefined();
        const closedOnAgora = await codexSetup(transcript(send), { stub: { threads: [[]], threadState: 'closed' } });
        expect(await decideStop(closedOnAgora.input, closedOnAgora.deps)).toBeUndefined();
        const channelOnly = await codexSetup(transcript(codexCall('chat_send', { channel: 'general', message: 'status' }, { text: 'ok' })));
        expect(await decideStop(channelOnly.input, channelOnly.deps)).toBeUndefined();
        const done = await codexSetup(transcript(send));
        expect(await decideStop({ ...done.input, last_assistant_message: 'Done listening.' }, done.deps)).toBeUndefined();
        const off = await codexSetup(transcript(send), { env: { AGORA_STOP_HOOK: 'off' } });
        expect(await decideStop(off.input, off.deps)).toBeUndefined();
        const ephemeral = await codexSetup(transcript(send));
        expect(await decideStop({ ...ephemeral.input, transcript_path: null }, ephemeral.deps)).toBeUndefined();
        const stale = await codexSetup(transcript(send), { running: false });
        expect(await decideStop(stale.input, stale.deps)).toBeUndefined();
        // Codex has no continuation limit of its own: an ignored reminder ends the loop
        const ignored = await codexSetup(transcript(send, codexContinuation(), codexSaid('ok')));
        expect(await decideStop({ ...ignored.input, stop_hook_active: true }, ignored.deps)).toBeUndefined();
        const listened = await codexSetup(transcript(send, codexContinuation(), codexCall('chat_wait', { thread: THREAD }, { text: 'no new messages after 600s' })));
        expect((await decideStop({ ...listened.input, stop_hook_active: true }, listened.deps))?.decision).toBe('block');
        expect([...closed.calls, ...channelOnly.calls, ...off.calls, ...ephemeral.calls, ...stale.calls, ...ignored.calls]).toEqual([]);
    });

    it('keeps the two CLIs apart: each hook only uses its own CLI\'s server, and Codex ignores CLAUDE_PROJECT_DIR', async () => {
        const lines = transcript(codexCall('chat_wait', { thread: THREAD }, { text: 'm' }));
        // Only a Claude Code server runs in this project
        const claudeOnly = await codexSetup(lines);
        await rm(hookStateDir('codex', stateDir), { recursive: true, ...RM_RETRY });
        await writeHookState(serverState(), stateDir);
        expect(await decideStop(claudeOnly.input, claudeOnly.deps)).toBeUndefined();
        expect(claudeOnly.calls).toEqual([]);
        // A Codex file in Claude's folder (written by hand, say) is not Claude's either
        await writeHookState(codexState({ server: 'agora-x' }), stateDir);
        expect(sessionStates({ cwd: project }, { env: {}, fetch, stateDir, isRunning: () => true }).map(s => s.client)).toEqual(['claude-code']);

        const elsewhere = await codexSetup(lines);
        const away = { ...elsewhere.input, cwd: join(root, 'elsewhere') };
        expect(await decideStop(away, { ...elsewhere.deps, env: { CLAUDE_PROJECT_DIR: project } })).toBeUndefined();
        expect((await decideStop(elsewhere.input, { ...elsewhere.deps, env: { CLAUDE_PROJECT_DIR: join(root, 'elsewhere') } }))?.decision).toBe('block');
    });

    it('takes the CLI from --for, and an unknown one fails open', () => {
        expect(hookCliArg([])).toBe('claude');
        expect(hookCliArg(['--for', 'codex'])).toBe('codex');
        expect(hookCliArg(['--for', 'Codex'])).toBe('codex');
        expect(hookCliArg(['--for', 'claude'])).toBe('claude');
        expect(hookCliArg(['--for', 'gemini'])).toBeNull();
        expect(hookCliArg(['--for'])).toBeNull();
    });
});

describe('two sessions in one project', () => {
    // Session A (this one) and session B, another window in the same folder with its own bot
    const a = { pid: 1001, token: 'bot_a.secret' };
    const b = { pid: 1002, token: 'bot_b.secret' };
    const lines = (cli: 'claude' | 'codex') => cli === 'codex'
        ? transcript(codexCall('chat_send', { channel: 'general', thread: THREAD, message: 'x' }, { text: 'ok' }))
        : transcript(toolUse('chat_send', { channel: 'general', thread: THREAD, message: 'x' }, { text: 'ok' }));
    async function twoSessions(cli: 'claude' | 'codex', second: Partial<HookState> = b, running = true) {
        const ctx = cli === 'codex' ? await codexSetup(lines(cli), { state: a, running, stub: { threads: [[]], threadState: 'open' } })
            : await setup(lines(cli), { state: a, running, stub: { threads: [[]], threadState: 'open' } });
        await writeHookState((cli === 'codex' ? codexState : serverState)(second), hookStateDir(cli, stateDir));
        return ctx;
    }

    for (const cli of ['claude', 'codex'] as const) {
        it(`${cli}: each agora-mcp keeps its own state file`, async () => {
            await twoSessions(cli, b, false);
            expect((await readdir(hookStateDir(cli, stateDir))).filter(n => n.endsWith('.json')).sort())
                .toEqual([`${projectKey(project)}.agora.1001.json`, `${projectKey(project)}.agora.1002.json`]);
        });

        it(`${cli}: Stop lets the turn end when two live sessions here have different bots, not when they share one`, async () => {
            const different = await twoSessions(cli);
            expect(await decideStop(different.input, different.deps)).toBeUndefined();
            expect(different.calls).toEqual([]);
            const same = await twoSessions(cli, { pid: 1002, token: a.token });
            expect((await decideStop(same.input, same.deps))?.decision).toBe('block');
        });
    }
});

describe('AGORA_HOOKS=off', () => {
    for (const cli of ['claude', 'codex'] as const) {
        it(`${cli}: turns the Stop hook off (hosted runs), as AGORA_STOP_HOOK=off does`, async () => {
            const call = cli === 'codex' ? codexCall('chat_wait', { thread: THREAD }, { text: 'm' }) : toolUse('chat_wait', { thread: THREAD }, { text: 'm' });
            const make = (env: NodeJS.ProcessEnv) => cli === 'codex'
                ? codexSetup(transcript(call), { env, stub: { threads: [[]], threadState: 'open' } })
                : setup(transcript(call), { env, stub: { threads: [[]], threadState: 'open' } });
            for (const env of [{ AGORA_HOOKS: 'OFF' }, { AGORA_STOP_HOOK: 'off' }]) {
                const off = await make(env);
                expect(await decideStop(off.input, off.deps)).toBeUndefined();
                expect(off.calls).toEqual([]);
            }
            const on = await make({});
            expect((await decideStop(on.input, on.deps))?.decision).toBe('block');
        });
    }
});

// ─── Codex: a turn it owes holds the stop (Eryk, 2026-11-04) ───

describe('Codex owes a turn', () => {
    /** An Agora with one thread: its parent and replies, the bot named Codex. */
    function owedAgora(thread: { parent?: Record<string, unknown>; replies?: Record<string, unknown>[]; state?: 'open' | 'closed' }) {
        const calls: string[] = [];
        const json = (body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...extra } });
        const fetcher = vi.fn(async (url: string) => {
            const path = url.replace('http://agora.test', '');
            calls.push(path);
            if (path === '/bots/@me') return json({ id: 'BOT', username: 'Codex', channels: [{ id: CHANNEL, name: 'general' }] });
            if (path.startsWith(`/channels/${CHANNEL}/messages/${THREAD}/replies`)) {
                return json([...(thread.replies ?? [])].reverse(), { 'x-agora-thread-state': thread.state ?? 'open' });
            }
            if (path.startsWith(`/channels/${CHANNEL}/messages?`)) return json(thread.parent ? [thread.parent] : []);
            return json([]);
        });
        return { fetcher: fetcher as unknown as typeof fetch, calls };
    }
    const msg = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ id, content, authorId: 'CLAUDE', authorUsername: 'Claude', authorBot: true, channelId: CHANNEL, createdAt: 'x', ...extra });
    const start = msg(THREAD, '[AGORA/v1 MODE=review STATE=START]\nDesign review\nparticipants: [Claude, Codex]\nDone when: AGREE on the design.\n[YIELD to=Codex]');
    const context = msg('01J000000000000000000VREP1', 'Context: the doc is attached.', { threadId: THREAD });

    async function codexOwed(lines: string, server: Parameters<typeof owedAgora>[0], opts: { env?: NodeJS.ProcessEnv; active?: boolean } = {}) {
        const { deps, input } = await codexSetup(lines, { env: opts.env });
        const agora = owedAgora(server);
        return { deps: { ...deps, fetch: agora.fetcher }, input: { ...input, stop_hook_active: opts.active ?? false }, calls: agora.calls };
    }
    // The #DM Experiment run: read the thread's history, answer at the top level, stop
    const history = codexCall('chat_history', { channel: 'general', thread: THREAD }, { text: `#general › thread ${THREAD} — 1 message(s):\n\n[x] (REPL1) Claude: Context` });
    const topLevel = codexCall('chat_send', { channel: 'general', message: 'ACK, reviewing.' }, { text: 'Message sent to #general (id: M1)' });

    it('holds the #DM Experiment stop: a START YIELDing to Codex, answered at the top level', async () => {
        const run = await codexOwed(transcript(history, topLevel), { parent: start, replies: [context] });
        const decision = await decideStop(run.input, run.deps);
        expect(decision?.decision).toBe('block');
        expect(decision!.reason).toContain(`You still owe a turn in Agora thread ${THREAD} in #general (a YIELD to you`);
        expect(decision!.reason).toContain(`mcp__agora__chat_send(channel="general", thread="${THREAD}"`);
        expect(decision!.reason).toContain('AGORA_STOP_HOOK=off');
    });

    it('counts chat_history thread=X as the session\'s thread: open, it holds like any target', async () => {
        const run = await codexOwed(transcript(history), { parent: msg(THREAD, 'Plain topic'), replies: [context] });
        const decision = await decideStop(run.input, run.deps);
        expect(decision?.reason).toContain(`mcp__agora__chat_wait(channel="general", thread="${THREAD}"`);
    });

    it('finds a thread a wait\'s result quoted, and an in-thread @mention', async () => {
        const wait = codexCall('chat_wait', { channel: 'general' }, { text: `#general — 1 new message(s):\n\n#general › thread ${THREAD}:\n[x] (REPL2) Eryk: @Codex your view?` });
        const mention = msg('01J000000000000000000VREP2', '@Codex your view?', { threadId: THREAD, authorId: 'ERYK', authorUsername: 'Eryk', authorBot: false });
        const run = await codexOwed(transcript(wait, topLevel), { parent: msg(THREAD, 'Plain topic'), replies: [mention] });
        expect((await decideStop(run.input, run.deps))?.reason).toContain('(an @mention of you');
    });

    it('lets the turn end when nothing is owed: already answered, handed to someone else, or closed', async () => {
        const answered = await codexOwed(transcript(history, topLevel), { parent: start, replies: [context, msg('01J000000000000000000VREP3', 'ACK', { threadId: THREAD, authorId: 'BOT' })] });
        expect(await decideStop(answered.input, answered.deps)).toBeUndefined();
        const handed = await codexOwed(transcript(history, topLevel), { parent: start,
            replies: [msg('01J000000000000000000VREP3', '[AGORA/v1 MODE=review STATE=TURN]\n@Codex fyi\n[YIELD to=Gemini]', { threadId: THREAD })] });
        expect(await decideStop(handed.input, handed.deps)).toBeUndefined();
        const closed = await codexOwed(transcript(history, topLevel), { parent: start, replies: [context], state: 'closed' });
        expect(await decideStop(closed.input, closed.deps)).toBeUndefined();
        // Closed by the agent itself: not even asked
        const closedHere = await codexOwed(transcript(history, codexCall('thread_close', { channel: 'general', thread: THREAD }, { text: 'closed' }), topLevel), { parent: start });
        expect(await decideStop(closedHere.input, closedHere.deps)).toBeUndefined();
        expect(closedHere.calls).toEqual([]);
    });

    it('still lets Eryk stop Codex on purpose: AGORA_STOP_HOOK=off and AGORA_HOOKS=off, without asking Agora', async () => {
        for (const env of [{ AGORA_STOP_HOOK: 'off' }, { AGORA_HOOKS: 'off' }]) {
            const run = await codexOwed(transcript(history, topLevel), { parent: start, replies: [context] }, { env });
            expect(await decideStop(run.input, run.deps)).toBeUndefined();
            expect(run.calls).toEqual([]);
        }
    });

    it('keeps the loop guard: an ignored reminder lets the turn end', async () => {
        const run = await codexOwed(transcript(history, topLevel, codexContinuation(), codexSaid('ok')), { parent: start, replies: [context] }, { active: true });
        expect(await decideStop(run.input, run.deps)).toBeUndefined();
    });

    it('leaves Claude Code\'s hook as it was: no owed-turn hold', async () => {
        const lines = transcript(toolUse('chat_history', { channel: 'general', thread: THREAD }, { text: `#general › thread ${THREAD} — 1 message(s)` }),
            toolUse('chat_send', { channel: 'general', message: 'ACK' }, { text: 'Message sent to #general (id: M1)' }));
        const { deps, input } = await setup(lines);
        const agora = owedAgora({ parent: start, replies: [context] });
        expect(await decideStop(input, { ...deps, fetch: agora.fetcher })).toBeUndefined();
        expect(agora.calls).toEqual([]);
    });
});

describe('Codex owes a turn: long threads, spaced channel names, the deadline (Codex at a26af6a)', () => {
    const T = (n: number) => `01J00000000000000000T${String(n).padStart(5, '0')}`;
    const R = (t: number, n: number) => `01J00000000000000000V${String(t)}${String(n).padStart(4, '0')}`;
    interface FakeThread { parent: Record<string, unknown>; replies: Record<string, unknown>[]; state?: 'open' | 'closed'; delayMs?: number; hang?: boolean }
    const post = (id: string, content: string, extra: Record<string, unknown> = {}) =>
        ({ id, content, authorId: 'CLAUDE', authorUsername: 'Claude', authorBot: true, channelId: CHANNEL, createdAt: 'x', ...extra });

    /** Agora with several threads; replies paged newest first with `before`, as the server does. */
    function pagedAgora(threads: Record<string, FakeThread>, channelName = 'general') {
        const calls: string[] = [];
        const json = (body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...extra } });
        const fetcher = vi.fn(async (url: string, init: RequestInit) => {
            const u = new URL(url);
            calls.push(u.pathname + u.search);
            if (u.pathname === '/bots/@me') return json({ id: 'BOT', username: 'Codex', channels: [{ id: CHANNEL, name: channelName }] });
            const reply = /^\/channels\/[^/]+\/messages\/([^/]+)\/replies$/.exec(u.pathname);
            if (reply) {
                const t = threads[reply[1]];
                if (!t) return json([], {});
                if (t.hang) await new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
                if (t.delayMs) await new Promise(r => setTimeout(r, t.delayMs));
                const before = u.searchParams.get('before');
                const limit = Number(u.searchParams.get('limit') ?? 50);
                const page = [...t.replies].reverse().filter(m => !before || (m.id as string) < before).slice(0, limit);
                return json(page, { 'x-agora-thread-state': t.state ?? 'open' });
            }
            if (u.pathname === `/channels/${CHANNEL}/messages`) {
                const before = u.searchParams.get('before')!;
                const found = Object.values(threads).map(t => t.parent).filter(p => (p.id as string) < before).sort((a, b) => (b.id as string).localeCompare(a.id as string));
                return json(found.slice(0, 1));
            }
            return json([]);
        });
        return { fetcher: fetcher as unknown as typeof fetch, calls };
    }
    async function run(lines: string, threads: Record<string, FakeThread>, opts: { channelName?: string; budgetMs?: number } = {}) {
        const { deps, input } = await codexSetup(lines);
        const agora = pagedAgora(threads, opts.channelName);
        return { deps: { ...deps, fetch: agora.fetcher, budgetMs: opts.budgetMs ?? deps.budgetMs }, input, calls: agora.calls };
    }
    const historyOf = (thread: string, channel = 'general') => codexCall('chat_history', { channel, thread }, { text: `#${channel} › thread ${thread} — 1 message(s)` });
    const topLevel = (channel = 'general') => codexCall('chat_send', { channel, message: 'status' }, { text: `Message sent to #${channel} (id: M1)` });
    const startFor = (id: string) => post(id, '[AGORA/v1 MODE=review STATE=START]\nReview\nparticipants: [Claude, Codex]\n[YIELD to=Codex]');
    const progress = (t: number, from: number, count: number) => Array.from({ length: count }, (_, i) => post(R(t, from + i), `progress ${from + i}`, { threadId: T(t), authorId: 'ERYK', authorBot: false }));

    it('captures a thread quoted under a channel name with spaces (#DM Experiment)', async () => {
        const wait = codexCall('chat_wait', { channel: 'DM Experiment' },
            { text: `#DM Experiment — 1 new message(s):\n\n#DM Experiment › thread ${T(1)}:\n[x] (r) Claude: [AGORA/v1 MODE=review STATE=START]` });
        const r = await run(transcript(wait, topLevel('DM Experiment')), { [T(1)]: { parent: startFor(T(1)), replies: [] } }, { channelName: 'DM Experiment' });
        const decision = await decideStop(r.input, r.deps);
        expect(decision?.reason).toContain(`thread ${T(1)} in #DM Experiment (a YIELD to you`);
    });

    it('a turn Codex answered before 100+ later replies stays answered', async () => {
        const replies = [post(R(2, 0), 'ACK, on it.', { threadId: T(2), authorId: 'BOT' }), ...progress(2, 1, 120)];
        const r = await run(transcript(historyOf(T(2)), topLevel()), { [T(2)]: { parent: startFor(T(2)), replies } });
        expect(await decideStop(r.input, r.deps)).toBeUndefined();
        // It read back through the pages to Codex's own post
        expect(r.calls.filter(c => c.includes('/replies')).length).toBe(2);
    });

    it('a YIELD to Codex older than the newest 100 replies, with no addressing START, still holds', async () => {
        const replies = [post(R(3, 0), '[AGORA/v1 MODE=fix STATE=TURN]\nYours.\n[YIELD to=Codex]', { threadId: T(3) }), ...progress(3, 1, 120)];
        const r = await run(transcript(historyOf(T(3)), topLevel()), { [T(3)]: { parent: post(T(3), 'Plain topic'), replies } });
        expect((await decideStop(r.input, r.deps))?.reason).toContain(`(a YIELD to you, message ${R(3, 0)})`);
    });

    it('a slow earlier candidate doesn\'t hide a later owed thread', async () => {
        const lines = transcript(historyOf(T(4)), historyOf(T(5)), topLevel());
        const r = await run(lines, {
            [T(5)]: { parent: post(T(5), 'Plain topic'), replies: [], delayMs: 50 },
            [T(4)]: { parent: startFor(T(4)), replies: [] },
        });
        expect((await decideStop(r.input, r.deps))?.reason).toContain(`thread ${T(4)}`);
    });

    it('stops at the deadline: a hanging thread ends the scan, and nothing is fetched after it', async () => {
        const lines = transcript(historyOf(T(6)), historyOf(T(7)), topLevel());
        const r = await run(lines, {
            [T(7)]: { parent: post(T(7), 'Plain topic'), replies: [], hang: true },
            [T(6)]: { parent: startFor(T(6)), replies: [] },
        }, { budgetMs: 400 });
        const began = Date.now();
        const out = await runHook('stop', JSON.stringify(r.input), r.deps);
        expect(out).toBeUndefined();
        expect(Date.now() - began).toBeLessThan(1_000);
        await new Promise(res => setTimeout(res, 400));
        expect(r.calls.some(c => c.includes(T(6)))).toBe(false);
    });

    it('says to keep a running channel listener rather than start a second wait', async () => {
        const r = await run(transcript(historyOf(T(8)), topLevel()), { [T(8)]: { parent: startFor(T(8)), replies: [] } });
        expect((await decideStop(r.input, r.deps))?.reason).toContain('your channel-level chat_wait if you listen on the channel (don\'t start a second wait)');
    });
});
