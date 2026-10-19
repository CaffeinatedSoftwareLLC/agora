import { performance } from 'node:perf_hooks';
import type { Config } from './config.js';
import { prepare, type Launch } from './adapters.js';
import { fatalAuth, fenced, HttpError } from './client.js';
import type { Claim, HostApi, Result } from './types.js';
import { worktreeSnapshot, changedSince, type Runner, type RunningChild } from './process.js';
import { reconcileWorkspaces, workspaceHead } from './workspaces.js';
import { attachRunImages } from './images.js';
import { NON_RETRYABLE, TermsRefusal } from './terms.js';
import { planLoop } from './siwc/requests.js';
import { snapshotTree, checkpoint, executeReview, type Checkpoint } from './review.js';

interface Active { claim: Claim; child?: RunningChild; stop?: string; noReport: boolean; done: Promise<void> }
export interface SchedulerOptions {
    now?: () => number; tickMs?: number; safetyMs?: number; commandPollMs?: number;
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
        let beforeTree: string | undefined, savedCheckpoint: Checkpoint | undefined;
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
            if (launch.unknownPresets?.length) this.log('unknown_tool_preset');
            if (this.stopping || a.stop || this.now() >= deadline) return;
            const before = launch.adapter === 'claude' ? await worktreeSnapshot(launch.cwd) : null;
            if (launch.workspace) beforeTree = await snapshotTree(launch.workspace);
            if (this.stopping || a.stop || this.now() >= deadline) return;
            a.child = this.runner.start(launch);
            result = await a.child.result; finished = true;
            if (launch.adapter === 'claude') result.changedPaths = changedSince(before, await worktreeSnapshot(launch.cwd));
            // Keep the lease watchdog/heartbeats alive while attachments upload. A bad
            // reference must not lose a successful CLI result or trigger another agent turn.
            if (!a.stop && !this.stopping && !a.noReport) {
                try { await attachRunImages(this.api, claim, launch.cwd,
                    AbortSignal.any([this.abort.signal, AbortSignal.timeout(Math.max(1, Math.ceil(deadline - this.now())))]), this.log); }
                catch (err) {
                    if (fatalAuth(err)) { a.noReport = true; await this.stop(); }
                    else if (fenced(err)) a.noReport = true;
                    else this.log('image_discovery_failed');
                }
            }
        } catch (err) {
            // A provider-terms refusal is reported by its own code and never retried
            result = { ...empty, error: err instanceof TermsRefusal ? err.code : 'host_launch_failed' };
            if (err instanceof TermsRefusal) this.log(err.code);
            if (err instanceof Error && err.message === 'process_tree_kill_failed') {
                a.noReport = true; this.log('process_tree_kill_failed'); await this.stop();
            }
        }
        finally {
            if (finished && launch?.workspace && beforeTree) {
                try { savedCheckpoint = await checkpoint(launch.workspace, claim.run.id, beforeTree); }
                catch { this.log('checkpoint_failed'); }
            }
            if (interval) clearInterval(interval);
            // Finish any heartbeat before reporting; no post-completion heartbeat race.
            beatAbort.abort(); await beat;
            if (!a.noReport && !this.stopping && this.now() < deadline && result) {
                const reportAbort = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - this.now())));
                try {
                    if (finished && result.success) {
                        // A failed branch check (e.g. the agent switched branches) must not lose the completion.
                        let head = {};
                        if (launch?.workspace) { try { head = await workspaceHead(launch.workspace); } catch { this.log('workspace_head_failed'); } }
                        await this.api.complete(claim, { claimToken: claim.run.claimToken, nativeSessionId: result.nativeSessionId,
                            ...(savedCheckpoint ? { checkpoint: savedCheckpoint } : {}),
                            tokensUsed: result.tokensUsed, summary: result.summary, changedPaths: result.changedPaths, ...head,
                            ...(result.deniedTools?.length ? { deniedTools: result.deniedTools } : {}) }, reportAbort);
                    } else {
                        // A rate limit puts the session to sleep server-side instead of spending a retry (#87)
                        const rateLimited = !a.stop && finished && !!result.rateLimit;
                        await this.api.fail(claim, { claimToken: claim.run.claimToken, error: a.stop ?? (rateLimited ? 'rate_limited' : result.error ?? 'cli_failed'),
                            ...(savedCheckpoint ? { checkpoint: savedCheckpoint } : {}),
                            message: rateLimited ? 'The CLI hit its rate limit' : 'Agent run did not complete', tokensUsed: result.tokensUsed, changedPaths: result.changedPaths,
                            retryable: a.stop !== 'cancelled' && !NON_RETRYABLE.has(result.error ?? ''),
                            ...(result.deniedTools?.length ? { deniedTools: result.deniedTools } : {}),
                            ...(rateLimited ? { rateLimit: result.rateLimit } : {}) }, reportAbort);
                    }
                } catch (err) {
                    if (fatalAuth(err)) await this.stop();
                    this.log(fenced(err) ? 'report_fenced' : 'report_failed');
                }
            }
            try { await launch?.cleanup(); } catch { this.log('run_cleanup_failed'); }
        }
    }
    private pause(ms: number) {
        return new Promise<void>(resolve => {
            const end = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => { this.abort.signal.removeEventListener('abort', end); resolve(); }, ms);
            this.abort.signal.addEventListener('abort', end, { once: true });
        });
    }
    /**
     * Workspace commands poll on their own loop so a phone diff doesn't wait behind the 25s
     * run long poll. The server serialises commands and runs per session.
     */
    private async commandLoop(): Promise<void> {
        const api = this.api;
        if (!api.claimWorkspaceCommand || !api.workspaceCommandResult) return;
        while (!this.stopping) {
            try {
                const cmd = await api.claimWorkspaceCommand(this.abort.signal);
                if (!cmd) { await this.pause(this.options.commandPollMs ?? 2000); continue; }
                let success = false, result: object;
                try {
                    const local = this.config.profiles[cmd.profile];
                    if (!local || this.active.has(cmd.sessionId)) throw new Error('session_busy_or_profile_unavailable');
                    result = await executeReview(local, cmd); success = true;
                } catch (err) {
                    // Git/gh errors contain local paths and command output. Send only known codes.
                    const code = err instanceof Error ? err.message : '';
                    result = { error: /^[a-z][a-z_]{0,100}$/.test(code) ? code : 'workspace_command_failed' };
                }
                await api.workspaceCommandResult(cmd, success, result, this.abort.signal);
            } catch (err) {
                if (fatalAuth(err)) { this.log('host_auth_rejected'); await this.stop(); }
                // An older server without the command queue: leave runs working, stop polling.
                else if (err instanceof HttpError && err.status === 404) { this.log('workspace_commands_unsupported'); return; }
                else if (!this.stopping) { this.log('workspace_command_failed'); await this.pause(2000); }
            }
        }
    }
    async run(): Promise<void> {
        let nextReconcile = 0;
        const commands = this.commandLoop();
        // Settings → Agents "Continue with ChatGPT": sign-ins run on this machine (siwc/requests.ts)
        const plans = planLoop(this.config, this.api, { signal: this.abort.signal, log: this.log, pause: ms => this.pause(ms), stopping: () => this.stopping });
        while (!this.stopping) {
            try {
                if (this.now() >= nextReconcile) {
                    await reconcileWorkspaces(this.config, this.api, new Set(this.active.keys()), this.log);
                    nextReconcile = this.now() + 60000;
                }
                if (this.size >= this.config.maxConcurrent) {
                    await Promise.race([...this.active.values()].map(a => a.done).concat(new Promise<void>(r => setTimeout(r, 1000)))); continue;
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
        await commands;
        await plans;
        await this.drain();
    }
}
