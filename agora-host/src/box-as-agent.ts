import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Config, LocalProfile } from './config.js';
import { childEnv } from './adapters.js';
import { BOX_HOME, inBox, scratchDir } from './box.js';

/**
 * The agent's side of `as-agent` (docs/box-terminal.md). The owner's shell runs as another Unix
 * user; `as-agent <command>` there asks this process's child (box/as-agent-server, Python) to run
 * the command with the agent's rights, in the agent's workspace. This module only starts that
 * server with the agent's environment and keeps it running; it speaks to nobody.
 *
 * Boxes only. The server refuses every connection whose kernel-attested user is not the operator.
 */

export const AS_AGENT_SERVER = '/opt/agora/as-agent-server';
export const OPERATOR_UID = 1001;
/** The image's root-owned CLI links come first, ahead of the agent-writable folders (the agent can shadow a name there). */
const IMAGE_BIN = '/opt/agora/bin';

/**
 * The environment `as-agent` commands get: exactly what the agent's own CLI runs get (`childEnv`:
 * an OS allowlist, the CLI's state directory so `claude` is logged in as the agent, the proxy
 * variables, and an API-key agent's provider key), no host or bot token, plus a terminal type.
 */
export function asAgentEnv(config: Config, source: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): NodeJS.ProcessEnv {
    const local: LocalProfile = Object.values(config.profiles)[0]!;
    const env = childEnv(local, source);
    env.HOME ??= BOX_HOME;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.LANG = source.LANG && /^[A-Za-z0-9_.@-]{1,40}$/.test(source.LANG) ? source.LANG : 'C.UTF-8';
    env.SHELL = '/bin/bash';
    env.PATH = [IMAGE_BIN, ...(env.PATH ?? '').split(':').filter(p => p && p !== IMAGE_BIN)].join(':');
    env.AGORA_WORKSPACE = [local.workdir, scratchDir(env.HOME)].find(p => exists(p)) ?? env.HOME;
    env.AGORA_OPERATOR_UID = String(OPERATOR_UID);
    return env;
}

export interface AsAgentOptions {
    signal: AbortSignal;
    log(code: string): void;
    server?: string;
    spawnServer?: (server: string, env: NodeJS.ProcessEnv) => ChildProcess;
    retryMinMs?: number;
    retryMaxMs?: number;
}

/** Run the server; start it again, slowly, if it ends; stop it with the host. */
export async function runAsAgentServer(config: Config, o: AsAgentOptions): Promise<void> {
    if (!inBox() || Object.keys(config.profiles).length !== 1) return;
    const server = o.server ?? AS_AGENT_SERVER;
    const start = o.spawnServer ?? ((s, env) => spawn('python3', [s], { env, stdio: ['ignore', 'inherit', 'inherit'], shell: false }));
    let delay = o.retryMinMs ?? 2000;
    while (!o.signal.aborted) {
        const child = start(server, asAgentEnv(config));
        const startedAt = Date.now();
        const stop = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
        o.signal.addEventListener('abort', stop, { once: true });
        const code = await new Promise<number | null>(resolve => { child.once('exit', c => resolve(c)); child.once('error', () => resolve(null)); });
        o.signal.removeEventListener('abort', stop);
        if (o.signal.aborted) return;
        o.log(`as_agent_server_ended ${code ?? 'error'}`);
        // A server that ran a while starts again at once; one that dies at start backs off
        delay = Date.now() - startedAt > 30_000 ? (o.retryMinMs ?? 2000) : Math.min(delay * 2, o.retryMaxMs ?? 60_000);
        await new Promise<void>(r => { const t = setTimeout(r, delay); o.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
    }
}
