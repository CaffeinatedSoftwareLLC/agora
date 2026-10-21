import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
export interface GitOwner { pid: number; nonce: string; argv0: string; at: string }
interface GitWorkspace { cwd: string; gitDir: string; record: string; log: (code: string) => void }
const workspaces = new Map<string, GitWorkspace>();
const queues = new Map<string, Promise<void>>();
const key = (cwd: string) => process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd);

export class GitLockError extends Error {
    constructor(public readonly detail: string) { super('stale_git_lock'); }
}

/** Only recovery needs an OS probe. A reused PID cannot accidentally have this random nonce. */
export async function gitOwnerAlive(owner: GitOwner): Promise<boolean> {
    const { pid, nonce } = owner;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid_git_owner_pid');
    if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error('invalid_git_owner_nonce');
    try { process.kill(pid, 0); } catch (e: any) {
        if (e.code === 'ESRCH') return false;
        throw e;
    }
    if (process.platform === 'win32') {
        const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const script = `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -eq $p) { 'null' } else { @{ commandLine = $p.CommandLine } | ConvertTo-Json -Compress }`;
        const r = await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 4096 });
        const value = JSON.parse(r.stdout.trim());
        if (value === null) return false;
        if (typeof value?.commandLine !== 'string' || !value.commandLine) throw new Error('git_owner_identity_unavailable');
        return new RegExp(`(?:^|[\\s"'])${nonce}(?:$|[\\s"'])`).test(value.commandLine);
    }
    if (process.platform === 'linux') {
        try {
            const command = await readFile(`/proc/${pid}/cmdline`, 'utf8');
            if (!command) throw new Error('git_owner_identity_unavailable');
            return command.split('\0').includes(nonce);
        } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; }
    }
    const r = await exec('ps', ['-ww', '-p', String(pid), '-o', 'command='], { timeout: 10000, maxBuffer: 16384,
        env: { ...process.env, LC_ALL: 'C' } }).catch((e: any) => { if (e.code === 1) return { stdout: '' }; throw e; });
    if (!r.stdout.trim()) return false;
    return new RegExp(`(?:^|[\\s"'])${nonce}(?:$|[\\s"'])`).test(r.stdout);
}

export function registerGitWorkspace(cwd: string, gitDir: string, record: string, log?: (code: string) => void) {
    workspaces.set(key(cwd), { cwd, gitDir, record, log: log ?? workspaces.get(key(cwd))?.log ?? (code => console.error(code)) });
}

async function statOrNull(path: string) {
    try { return await lstat(path, { bigint: true }); } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
}
async function ownerOf(w: GitWorkspace): Promise<GitOwner | null> {
    const stat = await statOrNull(w.record);
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192n) throw new GitLockError('Git ownership record is not a small regular file; locks retained.');
    let o: GitOwner;
    try { o = JSON.parse(await readFile(w.record, 'utf8')); }
    catch { throw new GitLockError('Git ownership record is invalid; locks retained.'); }
    if (!o || typeof o !== 'object' || !Number.isSafeInteger(o.pid) || o.pid <= 0 || typeof o.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(o.nonce)
        || o.argv0 !== process.execPath || typeof o.at !== 'string' || !Number.isFinite(Date.parse(o.at)))
        throw new GitLockError('Git ownership record is invalid; locks retained.');
    return o;
}

/** Only the linked worktree's private index/HEAD locks, never common refs or a human's lock. */
export async function recoverGitLocks(cwd: string, ownerAlive = gitOwnerAlive): Promise<void> {
    const w = workspaces.get(key(cwd));
    if (!w) return;
    const locks = [];
    for (const name of ['index.lock', 'HEAD.lock']) {
        const path = join(w.gitDir, name), stat = await statOrNull(path);
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
            throw new GitLockError(`${path}: not a regular, singly linked Git lock; retained.`);
        locks.push({ path, stat });
    }
    if (!locks.length) return;
    const owner = await ownerOf(w);
    if (!owner) throw new GitLockError(`${locks[0].path}: no host ownership record; retained for the owner to check.`);
    let alive: boolean;
    try { alive = await ownerAlive(owner); }
    catch { throw new GitLockError(`${locks[0].path}: cannot confirm the recorded Git process exited; retained.`); }
    if (alive) throw new GitLockError(`${locks[0].path}: git still running; retained.`);
    for (const lock of locks) {
        const now = await statOrNull(lock.path);
        if (!now) continue;
        if (!now.isFile() || now.isSymbolicLink() || now.nlink !== 1n || now.dev !== lock.stat.dev || now.ino !== lock.stat.ino
            || now.ctimeNs !== lock.stat.ctimeNs || now.size !== lock.stat.size)
            throw new GitLockError(`${lock.path}: Git lock changed during recovery; retained.`);
        await unlink(lock.path);
        w.log('workspace_git_lock_cleared');
    }
}

// The owner process waits for the durable PID/nonce record BEFORE it starts Git.
// If the host dies alone, this process remains alive until Git and its pipes have closed;
// a restarted host therefore cannot mistake a surviving writer for a stale lock.
const GATE = `
const { spawn } = require('node:child_process');
let git, started = false;
let out = true, err = true;
process.stdout.on('error', () => { out = false; });
process.stderr.on('error', () => { err = false; });
const forward = (stream, enabled, chunk) => { if (enabled) { try { stream.write(chunk); } catch {} } };
const flush = (stream, enabled, next) => { if (enabled && !stream.destroyed) stream.write('', next); else next(); };
process.on('message', m => {
  if (m.cancel) { if (git) git.kill('SIGTERM'); else process.exit(1); return; }
  if (started) return; started = true;
  git = spawn('git', m.args, { cwd: m.cwd, env: process.env, shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  // Keep draining if the host died and its pipes closed; EPIPE must not orphan Git.
  git.stdout.on('data', chunk => forward(process.stdout, out, chunk));
  git.stderr.on('data', chunk => forward(process.stderr, err, chunk));
  git.on('error', () => process.exit(1));
  git.on('close', code => flush(process.stdout, out, () => flush(process.stderr, err, () => process.exit(code === null ? 1 : code))));
});
process.on('disconnect', () => { if (!started) process.exit(1); });
process.on('SIGTERM', () => { if (git) git.kill('SIGTERM'); else process.exit(1); });
`;

