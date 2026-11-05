import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, utimes, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_RECORD, describeError, ensureWorkspace, git, reconcileWorkspaces, samePath, workspaceHead } from '../src/workspaces.js';
import { prepare } from '../src/adapters.js';
import { setGitGateProbe } from '../src/git-owner.js';
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
it('reconciles a dirty ended tree whose ownership record was torn before this boot (host log, 2026-11-04)', async () => {
    const s = await setup(), w = await ensureWorkspace(s.local, s.delivery), log = vi.fn();
    setGitGateProbe(async () => []); cleanups.push(async () => setGitGateProbe()); // the live host may run gates meanwhile
    const record = join(s.local.stateDir, `wt-${w.sessionId.slice(-10)}.git-process.json`), past = new Date('2000-01-01T00:00:00Z');
    await writeFile(join(w.cwd, 'kept.txt'), 'keep');
    await writeFile(record, '\0'.repeat(134)); await utimes(record, past, past);
    await reconcileWorkspaces(s.c, s.api, new Set(), log);
    expect(log.mock.calls.flat().filter((l: string) => l.startsWith('workspace_reconcile_failed'))).toEqual([]);
    expect(log).toHaveBeenCalledWith('dirty_workspace_kept');
    expect(s.api.workspaceWarning).toHaveBeenCalledWith(w.sessionId, ['kept.txt']);
    expect(JSON.parse(await readFile(join(s.local.stateDir, `wt-${w.sessionId.slice(-10)}.json`), 'utf8')).warning).toBeTruthy();
});
it('skips a record that is not JSON with one warning until it changes, and never reads the ownership record', async () => {
    const s = await setup(), log = vi.fn();
    await mkdir(s.local.stateDir, { recursive: true });
    const bad = join(s.local.stateDir, `wt-${id(5).slice(-10)}.json`);
    await writeFile(bad, '\0'.repeat(134));
    await writeFile(join(s.local.stateDir, `wt-${id(6).slice(-10)}.git-process.json`), '\0'.repeat(134));
    for (let i = 0; i < 3; i++) await reconcileWorkspaces(s.c, s.api, new Set(), log);
    expect(log.mock.calls).toEqual([[expect.stringMatching(new RegExp(`^workspace_record_invalid wt-${id(5).slice(-10)}\\.json: .*worktree kept$`))]]);
    expect(s.api.workspaceStates).not.toHaveBeenCalled();
    await writeFile(bad, '{"truncated":'); await utimes(bad, new Date(), new Date(Date.now() + 5000));
    await reconcileWorkspaces(s.c, s.api, new Set(), log);
    expect(log).toHaveBeenCalledTimes(2);
    expect(await readFile(bad, 'utf8')).toBe('{"truncated":');
    expect(WORKSPACE_RECORD.test('wt-EGVD0BE2T6.git-process.json')).toBe(false);
    expect(WORKSPACE_RECORD.test('wt-EGVD0BE2T6.json')).toBe(true);
});
it('logs a reconcile failure once with record, step, code and message, never the token', async () => {
    const s = await setup(), w = await ensureWorkspace(s.local, s.delivery), log = vi.fn();
    const token = `ah_${id(7)}.${'0123456789abcdef'.repeat(4)}`;
    // fetch() reports the network error on cause; the token here stands in for any echo of the header.
    s.api.workspaceStates.mockRejectedValue(Object.assign(new TypeError(`fetch failed (Authorization: AgentHost ${token})`), { cause: { code: 'ECONNREFUSED' } }));
    for (let i = 0; i < 3; i++) await reconcileWorkspaces(s.c, s.api, new Set(), log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe(`workspace_reconcile_failed wt-${w.sessionId.slice(-10)}.json step=workspace_states message=fetch failed (Authorization: [redacted]) cause=ECONNREFUSED`);
    s.api.workspaceStates.mockResolvedValueOnce([]);
    await reconcileWorkspaces(s.c, s.api, new Set(), log);
    await reconcileWorkspaces(s.c, s.api, new Set(), log);
    expect(log).toHaveBeenCalledTimes(2); // logged again after a success
    expect(log.mock.calls.flat().join('\n')).not.toContain(token);
});
it('describes errors without tokens or credentials but keeps SHAs and paths', () => {
    const sha = 'a'.repeat(40), path = 'C:\\Users\\someone\\.codex\\wt-EGVD0BE2T6\\some\\deeper\\folder';
    const text = describeError(Object.assign(new Error(`bad ${sha} at ${path} https://user:pass@example.com/x token=hunter2 Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNb`),
        { code: 128, stderr: 'fatal: Bearer s3cr3t-value\nsecond line', detail: 'lock' }));
    expect(text).toContain(sha); expect(text).toContain(path);
    expect(text).toMatch(/^code=128 message=bad /); expect(text).toContain('detail=lock');
    for (const secret of ['user:pass', 'hunter2', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNb', 's3cr3t-value', 'second line']) expect(text).not.toContain(secret);
    const host = describeError(new Error(`Authorization: Basic dXNlcjpwYXNz; AgentHost ah_short access_token=abc refresh_token: "xyz"`));
    for (const secret of ['dXNlcjpwYXNz', 'ah_short', 'abc', 'xyz']) expect(host).not.toContain(secret);
    const long = 'C:\\repo\\test\\integration\\agent-host-lifecycle.integration.test.ts';
    expect(describeError(new Error(`cannot read ${long}`))).toContain(long);
    expect(describeError(new Error(`at C:\\tmp\\${'Ab1'.repeat(12)}\\x`))).toBe('message=at C:\\tmp\\[redacted]\\x');
    const zod = Object.assign(new Error('[\n  {\n    "code": "invalid_type"'), { issues: [{ code: 'invalid_type', path: [0] }] });
    expect(describeError(zod)).toBe('message=invalid response: invalid_type at 0');
});
it('normalizes Windows drive, case, separators and UNC roots without equating a child with its parent', () => {
    expect(samePath('C:\\Repo\\WT', 'c:/repo/wt/', 'win32')).toBe(true);
    expect(samePath('\\\\server\\share\\Repo', '//SERVER/share/repo', 'win32')).toBe(true);
    expect(samePath('C:\\Repo', 'C:\\Repo\\child', 'win32')).toBe(false);
});
it.skipIf(process.platform !== 'win32')('checks out tracked files beyond Windows MAX_PATH using execFile and longpaths', async () => {
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
