import { spawn, execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import type { LocalProfile } from './config.js';
import { osEnv } from './adapters.js';

/**
 * Verify before yield (docs/project-context.md). The server owner sets a command for a
 * channel; after a run that changed files the host runs it in the session worktree and, on
 * failure, gives the agent the output as a follow-up turn (scheduler.ts), up to the
 * channel's retry limit. The result is posted in the channel.
 *
 * The server only names the command. The host runs it only when the profile's own config
 * lists that exact command (`verify.commands`), so a server can never make a host run
 * something its owner didn't write down locally. No shell: the command is split on single
 * spaces and the first word is the executable. The child gets the OS variables only (no CLI
 * login directory, no API key) plus CI=1, so test runners don't wait for input.
 */

/** Same rule as the server's (src/lib/channel-projects.ts): plain words, single spaces. */
export const VERIFY_COMMAND = /^[A-Za-z0-9_./:@=+,-]+( [A-Za-z0-9_./:@=+,-]+)*$/;
/** Output kept while the command runs, and how much of its end goes to the agent and the channel. */
const KEEP = 64 * 1024;
export const AGENT_TAIL = 12_000;
export const NOTICE_TAIL = 4_000;

/** The command's argv, or null when this profile doesn't allow it. */
export function verifyArgv(local: LocalProfile, command: string): string[] | null {
    if (command.length > 300 || !VERIFY_COMMAND.test(command)) return null;
    if (!local.verify?.commands.includes(command)) return null;
    return command.split(' ');
}

export function verifyEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return { ...osEnv(source), CI: '1' };
}

/**
 * The executable's absolute path. A bare name is looked up only in the absolute PATH
 * entries, never in the worktree: Windows would otherwise try the current directory first,
 * so an agent could drop a `node.exe` into its worktree and have the host run it. A name
 * with a path separator is the owner's explicit choice and resolves against the worktree.
 */
export function resolveExecutable(name: string, cwd: string, env: NodeJS.ProcessEnv, platform = process.platform): string | null {
    const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
    if (isAbsolute(name)) return name;
    if (/[\\/]/.test(name)) return resolvePath(cwd, name);
    const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
    const exts = platform === 'win32' && !extname(name) ? ['.exe', '.com'] : [''];
    const root = resolvePath(cwd);
    for (const dir of pathVar.split(platform === 'win32' ? ';' : delimiter)) {
        if (!dir || !isAbsolute(dir) || resolvePath(dir) === root) continue;
        for (const ext of exts) if (isFile(join(dir, name + ext))) return join(dir, name + ext);
    }
    return null;
}

export interface VerifyOutcome { passed: boolean; exitCode: number | null; timedOut: boolean; spawnFailed: boolean; output: string }

/** How long to wait for the pipes to close after the tree was killed before giving up on them. */
const CLOSE_GRACE_MS = 1000;

/**
 * Kill a verify command's whole tree, whether or not its first process is still alive (#111
 * review): a script can exit after starting a descendant that keeps running and holds the
 * output pipes. On POSIX the command runs in its own process group, which outlives its
 * leader, so the group is killed. On Windows `taskkill /T` only finds a tree through a live
 * root, so the host also sweeps every process descended from the root's PID that started
 * after the command did (the start time guards against PID reuse). Rejects when it cannot
 * establish that the processes are gone.
 */
export async function killVerifyTree(pid: number, startedAt: number, platform = process.platform): Promise<void> {
    if (platform !== 'win32') {
        try { process.kill(-pid, 'SIGKILL'); } catch (e: any) { if (e?.code !== 'ESRCH') throw e; }
        return;
    }
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    await promisify(execFile)(join(system, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(() => {});
    // Only integers go into the script
    const script = [
        `$root=${Math.trunc(pid)}; $since=[DateTimeOffset]::FromUnixTimeMilliseconds(${Math.trunc(startedAt) - 1000}).UtcDateTime`,
        '$all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate)',
        '$kill=New-Object System.Collections.Generic.List[int]; $queue=New-Object System.Collections.Generic.Queue[int]; $queue.Enqueue($root)',
        'while($queue.Count){ $p=$queue.Dequeue(); foreach($c in $all){ $id=[int]$c.ProcessId',
        '  if($c.ParentProcessId -eq $p -and $id -ne $p -and $c.CreationDate -and $c.CreationDate.ToUniversalTime() -ge $since -and -not $kill.Contains($id)){ $kill.Add($id); $queue.Enqueue($id) } } }',
        'foreach($id in $kill){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }',
        'if($kill.Count){ Get-Process -Id $kill -ErrorAction SilentlyContinue | Wait-Process -Timeout 3 -ErrorAction SilentlyContinue',
        '  if(@(Get-Process -Id $kill -ErrorAction SilentlyContinue).Count){ exit 1 } }',
    ].join('\n');
    await promisify(execFile)(join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 20000 });
}

/**
 * Run the command in `cwd`. On timeout or abort the whole process tree is killed and the
 * outcome settles even if a descendant still holds the output pipes: they are destroyed after
 * a short grace. A stopped command never passes, and when the host cannot confirm the tree is
 * gone the output says so.
 */
export function runVerify(argv: string[], cwd: string, timeoutMs: number, signal: AbortSignal, env = verifyEnv(),
    deps: { killTree?: typeof killVerifyTree; spawn?: typeof spawn } = {}): Promise<VerifyOutcome> {
    const killTree = deps.killTree ?? killVerifyTree;
    return new Promise(resolve => {
        let output = ''; let timedOut = false; let settled = false; let stopping = false;
        // Declared before finish() can run, so an early return never hits a TDZ error
        let timer: ReturnType<typeof setTimeout> | undefined;
        let grace: ReturnType<typeof setTimeout> | undefined;
        let terminate = () => {};
        const stop = () => terminate();
        const finish = (o: Omit<VerifyOutcome, 'output' | 'timedOut'>) => {
            if (settled) return;
            settled = true; clearTimeout(timer); clearTimeout(grace); signal.removeEventListener('abort', stop);
            resolve({ ...o, passed: o.passed && !stopping, timedOut, output });
        };
        if (signal.aborted) { finish({ passed: false, exitCode: null, spawnFailed: false }); return; }
        const executable = resolveExecutable(argv[0], cwd, env);
        if (!executable) { finish({ passed: false, exitCode: null, spawnFailed: true }); return; }
        const startedAt = Date.now();
        const child = (deps.spawn ?? spawn)(executable, argv.slice(1), {
            cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        });
        const collect = (chunk: string) => { output += chunk; if (output.length > 2 * KEEP) output = output.slice(-KEEP); };
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        terminate = () => {
            if (settled || stopping) return;
            stopping = true;
            const done = (confirmed: boolean) => {
                if (settled) return;
                if (!confirmed) output += '\n[agora-host: could not confirm that every process of this command stopped]\n';
                // A descendant may still hold the pipes, so 'close' might never come
                grace = setTimeout(() => {
                    child.stdout.destroy(); child.stderr.destroy();
                    finish({ passed: false, exitCode: child.exitCode, spawnFailed: false });
                }, CLOSE_GRACE_MS);
            };
            if (!child.pid) { done(true); return; }
            killTree(child.pid, startedAt).then(() => done(true), () => { try { child.kill('SIGKILL'); } catch { /* gone */ } done(false); });
        };
        timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
        signal.addEventListener('abort', stop, { once: true });
        child.on('error', () => finish({ passed: false, exitCode: null, spawnFailed: true }));
        child.on('close', code => finish({ passed: code === 0 && !timedOut && !signal.aborted, exitCode: code, spawnFailed: false }));
    });
}
