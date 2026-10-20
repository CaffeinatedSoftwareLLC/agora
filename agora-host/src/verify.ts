import { spawn, execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
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
    const fold = (s: string) => (platform === 'win32' ? resolvePath(s).toLowerCase() : resolvePath(s));
    const root = fold(cwd);
    // Any entry inside the worktree (node_modules/.bin, a tools folder) is the agent's to write
    const inWorktree = (dir: string) => { const rel = relative(root, fold(dir)); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
    for (const dir of pathVar.split(platform === 'win32' ? ';' : delimiter)) {
        if (!dir || !isAbsolute(dir) || inWorktree(dir)) continue;
        for (const ext of exts) if (isFile(join(dir, name + ext))) return join(dir, name + ext);
    }
    return null;
}

export interface VerifyOutcome { passed: boolean; exitCode: number | null; timedOut: boolean; spawnFailed: boolean; output: string }

/** How long to wait for the pipes to close after the tree was killed before giving up on them. */
const CLOSE_GRACE_MS = 1000;
/** How long the tree may take to disappear after the kill before the host reports it could not confirm it. */
const KILL_CONFIRM_MS = 5000;
/** Exit code and stderr marker of the Windows job wrapper when it could not contain the command. */
export const JOB_FAILED_EXIT = 250;
export const JOB_FAILED_MARKER = 'agora-host: could not create a job object';

/**
 * Windows lifetime containment (#111 recheck). A one-time look at the live processes cannot find
 * a grandchild whose parents already exited, so the command runs inside a Job Object instead:
 * a small PowerShell wrapper creates a job with KILL_ON_JOB_CLOSE, puts itself in it, then starts
 * the command, so every process the command ever starts is in the job before it exists (no
 * breakaway allowed). When the wrapper exits, normally or killed, the job's last handle closes
 * and Windows kills everything still in it. The wrapper refuses to start the command when the
 * job can't be set up (exit JOB_FAILED_EXIT with JOB_FAILED_MARKER), so containment fails closed.
 * No native dependency: the job calls are compiled by PowerShell's Add-Type from the C# below.
 */
const JOB_SOURCE = `
using System; using System.Runtime.InteropServices;
public static class AgoraVerifyJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long A; public long B; public uint LimitFlags; public UIntPtr C; public UIntPtr D; public uint E; public UIntPtr F; public uint G; public uint H; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic BasicLimits; public Io IoInfo; public UIntPtr A, B, C, D; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static IntPtr held;
  public static bool Contain() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return false;
    Extended info = new Extended();
    info.BasicLimits.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway flags
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)))) return false;
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) return false;
    held = job; // never closed: the handle closes when this process exits, which kills the job
    return true;
  }
}`;

/** One argument for a Windows command line, quoted the way CommandLineToArgvW reads it back. */
export function quoteWindowsArg(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg;
  let out = '"', slashes = 0;
  for (const ch of arg) {
    if (ch === '\\') { slashes++; continue; }
    out += ch === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + ch;
    slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

/** The wrapper's argv: powershell.exe running the job script, which starts `executable args`. */
export function windowsJobArgv(executable: string, args: string[]): { file: string; args: string[] } {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const utf8 = (v: string) => `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${v}')))`;
  const script = [
    "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
    `try { Add-Type -TypeDefinition ${utf8(b64(JOB_SOURCE))}; $ok = [AgoraVerifyJob]::Contain() } catch { $ok = $false }`,
    `if (-not $ok) { [Console]::Error.WriteLine('${JOB_FAILED_MARKER}'); exit ${JOB_FAILED_EXIT} }`,
    '$psi = New-Object System.Diagnostics.ProcessStartInfo',
    `$psi.FileName = ${utf8(b64(executable))}`,
    `$psi.Arguments = ${utf8(b64(args.map(quoteWindowsArg).join(' ')))}`,
    '$psi.UseShellExecute = $false',
    '$psi.WorkingDirectory = (Get-Location).ProviderPath',
    '$p = [System.Diagnostics.Process]::Start($psi)',
    '$p.WaitForExit()',
    'exit $p.ExitCode',
  ].join('\n');
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  return {
    file: join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

/**
 * Kill a verify command's whole tree and confirm it is gone; rejects with
 * `process_tree_kill_failed` when it can't. POSIX: the command leads its own process group,
 * which outlives its leader, so the group is killed and polled until no member is left.
 * Windows: the command runs in the wrapper's Job Object, so killing the wrapper closes the job
 * and Windows kills every process in it; the wrapper's exit confirms that.
 */
export async function killVerifyTree(pid: number, exited: () => boolean, platform = process.platform): Promise<void> {
  const deadline = Date.now() + KILL_CONFIRM_MS;
  const wait = () => new Promise(r => setTimeout(r, 50));
  if (platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch (e: any) { if (e?.code !== 'ESRCH') throw new Error('process_tree_kill_failed'); }
    for (;;) {
      try { process.kill(-pid, 0); } catch (e: any) { if (e?.code === 'ESRCH') return; throw new Error('process_tree_kill_failed'); }
      if (Date.now() > deadline) throw new Error('process_tree_kill_failed');
      await wait();
    }
  }
  if (!exited()) {
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    await promisify(execFile)(join(system, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: KILL_CONFIRM_MS }).catch(() => {});
  }
  while (!exited()) {
    if (Date.now() > deadline) throw new Error('process_tree_kill_failed');
    await wait();
  }
}

export interface VerifyDeps {
  killTree?: (pid: number, exited: () => boolean) => Promise<void>;
  spawn?: typeof spawn;
  /** Run inside a Windows Job Object (default: on Windows). */
  windowsJob?: boolean;
}

/**
 * Run the command in `cwd`. On timeout or abort the whole process tree is killed, and the
 * outcome waits for that kill to be confirmed, even if the command's pipes close first. When a
 * descendant still holds the pipes after the kill, they are destroyed after a short grace. A
 * stopped command never passes. When the host cannot confirm the tree is gone the promise
 * rejects with `process_tree_kill_failed`, which halts the host (scheduler.ts) rather than
 * starting a fix turn or reporting success.
 */
export function runVerify(argv: string[], cwd: string, timeoutMs: number, signal: AbortSignal, env = verifyEnv(),
  deps: VerifyDeps = {}): Promise<VerifyOutcome> {
  const killTree = deps.killTree ?? ((pid: number, exited: () => boolean) => killVerifyTree(pid, exited));
  return new Promise((resolve, reject) => {
    let output = ''; let timedOut = false; let settled = false;
    // Declared before finish() can run, so an early return never hits a TDZ error
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let killing: Promise<void> | null = null;
    let terminate = () => {};
    const stop = () => terminate();
    const cleanup = () => { settled = true; clearTimeout(timer); clearTimeout(grace); signal.removeEventListener('abort', stop); };
    const finish = (o: Omit<VerifyOutcome, 'output' | 'timedOut'>) => {
      if (settled) return;
      cleanup();
      resolve({ ...o, passed: o.passed && !killing, timedOut, output });
    };
    const fail = () => { if (settled) return; cleanup(); reject(new Error('process_tree_kill_failed')); };
    /** Settle only once any kill in progress is confirmed; a failed kill rejects. */
    const settle = (o: Omit<VerifyOutcome, 'output' | 'timedOut'>) => {
      if (!killing) { finish(o); return; }
      killing.then(() => finish(o), fail);
    };
    if (signal.aborted) { finish({ passed: false, exitCode: null, spawnFailed: false }); return; }
    const executable = resolveExecutable(argv[0], cwd, env);
    if (!executable) { finish({ passed: false, exitCode: null, spawnFailed: true }); return; }
    const job = deps.windowsJob ?? process.platform === 'win32';
    const launch = job ? windowsJobArgv(executable, argv.slice(1)) : { file: executable, args: argv.slice(1) };
    const child = (deps.spawn ?? spawn)(launch.file, launch.args, {
      cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let exited = false;
    child.on('exit', () => { exited = true; });
    const collect = (chunk: string) => { output += chunk; if (output.length > 2 * KEEP) output = output.slice(-KEEP); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    terminate = () => {
      if (settled || killing) return;
      killing = child.pid ? killTree(child.pid, () => exited || child.exitCode !== null || child.signalCode !== null) : Promise.resolve();
      killing.then(() => {
        // A descendant may still hold the pipes, so 'close' might never come
        grace = setTimeout(() => {
          child.stdout.destroy(); child.stderr.destroy();
          finish({ passed: false, exitCode: child.exitCode, spawnFailed: false });
        }, CLOSE_GRACE_MS);
      }, () => { try { child.kill('SIGKILL'); } catch { /* gone */ } fail(); });
    };
    timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    child.on('error', () => settle({ passed: false, exitCode: null, spawnFailed: true }));
    child.on('close', code => {
      // The wrapper could not contain the command, so it never started it
      if (job && code === JOB_FAILED_EXIT && output.includes(JOB_FAILED_MARKER)) { settle({ passed: false, exitCode: null, spawnFailed: true }); return; }
      settle({ passed: code === 0 && !timedOut && !signal.aborted, exitCode: code, spawnFailed: false });
    });
  });
}
