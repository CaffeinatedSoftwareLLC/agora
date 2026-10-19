import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { LocalProfile } from './config.js';
import { ensureWorkspace, git, gitSignal, withGitSignal, validateWorkspace, type Workspace } from './workspaces.js';

const exec = promisify(execFile);
const identity = ['-c', 'user.name=Agora', '-c', 'user.email=agora@localhost'];
export interface Checkpoint { sha: string; ref: string }
export interface ReviewCommand {
    id: string; claimToken: string; sessionId: string; profile: string; workdirAlias: string;
    action: 'diff' | 'discard' | 'commit' | 'merge' | 'pr' | 'restore' | 'fork' | 'pr_status';
    payload: { path?: string; offset?: number; revision?: string; message?: string; checkpoint?: Checkpoint; forkSessionId?: string };
}
const CAP = 128 * 1024, PAGE = 16000;
/** execFile bounds output before allocation can grow with a huge patch. No shell or diff drivers. */
async function boundedGit(cwd: string, args: string[]) {
    return new Promise<{ text: string; truncated: boolean }>((resolve, reject) => {
        execFile('git', ['-c', 'core.longpaths=true', '--literal-pathspecs', ...args], {
            cwd, windowsHide: true, signal: gitSignal(), timeout: 30000, maxBuffer: CAP, encoding: 'buffer',
            env: {...process.env,GIT_TERMINAL_PROMPT:'0'},
        }, (err,stdout) => {
            const truncated=err?.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
            if (err && !truncated) reject(new Error('git_review_failed'));
            else resolve({text:stdout.subarray(0,CAP).toString('utf8'),truncated});
        });
    });
}
export async function safeReviewPath(w: Workspace, path: string) {
    if (!path || path.length > 4096 || /[\\\x00-\x1f:]/.test(path) || isAbsolute(path)
        || path.split('/').some(p => !p || p === '.' || p === '..' || /[ .]$/.test(p) || /^(?:\.git(?:[ .~]|$)|git~[0-9]+$)/i.test(p))) throw new Error('unsafe_path');
    const full = join(w.cwd, path), rel = relative(w.cwd, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('unsafe_path');
    let part = w.cwd;
    for (const segment of path.split('/')) {
        part = join(part, segment);
        const s = await lstat(part).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
        if (s?.isSymbolicLink()) throw new Error('unsafe_path');
    }
    return full;
}
function revisionFor(text: string, expected?: string) {
    const revision=createHash('sha256').update(text).digest('hex');
    if (expected && expected!==revision) throw new Error('diff_changed_refresh');
    return revision;
}
export async function reviewDiff(w: Workspace, path?: string, offset = 0, expected?: string) {
    await validateWorkspace(w);
    if (!Number.isInteger(offset) || offset < 0 || offset > CAP) throw new Error('invalid_offset');
    if (!path) {
        const tracked = await boundedGit(w.cwd, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--no-renames', w.baseSha, '--']);
        const other = await boundedGit(w.cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
        const names = (r: {text:string;truncated:boolean}) => { const items=r.text.split('\0'); items.pop(); return items.filter(Boolean); };
        const all = [...new Set([...names(tracked),...names(other)])];
        const files = all.slice(0,1000);
        const revision=revisionFor(JSON.stringify(files),expected);
        return { files: files.slice(offset, offset + 30), next: offset + 30 < files.length ? offset + 30 : null,
            revision,truncated: tracked.truncated || other.truncated || all.length>1000, baseSha: w.baseSha, branch: w.branch };
    }
    const full = await safeReviewPath(w, path);
    const patch = await boundedGit(w.cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--submodule=short', w.baseSha, '--', path]);
    if (!patch.text) {
        const untracked = await git(w.cwd, ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '--', path]);
        if (untracked) {
            const s = await lstat(full);
            if (!s.isFile()) throw new Error('unsupported_file');
            if (s.size > CAP) return { path, diff: 'File exceeds the 128 KiB preview cap.', next: null, truncated: true };
            const data = await readFile(full);
            const content=data.toString('utf8'), lines=content ? content.replace(/\n$/,'').split('\n') : [];
            patch.text = data.includes(0) ? 'Binary file (untracked)' : `--- /dev/null\n+++ b/${path}\n`
                + (lines.length ? `@@ -0,0 +1,${lines.length} @@\n` + lines.map(l=>'+'+l).join('\n') + '\n'
                    + (content.endsWith('\n') ? '' : '\\ No newline at end of file\n') : '');
            patch.truncated = patch.text.length > CAP; patch.text = patch.text.slice(0, CAP);
        }
    }
    const revision=revisionFor(patch.text,expected);
    return { path, revision, diff: patch.text.slice(offset, offset + PAGE), next: offset + PAGE < patch.text.length ? offset + PAGE : null, truncated: patch.truncated };
}
/** Alternate index: checkpointing preserves the agent's staged/unstaged split and HEAD. */
export async function snapshotTree(w: Workspace): Promise<string> {
    await validateWorkspace(w);
    const index = join(dirname(w.cwd), `snapshot-${randomUUID()}.index`);
    const run = async (args: string[]) => (await exec('git', ['-c', 'core.longpaths=true', ...args], {
        cwd: w.cwd, env: { ...process.env, GIT_INDEX_FILE: index }, windowsHide: true, timeout: 30000, signal: gitSignal(), maxBuffer: 1024 * 1024,
    })).stdout.trim();
    try { await run(['read-tree', 'HEAD']); await run(['add', '-A', '--', '.']); return await run(['write-tree']); }
    finally { await rm(index, { force: true }); await rm(index + '.lock', { force: true }); }
}
export async function checkpoint(w: Workspace, runId: string, beforeTree: string): Promise<Checkpoint | undefined> {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(runId)) throw new Error('invalid_run');
    const tree = await snapshotTree(w);
    if (tree === beforeTree) return;
    const prefix = `refs/agora/checkpoints/${w.sessionId}/`;
    const refs = (await git(w.cwd, ['for-each-ref', '--format=%(refname) %(objectname) %(subject)', prefix])).trim().split('\n').filter(Boolean);
    const existing = refs.find(r => r.endsWith(`Agora checkpoint ${runId}`));
    if (existing) { const [ref, sha] = existing.split(' '); return { ref, sha }; }
    const n = Math.max(0, ...refs.map(r => Number(r.split(' ')[0].slice(prefix.length)) || 0)) + 1;
    const sha = (await git(w.cwd, [...identity, 'commit-tree', tree, '-p', 'HEAD', '-m', `Agora checkpoint ${runId}`])).trim();
    const ref = prefix + n;
    await git(w.cwd, ['update-ref', ref, sha, '0'.repeat(sha.length)]);
    return { sha, ref };
}
async function checkedCheckpoint(w: Workspace, cp?: Checkpoint) {
    if (!cp || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(cp.sha)
        || !new RegExp(`^refs/agora/checkpoints/${w.sessionId}/[1-9][0-9]*$`).test(cp.ref)
        || (await git(w.cwd, ['rev-parse', '--verify', cp.ref])).trim() !== cp.sha) throw new Error('invalid_checkpoint');
    return cp;
}
/** Control characters out (newline and tab kept for commit bodies); NUL would make execFile throw. */
export const cleanMessage = (m: string) => m.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
const oneLine = (m: string) => cleanMessage(m).split('\n')[0].replace(/\t/g, ' ').trim().slice(0, 256);
type Gh = (cwd: string, args: string[]) => Promise<string>;
const gh: Gh = async (cwd,args) => (await exec('gh',args,{ cwd,windowsHide:true,timeout:60000,maxBuffer:16384,
    signal:gitSignal(),env:{...process.env,GH_PROMPT_DISABLED:'1',GIT_TERMINAL_PROMPT:'0'} })).stdout;
/**
 * The session branch's pull request, for its task card (docs/task-board.md). Reads only; gh
 * uses the host owner's login. The branch name is ours (agora/<profile>/<session>), never a flag.
 */
async function prStatus(w: Workspace, runGh: Gh) {
    let out: string;
    try { out = await runGh(w.cwd, ['pr', 'view', w.branch, '--json', 'url,state,isDraft']); }
    catch (err: any) { throw new Error(/no pull requests? found/i.test(String(err?.stderr ?? err?.message ?? '')) ? 'no_pull_request' : 'pr_status_failed'); }
    let pr: { url?: unknown; state?: unknown; isDraft?: unknown };
    try { pr = JSON.parse(out); } catch { throw new Error('pr_status_failed'); }
    const state = String(pr.state ?? '').toUpperCase();
    const prState = state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : state === 'OPEN' ? (pr.isDraft ? 'draft' : 'open') : null;
    if (!prState) throw new Error('pr_status_failed');
    const url = typeof pr.url === 'string' && /^https:\/\/\S+$/.test(pr.url) ? pr.url.slice(0, 2048) : undefined;
    return { prState, ...(url ? { url } : {}), message: `Pull request is ${prState}` };
}
export function executeReview(local: LocalProfile, cmd: ReviewCommand, runGh: Gh = gh) {
    // Entire operation ends before the 180s server lease; no later Git steps run on expiry.
    return withGitSignal(AbortSignal.timeout(120000),()=>executeOperation(local,cmd,runGh));
}
async function executeOperation(local: LocalProfile, cmd: ReviewCommand, runGh: Gh) {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(cmd.sessionId)) throw new Error('invalid_workspace_identity');
    if (cmd.workdirAlias !== local.workdirAlias) throw new Error('workspace_mapping_changed');
    const record = join(local.stateDir, `wt-${cmd.sessionId.slice(-10)}.json`);
    // Commands may never invent a workspace from the user's current HEAD.
    await readFile(record, 'utf8').catch((err: any)=>{if(err.code==='ENOENT')throw new Error('workspace_not_created_yet');throw err;});
    const w = await ensureWorkspace(local, { session: { id: cmd.sessionId }, profile: { name: cmd.profile } });
    const p = cmd.payload;
    if (cmd.action === 'diff') return reviewDiff(w, p.path, p.offset,p.revision);
    if (cmd.action === 'discard') {
        const path = p.path!; const full = await safeReviewPath(w, path);
        const entries = (await git(w.cwd, ['--literal-pathspecs', 'ls-files', '-z', '--', path])).split('\0').filter(Boolean);
        const original = (await git(w.cwd, ['--literal-pathspecs', 'ls-tree', w.baseSha, '--', path])).trim();
        if (entries.some(p=>p!==path) || original && !/^100[0-9]{3} blob /.test(original)) throw new Error('unsafe_path');
        const tracked = entries.includes(path);
        if (original || tracked) await git(w.cwd, ['--literal-pathspecs', 'restore', `--source=${w.baseSha}`, '--staged', '--worktree', '--', path]);
        else {
            const s = await lstat(full); if (!s.isFile()) throw new Error('unsafe_path');
            const untracked=(await git(w.cwd,['--literal-pathspecs','ls-files','--others','--exclude-standard','-z','--',path])).split('\0');
            if (!untracked.includes(path)) throw new Error('file_not_in_diff');
            await rm(full);
        }
        return { message: `Discarded ${path}` };
    }
    if (cmd.action === 'commit') {
        const message = cleanMessage(p.message ?? '');
        if (!message || message.length > 2000) throw new Error('commit_message_required');
        await git(w.cwd, ['add', '-A', '--', '.']);
        await git(w.cwd, [...identity, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', message]);
        return { headSha: (await git(w.cwd, ['rev-parse', 'HEAD'])).trim(), message: 'Committed session changes' };
    }
    if (cmd.action === 'restore' || cmd.action === 'fork') {
        const cp = await checkedCheckpoint(w, p.checkpoint);
        if (cmd.action === 'restore') {
            // Save current files first as a recovery checkpoint; later refs are never deleted.
            const headTree = (await git(w.cwd, ['rev-parse', 'HEAD^{tree}'])).trim();
            await checkpoint(w, cmd.id, headTree);
            await git(w.cwd, ['reset', '--hard', cp.sha]);
            await git(w.cwd, ['clean', '-fd', '--']);
            return { headSha: cp.sha, message: `Restored checkpoint ${cp.ref.split('/').pop()}` };
        }
        if (!p.forkSessionId) throw new Error('invalid_workspace_identity');
        const fork = await ensureWorkspace(local, { session: { id: p.forkSessionId }, profile: { name: cmd.profile } }, { sha: cp.sha, baseBranch: w.baseBranch });
        return { sessionId: fork.sessionId, branch: fork.branch, baseSha: fork.baseSha, headSha: cp.sha, message: 'Forked checkpoint into a new shelved session' };
    }
    if (cmd.action === 'pr_status') return prStatus(w, runGh);
    if (await git(w.cwd, ['status', '--porcelain'])) throw new Error('commit_changes_first');
    const base = w.baseBranch;
    if (!base || base === w.branch) throw new Error('base_branch_unavailable');
    await git(w.cwd, ['check-ref-format', `refs/heads/${base}`]);
    if (cmd.action === 'pr') {
        // Push only the session branch, without force. gh uses the host owner's login.
        await git(w.cwd, ['push', '--', 'origin', `HEAD:refs/heads/${w.branch}`]);
        // One-line title; `--flag=value` so a title starting with '-' is never read as a flag.
        const title = (p.message ? oneLine(p.message) : '') || `Review ${w.branch}`;
        const result = await runGh(w.cwd, ['pr', 'create', `--base=${base}`, `--head=${w.branch}`, `--title=${title}`, `--body=Agora session ${w.sessionId}`]);
        return { url: result.trim().slice(0, 2048), message: 'Opened GitHub pull request' };
    }
    if (cmd.action !== 'merge') throw new Error('unsupported_command');
    // Updating a checked-out base ref would leave the user's checkout inconsistent.
    const worktrees = await git(w.cwd, ['worktree', 'list', '--porcelain']);
    if (worktrees.split('\n').includes(`branch refs/heads/${base}`)) throw new Error('base_branch_checked_out_use_pr');
    const old = (await git(w.cwd, ['rev-parse', `refs/heads/${base}`])).trim();
    const temp = await mkdtemp(join(local.stateDir, 'merge-'));
    await rm(temp, { recursive: true });
    try {
        await git(w.cwd, ['worktree', 'add', '--detach', temp, old]);
        await git(temp, ['merge', '--squash', '--no-commit', w.branch]);
        await git(temp, [...identity, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', cleanMessage(p.message ?? '') || `Squash ${w.branch}`]);
        const sha = (await git(temp, ['rev-parse', 'HEAD'])).trim();
        // Recheck just before compare-and-swap. Never move a checkout or force-push.
        if ((await git(w.cwd, ['worktree', 'list', '--porcelain'])).split('\n').includes(`branch refs/heads/${base}`)) throw new Error('base_branch_checked_out_use_pr');
        await git(w.cwd, ['update-ref', `refs/heads/${base}`, sha, old]);
        return { headSha: sha, message: `Squash-merged into ${base}` };
    } finally { await withGitSignal(AbortSignal.timeout(15000),()=>git(w.cwd, ['worktree', 'remove', '--force', temp])).catch(() => {}); }
}
