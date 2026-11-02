import { createHash } from 'node:crypto';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where the agent hooks (src/hook.ts) find this agent's Agora connection.
 *
 * Hooks get no MCP configuration, and agora-mcp never reads the CLIs' own files. So the
 * running MCP server says where it is: once it has its config it writes
 * `~/.agora/hooks/<sha256(project dir)>.<server>.<pid>.json` (Claude Code) or
 * `~/.agora/hooks/codex/<sha256(project dir)>.<server>.<pid>.json` (Codex CLI) with the instance,
 * token and default channel, its pid, and when it last refreshed the file. Only servers the
 * CLI actually started (registrations the user approved) write one. The project directory is
 * CLAUDE_PROJECT_DIR for Claude Code (it sets it for the processes it starts), else the
 * working directory, which Codex sets to the session's directory, the `cwd` its hooks get;
 * `server` is the name the tools are registered under (AGORA_HOOK_SERVER, default `agora`).
 * Each CLI has its own folder, so one CLI's server never replaces the other's file in the same
 * project, and a 0.8.0 hook (top folder only) never picks up a Codex file. Same protection as
 * saved invite credentials: folders 0700, files 0600.
 */

export interface HookState {
    instance: string;
    token: string;
    defaultChannel?: string;
    /** The MCP client that started the server; the token is bound to it (#39). */
    client: string;
    /** The MCP server name: tools are `mcp__<server>__chat_wait` and so on. */
    server: string;
    projectDir: string;
    pid: number;
    updatedAt: string;
}

export const HOOK_STATE_REFRESH_MS = 60_000;

/** The CLIs whose hooks agora-mcp serves (`agora-mcp hook stop --for codex`). */
export type HookCli = 'claude' | 'codex';

/** The hooks folder: Claude Code's files at the top (as in 0.8.0), Codex's in `codex/`. */
export function hookStateDir(cli: HookCli = 'claude', root = join(homedir(), '.agora', 'hooks')): string {
    return cli === 'claude' ? root : join(root, cli);
}

/** Path for comparing directories: forward slashes, no trailing slash, drive paths lowercased. */
export function normalizePath(path: string): string {
    let p = path.replace(/\\/g, '/');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    if (/^[A-Za-z]:/.test(p)) {
        p = p.toLowerCase();
        if (p.length === 2) p += '/';
    }
    return p;
}

/** `dir` and each of its ancestors, nearest first, normalized. */
export function ancestors(dir: string): string[] {
    const out: string[] = [];
    const parts = normalizePath(dir).split('/');
    for (let i = parts.length; i > 0; i--) {
        let candidate = parts.slice(0, i).join('/');
        if (candidate === '') candidate = '/';
        else if (/^[a-z]:$/.test(candidate)) candidate += '/';
        if (!out.includes(candidate)) out.push(candidate);
    }
    return out;
}

export function projectKey(dir: string): string {
    return createHash('sha256').update(normalizePath(dir)).digest('hex');
}

/** Server names as Claude Code allows them in tool names; anything else is not written. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function hookServerName(env: NodeJS.ProcessEnv): string | undefined {
    const name = env.AGORA_HOOK_SERVER?.trim() || 'agora';
    return SERVER_NAME.test(name) ? name : undefined;
}

/** This process's writes in progress, per state file. */
const pending = new Map<string, Promise<unknown>>();

/**
 * Write (or refresh) the state file atomically: temp file, then rename. Each agora-mcp process
 * has its own file (`<key>.<server>.<pid>.json`): two sessions in one project with the same
 * server name must not overwrite each other's, or a hook could act with the other session's
 * token. Writes of one file from this process run one after another: the first write and a
 * refresh can overlap, and they would share the temp file (and on Windows, two renames onto
 * one file can fail).
 */
export function writeHookState(state: HookState, directory = hookStateDir()): Promise<string> {
    const path = join(directory, `${projectKey(state.projectDir)}.${state.server}.${state.pid}.json`);
    const run = (pending.get(path) ?? Promise.resolve()).catch(() => {}).then(() => writeNow(state, directory, path));
    pending.set(path, run);
    const done = () => { if (pending.get(path) === run) pending.delete(path); };
    run.then(done, done);
    return run;
}

async function writeNow(state: HookState, directory: string, path: string): Promise<string> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(directory, 0o700).catch(() => {});
    const temporary = `${path}.${process.pid}.tmp`;
    // The temp file holds the token: whatever fails, it doesn't stay behind
    try {
        const file = await open(temporary, 'w', 0o600);
        try {
            await file.writeFile(JSON.stringify(state));
            await file.sync();
        } finally { await file.close(); }
        await rename(temporary, path);
    } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
    }
    return path;
}

const TEMP_MAX_AGE_MS = 60_000;
/** A gone server's file is only used by SessionEnd, for 5 minutes; with one file per process they pile up. */
const STALE_STATE_MAX_AGE_MS = 30 * 60_000;

/**
 * At agora-mcp startup: remove temp files older than a minute (a crashed write) and state files
 * of servers that are gone and haven't refreshed them for 30 minutes. Both hold a token. Never throws.
 */
