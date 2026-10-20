import { performance } from 'node:perf_hooks';
import type { Config } from './config.js';
import { prepare, type Launch } from './adapters.js';
import { fatalAuth, fenced, HttpError } from './client.js';
import type { Claim, HostApi, Result, Verification } from './types.js';
import { worktreeSnapshot, changedSince, type Runner, type RunningChild } from './process.js';
import { reconcileWorkspaces, workspaceHead } from './workspaces.js';
import { attachRunImages } from './images.js';
import { NON_RETRYABLE, TermsRefusal } from './terms.js';
import { planLoop } from './siwc/requests.js';
import { ACP_FATAL } from './acp/session.js';
import { snapshotTree, checkpoint, commitRun, executeReview, type Checkpoint } from './review.js';
import { verifyPrompt } from './prompt.js';
import { AGENT_TAIL, NOTICE_TAIL, runVerify, verifyArgv } from './verify.js';
import { runPreview } from './preview.js';
import { cardAsker } from './siwc/approvals.js';

interface Active {
    claim: Claim; child?: RunningChild; stop?: string; noReport: boolean; done: Promise<void>;
    /** Stops a running verify command (verify.ts). */
    verifyAbort?: AbortController;
    /** Tokens of earlier turns in this run (verify fix turns), added to the current child's. */
    tokenBase: number;
}
export interface SchedulerOptions {
    now?: () => number; tickMs?: number; safetyMs?: number; commandPollMs?: number;
    prepare?: (config: Config, claim: Claim, prompt?: string, active?: ReadonlySet<string>) => Promise<Launch>;
    /** Runs a verify command; tests replace it (verify.ts runVerify). */
    runVerify?: typeof runVerify;
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
            a.stop ??= 'host_stopped'; a.noReport = true; a.verifyAbort?.abort();
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
        const a: Active = { claim, noReport: false, done: Promise.resolve(), tokenBase: 0 };
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
            a.stop ??= reason; a.noReport ||= noReport; a.verifyAbort?.abort();
            try { await a.child?.kill(); } catch { a.noReport = true; this.log('process_tree_kill_failed'); await this.stop(); }
        };
        const tick = () => {
            if (this.stopping) { void stopChild('host_stopped', true); return; }
            if (this.now() >= deadline) { void stopChild('lease_deadline', true); return; }
            if (this.now() >= timeout) { void stopChild('run_timeout'); return; }
            if (a.stop || beat || this.now() < nextHeartbeat) return;
            const started = this.now(); nextHeartbeat = started + claim.run.heartbeatSeconds * 1000;
            const used = a.child?.tokensUsed?.();
            beat = this.api.heartbeat(claim, beatAbort.signal, a.tokenBase ? a.tokenBase + (used ?? 0) : used, a.child?.progress?.()).then(async response => {
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
            launch = await (this.options.prepare ?? prepare)(this.config, claim, undefined, new Set(this.active.keys()));
            if (launch.unknownPresets?.length) this.log('unknown_tool_preset');
            if (this.stopping || a.stop || this.now() >= deadline) return;
            // Codex reports its file changes; Claude and ACP agents are compared against the disk
            const snapshot = launch.adapter === 'claude' || !!launch.acp;
            const before = snapshot ? await worktreeSnapshot(launch.cwd) : null;
            if (launch.workspace) beforeTree = await snapshotTree(launch.workspace);
            if (this.stopping || a.stop || this.now() >= deadline) return;
            // Codex app-server approvals outside the rules wait for a tool-request card (#93)
            if (launch.appServer) launch.appServer.ask = cardAsker(this.api, claim, { waitMs: (this.config.approvalWaitSeconds ?? 300) * 1000 });
            a.child = this.runner.start(launch);
            result = await a.child.result; finished = true;
            if (snapshot) result.changedPaths = [...new Set([...changedSince(before, await worktreeSnapshot(launch.cwd)), ...(result.changedPaths ?? [])])].slice(0, 1000);
            // Verify before yield: only after a successful run that changed files
            if (claim.verify && result.success && !launch.lurk && result.changedPaths?.length && !a.stop && !this.stopping)
                result = await this.verify(a, launch, result, before, () => timeout - this.now());
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
            // Every preview range belongs to a running session: never take one away, refuse this run
            if (err instanceof Error && err.message === 'preview_ports_exhausted') this.log('preview_ports_exhausted');
            if (err instanceof Error && err.message === 'process_tree_kill_failed') {
                a.noReport = true; this.log('process_tree_kill_failed'); await this.stop();
            }
        }
        finally {
            if (finished && launch?.workspace && beforeTree) {
                try { savedCheckpoint = await checkpoint(launch.workspace, claim.run.id, beforeTree); }
                catch { this.log('checkpoint_failed'); }
                // The host commits for the agent; its sandbox can't write the shared .git (#113)
                if (result?.success && !launch.lurk) {
                    try { await commitRun(launch.workspace, { name: claim.profile.name, botId: claim.profile.botId }, result.summary); }
                    catch { this.log('auto_commit_failed'); }
                }
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
                            ...(result.deniedTools?.length ? { deniedTools: result.deniedTools } : {}),
                            ...(result.verification ? { verification: result.verification } : {}) }, reportAbort);
                    } else {
                        // A rate limit puts the session to sleep server-side instead of spending a retry (#87)
                        const rateLimited = !a.stop && finished && !!result.rateLimit;
                        await this.api.fail(claim, { claimToken: claim.run.claimToken, error: a.stop ?? (rateLimited ? 'rate_limited' : result.error ?? 'cli_failed'),
                            ...(savedCheckpoint ? { checkpoint: savedCheckpoint } : {}),
                            message: rateLimited ? 'The CLI hit its rate limit' : 'Agent run did not complete', tokensUsed: result.tokensUsed, changedPaths: result.changedPaths,
                            retryable: a.stop !== 'cancelled' && !NON_RETRYABLE.has(result.error ?? '') && !ACP_FATAL.has(result.error ?? ''),
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
    /**
     * Run the channel's verify command; on failure resume the same conversation with the
     * output as a follow-up turn, up to the channel's retry limit (docs/project-context.md).
     * The first turn already succeeded, so this always returns a successful result: a failed
     * fix turn or a failing command ends up in `verification`, never as a failed run.
     */
    private async verify(a: Active, first: Launch, result: Result, before: Map<string, string> | null, remainingMs: () => number): Promise<Result> {
        const { claim } = a; const spec = claim.verify!;
        const local = this.config.profiles[claim.profile.name];
        const argv = local ? verifyArgv(local, spec.command) : null;
        let current = result, tokens = result.tokensUsed, attempts = 0;
        const changed = new Set(result.changedPaths ?? []), denied = new Set(result.deniedTools ?? []);
        const done = (v: Omit<Verification, 'command' | 'attempts'>): Result => ({
            ...current, success: true, tokensUsed: tokens, changedPaths: [...changed].slice(0, 1000),
            ...(denied.size ? { deniedTools: [...denied] } : {}), verification: { command: spec.command, attempts, ...v },
        });
        if (!local || !argv) { this.log('verify_not_allowed'); return done({ status: 'skipped', reason: 'not_allowed' }); }
        const abort = new AbortController(); a.verifyAbort = abort;
        try {
            for (;;) {
                const timeoutMs = Math.max(1, Math.min(local.verify!.timeoutSeconds * 1000, remainingMs()));
                const out = await (this.options.runVerify ?? runVerify)(argv, first.cwd, timeoutMs, abort.signal);
                if (a.stop || this.stopping) return done({ status: 'skipped', reason: 'stopped' });
                if (out.spawnFailed) return done({ status: 'skipped', reason: 'spawn_failed' });
                if (out.passed) return done({ status: 'passed', exitCode: 0 });
                const failed = { status: 'failed' as const, exitCode: out.exitCode, output: out.output.slice(-NOTICE_TAIL), ...(out.timedOut ? { reason: 'timeout' } : {}) };
                if (attempts >= spec.maxRetries) return done(failed);
                if (!current.nativeSessionId) return done({ ...failed, reason: 'no_session' });
                attempts++;
                const resumed = { ...claim, session: { ...claim.session, nativeSessionId: current.nativeSessionId } };
                let next: Launch;
                try { next = await (this.options.prepare ?? prepare)(this.config, resumed,
                    verifyPrompt(claim, attempts, spec.command, out.exitCode, out.timedOut, out.output.slice(-AGENT_TAIL)), new Set(this.active.keys())); }
                catch { return done({ ...failed, reason: 'fix_turn_failed' }); }
                let r: Result;
                try {
                    if (a.stop || this.stopping) return done({ status: 'skipped', reason: 'stopped' });
                    a.tokenBase = tokens ?? 0;
                    a.child = this.runner.start(next);
                    r = await a.child.result;
                } finally { try { await next.cleanup(); } catch { this.log('run_cleanup_failed'); } }
                if (next.adapter === 'claude' || next.acp) r.changedPaths = [...new Set([...changedSince(before, await worktreeSnapshot(first.cwd)), ...(r.changedPaths ?? [])])].slice(0, 1000);
                for (const p of r.changedPaths ?? []) changed.add(p);
                for (const t of r.deniedTools ?? []) denied.add(t);
                if (r.tokensUsed !== null) tokens = (tokens ?? 0) + r.tokensUsed;
                if (!r.success || a.stop) return done({ ...failed, reason: 'fix_turn_failed' });
                current = { ...r, summary: r.summary ?? current.summary };
            }
        } finally { a.verifyAbort = undefined; }
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
    /**
     * Browser previews poll on a loop of their own: an agent asks for one mid-run and waits
     * for it, so it must not queue behind run claims or workspace commands.
     */
    private async previewLoop(): Promise<void> {
        const api = this.api;
        if (!api.claimPreview || !api.previewResult) return;
        while (!this.stopping) {
            try {
                const cmd = await api.claimPreview(this.abort.signal);
                if (!cmd) { await this.pause(this.options.commandPollMs ?? 2000); continue; }
                // Ends well inside the server's 90s lease, leaving time for the upload
                const outcome = await runPreview(this.config, cmd, new Set(this.active.keys()), AbortSignal.any([this.abort.signal, AbortSignal.timeout(45000)]));
                if (!outcome.success) this.log(`preview_${outcome.error}`);
                await api.previewResult(cmd, outcome, this.abort.signal);
            } catch (err) {
                if (fatalAuth(err)) { this.log('host_auth_rejected'); await this.stop(); }
                // An older server without previews: stop polling for them
                else if (err instanceof HttpError && err.status === 404) { this.log('previews_unsupported'); return; }
                else if (!this.stopping) { this.log('preview_failed'); await this.pause(2000); }
            }
        }
    }
    async run(): Promise<void> {
        let nextReconcile = 0;
        const commands = this.commandLoop(), previews = this.previewLoop();
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
        await commands; await previews;
        await plans;
        await this.drain();
    }
}
