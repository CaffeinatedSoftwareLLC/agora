import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';
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

export interface VerifyOutcome { passed: boolean; exitCode: number | null; timedOut: boolean; spawnFailed: boolean; output: string }

/** Run the command in `cwd`; kill its whole process tree on timeout or abort. */
export function runVerify(argv: string[], cwd: string, timeoutMs: number, signal: AbortSignal, env = verifyEnv()): Promise<VerifyOutcome> {
    return new Promise(resolve => {
        let output = ''; let timedOut = false; let settled = false;
        const finish = (o: Omit<VerifyOutcome, 'output' | 'timedOut'>) => {
            if (settled) return;
            settled = true; clearTimeout(timer); signal.removeEventListener('abort', stop);
            resolve({ ...o, timedOut, output });
        };
        if (signal.aborted) { finish({ passed: false, exitCode: null, spawnFailed: false }); return; }
        const child = spawn(argv[0], argv.slice(1), {
            cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        });
        const collect = (chunk: string) => { output += chunk; if (output.length > 2 * KEEP) output = output.slice(-KEEP); };
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        const kill = () => {
            if (!child.pid || child.exitCode !== null) return;
            if (process.platform === 'win32') {
                promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
                    ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(() => child.kill('SIGKILL'));
            } else {
                try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
            }
        };
        const stop = () => kill();
        const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
        signal.addEventListener('abort', stop, { once: true });
        child.on('error', () => finish({ passed: false, exitCode: null, spawnFailed: true }));
        child.on('close', code => finish({ passed: code === 0 && !timedOut && !signal.aborted, exitCode: code, spawnFailed: false }));
    });
}
