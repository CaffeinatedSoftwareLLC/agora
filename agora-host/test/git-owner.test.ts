import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, symlink, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { GitLockError, gitOwnerAlive, recoverGitLocks, registerGitWorkspace, type GitOwner } from '../src/git-owner.js';
import { ensureWorkspace, git, recoverWorkspaceGitLocks, withGitSignal } from '../src/workspaces.js';
import { executeReview } from '../src/review.js';
import { claim, config, id, tempDir } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const deadOwner: GitOwner = { pid: 2147483647, nonce: randomUUID().replace(/-/g, ''), argv0: process.execPath, at: new Date().toISOString() };

async function fixture() {
    const t = await tempDir(); cleanups.push(t.cleanup);
    const repo = join(t.dir, 'repo'); await mkdir(repo);
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'base']);
    const c = config(t.dir), delivery = claim(), local = c.profiles.builder;
    local.workdir = repo;
    const w = await ensureWorkspace(local, delivery);
    const gitDir = (await git(w.cwd, ['rev-parse', '--absolute-git-dir'])).trim();
    const record = join(local.stateDir, `wt-${w.sessionId.slice(-10)}.git-process.json`);
    const log = vi.fn(); registerGitWorkspace(w.cwd, gitDir, record, log);
    return { t, c, delivery, local, w, gitDir, record, log };
}

it('recovers only private index/HEAD locks with a dead owner, leaving common locks alone', async () => {
    const s = await fixture();
    const locks = ['index.lock', 'HEAD.lock'].map(n => join(s.gitDir, n));
    for (const lock of locks) await writeFile(lock, 'owned');
    const common = join(s.w.commonDir, 'index.lock'); await writeFile(common, 'human main checkout');
    await writeFile(s.record, JSON.stringify(deadOwner));
    await recoverGitLocks(s.w.cwd);
    for (const lock of locks) await expect(stat(lock)).rejects.toThrow();
    expect(await readFile(common, 'utf8')).toBe('human main checkout');
    expect(s.log.mock.calls).toEqual([['workspace_git_lock_cleared'], ['workspace_git_lock_cleared']]);
});

it('keeps a lock owned by a live PID with the same command-line nonce', async () => {
    const s = await fixture(), lock = join(s.gitDir, 'index.lock');
    const nonce = randomUUID().replace(/-/g, '');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', nonce], { windowsHide: true, stdio: 'ignore' });
    const closed = once(child, 'close');
    try {
        await writeFile(lock, 'live');
        await writeFile(s.record, JSON.stringify({ ...deadOwner, pid: child.pid, nonce }));
        await expect(recoverGitLocks(s.w.cwd)).rejects.toMatchObject({ message: 'stale_git_lock', detail: expect.stringContaining('git still running') });
        expect(await readFile(lock, 'utf8')).toBe('live');
    } finally { child.kill(); await closed; }
});

it('recovers a dead ownership generation when the PID has been reused', async () => {
    const s = await fixture(), lock = join(s.gitDir, 'HEAD.lock');
    await writeFile(lock, 'old generation');
    await writeFile(s.record, JSON.stringify({ ...deadOwner, pid: process.pid }));
    await recoverGitLocks(s.w.cwd);
    await expect(stat(lock)).rejects.toThrow();
});

it('keeps unknown locks and gives the owner the lock path', async () => {
    const s = await fixture(), lock = join(s.gitDir, 'index.lock');
    await writeFile(lock, 'human');
    await expect(recoverGitLocks(s.w.cwd)).rejects.toMatchObject({ message: 'stale_git_lock', detail: expect.stringContaining(lock) });
    expect(await readFile(lock, 'utf8')).toBe('human');
});