export async function sweepHookStates(directory = hookStateDir(), opts: { now?: number; isRunning?: (pid: number) => boolean } = {}): Promise<void> {
    const now = opts.now ?? Date.now();
    const running = opts.isRunning ?? processRunning;
    let names: string[];
    try { names = readdirSync(directory); } catch { return; }
    for (const name of names) {
        const path = join(directory, name);
        try {
            const age = now - statSync(path).mtimeMs;
            if (name.endsWith('.tmp')) {
                if (age > TEMP_MAX_AGE_MS) await unlink(path);
                continue;
            }
            if (!name.endsWith('.json') || age <= STALE_STATE_MAX_AGE_MS) continue;
            let pid: unknown;
            try { pid = JSON.parse(readFileSync(path, 'utf8'))?.pid; } catch { /* unreadable: stale */ }
            if (!Number.isSafeInteger(pid) || !running(pid as number)) await unlink(path);
        } catch { /* gone already, or not ours to remove */ }
    }
}

/** Claude Code and the Claude desktop app. */
export function isClaudeClient(client: string | null | undefined): client is string {
    return !!client && /^claude([ -]|$)/i.test(client);
}

/** The Codex CLI (`codex-mcp-client`). */
export function isCodexClient(client: string | null | undefined): client is string {
    return !!client && /^codex([ -]|$)/i.test(client);
}

/** Which CLI's hooks serve this MCP client, if any. Other clients write no state file. */
export function hookCli(client: string | null | undefined): HookCli | undefined {
    return isClaudeClient(client) ? 'claude' : isCodexClient(client) ? 'codex' : undefined;
}

/**
 * Once the MCP client has initialized: write this server's state file and refresh it every
 * minute, so the hooks can tell a live server (and, at SessionEnd, one that just exited) from
 * a stale file. Only for Claude Code (and the Claude desktop app) and the Codex CLI, each in
 * its own folder under `root`. Never throws.
 *
 * The SDK may call `oninitialized` before the client's name is readable, so `client` is read
 * on each write, and the first write is retried briefly until the name is known.
 */
export function startHookState(config: { instance: string; token: string; defaultChannel?: string }, client: () => string | null,
    env: NodeJS.ProcessEnv = process.env, root = hookStateDir()): (() => Promise<boolean>) | undefined {
    const server = hookServerName(env);
    if (!server) return undefined;
    const write = async (): Promise<boolean> => {
        const name = client();
        const cli = hookCli(name);
        if (!cli) return false;
        // Codex starts its MCP servers in the session's directory, the `cwd` its hooks get. A
        // CLAUDE_PROJECT_DIR that reached a Codex server (a Codex started from Claude Code, with
        // the variable passed on) would name another project, so only Claude's counts.
        const projectDir = resolve((cli === 'claude' ? env.CLAUDE_PROJECT_DIR?.trim() : undefined) || process.cwd());
        return writeHookState({ instance: config.instance, token: config.token, defaultChannel: config.defaultChannel, client: name!,
            server, projectDir, pid: process.pid, updatedAt: new Date().toISOString() }, hookStateDir(cli, root)).then(() => true, () => false);
    };
    const first = (tries: number) => {
        if (client() === null && tries > 0) { setTimeout(() => first(tries - 1), 250).unref(); return; }
        void write();
    };
    // Clear what crashed writes and long-gone servers left, then write ours
    void Promise.all((['claude', 'codex'] as const).map(cli => sweepHookStates(hookStateDir(cli, root)))).finally(() => first(20));
    setInterval(() => { void write(); }, HOOK_STATE_REFRESH_MS).unref();
    return write;
}

function valid(state: any): state is HookState {
    return !!state && typeof state.instance === 'string' && typeof state.token === 'string' && state.token.startsWith('bot_')
        && typeof state.client === 'string' && typeof state.server === 'string' && SERVER_NAME.test(state.server) && Number.isSafeInteger(state.pid)
        && typeof state.updatedAt === 'string';
}

/**
 * The state files of the nearest directory that has any, among `dirs` (each tried with its
 * ancestors) for which `usable` holds. Unreadable or malformed files are skipped.
 */
export function findHookStates(dirs: string[], usable: (state: HookState) => boolean, directory = hookStateDir()): HookState[] {
    let names: string[];
    try { names = readdirSync(directory); } catch { return []; }
    const seen = new Set<string>();
    for (const start of dirs) {
        for (const dir of ancestors(start)) {
            if (seen.has(dir)) continue;
            seen.add(dir);
            const prefix = `${projectKey(dir)}.`;
            const states: HookState[] = [];
            for (const name of names) {
                if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
                try {
                    const state = JSON.parse(readFileSync(join(directory, name), 'utf8'));
                    if (valid(state) && usable(state)) states.push(state);
                } catch { /* skip */ }
            }
            if (states.length > 0) return states;
        }
    }
    return [];
}

/** Is a process with this pid running? */
export function processRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: it exists, but belongs to someone else
        return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
}
