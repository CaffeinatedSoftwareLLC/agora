import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Launch } from '../src/adapters.js';
import { ProcessRunner } from '../src/process.js';
import type { AcpPlan } from '../src/acp/session.js';
import { acpStep, appServerStream, claudeStep, claudeStream, codexStream, commandLabel, lineSplitter, relPath, Streamer, STREAM_BATCH, type StreamEvent } from '../src/stream.js';
import { tempDir } from './helpers.js';

/**
 * Live output (docs/live-output.md). The Claude and Codex fixtures are real output of the installed
 * CLIs (claude 2.x with --include-partial-messages, codex exec --json) for a trivial prompt in an
 * empty folder; paths were rewritten to /work and the SessionStart hook and signatures removed.
 */
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8').split('\n').filter(Boolean);
const feed = (parser: { push(line: string): StreamEvent[] }, lines: string[]) => lines.flatMap(l => parser.push(l));
const text = (events: StreamEvent[]) => events.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('');

describe('claudeStream (real stream-json with partial messages)', () => {
    const events = feed(claudeStream('/work'), fixture('claude-partial-read.jsonl'));
    it('turns a Read into a step that starts, then ends ok, with a path relative to the workspace', () => {
        expect(events.filter(e => e.type === 'step')).toEqual([
            { type: 'step', step: 'toolu_011LGNPzhXesNeor6Qy583Fi', state: 'start', tool: 'Read', label: 'Read notes.txt' },
            { type: 'step', step: 'toolu_011LGNPzhXesNeor6Qy583Fi', state: 'ok' },
        ]);
    });
    it('streams the reply as deltas, once: the complete assistant message is not repeated', () => {
        const deltas = events.filter(e => e.type === 'text');
        expect(deltas.length).toBeGreaterThan(1);
        expect(text(events)).toBe('`notes.txt` has one line: "hello world".');
        expect(new Set(deltas.map(e => (e as { message: string }).message)).size).toBe(1);
    });
    it('never carries thinking, tool input or tool output', () => {
        const json = JSON.stringify(events);
        expect(json).not.toContain('thinking'); expect(json).not.toContain('signature');
        expect(json).not.toContain('input_json'); expect(json).not.toContain('hello world\\n');
    });
    it('without partial messages the complete assistant text is used', () => {
        const lines = fixture('claude-partial-read.jsonl').filter(l => !l.startsWith('{"type":"stream_event"'));
        expect(text(feed(claudeStream('/work'), lines))).toBe('`notes.txt` has one line: "hello world".');
    });
    it('marks a failed tool result and ignores sub-agent events and bad lines', () => {
        const p = claudeStream('/work');
        expect(p.push('not json')).toEqual([]);
        expect(p.push(JSON.stringify({ type: 'user', parent_tool_use_id: 'x', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } }))).toEqual([]);
        expect(p.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } })))
            .toEqual([{ type: 'step', step: 't1', state: 'failed' }]);
    });
});

describe('codexStream (real codex exec --json)', () => {
    const events = feed(codexStream('C:\\work'), fixture('codex-exec-command.jsonl'));
    it('gives the agent messages as text and a command as a step with its wrapper removed', () => {
        expect(events).toEqual([
            { type: 'text', message: 'item_0', delta: 'Read `notes.txt` next; step 1 of 1, about 5 seconds.\n' },
            { type: 'step', step: 'item_1', state: 'start', tool: 'command', label: 'Ran Get-Content -LiteralPath notes.txt' },
            { type: 'step', step: 'item_1', state: 'ok' },
            { type: 'text', message: 'item_2', delta: 'Read complete: `notes.txt` contains \u201chello world.\u201d' },
        ]);
    });
    it('never carries the command output', () => { expect(JSON.stringify(events)).not.toContain('hello world\\r'); });
    it('a file change is one step named by its path, or by its count; a nonzero exit fails', () => {
        const change = (changes: Array<{ path: string }>) => feed(codexStream('/w'), [JSON.stringify({ type: 'item.completed', item: { id: 'f', type: 'file_change', status: 'completed', changes } })]);
        expect(change([{ path: '/w/src/app.ts' }])[0]).toMatchObject({ label: 'Edited src/app.ts' });
        expect(change([{ path: '/w/a.ts' }, { path: '/w/b.ts' }])[0]).toMatchObject({ label: 'Edited 2 files' });
        const failed = feed(codexStream('/w'), [JSON.stringify({ type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'npm test', exit_code: 1, status: 'completed' } })]);
        expect(failed.map(e => (e as { state: string }).state)).toEqual(['start', 'failed']);
    });
    it('ignores reasoning items', () => {
        expect(feed(codexStream('/w'), [JSON.stringify({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'secret thoughts' } })])).toEqual([]);
    });
});

