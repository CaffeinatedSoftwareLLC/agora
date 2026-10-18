import { performance } from 'node:perf_hooks';
import type { Config } from './config.js';
import { prepare, type Launch } from './adapters.js';
import { fatalAuth, fenced, HttpError } from './client.js';
import type { Claim, HostApi, Result } from './types.js';
import { worktreeSnapshot, changedSince, type Runner, type RunningChild } from './process.js';

interface Active { claim: Claim; child?: RunningChild; stop?: string; noReport: boolean; done: Promise<void> }
export interface SchedulerOptions {
    now?: () => number; tickMs?: number; safetyMs?: number;
    prepare?: (config: Config, claim: Claim) => Promise<Launch>;
    log?: (code: string) => void;
}
const empty: Result = { success: false, nativeSessionId: null, tokensUsed: null, summary: null };

export class Scheduler {
    private active = new Map<string, Active>();
    private stopping = false;
    private abort = new AbortController();
    private now: () => number;
    private log: (code: string) => void;
    private safetyMs: number;
    constructor(private config: Config, private api: HostApi, private runner: Runner, private options: SchedulerOptions = {}) {
        this.now = options.now ?? (() => performance.now());
        this.log = options.log ?? (() => {}); this.safetyMs = options.safetyMs ?? 10000;
    }
    get size() { return this.active.size; }
    async stop(): Promise<void> {
        this.stopping = true; this.abort.abort();
        await Promise.all([...this.active.values()].map(async a => {
            a.stop ??= 'host_stopped'; a.noReport = true;
            try { await a.child?.kill(); } catch { this.log('process_tree_kill_failed'); }
        }));
    }
    async drain(): Promise<void> { await Promise.all([...this.active.values()].map(a => a.done)); }
    submit(claim: Claim, sentAt: number): Promise<void> {
        if (this.stopping) return Promise.resolve();
        if (this.active.has(claim.session.id)) {
            // Do not spawn a second child or mutate either conflicting lease.
            this.log('duplicate_session_claim'); return this.stop();
        }
        const a: Active = { claim, noReport: false, done: Promise.resolve() };
        this.active.set(claim.session.id, a);
        a.done = this.execute(a, sentAt).finally(() => { this.active.delete(claim.session.id); });
        return a.done;
    }
    private async execute(a: Active, sentAt: number): Promise<void> {
        const { claim } = a;
        let deadline = sentAt + claim.run.leaseSeconds * 1000 - this.safetyMs;
        const timeout = this.now() + claim.run.timeoutSeconds * 1000;
        let nextHeartbeat = this.now() + claim.run.heartbeatSeconds * 1000;
        let launch: Launch | undefined; let beat: Promise<void> | undefined;
        let result: Result | undefined; let finished = false;
        let interval: ReturnType<typeof setInterval> | undefined;
        const beatAbort = new AbortController();
        const stopChild = async (reason: string, noReport = false) => {
            a.stop ??= reason; a.noReport ||= noReport;
            try { await a.child?.kill(); } catch { a.noReport = true; this.log('process_tree_kill_failed'); await this.stop(); }
        };
        const tick = () => {
            if (this.stopping) { void stopChild('host_stopped', true); return; }
            if (this.now() >= deadline) { void stopChild('lease_deadline', true); return; }
            if (this.now() >= timeout) { void stopChild('run_timeout'); return; }
            if (a.stop || beat || this.now() < nextHeartbeat) return;
            const started = this.now(); nextHeartbeat = started + claim.run.heartbeatSeconds * 1000;
            beat = this.api.heartbeat(claim, beatAbort.signal, a.child?.tokensUsed?.()).then(async response => {
                if (response.cancel) await stopChild('cancelled');
                else if (!a.stop) deadline = started + claim.run.leaseSeconds * 1000 - this.safetyMs;
            }).catch(async err => {
                if (fatalAuth(err)) { a.noReport = true; await this.stop(); }
                else if (fenced(err)) await stopChild('claim_lost', true);
                else if (err instanceof HttpError && err.status < 500) await stopChild('heartbeat_rejected', true);
                // Network/5xx: the independent watchdog still enforces the last confirmed deadline.
            }).finally(() => { beat = undefined; });
        };
        try {
            if (deadline <= this.now()) return;
            interval = setInterval(tick, this.options.tickMs ?? 100);
            launch = await (this.options.prepare ?? prepare)(this.config, claim);
            if (this.stopping || a.stop || this.now() >= deadline) return;
            const before = launch.adapter === 'claude' ? await worktreeSnapshot(launch.cwd) : null;
            if (this.stopping || a.stop || this.now() >= deadline) return;
            a.child = this.runner.start(launch);
            result = await a.child.result; finished = true;
            if (launch.adapter === 'claude') result.changedPaths = changedSince(before, await worktreeSnapshot(launch.cwd));
        } catch (err) {
            result = { ...empty, error: 'host_launch_failed' };
            if (err instanceof Error && err.message === 'process_tree_kill_failed') {
                a.noReport = true; this.log('process_tree_kill_failed'); await this.stop();
            }
        }
        finally {
            if (interval) clearInterval(interval);
            // Finish any heartbeat before reporting; no post-completion heartbeat race.
            beatAbort.abort(); await beat;
            if (!a.noReport && !this.stopping && this.now() < deadline && result) {
                const reportAbort = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - this.now())));
                try {
                    if (finished && result.success) {
                        await this.api.complete(claim, { claimToken: claim.run.claimToken, nativeSessionId: result.nativeSessionId,
                            tokensUsed: result.tokensUsed, summary: result.summary, changedPaths: result.changedPaths }, reportAbort);
                    } else {
                        await this.api.fail(claim, { claimToken: claim.run.claimToken, error: a.stop ?? result.error ?? 'cli_failed',
                            message: 'Agent run did not complete', tokensUsed: result.tokensUsed, changedPaths: result.changedPaths,
                            retryable: a.stop !== 'cancelled' && result.error !== 'host_launch_failed' }, reportAbort);
                    }
                } catch (err) {
                    if (fatalAuth(err)) await this.stop();
                    this.log(fenced(err) ? 'report_fenced' : 'report_failed');
                }
            }
            try { await launch?.cleanup(); } catch { this.log('run_cleanup_failed'); }
        }
    }
    async run(): Promise<void> {
        while (!this.stopping) {
            try {
                if (this.size >= this.config.maxConcurrent) {
                    await Promise.race([...this.active.values()].map(a => a.done)); continue;
                }
                const delivery = await this.api.claim(this.abort.signal);
                if (delivery && !this.stopping) void this.submit(delivery.claim, delivery.sentAt);
            } catch (err) {
                if (fatalAuth(err)) { this.log('host_auth_rejected'); await this.stop(); }
                else if (!this.stopping) {
                    this.log('claim_failed');
                    await new Promise<void>(resolve => {
                        const end = () => { clearTimeout(timer); resolve(); };
                        const timer = setTimeout(() => { this.abort.signal.removeEventListener('abort', end); resolve(); }, 1000);
                        this.abort.signal.addEventListener('abort', end, { once: true });
                    });
                }
            }
        }
        await this.drain();
    }
}
