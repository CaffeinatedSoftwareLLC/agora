import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, win32, relative, isAbsolute, sep } from 'node:path';
import { executeGit, recoverGitLocks, registerGitWorkspace } from './git-owner.js';
import type { Config, LocalProfile } from './config.js';
import type { Claim, HostApi } from './types.js';

const exec = promisify(execFile);
const gitContext = new AsyncLocalStorage<AbortSignal>();
export const withGitSignal = <T>(signal: AbortSignal, fn: () => Promise<T>) => gitContext.run(signal,fn);
export const gitSignal = () => gitContext.getStore();
export async function git(cwd: string, args: string[]): Promise<string> {
    return (await executeGit(cwd, ['-c', 'core.longpaths=true', ...args], { timeout: 60000,
        signal: gitSignal(), env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 4 * 1024 * 1024 })).stdout;
}
// Identity probes cannot acquire an index lock or replace a dead writer's ownership record.
async function probeGit(cwd: string, args: string[]) {
    return (await exec('git', ['--no-optional-locks', '-c', 'core.longpaths=true', ...args], {
        cwd, windowsHide: true, timeout: 10000, signal: gitSignal(), maxBuffer: 16384,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })).stdout;
}
export function samePath(a: string, b: string, platform = process.platform): boolean {
    return platform === 'win32' ? win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase() : resolve(a) === resolve(b);
}
export interface Workspace { sessionId: string; profile: string; workdir: string; cwd: string; commonDir: string; branch: string; baseSha: string; baseBranch?: string; warning?: string }
const metadata = (local: LocalProfile, sessionId: string) => join(local.stateDir, `wt-${sessionId.slice(-10)}.json`);
async function exists(path: string) { try { await lstat(path); return true; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } }
async function common(cwd: string) { return realpath((await probeGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()); }
async function hasBranch(cwd: string, branch: string) {
    try { await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); return true; } catch (e: any) {
        if (e.code === 1) return false;
        throw e;
    }
}
export async function validateWorkspace(w: Workspace) {
    // A parent checkout also answers is-inside-work-tree=true. Require the exact root.
    if ((await lstat(w.cwd)).isSymbolicLink()
        || !samePath(await realpath(w.cwd), (await probeGit(w.cwd, ['rev-parse', '--show-toplevel'])).trim())
        || !samePath(await common(w.cwd), w.commonDir)
        || (await probeGit(w.cwd, ['symbolic-ref', '--short', 'HEAD'])).trim() !== w.branch) throw new Error('unsafe_workspace_reuse');
}
async function registerWorkspaceGit(w: Workspace, local: LocalProfile, log?: (code: string) => void) {
    const path = (await probeGit(w.cwd, ['rev-parse', '--absolute-git-dir'])).trim();
    const gitDir = await realpath(path), rel = relative(join(w.commonDir, 'worktrees'), gitDir);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || (await lstat(path)).isSymbolicLink())
        throw new Error('unsafe_workspace_git_dir');
    const record = metadata(local, w.sessionId).replace(/\.json$/, '.git-process.json');
    registerGitWorkspace(w.cwd, gitDir, record, log);
    await recoverGitLocks(w.cwd);
}
function checkRecord(w: Workspace, local: LocalProfile, profile: string, sessionId: string) {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(sessionId) || w.sessionId !== sessionId || w.profile !== profile || !samePath(w.workdir, local.workdir)
        || !samePath(w.cwd, join(local.stateDir, `wt-${sessionId.slice(-10)}`))
        || w.branch !== `agora/${profile}/${sessionId}` || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(w.baseSha)) throw new Error('workspace_mapping_changed');
}
export async function ensureWorkspace(local: LocalProfile, claim: { session: Pick<Claim['session'], 'id'>; profile: Pick<Claim['profile'], 'name'> }, seed?: { sha: string; baseBranch?: string }): Promise<Workspace> {
    const sessionId = claim.session.id, profile = claim.profile.name;
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(sessionId) || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile)) throw new Error('invalid_workspace_identity');
    await mkdir(local.stateDir, { recursive: true, mode: 0o700 });
    const file = metadata(local, sessionId);
    let w: Workspace;
    if (await exists(file)) {
        w = JSON.parse(await readFile(file, 'utf8')); checkRecord(w, local, profile, sessionId);
        if (!samePath(await common(local.workdir), w.commonDir)) throw new Error('workspace_repository_changed');
    } else {
        w = { sessionId, profile, workdir: local.workdir, cwd: join(local.stateDir, `wt-${sessionId.slice(-10)}`),
            commonDir: await common(local.workdir), branch: `agora/${profile}/${sessionId}`,
            baseSha: seed?.sha ?? (await git(local.workdir, ['rev-parse', 'HEAD'])).trim(),
            baseBranch: seed?.baseBranch ?? (await git(local.workdir, ['symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim() };
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(w.baseSha)) throw new Error('invalid_workspace_base');
        if (await exists(w.cwd)) throw new Error('untracked_workspace_path');
        if (await hasBranch(local.workdir, w.branch)) throw new Error('workspace_branch_without_metadata');
        // Write the original base before creation; a restart must never replace it with a newer HEAD.
        await writeFile(file, JSON.stringify(w), { flag: 'wx', mode: 0o600 });
    }
    if (!await exists(w.cwd)) {
        const branchExists = await hasBranch(local.workdir, w.branch);
        // A worktree deleted without `git worktree remove` stays registered and blocks re-adding its branch.
        if (branchExists) await git(local.workdir, ['worktree', 'prune']);
        await git(local.workdir, ['worktree', 'add', ...(branchExists ? [] : ['-b', w.branch]), w.cwd, branchExists ? w.branch : w.baseSha]);
    }
    await validateWorkspace(w);
    await registerWorkspaceGit(w, local);
    return w;
}
/** Startup recovery never changes unknown locks, metadata mappings or common repository refs. */
export async function recoverWorkspaceGitLocks(config: Config, log: (code: string) => void) {
    for (const [profile, local] of Object.entries(config.profiles)) {
        const files = await readdir(local.stateDir).catch((e: any) => { if (e.code === 'ENOENT') return []; throw e; });
        for (const file of files.filter(f => /^wt-[0-9A-HJKMNP-TV-Z]{10}\.json$/.test(f))) {
            try {
                const w: Workspace = JSON.parse(await readFile(join(local.stateDir, file), 'utf8'));
                checkRecord(w, local, profile, w.sessionId);
                if (!await exists(w.cwd)) continue;
                if (!samePath(await common(local.workdir), w.commonDir)) throw new Error('workspace_repository_changed');
                await validateWorkspace(w);
                await registerWorkspaceGit(w, local, log);
            } catch (err) { log(err instanceof Error && err.message === 'stale_git_lock' ? 'stale_git_lock' : 'workspace_git_recovery_failed'); }
        }
    }
}
export async function workspaceHead(w: Workspace) {
    await validateWorkspace(w);
    return { branch: w.branch, baseSha: w.baseSha, headSha: (await git(w.cwd, ['rev-parse', 'HEAD'])).trim() };
}
export async function reconcileWorkspaces(config: Config, api: HostApi, active: ReadonlySet<string>, log: (code: string) => void) {
    if (!api.workspaceStates || !api.workspaceWarning) return;
    for (const [profile, local] of Object.entries(config.profiles)) {
        const files = await readdir(local.stateDir).catch((e: any) => { if (e.code === 'ENOENT') return []; throw e; });
        for (const file of files.filter(f => /^wt-[0-9A-HJKMNP-TV-Z]{10}\.json$/.test(f))) {
            try {
                const w: Workspace = JSON.parse(await readFile(join(local.stateDir, file), 'utf8'));
                if (w.profile !== profile) continue; // another profile sharing this stateDir
                checkRecord(w, local, profile, w.sessionId);
                if (active.has(w.sessionId)) continue;
                const states = await api.workspaceStates([w.sessionId]);
                if (!states.includes(w.sessionId)) continue; // server confirms ended, host ownership and no claimed run
                if (!await exists(w.cwd)) { await unlink(join(local.stateDir, file)); continue; }
                if (!samePath(await common(local.workdir), w.commonDir)) throw new Error('workspace_repository_changed');
                await validateWorkspace(w);
                const status = await git(w.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
                if (status) {
                    const paths: string[] = [], entries = status.split('\0').filter(Boolean);
                    for (let i = 0; i < entries.length; i++) {
                        paths.push(entries[i].slice(3));
                        if (/[RC]/.test(entries[i].slice(0, 2)) && entries[i + 1]) paths.push(entries[++i]);
                    }
                    if (w.warning !== status) {
                        await api.workspaceWarning(w.sessionId, paths);
                        w.warning = status; await writeFile(join(local.stateDir, file), JSON.stringify(w), { mode: 0o600 });
                    }
                    log('dirty_workspace_kept'); continue;
                }
                // Never force removal; retain branch refs, including commits ahead of the saved base.
                if ((await git(w.cwd, ['for-each-ref', '--format=%(refname)', `refs/agora/checkpoints/${w.sessionId}/`])).trim()) continue;
                await git(local.workdir, ['worktree', 'remove', w.cwd]);
                await unlink(join(local.stateDir, file));
            } catch { log('workspace_reconcile_failed'); }
        }
    }
}