export interface GitExecOptions { signal?: AbortSignal; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv }
async function waitForSlot(previous: Promise<void>, signal: AbortSignal | undefined, timeout: number) {
    if (signal?.aborted) throw new Error('Git operation aborted');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    try {
        await new Promise<void>((resolve, reject) => {
            abort = () => reject(new Error('Git operation aborted while queued'));
            signal?.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => reject(new Error('Git operation timed out while queued')), timeout);
            previous.then(resolve, reject);
        });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Same string output/exit-code contract as execFile, with durable ownership for session Git. */
export async function executeGit(cwd: string, args: string[], options: GitExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
    const w = workspaces.get(key(cwd));
    const env = options.env ?? { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (!w) return exec('git', args, { cwd, env, windowsHide: true, timeout: options.timeout ?? 60000,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024, signal: options.signal });
    const k = key(cwd), previous = queues.get(k) ?? Promise.resolve(), began = Date.now();
    let release!: () => void;
    const slot = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => slot);
    queues.set(k, tail);
    void tail.then(() => { if (queues.get(k) === tail) queues.delete(k); });
    try {
        const budget = options.timeout ?? 60000;
        await waitForSlot(previous, options.signal, budget);
        const left = budget - (Date.now() - began);
        if (left <= 0) throw new Error('Git operation timed out while queued');
        return await executeOwnedGit(w, args, { ...options, timeout: left }, env);
    } finally { release(); }
}

async function executeOwnedGit(w: GitWorkspace, args: string[], options: GitExecOptions, env: NodeJS.ProcessEnv) {
    const cwd = w.cwd;
    let child: ReturnType<typeof spawn> | undefined;
    let owner: GitOwner | undefined, closed = false, started = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    let result: Promise<{ stdout: string; stderr: string }> | undefined;
    let onAbort = () => {};
    try {
        await recoverGitLocks(cwd);
        const previous = await ownerOf(w);
        if (previous && await gitOwnerAlive(previous))
            throw new GitLockError('Recorded Git process is still running in this worktree.');
        if (options.signal?.aborted) throw new Error('Git operation aborted');
        const nonce = randomUUID().replace(/-/g, '');
        child = spawn(process.execPath, ['-e', GATE, nonce], { cwd, env, windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        let stdout = '', stderr = '', bytes = 0;
        let failure: Error | undefined;
        let rejectResult!: (error: Error) => void;
        result = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            rejectResult = reject;
            child!.on('error', reject);
            child!.on('close', code => {
                closed = true;
                if (failure || code !== 0) reject(Object.assign(failure ?? new Error('Git command failed'), { code: code ?? 1, stdout, stderr }));
                else resolve({ stdout, stderr });
            });
        });
        // Setup can fail before we await the process result; always attach a rejection handler.
        void result.catch(() => {});
        const cancel = () => {
            if (cancelTimer) return;
            failure ??= new Error('Git operation aborted or timed out');
            if (closed || !child?.pid) return;
            // If the tree cannot close, leave its owner alive and its record intact.
            // Never kill only the owner and then classify a surviving Git writer as dead.
            cancelTimer = setTimeout(() => rejectResult(new Error('process_tree_kill_failed')), 5000);
            if (process.platform === 'win32') {
                const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
                void exec(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(() => {});
            } else if (child.connected) child.send({ cancel: true });
        };
        onAbort = cancel;
        options.signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(cancel, options.timeout ?? 60000);
        child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
        const collect = (which: 'stdout' | 'stderr', chunk: string) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > (options.maxBuffer ?? 4 * 1024 * 1024)) { cancel(); return; }
            if (which === 'stdout') stdout += chunk; else stderr += chunk;
        };
        child.stdout!.on('data', chunk => collect('stdout', chunk)); child.stderr!.on('data', chunk => collect('stderr', chunk));
        if (!child.pid) throw new Error('git_owner_process_failed');
        if (closed || options.signal?.aborted) throw new Error('Git operation aborted');
        owner = { pid: child.pid, nonce, argv0: process.execPath, at: new Date().toISOString() };
        const temp = `${w.record}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
        await rename(temp, w.record);
        if (closed || options.signal?.aborted || failure) throw new Error('Git operation aborted');
        started = true;
        child.send({ args, cwd });
        return await result;
    } finally {
        clearTimeout(timer); clearTimeout(cancelTimer); options.signal?.removeEventListener('abort', onAbort);
        if (child && !closed && !started) {
            child.kill(); // gate never received permission to launch Git
            await result?.catch(() => {});
        }
        // Keep ownership evidence if a lock survived, or if the owner is still alive.
        if (owner && closed && !await statOrNull(join(w.gitDir, 'index.lock')) && !await statOrNull(join(w.gitDir, 'HEAD.lock'))) {
            const current = await ownerOf(w);
            if (current?.pid === owner.pid && current.nonce === owner.nonce) await unlink(w.record);
        }
    }
}
