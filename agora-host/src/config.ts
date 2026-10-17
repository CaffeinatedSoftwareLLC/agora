import { readFile, access, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const absolute = z.string().refine(isAbsolute, 'must be an absolute path');
const executable = absolute.refine(p => !/\.(cmd|bat|ps1)$/i.test(p), 'use a native executable, not a shell shim');
const tool = z.enum(['chat_history', 'chat_read', 'chat_send', 'channel_list', 'thread_start', 'thread_list',
    'thread_close', 'who_directs', 'file_search', 'file_read', 'session_start', 'session_end', 'session_list', 'session_wake']);
const profile = z.object({
    adapter: z.enum(['codex', 'claude']), workdir: absolute, workdirAlias: z.string().min(1),
    executable, stateDir: absolute,
    sandbox: z.enum(['read-only', 'workspace-write']).default('workspace-write'),
    approvedTools: z.array(tool).default([]),
    caps: z.object({ maxTokens: z.number().int().positive().optional(), maxBudgetUsd: z.number().positive().optional() }).strict().default({}),
    allowUntestedVersion: z.boolean().default(false),
}).strict().superRefine((p, ctx) => {
    if (p.caps.maxTokens !== undefined) ctx.addIssue({ code: 'custom', message: 'Neither verified CLI supports a hard per-run token cap; omit maxTokens explicitly' });
    if (p.adapter === 'codex' && p.caps.maxBudgetUsd !== undefined) ctx.addIssue({ code: 'custom', message: 'Codex has no verified USD cap' });
});
export const configSchema = z.object({
    instance: z.string().url().refine(s => { const u = new URL(s); return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/'; }, 'instance must be an HTTP(S) origin'),
    hostToken: z.string().regex(/^ah_[^\s]+$/),
    mcp: z.object({ executable, entrypoint: absolute }).strict(),
    profiles: z.record(z.string().min(1), profile), botTokens: z.record(z.string(), z.string().regex(/^bot_[^\s]+$/)),
    maxConcurrent: z.number().int().min(1).max(16).default(2),
}).strict();
export type Config = z.infer<typeof configSchema>;
export type LocalProfile = Config['profiles'][string];

export async function loadConfig(path: string): Promise<Config> {
    // Never include input values (which may be credentials) in validation errors.
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Cannot read host JSON configuration'); }
    const result = configSchema.safeParse(parsed);
    if (!result.success) throw new Error(`Invalid host config (${result.error.issues.map(i => i.code).join(', ')})`);
    const config = result.data;
    for (const p of Object.values(config.profiles)) {
        await access(p.executable); await access(p.workdir);
        if (!(await stat(p.workdir)).isDirectory()) throw new Error('Configured workdir is not a directory');
    }
    await access(config.mcp.executable); await access(config.mcp.entrypoint);
    const states = Object.values(config.profiles).map(p => resolve(p.stateDir).toLowerCase());
    if (new Set(states).size !== states.length) throw new Error('Each profile must have its own CLI stateDir');
    return config;
}
