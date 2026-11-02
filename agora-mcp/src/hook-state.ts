import { createHash } from 'node:crypto';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where the Claude Code hooks (src/hook.ts) find this agent's Agora connection.
 *
 * Hooks get no MCP configuration, and agora-mcp never reads the CLIs' own files. So the
 * running MCP server says where it is: once it has its config it writes
 * `~/.agora/hooks/<sha256(project dir)>.<server>.json` with the instance, token and default
 * channel, its pid, and when it last refreshed the file. Only servers the CLI actually
 * started (registrations the user approved) write one. The project directory is
 * CLAUDE_PROJECT_DIR (Claude Code sets it for the processes it starts), else the working
 * directory; `server` is the name the tools are registered under (AGORA_HOOK_SERVER, default
 * `agora`). Same protection as saved invite credentials: folder 0700, file 0600.
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

export function hookStateDir(): string {
    return join(homedir(), '.agora', 'hooks');
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

/** Write (or refresh) the state file atomically: temp file, then rename. */
export async function writeHookState(state: HookState, directory = hookStateDir()): Promise<string> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(directory, 0o700).catch(() => {});
    const path = join(directory, `${projectKey(state.projectDir)}.${state.server}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    const file = await open(temporary, 'w', 0o600);
    try {
        await file.writeFile(JSON.stringify(state));
        await file.sync();
    } finally { await file.close(); }
    try { await rename(temporary, path); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    return path;
}

/** Only Claude's clients run these hooks; another CLI in the same folder must not replace the file. */
export function isClaudeClient(client: string | null | undefined): client is string {
    return !!client && /^claude([ -]|$)/i.test(client);
}

/**
 * Once the MCP client has initialized: write this server's state file and refresh it every
 * minute, so the hooks can tell a live server (and, at SessionEnd, one that just exited) from
 * a stale file. Only for Claude Code (and the Claude desktop app). Never throws.
 *
 * The SDK may call `oninitialized` before the client's name is readable, so `client` is read
 * on each write, and the first write is retried briefly until the name is known.
 */
export function startHookState(config: { instance: string; token: string; defaultChannel?: string }, client: () => string | null,
    env: NodeJS.ProcessEnv = process.env, directory = hookStateDir()): (() => Promise<boolean>) | undefined {
    const server = hookServerName(env);
    if (!server) return undefined;
    const projectDir = resolve(env.CLAUDE_PROJECT_DIR?.trim() || process.cwd());
    const write = async (): Promise<boolean> => {
        const name = client();
        if (!isClaudeClient(name)) return false;
        return writeHookState({ instance: config.instance, token: config.token, defaultChannel: config.defaultChannel, client: name,
            server, projectDir, pid: process.pid, updatedAt: new Date().toISOString() }, directory).then(() => true, () => false);
    };
    const first = (tries: number) => {
        if (client() === null && tries > 0) { setTimeout(() => first(tries - 1), 250).unref(); return; }
        void write();
    };
    first(20);
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