describe('step labels never leak', () => {
    it('shows paths relative to the workspace and only the file name outside it', () => {
        expect(relPath('/work', '/work/src/app.ts')).toBe('src/app.ts');
        expect(relPath('C:\\Users\\me\\repo', 'c:\\users\\me\\repo\\src\\app.ts')).toBe('src/app.ts');
        expect(relPath('/work', '/etc/passwd')).toBe('\u2026/passwd');
        expect(relPath('/work', '../outside/secret.txt')).toBe('\u2026/secret.txt');
    });
    it('redacts tokens and environment values in a command line, and shows the workspace as "."', () => {
        const label = commandLabel('API_KEY=sk-abc123def456 TOKEN=xyz npm test --token ghp_abcdefghijklmnopqrstuvwxyz0123456789 /work/src', '/work');
        expect(label).not.toContain('sk-abc'); expect(label).not.toContain('xyz'); expect(label).not.toContain('ghp_');
        expect(label).toMatch(/API_KEY=(\u2026|\[redacted\])/); expect(label).toContain('./src');
        expect(commandLabel('curl -H "Authorization: Bearer abcdef0123456789abcdef0123456789abcdef" https://x.test', '/w')).not.toContain('abcdef0123');
        expect(commandLabel('echo a\nsecret second line', '/w')).toBe('Ran echo a');
        expect(commandLabel(`bash -lc 'git status'`, '/w')).toBe('Ran git status');
    });
    it('keeps a long command short, and names tools without their arguments', () => {
        expect(commandLabel('x'.repeat(500), '/w').length).toBeLessThanOrEqual(104);
        expect(claudeStep('Write', { file_path: '/work/a.ts', content: 'SECRET BODY' }, '/work')).toEqual({ tool: 'Write', label: 'Wrote a.ts' });
        expect(claudeStep('WebFetch', { url: 'https://docs.example.com/a?token=abc' }, '/work').label).toBe('Fetched docs.example.com');
        expect(claudeStep('Grep', { pattern: 'password' }, '/work').label).toBe('Searched the code');
        expect(claudeStep('mcp__agora__chat_send', { content: 'hi' }, '/work').label).toBe('Used agora: chat_send');
    });
    it('ACP: reasoning gives no step, a kind gives a label', () => {
        expect(acpStep({ kind: 'think', title: 'Thinking' }, '/w')).toBeNull();
        expect(acpStep({ kind: 'read', title: 'Read file', locations: [{ path: '/w/src/a.ts' }] }, '/w')).toEqual({ tool: 'read', label: 'Read src/a.ts' });
        expect(acpStep({ kind: 'execute', title: 'Run `npm test`' }, '/w')).toEqual({ tool: 'execute', label: 'Ran npm test' });
    });
});

