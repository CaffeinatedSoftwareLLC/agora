import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Launch } from '../src/adapters.js';

const mocked = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', () => mocked);
import { ProcessRunner } from '../src/process.js';

function fakeChild() {
    const c = Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        kill: vi.fn(() => { c.emit('close', 1); return true; }) });
    return c;
}
const launch: Launch = { executable: 'trusted.exe', args: ['--json'], cwd: 'workspace', env: { AGORA_BOT_TOKEN: 'bot_selected' },
    adapter: 'codex', stdin: 'headless prompt', cleanup: async () => {} };
beforeEach(() => { vi.clearAllMocks(); });
describe('process runner (all subprocesses mocked)', () => {
    it('spawns without a shell/visible window, pipes prompt and parses stdout on close', async () => {
        const c = fakeChild(); mocked.spawn.mockReturnValue(c);
        const running = new ProcessRunner().start(launch);
        expect(mocked.spawn).toHaveBeenCalledWith('trusted.exe', ['--json'], expect.objectContaining({ shell: false, windowsHide: true, env: launch.env }));
        expect(c.stdin.read().toString()).toBe('headless prompt');
        c.stdout.write('{"type":"thread.started","thread_id":"native"}\n');
        c.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"{\\"summary\\":\\"Done\\"}"}}\n');
        c.stdout.write('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}\n');
        c.emit('close', 0);
        expect(await running.result).toMatchObject({ success: true, nativeSessionId: 'native', tokensUsed: 12 });
    });
    it('Windows kill uses only the child PID and /T /F, and waits for close', async () => {
        if (process.platform !== 'win32') return;
        const c = fakeChild(); mocked.spawn.mockReturnValue(c);
        mocked.execFile.mockImplementation((_exe, _args, _opts, cb) => { c.emit('close', 1); cb(null, { stdout: '', stderr: '' }); });
        const running = new ProcessRunner().start(launch); await running.kill(); await running.result;
        expect(mocked.execFile.mock.calls[0][1]).toEqual(['/PID', '12345', '/T', '/F']);
        expect(mocked.execFile.mock.calls[0][2]).toMatchObject({ windowsHide: true, timeout: 5000 });
    });
    it('failed tree termination raises an error even if a root-only fallback succeeds', async () => {
        if (process.platform !== 'win32') return;
        const c = fakeChild(); mocked.spawn.mockReturnValue(c);
        mocked.execFile.mockImplementation((_exe, _args, _opts, cb) => cb(new Error('denied')));
        const running = new ProcessRunner().start(launch);
        const rejectedResult = expect(running.result).rejects.toThrow('process_tree_kill_failed');
        await expect(running.kill()).rejects.toThrow('process_tree_kill_failed');
        expect(c.kill).toHaveBeenCalledWith('SIGKILL'); await rejectedResult;
    });
    it('spawn errors are reported without leaking exception/CLI text', async () => {
        const c = fakeChild(); mocked.spawn.mockReturnValue(c);
        const running = new ProcessRunner().start(launch); c.emit('error', new Error('token: secret'));
        const result = await running.result; expect(result.error).toBe('spawn_failed'); expect(JSON.stringify(result)).not.toContain('secret');
    });
});
