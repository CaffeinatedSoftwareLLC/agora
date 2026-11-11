import { execFile, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { summaryOf } from './acp/session.js';
import type { LocalProfile } from './config.js';
import type { Claim, Result } from './types.js';

/**
 * NVIDIA NemoClaw (Apache-2.0, alpha): OpenClaw in an OpenShell sandbox on the owner's machine,
 * inference from NVIDIA Endpoints, OpenRouter or a local Ollama (agora-host README, "NemoClaw").
 *
 * Host mode. Every wake is one headless OpenClaw turn in the profile's sandbox:
 *   nemoclaw <sandbox> agent --session-id <id> --json [--model <m>] [--timeout <s>]   (prompt on stdin)
 * NemoClaw passes the arguments to `openclaw agent` inside the sandbox unchanged. The agent
 * reaches Agora through NemoClaw's managed MCP, which takes only an HTTPS Streamable HTTP server:
 * Agora's `/mcp` endpoint (docs/mcp-http.md), attached once with `agora-host nemoclaw setup`.
 * The bot token is then kept by OpenShell; it is not passed to any run. The agent works in its
 * own sandbox: the session worktree agora-host keeps on this machine is not visible to it.
 *
 * On Windows NemoClaw runs in WSL2 ("tested with limitations"): the profile's executable is
 * wsl.exe and `nemoclaw.wsl` names the distro and the nemoclaw path in it.
 *
 * Box mode (box-adapters.ts) runs OpenClaw itself, without NemoClaw or OpenShell, which need
 * Docker and can't run inside a gVisor box.
 */

/** NemoClaw versions this host was checked against: v0.0.142 (the installer's `lkg`) and v0.0.143. */
export const NEMOCLAW_TESTED = /^0\.0\.14[23]$/;

/** Sandbox names as NemoClaw takes them: 1–19 characters, lowercase, single inner hyphens. */
export const NEMOCLAW_SANDBOX = /^(?=.{1,19}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The environment variable `nemoclaw mcp add --env` reads the bot token from (setup only). */
export const NEMOCLAW_TOKEN_ENV = 'AGORA_MCP_TOKEN';

/** The MCP server name the Agora endpoint is attached under in the sandbox. */
export const NEMOCLAW_MCP_SERVER = 'agora';

/** OpenClaw session ids the host passes and accepts back. */
export const OPENCLAW_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface NemoclawSettings {
    sandbox: string;
    mcpUrl: string;
    trustPrivateHost: boolean;
    wsl?: { distro: string; nemoclawPath: string };
}

export const NEMOCLAW_HOST_ONLY =
    'A nemoclaw profile with a "nemoclaw" block (sandbox, mcpUrl) runs NemoClaw on this machine, which an agent box can\'t: in a box the adapter runs OpenClaw itself (agora-host README, "NemoClaw").';
export const NEMOCLAW_BOX_ONLY =
    'A nemoclaw profile without a "nemoclaw" block is the box form (OpenClaw on an NVIDIA_API_KEY) and runs only in an agent box. On a machine, add "nemoclaw": { "sandbox": "<name>", "mcpUrl": "https://<host>/mcp" } (agora-host README, "NemoClaw").';
export const NEMOCLAW_NOT_OPENCLAW =
    'The NemoClaw sandbox does not run OpenClaw. agora-host drives OpenClaw sandboxes only (`nemoclaw <name> agent`); NemoClaw refuses that command for Hermes and Deep Agents sandboxes.';

/** The program and arguments that run `nemoclaw <args>` for this profile (through WSL on Windows). */
export function nemoclawCommand(profile: Pick<LocalProfile, 'executable'> & { nemoclaw?: NemoclawSettings }, args: string[]): { executable: string; args: string[] } {
    const wsl = profile.nemoclaw?.wsl;
    return wsl
        ? { executable: profile.executable, args: ['-d', wsl.distro, '--exec', wsl.nemoclawPath, ...args] }
        : { executable: profile.executable, args };
}

/**
 * The environment of a nemoclaw command: the host's, plus NemoClaw's telemetry off and its
 * prompts off. Through WSL, WSLENV carries those variables (and `extra`) into the distro.
 */
export function nemoclawEnv(profile: { nemoclaw?: NemoclawSettings }, base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const own = { NEMOCLAW_DISABLE_TELEMETRY: '1', NEMOCLAW_NON_INTERACTIVE: '1', ...extra };
    const env: NodeJS.ProcessEnv = { ...base, ...own };
    if (profile.nemoclaw?.wsl) {
        const passed = Object.keys(own).map(name => `${name}/u`);
        env.WSLENV = [...(base.WSLENV ? base.WSLENV.split(':').filter(Boolean) : []), ...passed].join(':');
    }
    return env;
}

/** The OpenClaw session a wake continues: the one Agora has, else one named after the Agora session. */
export function openclawSessionId(claim: Pick<Claim, 'session'>): string {
    return claim.session.nativeSessionId ?? `agora-${claim.session.id.trim().toLowerCase()}`;
}

/** The `nemoclaw` arguments of one wake (the prompt goes on stdin). */
export function nemoclawAgentArgs(settings: NemoclawSettings, sessionId: string, model: string | null, timeoutSeconds: number): string[] {
    return [settings.sandbox, 'agent', '--session-id', sessionId, '--json',
        ...(model !== null ? ['--model', model] : []),
        // NemoClaw waits the timeout plus 30 s; the host's own run timeout stops it after that
        ...(timeoutSeconds > 0 ? ['--timeout', String(timeoutSeconds)] : [])];
}

/** The line added to a wake prompt in host mode: where the agent is, and what it can't see. */
export const NEMOCLAW_WAKE_NOTE =
    'You run in your own NemoClaw sandbox. Agora\'s session worktree is on the host and you can\'t see or change it: work through the Agora tools '
    + '(post results, canvases and file contents in Agora), and say so when a task needs changes in the repository you can\'t make from here.';

const numeric = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** The last JSON object in the output: the whole of it, else its last line that parses. */
function lastJson(stdout: string): Record<string, any> | null {
    const text = stdout.trim();
    if (!text) return null;
    try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { /* lines below */ }
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith('{')) continue;
        try { const v = JSON.parse(line); if (v && typeof v === 'object') return v; } catch { /* keep looking */ }
    }
    return null;
}

