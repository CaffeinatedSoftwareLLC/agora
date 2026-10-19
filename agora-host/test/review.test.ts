import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureWorkspace, git, reconcileWorkspaces } from '../src/workspaces.js';
import { checkpoint, snapshotTree, reviewDiff, executeReview, safeReviewPath, type ReviewCommand } from '../src/review.js';
import { claim, config, tempDir, id } from './helpers.js';
import { Scheduler } from '../src/scheduler.js';
import { performance } from 'node:perf_hooks';
import { vi } from 'vitest';
const cleanups: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const c of cleanups.splice(0).reverse()) await c();});
async function setup() {
    const temp=await tempDir();cleanups.push(temp.cleanup);
    const repo=join(temp.dir,'repo');await mkdir(repo);await git(repo,['init','-b','main']);await git(repo,['config','core.autocrlf','false']);
    await writeFile(join(repo,'file.txt'),'base\n');await git(repo,['add','.']);
    await git(repo,['-c','user.name=Test','-c','user.email=test@example.com','commit','-m','base']);
    const c=config(temp.dir);c.profiles.builder.workdir=repo;const delivery=claim();
    const local=c.profiles.builder,w=await ensureWorkspace(local,delivery);
    const cmd=(action:ReviewCommand['action'],payload:ReviewCommand['payload']={})=>executeReview(local,{
        id:id(10),claimToken:'test-token',sessionId:w.sessionId,profile:'builder',workdirAlias:'agora',action,payload,
    });
    return {local,w,cmd,repo,c,delivery};
}
it('reviews committed, staged, unstaged, deleted, untracked and binary files against the saved base',async()=>{
    const {w,cmd}=await setup();await writeFile(join(w.cwd,'file.txt'),'changed\n');
    await cmd('commit',{message:'change'});await writeFile(join(w.cwd,'file.txt'),'later\n');
    await writeFile(join(w.cwd,'new file.txt'),'new\n');await writeFile(join(w.cwd,'binary'),Buffer.from([1,0,2]));
    expect((await reviewDiff(w)).files).toEqual(expect.arrayContaining(['file.txt','new file.txt','binary']));
    expect((await reviewDiff(w,'file.txt')).diff).toContain('-base');
    expect((await reviewDiff(w,'file.txt')).diff).toContain('+later');
    expect((await reviewDiff(w,'new file.txt')).diff).toContain('+++ b/new file.txt');
    expect((await reviewDiff(w,'new file.txt')).diff).toContain('@@ -0,0 +1,1 @@\n+new\n');
    expect((await reviewDiff(w,'binary')).diff).toContain('Binary');
    await git(w.cwd,['rm','-f','file.txt']);expect((await reviewDiff(w,'file.txt')).diff).toContain('-base');
});
it('paginates file lists and patches and caps large output',async()=>{
    const {w}=await setup();
    await Promise.all(Array.from({length:35},(_,n)=>writeFile(join(w.cwd,`file${n}`),'x')));
    const first=await reviewDiff(w);expect(first.files).toHaveLength(30);expect(first.next).toBe(30);
    expect((await reviewDiff(w,undefined,30)).files).toHaveLength(5);
    await writeFile(join(w.cwd,'file.txt'),'change\n'.repeat(40000));
    const patch=await reviewDiff(w,'file.txt');expect(patch.diff!.length).toBeLessThanOrEqual(16000);expect(patch.next).toBe(16000);expect(patch.truncated).toBe(true);
    expect((await reviewDiff(w,'file.txt',16000)).diff).toBeTruthy();
    await writeFile(join(w.cwd,'file.txt'),'different\n');await expect(reviewDiff(w,'file.txt',16000,patch.revision)).rejects.toThrow('diff_changed_refresh');
});
it('discards a file to base even after a commit and removes a single untracked file',async()=>{
    const {w,cmd}=await setup();await writeFile(join(w.cwd,'file.txt'),'committed');await writeFile(join(w.cwd,'added.txt'),'added');await cmd('commit',{message:'change'});
    await writeFile(join(w.cwd,'keep.txt'),'keep');await writeFile(join(w.cwd,'drop.txt'),'drop');
    await cmd('discard',{path:'file.txt'});await cmd('discard',{path:'drop.txt'});
    await cmd('discard',{path:'added.txt'});await expect(readFile(join(w.cwd,'added.txt'))).rejects.toThrow();
    expect(await readFile(join(w.cwd,'file.txt'),'utf8')).toBe('base\n');
    expect(await readFile(join(w.cwd,'keep.txt'),'utf8')).toBe('keep');
    await expect(readFile(join(w.cwd,'drop.txt'))).rejects.toThrow();
});
it('commits all changes with a literal message while leaving the main checkout untouched',async()=>{
    const {w,cmd,repo}=await setup();await writeFile(join(w.cwd,'file.txt'),'session');await writeFile(join(w.cwd,'new'),'new');
    const result=await cmd('commit',{message:'--literal $(not-a-shell)'});
    expect(result).toHaveProperty('headSha');expect(await git(w.cwd,['status','--porcelain'])).toBe('');
    expect((await git(w.cwd,['log','-1','--format=%s'])).trim()).toBe('--literal $(not-a-shell)');
    expect(await readFile(join(repo,'file.txt'),'utf8')).toBe('base\n');
    expect((await git(repo,['rev-parse','HEAD'])).trim()).toBe(w.baseSha);
});
it('checkpoints use refs without changing HEAD or the real index, and detect no-op runs',async()=>{
    const {w}=await setup();const before=await snapshotTree(w);const head=(await git(w.cwd,['rev-parse','HEAD'])).trim();
    expect(await checkpoint(w,id(20),before)).toBeUndefined();
    await writeFile(join(w.cwd,'file.txt'),'staged');await git(w.cwd,['add','.']);await writeFile(join(w.cwd,'file.txt'),'unstaged');
    const index=await git(w.cwd,['diff','--cached']);const cp=await checkpoint(w,id(20),before);
    expect(cp?.ref).toBe(`refs/agora/checkpoints/${w.sessionId}/1`);
    expect((await git(w.cwd,['show',`${cp!.sha}:file.txt`])).trim()).toBe('unstaged');
    expect((await git(w.cwd,['rev-parse','HEAD'])).trim()).toBe(head);expect(await git(w.cwd,['diff','--cached'])).toBe(index);
    expect(await checkpoint(w,id(20),before)).toEqual(cp);
});
it('restores exact checkpoint content, clears untracked files and retains later refs',async()=>{
    const {w,cmd,repo}=await setup();const before=await snapshotTree(w);await writeFile(join(w.cwd,'file.txt'),'first');
    const first=(await checkpoint(w,id(20),before))!;const tree=await snapshotTree(w);
    await writeFile(join(w.cwd,'file.txt'),'second');await writeFile(join(w.cwd,'later'),'later');const second=(await checkpoint(w,id(21),tree))!;
    await cmd('restore',{checkpoint:first});
    expect(await readFile(join(w.cwd,'file.txt'),'utf8')).toBe('first');
    await expect(readFile(join(w.cwd,'later'))).rejects.toThrow();
    expect((await git(w.cwd,['rev-parse',second.ref])).trim()).toBe(second.sha);
    expect(await readFile(join(repo,'file.txt'),'utf8')).toBe('base\n');
});
it('forks a checkpoint into a distinct session worktree, preserving the source and base branch',async()=>{
    const {w,cmd,local}=await setup();const before=await snapshotTree(w);await writeFile(join(w.cwd,'file.txt'),'fork content');
    const cp=(await checkpoint(w,id(20),before))!;await writeFile(join(w.cwd,'file.txt'),'source later');
    const result=await cmd('fork',{checkpoint:cp,forkSessionId:id(30)});expect(result).toHaveProperty('sessionId',id(30));
    const fork=await ensureWorkspace(local,{session:{id:id(30)},profile:{name:'builder'}} as any);
    expect(fork.baseSha).toBe(cp.sha);expect(fork.baseBranch).toBe('main');expect(fork.cwd).not.toBe(w.cwd);
    expect(await readFile(join(fork.cwd,'file.txt'),'utf8')).toBe('fork content');expect(await readFile(join(w.cwd,'file.txt'),'utf8')).toBe('source later');
});
it('squash-merges on an isolated temporary worktree with one commit and no main checkout changes',async()=>{
    const {w,cmd,repo}=await setup();await writeFile(join(w.cwd,'file.txt'),'one');await cmd('commit',{message:'one'});
    await writeFile(join(w.cwd,'another'),'two');await cmd('commit',{message:'two'});
    // Main can only advance when it has no checkout. The user explicitly switched away.
    await git(repo,['switch','-c','user-working']);await writeFile(join(repo,'uncommitted'),'keep');
    const result=await cmd('merge',{message:'squash'});expect(result).toHaveProperty('headSha');
    expect((await git(repo,['rev-list','--count',`${w.baseSha}..main`])).trim()).toBe('1');
    expect((await git(repo,['show','main:file.txt'])).trim()).toBe('one');expect(await readFile(join(repo,'file.txt'),'utf8')).toBe('base\n');
    expect(await readFile(join(repo,'uncommitted'),'utf8')).toBe('keep');
});
it('refuses squash merge while the base is checked out and leaves conflicts off the base branch',async()=>{
    const {w,cmd,repo}=await setup();await writeFile(join(w.cwd,'file.txt'),'session');await cmd('commit',{message:'session'});
    await expect(cmd('merge')).rejects.toThrow('base_branch_checked_out_use_pr');
    await writeFile(join(repo,'file.txt'),'base changed');await git(repo,['add','.']);await git(repo,['-c','user.name=T','-c','user.email=t@t','commit','-m','base change']);
    const old=(await git(repo,['rev-parse','main'])).trim();await git(repo,['switch','-c','user-working']);
    await expect(cmd('merge')).rejects.toThrow();expect((await git(repo,['rev-parse','main'])).trim()).toBe(old);
    expect((await git(repo,['worktree','list','--porcelain']))).not.toContain('merge-');
});
it('refuses path traversal, git internals, directories, symlinks and foreign checkpoints',async()=>{
    const {w,cmd}=await setup();
    for(const path of ['../file.txt','/absolute','C:/repo','a\\b','.git/config','a/../file','./file','file.txt\0x','.. /outside','git~1/config','.git~1/config']) await expect(safeReviewPath(w,path)).rejects.toThrow('unsafe_path');
    await mkdir(join(w.cwd,'dir'));await writeFile(join(w.cwd,'dir','keep'),'keep');await expect(cmd('discard',{path:'dir'})).rejects.toThrow('unsafe_path');
    await symlink(dirnameSafe(w.cwd),join(w.cwd,'linked'),'junction');await expect(safeReviewPath(w,'linked/outside')).rejects.toThrow('unsafe_path');
    await writeFile(join(w.cwd,'.gitignore'),'.env\n');await writeFile(join(w.cwd,'.env'),'keep secret');
    await expect(cmd('discard',{path:'.env'})).rejects.toThrow('file_not_in_diff');expect(await readFile(join(w.cwd,'.env'),'utf8')).toBe('keep secret');
    await expect(cmd('restore',{checkpoint:{sha:w.baseSha,ref:`refs/agora/checkpoints/${id(88)}/1`}})).rejects.toThrow('invalid_checkpoint');
});
function dirnameSafe(path:string) { return join(path,'..'); }
it('refuses changed branches and profile/workdir mappings',async()=>{
    const {w,cmd,local}=await setup();local.workdirAlias='moved';await expect(cmd('diff')).rejects.toThrow('workspace_mapping_changed');
    local.workdirAlias='agora';await git(w.cwd,['switch','-c','unexpected']);await expect(cmd('diff')).rejects.toThrow('unsafe_workspace_reuse');
});
it('pushes only the session branch without force and calls gh with explicit base/head',async()=>{
    const {w,cmd,repo,local}=await setup();await writeFile(join(w.cwd,'file.txt'),'pr');await cmd('commit',{message:'pr'});
    const remote=join(local.stateDir,'remote.git');await git(repo,['init','--bare',remote]);await git(repo,['remote','add','origin',remote]);
    const gh=vi.fn(async()=> 'https://github.com/example/repo/pull/1\n');
    const result=await executeReview(local,{id:id(11),claimToken:'token',sessionId:w.sessionId,profile:'builder',workdirAlias:'agora',action:'pr',payload:{message:'--web Phone PR\u0007\nsecond line'}},gh);
    expect(result).toMatchObject({url:'https://github.com/example/repo/pull/1'});
    // Title is one line, control characters stripped, attached with '=' so it can't become a flag
    expect(gh).toHaveBeenCalledWith(w.cwd,['pr','create','--base=main',`--head=${w.branch}`,'--title=--web Phone PR',`--body=Agora session ${w.sessionId}`]);
    expect((await git(repo,['ls-remote','origin'])).trim()).toContain(`refs/heads/${w.branch}`);
    expect((await git(repo,['ls-remote','origin','refs/heads/main'])).trim()).toBe('');
});
it('reads the session branch PR for its task card, even with uncommitted changes, and only keeps https links',async()=>{
    const {w,local}=await setup();await writeFile(join(w.cwd,'file.txt'),'uncommitted');
    const status=(gh:(cwd:string,args:string[])=>Promise<string>)=>executeReview(local,{id:id(12),claimToken:'token',sessionId:w.sessionId,profile:'builder',workdirAlias:'agora',action:'pr_status',payload:{}},gh);
    const gh=vi.fn(async()=>JSON.stringify({url:'https://github.com/example/repo/pull/2',state:'OPEN',isDraft:true}));
    expect(await status(gh)).toEqual({prState:'draft',url:'https://github.com/example/repo/pull/2',message:'Pull request is draft'});
    // The branch is passed as the positional argument; nothing from the phone reaches gh
    expect(gh).toHaveBeenCalledWith(w.cwd,['pr','view',w.branch,'--json','url,state,isDraft']);
    expect(await status(async()=>JSON.stringify({url:'javascript:alert(1)',state:'MERGED'}))).toEqual({prState:'merged',message:'Pull request is merged'});
    await expect(status(async()=>{throw Object.assign(new Error('exit 1'),{stderr:'no pull requests found for branch "x"'});})).rejects.toThrow('no_pull_request');
    await expect(status(async()=>{throw Object.assign(new Error('exit 1'),{stderr:'HTTP 401: Bad credentials /home/me/.config'});})).rejects.toThrow('pr_status_failed');
    await expect(status(async()=>JSON.stringify({state:'WEIRD'}))).rejects.toThrow('pr_status_failed');
});
it.each([true,false])('scheduler checkpoints changed files before reporting a run (success=%s)',async(success)=>{
    const {c,w,delivery}=await setup();
    const api={claim:vi.fn(),heartbeat:vi.fn(),complete:vi.fn(),fail:vi.fn()};
    const scheduler=new Scheduler(c,api,{start:()=>({result:(async()=>{await writeFile(join(w.cwd,'file.txt'),'run change');return{success,nativeSessionId:null,tokensUsed:0,summary:null};})(),kill:async()=>{}})});
    await scheduler.submit(delivery,performance.now());
    const report=success?api.complete:api.fail;expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0][1].checkpoint).toEqual({sha:expect.stringMatching(/^[0-9a-f]{40}$/),ref:`refs/agora/checkpoints/${w.sessionId}/1`});
});
it('retains a clean checkpointed workspace and warns when the ended workspace remains dirty',async()=>{
    const {c,w,cmd,local}=await setup();const before=await snapshotTree(w);await writeFile(join(w.cwd,'file.txt'),'checkpoint');await checkpoint(w,id(20),before);
    const api={claim:vi.fn(),heartbeat:vi.fn(),complete:vi.fn(),fail:vi.fn(),workspaceStates:vi.fn(async()=>[w.sessionId]),workspaceWarning:vi.fn()};
    await reconcileWorkspaces(c,api,new Set(),()=>{});expect(api.workspaceWarning).toHaveBeenCalledOnce();
    await cmd('commit',{message:'checkpoint content'});await reconcileWorkspaces(c,api,new Set(),()=>{});
    expect(await readFile(join(local.stateDir,`wt-${w.sessionId.slice(-10)}.json`),'utf8')).toContain(w.sessionId);
    expect(await readFile(join(w.cwd,'file.txt'),'utf8')).toBe('checkpoint');
});
