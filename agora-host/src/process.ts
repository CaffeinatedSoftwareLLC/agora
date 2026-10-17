import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseOutput, type Launch } from './adapters.js';
import type { Result } from './types.js';

export interface RunningChild { result: Promise<Result>; kill(): Promise<void> }
export interface Runner { start(launch: Launch): RunningChild }
export class ProcessRunner implements Runner {
    start(launch: Launch): RunningChild {
        const child = spawn(launch.executable, launch.args, {
            cwd: launch.cwd, env: launch.env, shell: false, windowsHide: true,
            detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = ''; let size = 0; let closed = false; let overflow = false;
        let killed: Promise<void> | undefined;
        let notifyClose!: () => void;
        const closedEvent = new Promise<void>(resolve => { notifyClose = resolve; });
        const result = new Promise<Result>((resolve, reject) => {
            child.on('error', () => resolve({ success: false, nativeSessionId: null, summary: null, tokensUsed: null, error: 'spawn_failed' }));
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                size += Buffer.byteLength(chunk);
                if (size <= 8 * 1024 * 1024) stdout += chunk;
                else { overflow = true; void kill().catch(() => reject(new Error('process_tree_kill_failed'))); }
            });
            // Drain stderr, but never forward it: a CLI may echo secrets or user content.
            child.stderr.resume(); child.stdin.on('error', () => {});
            child.on('close', code => {
                closed = true; notifyClose();
                // A close caused by root-only fallback must not conceal failed tree termination.
                queueMicrotask(() => {
                    void (async () => {
                        try {
                            await killed;
                            resolve(overflow ? { success: false, nativeSessionId: null, summary: null, tokensUsed: null, error: 'output_limit' }
                                : parseOutput(launch.adapter, stdout, code));
                        } catch { reject(new Error('process_tree_kill_failed')); }
                        finally { stdout = ''; }
                    })();
                });
            });
        });
        const kill = (): Promise<void> => {
            if (closed || !child.pid) return Promise.resolve();
            if (killed) return killed;
            killed = (async () => {
                try {
                    if (process.platform === 'win32') {
                        await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
                            ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
                    } else process.kill(-child.pid!, 'SIGKILL');
                } catch {
                    if (!closed) {
                        child.kill('SIGKILL');
                        // Root-only kill cannot establish that its descendants are gone.
                        throw new Error('process_tree_kill_failed');
                    }
                }
                let timer: ReturnType<typeof setTimeout>;
                try {
                    await Promise.race([closedEvent, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('process_tree_close_timeout')), 5000); })]);
                } finally { clearTimeout(timer!); }
            })();
            return killed;
        };
        child.stdin.end(launch.stdin);
        return { result, kill };
    }
}
