import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../src/scheduler.js';
import { HttpError } from '../src/client.js';
import type { Result, HostApi } from '../src/types.js';
import { claim, config, deferred, id, successful } from './helpers.js';

function setup() {
    const children: ReturnType<typeof child>[] = [];
    function child() {
        const finish = deferred<Result>();
        return { result: finish.promise, finish, tokensUsed: () => 123,
            kill: vi.fn(async () => { finish.resolve({ success: false, nativeSessionId: null, tokensUsed: null, summary: null }); }) };
    }
    const runner = { start: vi.fn(() => { const c = child(); children.push(c); return c; }) };
    const api = {
        claim: vi.fn(async () => null), heartbeat: vi.fn(async () => ({ cancel: false as const, leaseUntil: '2026-10-17T21:03:00.000Z' })),
        complete: vi.fn(async () => {}), fail: vi.fn(async () => {}),
    };
    const cleanup = vi.fn(async () => {});
    const scheduler = new Scheduler(config(), api as HostApi, runner, { now: () => Date.now(), tickMs: 10,
        prepare: async () => ({ executable: 'fake', args: [], env: {}, cwd: '', stdin: '', adapter: 'codex', cleanup }) });
    return { scheduler, api, runner, children, cleanup };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });
describe('scheduler with fake processes', () => {
    it('reports success and cleans up the per-run configuration', async () => {
        const s = setup(); const work = s.scheduler.submit(claim(), 0); await vi.advanceTimersByTimeAsync(0);
        s.children[0].finish.resolve(successful); await work;
        expect(s.api.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tokensUsed: 100, summary: 'Finished' }), expect.anything());
        expect(s.api.fail).not.toHaveBeenCalled(); expect(s.cleanup).toHaveBeenCalledOnce(); expect(s.scheduler.size).toBe(0);
    });
    it('never starts a second child for the same session', async () => {
        const s = setup(); const first = s.scheduler.submit(claim(), 0); await vi.advanceTimersByTimeAsync(0);
        const duplicate = claim(); duplicate.run.id = id(10);
        await s.scheduler.submit(duplicate, 0); await first;
        expect(s.runner.start).toHaveBeenCalledOnce(); expect(s.children[0].kill).toHaveBeenCalled(); expect(s.api.fail).not.toHaveBeenCalled();
    });
    it('does not spawn a child when the initial claim is already too old', async () => {
        const s = setup(); await s.scheduler.submit(claim(), -115000);
        expect(s.runner.start).not.toHaveBeenCalled(); expect(s.api.complete).not.toHaveBeenCalled();
    });
    it('heartbeat cancellation kills the tree and reports nonretryable failure', async () => {
        const s = setup(); s.api.heartbeat.mockResolvedValue({ cancel: true, reason: 'ended' } as never);
        const work = s.scheduler.submit(claim(), 0); await vi.advanceTimersByTimeAsync(30010); await work;
        expect(s.children[0].kill).toHaveBeenCalled();
        expect(s.api.heartbeat).toHaveBeenCalledWith(expect.anything(), expect.anything(), 123, undefined);
        expect(s.api.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ error: 'cancelled', retryable: false }), expect.anything());
    });
    it('run timeout kills and reports retryable failure', async () => {
        const s = setup(); const c = claim(); c.run.timeoutSeconds = 2;
        const work = s.scheduler.submit(c, 0); await vi.advanceTimersByTimeAsync(2010); await work;
        expect(s.api.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ error: 'run_timeout', retryable: true }), expect.anything());
    });
    it('409 fencing stops without any terminal report', async () => {
        const s = setup(); s.api.heartbeat.mockRejectedValue(new HttpError(409));
        const work = s.scheduler.submit(claim(), 0); await vi.advanceTimersByTimeAsync(30010); await work;
        expect(s.children[0].kill).toHaveBeenCalled(); expect(s.api.fail).not.toHaveBeenCalled(); expect(s.api.complete).not.toHaveBeenCalled();
    });
    it.each([401, 403])('auth %s stops every active child', async status => {
        const s = setup(); s.api.heartbeat.mockRejectedValue(new HttpError(status));
        const second = claim(); second.session.id = id(20); second.run.id = id(21);
        const a = s.scheduler.submit(claim(), 0); const b = s.scheduler.submit(second, 0);
        await vi.advanceTimersByTimeAsync(30010); await Promise.all([a, b]);
        expect(s.children).toHaveLength(2); expect(s.children.every(c => c.kill.mock.calls.length > 0)).toBe(true);
        expect(s.api.fail).not.toHaveBeenCalled();
    });
    it('network failure cannot renew the original lease; watchdog kills at the safety margin', async () => {
        const s = setup(); s.api.heartbeat.mockRejectedValue(new Error('network'));
        const work = s.scheduler.submit(claim(), 0); await vi.advanceTimersByTimeAsync(109990);
        expect(s.children[0].kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(20); await work;
        expect(s.children[0].kill).toHaveBeenCalled(); expect(s.api.fail).not.toHaveBeenCalled();
    });
    it('a successful heartbeat uses its send time, not response time', async () => {
        const s = setup(); const response = deferred<{ cancel: false; leaseUntil: string }>();
        s.api.heartbeat.mockImplementationOnce(() => response.promise).mockRejectedValue(new Error('offline'));
        const work = s.scheduler.submit(claim(), 0); await vi.advanceTimersByTimeAsync(60000);
        response.resolve({ cancel: false, leaseUntil: '2026-10-17T21:03:00.000Z' }); await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(79990); expect(s.children[0].kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(20); await work; expect(s.children[0].kill).toHaveBeenCalled();
    });
    it('hung heartbeats do not disable the independent lease watchdog', async () => {
        const s = setup(); s.api.heartbeat.mockImplementation((_c?: unknown, signal?: AbortSignal) => new Promise((_res, reject) => {
            signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }));
        const work = s.scheduler.submit(claim(), 0); await vi.advanceTimersByTimeAsync(110010); await work;
        expect(s.children[0].kill).toHaveBeenCalled(); expect(s.api.fail).not.toHaveBeenCalled();
    });
    it('sends an ACP run\'s progress with heartbeats and never retries an ACP login failure', async () => {
        const s = setup(); const progress = { step: 'Edit src/a.ts', toolCalls: 3, planDone: 1, planTotal: 2 };
        s.runner.start.mockImplementationOnce(() => {
            const finish = deferred<Result>();
            const c = { result: finish.promise, finish, tokensUsed: () => null, progress: () => progress, kill: vi.fn(async () => {}) };
            s.children.push(c as never); return c;
        });
        const work = s.scheduler.submit(claim(), 0); await vi.advanceTimersByTimeAsync(30010);
        expect(s.api.heartbeat).toHaveBeenCalledWith(expect.anything(), expect.anything(), null, progress);
        s.children[0].finish.resolve({ success: false, nativeSessionId: null, tokensUsed: null, summary: null, error: 'acp_auth_required' }); await work;
        expect(s.api.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ error: 'acp_auth_required', retryable: false }), expect.anything());
    });
    it('shutdown kills children and drains without releasing work as success', async () => {
        const s = setup(); const work = s.scheduler.submit(claim(), 0); await vi.advanceTimersByTimeAsync(0);
        await s.scheduler.stop(); await work; expect(s.api.complete).not.toHaveBeenCalled(); expect(s.api.fail).not.toHaveBeenCalled();
    });
});