it('refuses a symlink lock without touching its target', async () => {
    const s = await fixture(), target = join(s.t.dir, 'human-lock-directory');
    await mkdir(target); await writeFile(join(target, 'keep'), 'human');
    await symlink(target, join(s.gitDir, 'index.lock'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(s.record, JSON.stringify(deadOwner));
    await expect(recoverGitLocks(s.w.cwd)).rejects.toBeInstanceOf(GitLockError);
    expect(await readFile(join(target, 'keep'), 'utf8')).toBe('human');
});

it('keeps a lock when process identity cannot be checked, or the file changes during the check', async () => {
    const s = await fixture(), lock = join(s.gitDir, 'index.lock');
    await writeFile(lock, 'original'); await writeFile(s.record, JSON.stringify(deadOwner));
    await expect(recoverGitLocks(s.w.cwd, async () => { throw new Error('probe unavailable'); })).rejects.toThrow('stale_git_lock');
    await expect(recoverGitLocks(s.w.cwd, async () => { await writeFile(lock, 'new lock contents'); return false; })).rejects.toThrow('stale_git_lock');
    expect(await readFile(lock, 'utf8')).toBe('new lock contents');
});

it('startup recovery clears recorded stale locks and preserves an unknown lock', async () => {
    const s = await fixture(), lock = join(s.gitDir, 'index.lock');
    await writeFile(lock, 'dead'); await writeFile(s.record, JSON.stringify(deadOwner));
    await recoverWorkspaceGitLocks(s.c, s.log);
    await expect(stat(lock)).rejects.toThrow();
    // A successful host Git call removes its ownership record; the next lock is unknown.
    await git(s.w.cwd, ['rev-parse', 'HEAD']);
    await writeFile(lock, 'unknown');
    await recoverWorkspaceGitLocks(s.c, s.log);
    expect(await readFile(lock, 'utf8')).toBe('unknown');
    expect(s.log).toHaveBeenCalledWith('stale_git_lock');
});

it('a workspace commit recovers a recorded stale lock and commits without changing the main checkout', async () => {
    const s = await fixture(), lock = join(s.gitDir, 'index.lock');
    const head = (await git(s.local.workdir, ['rev-parse', 'HEAD'])).trim();
    await writeFile(join(s.w.cwd, 'changed.txt'), 'session change');
    await writeFile(lock, 'dead'); await writeFile(s.record, JSON.stringify(deadOwner));
    const result = await executeReview(s.local, { id: id(10), claimToken: 'fixture', sessionId: s.w.sessionId,
        profile: 'builder', workdirAlias: 'agora', action: 'commit', payload: { message: 'recovered' } });
    expect(result).toHaveProperty('headSha');
    expect((await git(s.local.workdir, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect(await readFile(join(s.w.cwd, 'changed.txt'), 'utf8')).toBe('session change');
    await expect(stat(lock)).rejects.toThrow();
    await expect(stat(s.record)).rejects.toThrow();
});

it('a workspace command refuses a human lock before spawning a new owned Git operation', async () => {
    const s = await fixture(), lock = join(s.gitDir, 'index.lock');
    await writeFile(join(s.w.cwd, 'keep.txt'), 'uncommitted');
    await writeFile(lock, 'human');
    await expect(executeReview(s.local, { id: id(10), claimToken: 'fixture', sessionId: s.w.sessionId,
        profile: 'builder', workdirAlias: 'agora', action: 'commit', payload: { message: 'must not run' } }))
        .rejects.toMatchObject({ message: 'stale_git_lock', detail: expect.stringContaining(lock) });
    expect(await readFile(lock, 'utf8')).toBe('human');
    expect(await readFile(join(s.w.cwd, 'keep.txt'), 'utf8')).toBe('uncommitted');
    await expect(stat(s.record)).rejects.toThrow();
});

it('records a live owner durably before Git can run a clean filter', async () => {
    const s = await fixture();
    const probe = join(s.t.dir, 'owner-probe.cjs'), observed = join(s.t.dir, 'observed.json');
    await writeFile(probe, `const fs = require('node:fs'); const o = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); process.kill(o.pid, 0); fs.writeFileSync(process.argv[3], JSON.stringify(o)); process.stdin.pipe(process.stdout);`);
    await writeFile(join(s.w.cwd, '.gitattributes'), 'owned.txt filter=owner-probe\n');
    await writeFile(join(s.w.cwd, 'owned.txt'), 'content');
    const quote = (p: string) => '"' + p.replace(/\\/g, '/') + '"';
    const command = [process.execPath, probe, s.record, observed].map(quote).join(' ');
    await git(s.w.cwd, ['-c', `filter.owner-probe.clean=${command}`, 'add', '-A']);
    expect(JSON.parse(await readFile(observed, 'utf8'))).toMatchObject({ argv0: process.execPath,
        nonce: expect.stringMatching(/^[0-9a-f]{32}$/), pid: expect.any(Number), at: expect.any(String) });
    await expect(stat(s.record)).rejects.toThrow();
});

it('an aborted Git operation retains ownership until its writer and pipes have closed', async () => {
    const s = await fixture(), probe = join(s.t.dir, 'slow-filter.cjs'), marker = join(s.t.dir, 'started');
    await writeFile(probe, `require('node:fs').writeFileSync(process.argv[2], 'started'); setTimeout(() => process.stdin.pipe(process.stdout), 1500);`);
    await writeFile(join(s.w.cwd, '.gitattributes'), 'slow.txt filter=slow-probe\n');
    await writeFile(join(s.w.cwd, 'slow.txt'), 'content');
    const quote = (p: string) => '"' + p.replace(/\\/g, '/') + '"';
    const command = [process.execPath, probe, marker].map(quote).join(' ');
    const abort = new AbortController();
    const result = withGitSignal(abort.signal, () => git(s.w.cwd, ['-c', `filter.slow-probe.clean=${command}`, 'add', '-A']))
        .then(() => null, err => err as Error);
    try {
        for (let i = 0; i < 250 && !await stat(marker).catch(() => null); i++) await new Promise(r => setTimeout(r, 20));
        expect(await readFile(marker, 'utf8')).toBe('started');
        const owner = JSON.parse(await readFile(s.record, 'utf8')) as GitOwner;
        abort.abort();
        expect(await result).toBeInstanceOf(Error);
        expect(await gitOwnerAlive(owner)).toBe(false);
        await recoverGitLocks(s.w.cwd);
        await expect(stat(join(s.gitDir, 'index.lock'))).rejects.toThrow();
    } finally { abort.abort(); await result; }
}, 15000);

it('queues overlapping Git commands, and cancelling a queued command does not let a later one overtake', async () => {
    const s = await fixture(), probe = join(s.t.dir, 'queue-filter.cjs'), marker = join(s.t.dir, 'queued-started');
    await writeFile(probe, `require('node:fs').writeFileSync(process.argv[2], 'started'); setTimeout(() => process.stdin.pipe(process.stdout), 500);`);
    await writeFile(join(s.w.cwd, '.gitattributes'), 'queued.txt filter=queue-probe\n');
    await writeFile(join(s.w.cwd, 'queued.txt'), 'content');
    const quote = (p: string) => '"' + p.replace(/\\/g, '/') + '"';
    const command = [process.execPath, probe, marker].map(quote).join(' ');
    let firstDone = false;
    const first = git(s.w.cwd, ['-c', `filter.queue-probe.clean=${command}`, 'add', '-A']).then(() => { firstDone = true; });
    for (let i = 0; i < 250 && !await stat(marker).catch(() => null); i++) await new Promise(r => setTimeout(r, 20));
    expect(await readFile(marker, 'utf8')).toBe('started');
    const abort = new AbortController();
    const cancelled = withGitSignal(abort.signal, () => git(s.w.cwd, ['rev-parse', 'HEAD'])).then(() => null, err => err as Error);
    abort.abort();
    const last = git(s.w.cwd, ['rev-parse', 'HEAD']).then(head => { expect(firstDone).toBe(true); return head; });
    expect(await cancelled).toBeInstanceOf(Error);
    await first;
    expect((await last).trim()).toMatch(/^[0-9a-f]{40}$/);
});