describe('appServerStream (codex app-server notifications; built from the documented format)', () => {
    it('streams agentMessage deltas once and gives commands and file changes as steps', () => {
        const p = appServerStream('/w');
        const out = [
            ...p.push('item/started', { item: { id: 'c1', type: 'commandExecution', command: 'npm test' } }),
            ...p.push('item/completed', { item: { id: 'c1', type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'SECRET' } }),
            ...p.push('item/agentMessage/delta', { itemId: 'a1', delta: 'Hel' }), ...p.push('item/agentMessage/delta', { itemId: 'a1', delta: 'lo' }),
            ...p.push('item/completed', { item: { id: 'a1', type: 'agentMessage', text: 'Hello' } }),
            ...p.push('item/completed', { item: { id: 'f1', type: 'fileChange', status: 'declined', changes: [{ path: '/w/a.ts' }] } }),
        ];
        expect(out).toEqual([
            { type: 'step', step: 'c1', state: 'start', tool: 'command', label: 'Ran npm test' }, { type: 'step', step: 'c1', state: 'ok' },
            { type: 'text', message: 'a1', delta: 'Hel' }, { type: 'text', message: 'a1', delta: 'lo' },
            { type: 'step', step: 'f1', state: 'start', tool: 'edit', label: 'Edited a.ts' }, { type: 'step', step: 'f1', state: 'failed' },
        ]);
    });
});

describe('lineSplitter', () => {
    it('joins a line split across chunks and flushes an unterminated last line', () => {
        const lines: string[] = []; const s = lineSplitter(l => lines.push(l));
        s.push('{"a":'); s.push('1}\r\n{"b"'); s.push(':2}\n{"c":3}'); s.end();
        expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    });
});

describe('Streamer batching', () => {
    afterEach(() => { vi.useRealTimers(); });
    it('merges neighbouring text and sends at most once per interval, in order', async () => {
        vi.useFakeTimers();
        const send = vi.fn(async (_: StreamEvent[]) => true);
        const s = new Streamer(send, () => {}, 400);
        s.emit({ type: 'text', message: 'm', delta: 'Hel' }); s.emit({ type: 'text', message: 'm', delta: 'lo' });
        s.emit({ type: 'step', step: 's', state: 'start', tool: 'Read', label: 'Read a' });
        s.emit({ type: 'text', message: 'n', delta: 'next' });
        expect(send).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(400);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0]).toEqual([{ type: 'text', message: 'm', delta: 'Hello' }, expect.objectContaining({ type: 'step' }), { type: 'text', message: 'n', delta: 'next' }]);
        await s.stop();
    });
    it('splits a flood into bounded requests (events and characters)', async () => {
        const batches: StreamEvent[][] = [];
        const s = new Streamer(async e => { batches.push(e); return true; }, () => {}, 1_000_000);
        for (let i = 0; i < 250; i++) s.emit({ type: 'step', step: `s${i}`, state: 'start', tool: 'Read', label: `Read file ${i}` });
        for (let i = 0; i < 12; i++) s.emit({ type: 'text', message: `m${i}`, delta: 'x'.repeat(4000) });
        await s.stop();
        expect(batches.flat()).toHaveLength(262);
        for (const b of batches) { expect(b.length).toBeLessThanOrEqual(STREAM_BATCH.maxEvents); expect(JSON.stringify(b).length).toBeLessThanOrEqual(STREAM_BATCH.maxChars + 4200); }
    });
    it('splits text longer than one delta and keeps its order', async () => {
        const batches: StreamEvent[][] = [];
        const s = new Streamer(async e => { batches.push(e); return true; }, () => {}, 1_000_000);
        s.emit({ type: 'text', message: 'm', delta: 'a'.repeat(9000) }); await s.stop();
        expect(batches.flat().map(e => (e as { delta: string }).delta.length)).toEqual([4000, 4000, 1000]);
    });
    it.each([[404], [409], [403]])('stops sending for good after a %i (an older server, a finished run)', async status => {
        const send = vi.fn(async () => { throw Object.assign(new Error('x'), { status }); });
        const log = vi.fn(); const s = new Streamer(send, log, 1_000_000);
        s.emit({ type: 'text', message: 'm', delta: 'a' }); await s.flush();
        s.emit({ type: 'text', message: 'm', delta: 'b' }); await s.flush();
        expect(send).toHaveBeenCalledOnce(); expect(log).toHaveBeenCalledWith('live_output_unavailable'); await s.stop();
    });
    it('stops when the server says the owner turned it off, and gives up after repeated failures', async () => {
        const off = vi.fn(async () => false); const a = new Streamer(off, () => {}, 1_000_000);
        a.emit({ type: 'text', message: 'm', delta: 'a' }); await a.flush(); a.emit({ type: 'text', message: 'm', delta: 'b' }); await a.flush();
        expect(off).toHaveBeenCalledOnce(); await a.stop();
        const boom = vi.fn(async () => { throw new Error('network'); }); const b = new Streamer(boom, () => {}, 1_000_000);
        for (let i = 0; i < 8; i++) { b.emit({ type: 'step', step: `s${i}`, state: 'start' }); await b.flush(); }
        expect(boom).toHaveBeenCalledTimes(STREAM_BATCH.maxFailures); await b.stop();
    });
    it('a transient failure drops that batch and the next one is still sent', async () => {
        const send = vi.fn(async (e: StreamEvent[]) => { if (send.mock.calls.length === 1) throw new Error('network'); return true; });
        const s = new Streamer(send, () => {}, 1_000_000);
        s.emit({ type: 'step', step: 'a', state: 'start' }); await s.flush();
        s.emit({ type: 'step', step: 'b', state: 'start' }); await s.flush();
        expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][0]).toEqual([{ type: 'step', step: 'b', state: 'start' }]); await s.stop();
    });
    it('holds a bounded buffer while the server is slow, dropping the oldest text first', () => {
        const s = new Streamer(() => new Promise(() => {}), () => {}, 1_000_000);
        for (let i = 0; i < STREAM_BATCH.maxBuffered + 50; i++) s.emit({ type: 'text', message: `m${i}`, delta: 'x' });
        expect((s as unknown as { buffer: unknown[] }).buffer.length).toBe(STREAM_BATCH.maxBuffered);
    });
});