describe('Codex app-server approvals (#93)', () => {
    it('hands an app-server run the card flow, which posts a card bound to the run and relays its decision', async () => {
        const children: Array<{ finish: ReturnType<typeof deferred<Result>> }> = [];
        let launched: any;
        const runner = { start: vi.fn((launch: any) => { launched = launch; const finish = deferred<Result>(); children.push({ finish });
            return { result: finish.promise, kill: vi.fn(async () => {}) }; }) };
        const api = {
            claim: vi.fn(async () => null), heartbeat: vi.fn(async () => ({ cancel: false as const, leaseUntil: '2026-10-17T21:03:00.000Z' })),
            complete: vi.fn(async () => {}), fail: vi.fn(async () => {}),
            openToolRequest: vi.fn(async () => ({ id: id(30), status: 'pending' })),
            toolRequest: vi.fn(async () => ({ status: 'once' })),
        };
        const plan = { threadId: null, prompt: 'p', outputSchema: null, model: null, effort: null, sandbox: 'workspace-write', refresh: async () => 't', rules: [], roots: [] };
        const scheduler = new Scheduler({ ...config(), approvalWaitSeconds: 120 }, api as HostApi, runner, { now: () => Date.now(), tickMs: 10,
            prepare: async () => ({ executable: 'fake', args: [], env: {}, cwd: '', stdin: '', adapter: 'codex', cleanup: async () => {}, appServer: plan as any }) });
        const work = scheduler.submit(claim(), 0); await vi.advanceTimersByTimeAsync(0);
        expect(launched.appServer.ask).toBeTypeOf('function');
        const decision = launched.appServer.ask({ tool: 'Bash(gh:*)', key: 'b'.repeat(64), detail: 'gh pr list' }, new AbortController().signal);
        await vi.advanceTimersByTimeAsync(2500);
        await expect(decision).resolves.toBe('once');
        expect(api.openToolRequest).toHaveBeenCalledWith(expect.objectContaining({ run: expect.objectContaining({ id: id(1) }) }),
            { tool: 'Bash(gh:*)', requestKey: 'b'.repeat(64), waitSeconds: 120, detail: 'gh pr list', cwd: null });
        children[0].finish.resolve(successful); await work;
    });
});
