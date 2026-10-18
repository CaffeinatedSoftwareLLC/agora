import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureWorkspace, git, reconcileWorkspaces, samePath, workspaceHead } from '../src/workspaces.js';
import { prepare } from '../src/adapters.js';
import { Scheduler } from '../src/scheduler.js';
import { claim, config, tempDir, id, successful } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
    const t = await tempDir(); cleanups.push(t.cleanup);
    const repo = join(t.dir, 'repo with spaces'); await mkdir(repo);
    await git(repo, ['init']);
    await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture']);
    const c = config(t.dir); c.profiles.builder.workdir = repo;
    const delivery = claim();
    const api = { claim: vi.fn(), heartbeat: vi.fn(), complete: vi.fn(), fail: vi.fn(),
        workspaceStates: vi.fn(async () => [delivery.session.id]), workspaceWarning: vi.fn(async () => {}) };
    return { c, delivery, local: c.profiles.builder, api };
}
it('reuses the session on wake, native resume and host restart, preserving original base and dirty files', async () => {
    const s = await setup();
    const first = await prepare(s.c, s.delivery); cleanups.push(first.cleanup);
    expect(first.cwd).toBe(join(s.local.stateDir, `wt-${s.delivery.session.id.slice(-10)}`));
    await writeFile(join(first.cwd, 'uncommitted.txt'), 'keep');
    await git(s.local.workdir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'new HEAD']);
    s.delivery.session.nativeSessionId = '12345678-1234-1234-1234-123456789abc';
    const restarted = JSON.parse(JSON.stringify(s.c));
    const second = await prepare(restarted, s.delivery); cleanups.push(second.cleanup);
    expect(second.args).toContain('resume'); expect(second.cwd).toBe(first.cwd);
    expect(second.workspace?.baseSha).toBe(first.workspace?.baseSha);
    expect(await readFile(join(second.cwd, 'uncommitted.txt'), 'utf8')).toBe('keep');
    s.c.profiles.builder.adapter = 'claude'; s.delivery.profile.adapter = 'claude';
    const claude = await prepare(s.c, s.delivery); cleanups.push(claude.cleanup);
    expect(claude.args).toContain('--resume'); expect(claude.cwd).toBe(first.cwd);
});
it('refuses a directory inside a parent checkout, a foreign repo, and a wrong branch without resetting it', async () => {
    const s = await setup(), w = await ensureWorkspace(s.local, s.delivery);
    await git(s.local.workdir, ['worktree', 'remove', w.cwd]);
    await mkdir(w.cwd);
    await expect(ensureWorkspace(s.local, s.delivery)).rejects.toThrow();
    await git(w.cwd, ['init']);
    await git(w.cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'foreign']);
    await expect(ensureWorkspace(s.local, s.delivery)).rejects.toThrow('unsafe_workspace_reuse');
    // A second session proves a valid linked worktree on a wrong branch is also rejected.
    s.delivery.session.id = id(99);
    const other = await ensureWorkspace(s.local, s.delivery);
    await git(other.cwd, ['checkout', '-b', 'human-branch']);
    await expect(ensureWorkspace(s.local, s.delivery)).rejects.toThrow('unsafe_workspace_reuse');
    expect((await git(other.cwd, ['branch', '--show-current'])).trim()).toBe('human-branch');
});
it('reconciles idle ended sessions after restart, removes clean trees and retains branches ahead of base', async () => {
    const s = await setup(), w = await ensureWorkspace(s.local, s.delivery);
    await git(w.cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'agent commit']);
    const head = await workspaceHead(w); expect(head.headSha).not.toBe(head.baseSha);
    await reconcileWorkspaces(s.c, s.api, new Set(), vi.fn());
    await expect(stat(w.cwd)).rejects.toThrow();
    expect((await git(s.local.workdir, ['rev-parse', w.branch])).trim()).toBe(head.headSha);
});
it('keeps dirty trees, posts filenames once, retries failed warnings and skips active or live/shelved sessions', async () => {
    const s = await setup(), w = await ensureWorkspace(s.local, s.delivery), log = vi.fn();
    await writeFile(join(w.cwd, 'new file.txt'), 'keep');
    await reconcileWorkspaces(s.c, s.api, new Set([w.sessionId]), log);
    expect(s.api.workspaceStates).not.toHaveBeenCalled();
    s.api.workspaceStates.mockResolvedValueOnce([]);
    await reconcileWorkspaces(s.c, s.api, new Set(), log); expect(s.api.workspaceWarning).not.toHaveBeenCalled();
    s.api.workspaceWarning.mockRejectedValueOnce(new Error('offline'));
    await reconcileWorkspaces(s.c, s.api, new Set(), log);
    await reconcileWorkspaces(s.c, s.api, new Set(), log);
    await reconcileWorkspaces(s.c, s.api, new Set(), log);
    expect(s.api.workspaceWarning).toHaveBeenCalledTimes(2);
    expect(s.api.workspaceWarning).toHaveBeenLastCalledWith(w.sessionId, ['new file.txt']);
    expect(await readFile(join(w.cwd, 'new file.txt'), 'utf8')).toBe('keep');
});
it('normalizes Windows drive, case, separators and UNC roots without equating a child with its parent', () => {
    expect(samePath('C:\\Repo\\WT', 'c:/repo/wt/', 'win32')).toBe(true);
    expect(samePath('\\\\server\\share\\Repo', '//SERVER/share/repo', 'win32')).toBe(true);
    expect(samePath('C:\\Repo', 'C:\\Repo\\child', 'win32')).toBe(false);
});
it('checks out tracked files beyond Windows MAX_PATH using execFile and longpaths', async () => {
    const s = await setup();
    const folder = 'long-path-'.repeat(16);
    await mkdir(join(s.local.workdir, folder));
    await writeFile(join(s.local.workdir, folder, 'file.txt'), 'long path');
    await git(s.local.workdir, ['add', `${folder}/file.txt`]);
    await git(s.local.workdir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'long path fixture']);
    const w = await ensureWorkspace(s.local, s.delivery);
    expect(join(w.cwd, folder, 'file.txt').length).toBeGreaterThan(260);
    expect(await readFile(join(w.cwd, folder, 'file.txt'), 'utf8')).toBe('long path');
    expect((await workspaceHead(w)).branch).toBe(`agora/builder/${s.delivery.session.id}`);
});
it('scheduler completion reports the workspace branch, original base and current HEAD', async () => {
    const s = await setup();
    const scheduler = new Scheduler(s.c, s.api, { start: () => ({ result: Promise.resolve(successful), kill: async () => {} }) });
    await scheduler.submit(s.delivery, performance.now());
    const w = await ensureWorkspace(s.local, s.delivery);
    expect(s.api.complete).toHaveBeenCalledWith(s.delivery, expect.objectContaining(await workspaceHead(w)), expect.anything());
});
it('recovers a missing tree from its recorded branch without resetting commits or guessing a missing base', async () => {
    const s = await setup(), w = await ensureWorkspace(s.local, s.delivery);
    await git(w.cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'keep commit']);
    const head = await workspaceHead(w);
    await git(s.local.workdir, ['worktree', 'remove', w.cwd]);
    const recovered = await ensureWorkspace(s.local, s.delivery);
    expect(await workspaceHead(recovered)).toEqual(head);
    s.delivery.session.id = id(100);
    const branch = `agora/builder/${s.delivery.session.id}`;
    await git(s.local.workdir, ['branch', branch]);
    await expect(ensureWorkspace(s.local, s.delivery)).rejects.toThrow('workspace_branch_without_metadata');
    expect((await git(s.local.workdir, ['rev-parse', branch])).trim()).toBe(w.baseSha);
});
