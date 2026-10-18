import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseOutput, type Launch } from './adapters.js';
import type { Result } from './types.js';

export interface RunningChild { result: Promise<Result>; kill(): Promise<void>; tokensUsed?(): number | null }
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
                                : parseOutput(launch.adapter, stdout, code, launch.sandbox));
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
        return { result, kill, tokensUsed: () => parseOutput(launch.adapter, stdout.slice(0, stdout.lastIndexOf('\n') + 1), null).tokensUsed };
    }
}

/** Compare dirty file contents, including files already dirty at launch and untracked files. */
export async function worktreeSnapshot(cwd: string): Promise<Map<string, string> | null> {
    try {
        const { stdout } = await promisify(execFile)('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
            { cwd, windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
        const entries = stdout.split('\0');
        const snapshot = new Map<string, string>();
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (!entry) continue;
            const path = entry.slice(3);
            const bytes = await readFile(join(cwd, path)).catch(() => null);
            snapshot.set(path, entry.slice(0, 2) + (bytes ? createHash('sha256').update(bytes).digest('hex') : 'deleted'));
            if (/[RC]/.test(entry.slice(0, 2))) { const old = entries[++i]; if (old) snapshot.set(old, 'renamed'); }
        }
        return snapshot;
    } catch { return null; }
}
export function changedSince(before: Map<string, string> | null, after: Map<string, string> | null): string[] {
    if (!before || !after) return [];
    return [...new Set([...before.keys(), ...after.keys()])].filter(p => p.length <= 4096 && before.get(p) !== after.get(p)).slice(0, 1000);
}