/** The reply text of OpenClaw payloads: the visible ones, not errors, reasoning, status or commentary. */
function payloadText(payloads: unknown): string | null {
    if (!Array.isArray(payloads)) return null;
    const parts = payloads.filter(p => p && typeof p === 'object' && typeof p.text === 'string'
        && !p.isError && !p.isReasoning && !p.isStatusNotice && !p.isCommentary).map(p => p.text as string);
    return parts.length ? parts.join('\n\n') : null;
}

function usageTokens(usage: any): number | null {
    if (!usage || typeof usage !== 'object') return null;
    if (numeric(usage.total)) return usage.total;
    const keys = ['input', 'output', 'cacheRead', 'cacheWrite'];
    if (!numeric(usage.input) || !numeric(usage.output)) return null;
    const values = keys.map(k => usage[k] ?? 0);
    return values.every(numeric) ? values.reduce((a: number, b: number) => a + b, 0) : null;
}

/**
 * One OpenClaw turn's `--json` output, from `nemoclaw <sandbox> agent` (host mode) or
 * `openclaw agent exec` (box mode). Shapes:
 * - `agent exec`: `{ ok, status: "ok"|"error"|"timeout", final, payloads, usage: {input, output, total}, sessionId, error? }`
 * - `agent`, embedded: `{ payloads, meta: { agentMeta: { sessionId, usage: {input, output, cacheRead, cacheWrite} }, error?, aborted? } }`
 * - `agent` through the gateway (NemoClaw's path): `{ status, result: { payloads, meta } }`
 * - a CLI error: `{ ok: false, error: { type, message } }`
 * Success needs exit 0, no error, and a reply (or a lurk run's silence).
 */
export function parseOpenClaw(stdout: string, exitCode: number | null, lurk = false, sessionId: string | null = null): Result {
    let text: string | null = null; let tokensUsed: number | null = null; let nativeSessionId: string | null = null; let failed = false;
    const env = lastJson(stdout);
    if (!env) failed = true;
    else {
        const inner = env.result && typeof env.result === 'object' && !Array.isArray(env.result) ? env.result : env;
        const meta = inner.meta && typeof inner.meta === 'object' ? inner.meta : {};
        const agentMeta = meta.agentMeta && typeof meta.agentMeta === 'object' ? meta.agentMeta : {};
        text = typeof env.final === 'string' && env.final.trim() ? env.final : payloadText(inner.payloads);
        tokensUsed = usageTokens(env.usage) ?? usageTokens(agentMeta.usage);
        const sid = typeof env.sessionId === 'string' ? env.sessionId : typeof agentMeta.sessionId === 'string' ? agentMeta.sessionId : null;
        nativeSessionId = sid && OPENCLAW_SESSION_ID.test(sid) ? sid : null;
        const status = typeof env.status === 'string' ? env.status : null;
        failed = env.ok === false || !!env.error || !!meta.error || meta.aborted === true
            || (status !== null && status !== 'ok' && status !== 'success' && status !== 'completed');
    }
    const final = text === null ? null : summaryOf(text);
    const success = !failed && exitCode === 0 && (final !== null || lurk);
    return {
        success,
        nativeSessionId: nativeSessionId ?? (sessionId && OPENCLAW_SESSION_ID.test(sessionId) ? sessionId : null),
        tokensUsed, summary: final === '[pass]' ? null : final, changedPaths: [],
        ...(success ? {} : { error: 'cli_failed_or_invalid_output' }),
    };
}

const run = promisify(execFile);