describe('ACP agents stream through their session updates (fake ACP agent)', () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
    it('gives the reply as text and each tool call as a step that ends', async () => {
        const t = await tempDir(); cleanups.push(t.cleanup);
        const events: StreamEvent[] = [];
        const tools = JSON.stringify([
            { kind: 'execute', title: 'git status', rawInput: { command: 'git status -s' } },
            { kind: 'edit', title: 'Edit src/a.ts', rawInput: { path: 'src/a.ts' }, locations: [{ path: join(t.dir, 'src', 'a.ts') }] },
        ]);
        const launch: Launch = { executable: process.execPath, args: [resolve('test/fixtures/fake-acp-agent.mjs')], cwd: t.dir,
            env: { PATH: process.env.PATH, ACP_TOOLS: tools }, adapter: 'gemini', stdin: '', cleanup: async () => {}, stream: e => events.push(e),
            acp: { prompt: 'Do the task', nativeSessionId: null, model: null, effort: null, authMethod: null, rules: ['Bash(git:*)', 'Edit'], mcpServers: [], rpcTimeoutMs: 5000 } as AcpPlan };
        await new ProcessRunner().start(launch).result;
        expect(events.filter(e => e.type === 'step')).toEqual([
            { type: 'step', step: 'call-0', state: 'start', tool: 'execute', label: 'Ran git status' }, { type: 'step', step: 'call-0', state: 'ok' },
            { type: 'step', step: 'call-1', state: 'start', tool: 'edit', label: 'Edited src/a.ts' }, { type: 'step', step: 'call-1', state: 'ok' },
        ]);
        const messages = [...new Set(events.filter(e => e.type === 'text').map(e => (e as { message: string }).message))];
        expect(messages).toHaveLength(2);
        expect(text(events.filter(e => (e as { message?: string }).message === messages[0]))).toBe('Let me check.');
    });
});