/** `nemoclaw --version` prints `nemoclaw v0.0.143`. */
export function nemoclawVersion(stdout: string): string | null {
    return /\bnemoclaw v(\d+\.\d+\.\d+)\b/.exec(stdout)?.[1] ?? null;
}

/**
 * The start-up check of a host-mode profile: a tested NemoClaw (unless allowUntestedVersion),
 * and a sandbox of that name that runs OpenClaw. Returns what the host logs.
 */
export async function verifyNemoclaw(profile: LocalProfile & { nemoclaw: NemoclawSettings }, env: NodeJS.ProcessEnv): Promise<string> {
    const opts = { env: nemoclawEnv(profile, env), cwd: profile.stateDir, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 };
    const v = nemoclawCommand(profile, ['--version']);
    const version = nemoclawVersion((await run(v.executable, v.args, opts)).stdout);
    if (!version || (!NEMOCLAW_TESTED.test(version) && !profile.allowUntestedVersion)) throw new Error('unsupported_cli_version');
    const s = nemoclawCommand(profile, [profile.nemoclaw.sandbox, 'status', '--json']);
    let status: any;
    try { status = JSON.parse((await run(s.executable, s.args, opts)).stdout); } catch { throw new Error('nemoclaw_status_failed'); }
    if (status?.found === false) throw new Error('nemoclaw_sandbox_not_found');
    if (typeof status?.agent === 'string' && status.agent.toLowerCase() !== 'openclaw') throw new Error(NEMOCLAW_NOT_OPENCLAW);
    return `nemoclaw ${version}, sandbox ${profile.nemoclaw.sandbox}${typeof status?.provider === 'string' ? ` (${status.provider}${typeof status?.model === 'string' ? ` ${status.model}` : ''})` : ''}`;
}

/** The MCP endpoint's host, for `--trusted-private-host`. */
export function mcpHost(mcpUrl: string): string { return new URL(mcpUrl).hostname; }

/** `nemoclaw <sandbox> mcp add agora --url <mcpUrl> --env AGORA_MCP_TOKEN [--trusted-private-host <host>]`. */
export function mcpAddArgs(settings: NemoclawSettings): string[] {
    return [settings.sandbox, 'mcp', 'add', NEMOCLAW_MCP_SERVER, '--url', settings.mcpUrl, '--env', NEMOCLAW_TOKEN_ENV,
        ...(settings.trustPrivateHost ? ['--trusted-private-host', mcpHost(settings.mcpUrl)] : [])];
}

/**
 * `agora-host nemoclaw setup --profile <name> --config <file> [--replace]`: attach Agora's MCP
 * endpoint to the profile's sandbox (agora-host README, "NemoClaw"). The bot token goes to
 * `nemoclaw mcp add` in its environment only (never as an argument); OpenShell keeps it, and the
 * sandbox's network policy for the endpoint is written by NemoClaw. Run again with --replace
 * after the bot's token changes. Then checks the server with `mcp status --probe`.
 */
export async function nemoclawSetup(profile: LocalProfile & { nemoclaw: NemoclawSettings }, token: string, replace: boolean,
    out: (line: string) => void, spawnFn: typeof spawn = spawn, env: NodeJS.ProcessEnv = process.env): Promise<number> {
    const step = (args: string[], extra: Record<string, string> = {}) => new Promise<number | null>(resolve => {
        const cmd = nemoclawCommand(profile, args);
        const child = spawnFn(cmd.executable, cmd.args, { cwd: profile.stateDir, env: nemoclawEnv(profile, env, extra), stdio: ['ignore', 'inherit', 'inherit'], shell: false, windowsHide: true });
        child.once('error', () => resolve(null));
        child.once('close', resolve);
    });
    const sb = profile.nemoclaw.sandbox;
    await mkdir(profile.stateDir, { recursive: true, mode: 0o700 });
    if (replace) {
        out(`Removing the old ${NEMOCLAW_MCP_SERVER} MCP server from ${sb} (NemoClaw keeps its stored credential; it prints its name for cleanup).`);
        await step([sb, 'mcp', 'remove', NEMOCLAW_MCP_SERVER, '--force']);
    }
    out(`Attaching ${profile.nemoclaw.mcpUrl} to sandbox ${sb} as MCP server "${NEMOCLAW_MCP_SERVER}".`);
    const added = await step(mcpAddArgs(profile.nemoclaw), { [NEMOCLAW_TOKEN_ENV]: token });
    if (added !== 0) { out('nemoclaw mcp add did not finish. Nothing else was changed.'); return 1; }
    const probed = await step([sb, 'mcp', 'status', NEMOCLAW_MCP_SERVER, '--probe', '--tools']);
    out(probed === 0 ? `Done: ${sb} reaches Agora's tools. The token is bound to OpenClaw's MCP client (openclaw-bundle-mcp) on first use.`
        : 'The server was added, but its probe failed: check the URL is reachable from the sandbox (docs/mcp-http.md).');
    return probed === 0 ? 0 : 1;
}
