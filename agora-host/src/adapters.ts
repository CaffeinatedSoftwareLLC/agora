import { mkdir, mkdtemp, realpath, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config, LocalProfile } from './config.js';
import type { Claim, Result } from './types.js';
import { isLurkRun, wakePrompt } from './prompt.js';
import { ensureWorkspace, type Workspace } from './workspaces.js';
<<<<<<< HEAD
import { CODEX_WORDS, resolvePermissions, type Permissions } from './presets.js';
=======
import { handoffNotes } from './handoff.js';
import { CODEX_WORDS, resolvePermissions } from './presets.js';
>>>>>>> origin/main
import { detectSignals } from './signals.js';
import { ACP_API_KEY_METHODS, checkTerms, GEMINI_NOT_HOSTED, HostConfigError, TermsRefusal, type SiwcRunError } from './terms.js';
import { accessToken, type AccessToken } from './siwc/session.js';
import { SiwcError } from './siwc/oauth.js';
import { DEFAULT_DIR } from './siwc/store.js';
import { PROVIDER_ARGS, type AppServerPlan } from './siwc/appserver.js';
import { sessionPorts } from './preview.js';
import { probeAcp, SESSION_ID, type AcpPlan } from './acp/session.js';
import { geminiPolicy } from './acp/permissions.js';

export interface Launch {
    lurk?: boolean;
    workspace?: Workspace;
    executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string;
    adapter: 'codex' | 'claude' | 'gemini'; cleanup(): Promise<void>;
    /** Codex's sandbox for this run, so denials can be read from its output. */
    sandbox?: 'read-only' | 'workspace-write';
    /** Preset names the claim used that this host doesn't define. */
    unknownPresets?: string[];
    /** auth "siwc": drive `codex app-server` on a ChatGPT plan instead of `codex exec`. */
    appServer?: AppServerPlan;
    /** protocol "acp": one ACP session turn instead of the CLI's headless mode. */
    acp?: AcpPlan;
}

/** Where this host keeps Sign in with ChatGPT state (config `siwc.dir`). */
export const siwcDir = (config: Config) => config.siwc?.dir ?? DEFAULT_DIR;

/** A fresh access token for a siwc profile; sign-in problems become terms refusals with their code. */
async function siwcToken(config: Config, profile: string, force = false): Promise<AccessToken> {
    try { return await accessToken({ dir: siwcDir(config), profile, force }); }
    catch (err) {
        if (err instanceof SiwcError && /^siwc_[a-z_]+$/.test(err.code)) throw new TermsRefusal(err.code as SiwcRunError, err.message);
        throw err;
    }
}
export const resultSchema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
const STATE_DIR_ENV = { codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR', gemini: 'GEMINI_CLI_HOME' } as const;
const osKeys = new Set(['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'COMSPEC']);
/**
 * Only the variables the OS needs to find programs and home/temp directories, made so a bare
 * program name never resolves to a file in the working directory (a worktree the agent writes):
 * - PATH keeps absolute entries only; `.`, an empty entry or any relative one means "here".
 * - Windows: NoDefaultCurrentDirectoryInExePath=1 stops cmd.exe, SearchPath and libuv (Node's
 *   child_process) from trying the current directory before PATH. PowerShell never does.
 */
export function osEnv(source: NodeJS.ProcessEnv = process.env, platform = process.platform): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    const absolute = platform === 'win32' ? win32.isAbsolute : posix.isAbsolute;
    for (const [key, value] of Object.entries(source)) {
        if (!osKeys.has(key.toUpperCase()) || value === undefined) continue;
        env[key] = key.toUpperCase() === 'PATH'
            ? value.split(platform === 'win32' ? ';' : ':').filter(e => !!e && absolute(e.replace(/^"(.*)"$/, '$1'))).join(platform === 'win32' ? ';' : ':')
            : value;
    }
    if (platform === 'win32') env.NoDefaultCurrentDirectoryInExePath = '1';
    return env;
}
/** Drop every PATH entry inside one of `roots` (links resolved), in place. */
export async function repoFreePath(env: NodeJS.ProcessEnv, roots: string[], platform = process.platform): Promise<NodeJS.ProcessEnv> {
    const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH');
    if (!key || !env[key]) return env;
    const p = platform === 'win32' ? win32 : posix;
    const norm = (s: string) => (platform === 'win32' ? p.resolve(s).toLowerCase() : p.resolve(s));
    const real = async (s: string) => { try { return await realpath(s); } catch { return s; } };
    const inside = (root: string, target: string) => {
        const rel = p.relative(norm(root), norm(target));
        return rel === '' || (!p.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${p.sep}`));
    };
    const all = [...roots.map(r => p.resolve(r)), ...(await Promise.all(roots.map(real)))];
    const sep = platform === 'win32' ? ';' : ':';
    const kept: string[] = [];
    for (const raw of env[key]!.split(sep)) {
        const entry = raw.replace(/^"(.*)"$/, '$1');
        if (!entry) continue;
        const resolved = await real(entry);
        if (!all.some(r => inside(r, entry) || inside(r, resolved))) kept.push(raw);
    }
    env[key] = kept.join(sep);
    return env;
}
export function childEnv(profile: LocalProfile, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env = osEnv(source);
    // Each CLI keeps its settings and login in the profile's stateDir. For Gemini that also keeps
    // the user's own ~/.gemini (and any Google login cached there) out of hosted runs.
    env[STATE_DIR_ENV[profile.adapter]] = profile.stateDir;
    // api_key mode: only this profile's key variable, never logged (docs/provider-terms.md)
    if (profile.auth === 'api_key' && profile.apiKeyEnv) {
        const key = source[profile.apiKeyEnv];
        if (key) env[profile.apiKeyEnv] = key;
    }
    return env;
}
export async function verifyProfile(profile: LocalProfile): Promise<string> {
    // ACP: the protocol version is the gate, not the CLI's version string
    if (profile.protocol === 'acp') return probeAcp({ executable: profile.executable, args: profile.acpArgs, cwd: profile.workdir, env: childEnv(profile) });
    if (profile.adapter === 'gemini') throw new HostConfigError(GEMINI_NOT_HOSTED);
    const { stdout } = await promisify(execFile)(profile.executable, ['--version'], {
        env: childEnv(profile), cwd: profile.workdir, windowsHide: true, timeout: 10000, maxBuffer: 4096,
    });
    const version = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
    const tested = version && (profile.adapter === 'codex' ? version[1] === '0' && version[2] === '163' : version[1] === '2' && version[2] === '1');
    if (!version || (!tested && !profile.allowUntestedVersion)) throw new Error('unsupported_cli_version');
    return version[0];
}

/**
 * The rules a Codex app-server approval request is judged by (siwc/approvals.ts): what the owner
 * allowed for this agent ("always" rules and this run's one-time grants), the Agora MCP tools,
 * and the capability words the presets turned on. A preset's Claude rules are left out: for Codex
 * a preset is its sandbox, and an approved request runs outside it, so `dev`'s `Bash(node:*)`
 * must not let any escalated `node` command through without the owner saying so.
 */
export function appServerRules(rules: string[], perms: Permissions, approvedTools: string[]): string[] {
    return [...new Set([...rules, ...approvedTools.map(t => `mcp__agora__${t}`),
        ...(perms.codex.sandbox === 'workspace-write' ? ['write'] : []), ...(perms.codex.network ? ['network'] : []),
        ...(perms.codex.webSearch ? ['web_search'] : [])])];
}

/** `prompt` replaces the wake prompt: a verify fix turn resuming the same conversation (verify.ts). */
/**
 * `active` is every session this host is running (the scheduler's set), so a preview port range
 * held by a running session is never handed to this one; when none is free, preparing fails.
 */
export async function prepare(config: Config, claim: Claim, prompt?: string, active: ReadonlySet<string> = new Set()): Promise<Launch> {
    const local = config.profiles[claim.profile.name];
    if (!local || local.adapter !== claim.profile.adapter || local.workdirAlias !== claim.profile.workdirAlias) throw new Error('unmapped_profile');
    // Subscription profiles run only for the owner, siwc ones for their plan owner; run approval when required (terms.ts)
    checkTerms(local, claim);
    let plan: AccessToken | undefined;
    if (local.auth === 'siwc') {
        plan = await siwcToken(config, claim.profile.name);
        // The Agora user this host saved at sign-in must be the one the server says owns the plan
        checkTerms(local, claim, plan.agoraUserId);
    }
    const token = config.botTokens[claim.profile.botId];
    if (!token) throw new Error('missing_bot_token');
    const acp = local.protocol === 'acp';
    // An ACP agent lists its own reasoning levels; acp/session.ts matches the effort against them
    const efforts = acp ? null : local.adapter === 'codex' ? ['minimal', 'low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high', 'xhigh', 'max'];
    const { model, effort } = claim.profile;
    if (effort !== null && efforts && !efforts.includes(effort)) throw new Error('unsupported_effort');
    // ACP session IDs are the agent's own; the CLIs use UUIDs
    const nativeId = acp ? SESSION_ID : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (claim.session.nativeSessionId && !nativeId.test(claim.session.nativeSessionId)) throw new Error('invalid_native_session_id');
    await mkdir(local.stateDir, { recursive: true, mode: 0o700 });
    const workspace = await ensureWorkspace(local, claim);
    // Handoff offers: is the sender's pinned commit here, and how to apply it (handoff.ts)
    const handoffs = await handoffNotes(claim, workspace.cwd);
    const dir = await mkdtemp(join(local.stateDir, 'run-'));
    const paths = ['mcp.json', 'mcp.toml', 'schema.json', 'policy.toml'].map(p => join(dir, p));
    const cleanup = async () => {
        // Only remove these known files and the empty directory we created; no recursive deletion.
        await Promise.all(paths.map(p => unlink(p).catch(() => {})));
        await rmdir(dir).catch(() => {});
    };
    // Presets and allowed tools come with every claim (#73): no restart after an edit
    const rules = [...claim.profile.allowedTools, ...claim.run.grantedTools];
    const perms = resolvePermissions(local.sandbox, claim.profile.toolPresets, rules, config.presets);
    try {
        // This session's own preview ports: the only ones browser_preview will load
        const ports = config.preview ? await sessionPorts(config.preview, claim.session.id, new Set([...active, claim.session.id])) : undefined;
        const env: NodeJS.ProcessEnv = { ...childEnv(local), AGORA_INSTANCE: config.instance, AGORA_BOT_TOKEN: token, AGORA_DEFAULT_CHANNEL: claim.session.channelId,
            ...(ports ? { AGORA_PREVIEW_PORTS: `${ports.first}-${ports.last}` } : {}) };
        // A PATH entry inside the worktree or repository would let a file the agent wrote win a
        // bare-name lookup over the trusted program (acp/permissions.ts executableTrust)
        await repoFreePath(env, [workspace.cwd, workspace.workdir, local.workdir]);
        // The plan's OAuth access token reaches app-server only through its environment
        if (plan) env.ACCESS_TOKEN = plan.accessToken;
        // Hosted runs are not bring-your-own sessions: no presence socket (agora-mcp src/socket.ts)
        const server = { command: config.mcp.executable, args: [config.mcp.entrypoint, '--no-presence'] };
        if (acp) {
            // The agent starts the Agora MCP server from session/new, so no MCP config is written
            const acpRules = [...new Set([...perms.claude, ...local.approvedTools.map(t => `mcp__agora__${t}`), ...rules.filter(r => CODEX_WORDS.has(r))])];
            const acpPlan: AcpPlan = {
                prompt: prompt ?? wakePrompt(claim, ports, workspace.branch, handoffs), nativeSessionId: claim.session.nativeSessionId, model, effort, rules: acpRules,
                mcpServers: [{ name: 'agora', ...server, env: (['AGORA_INSTANCE', 'AGORA_BOT_TOKEN', 'AGORA_DEFAULT_CHANNEL'] as const).map(name => ({ name, value: env[name]! })) }],
                authMethod: local.auth === 'api_key' ? ACP_API_KEY_METHODS[local.apiKeyEnv!] ?? null : null,
            };
            let args = local.acpArgs;
            const policy = local.adapter === 'gemini' ? geminiPolicy(acpRules) : '';
            if (policy) { await writeFile(paths[3], policy, { mode: 0o600 }); args = [...args, '--policy', paths[3]]; }
            return { executable: local.executable, args, env, cwd: workspace.cwd, workspace, adapter: local.adapter, stdin: '', cleanup,
                lurk: isLurkRun(claim), unknownPresets: perms.unknownPresets, acp: acpPlan };
        }
        if (local.adapter === 'gemini') throw new HostConfigError(GEMINI_NOT_HOSTED);
        await writeFile(paths[0], JSON.stringify({ mcpServers: { agora: server } }), { mode: 0o600 });
        await writeFile(paths[2], JSON.stringify(resultSchema), { mode: 0o600 });
        let args: string[];
        if (local.adapter === 'codex') {
            // A top-level CLI override replaces the MCP map: inherited servers/tokens are not passed through.
            // approval_mode "approve" pre-approves a listed tool; Codex 0.163 accepts auto|prompt|writes|approve.
            const tools = [...new Set([...local.approvedTools, ...perms.codex.mcpTools])].map(t => `${t}={approval_mode="approve"}`).join(',');
            const mcp = `{agora={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)},env_vars=["AGORA_INSTANCE","AGORA_BOT_TOKEN","AGORA_DEFAULT_CHANNEL"],required=true,tools={${tools}}}}`;
            await writeFile(paths[1], `mcp_servers=${mcp}\n`, { mode: 0o600 });
            if (plan) {
                // codex app-server with OpenAI's ChatGPT-plan provider; model, effort, sandbox and
                // output schema go over JSON-RPC (siwc/appserver.ts)
                // "on-request": Codex asks before anything outside its sandbox, and the host
                // answers from the rules or a tool-request card (siwc/approvals.ts, #93)
                args = ['app-server', '--listen', 'stdio://', ...PROVIDER_ARGS,
                    '-c', 'approval_policy="on-request"', '-c', `mcp_servers=${mcp}`,
                    ...(perms.codex.network ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
                    ...(perms.codex.webSearch ? ['-c', 'web_search="live"'] : []),
                    ...(process.platform === 'win32' ? ['-c', `windows.sandbox=${JSON.stringify(local.windowsSandbox)}`] : [])];
                const profileName = claim.profile.name;
                const appServer: AppServerPlan = {
                    threadId: claim.session.nativeSessionId, prompt: prompt ?? wakePrompt(claim, ports, workspace.branch, handoffs),
                    outputSchema: isLurkRun(claim) ? null : resultSchema, model, effort, sandbox: perms.codex.sandbox,
                    refresh: async () => (await siwcToken(config, profileName, true)).accessToken,
                    rules: appServerRules(rules, perms, local.approvedTools), roots: [workspace.workdir, local.workdir],
                };
                return { executable: local.executable, args, env, cwd: workspace.cwd, workspace, adapter: 'codex', stdin: '', cleanup, lurk: isLurkRun(claim),
                    sandbox: perms.codex.sandbox, unknownPresets: perms.unknownPresets, appServer };
            }
            args = ['exec', '--ignore-user-config', '-s', perms.codex.sandbox,
                '-c', 'approval_policy="never"', '-c', `mcp_servers=${mcp}`,
                ...(perms.codex.network ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
                ...(perms.codex.webSearch ? ['-c', 'web_search="live"'] : []),
                ...(process.platform === 'win32' ? ['-c', `windows.sandbox=${JSON.stringify(local.windowsSandbox)}`] : []),
                ...(model !== null ? ['-m', model] : []),
                ...(effort !== null ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
                ...(claim.session.nativeSessionId ? ['resume', claim.session.nativeSessionId] : []),
                '--json', ...(!isLurkRun(claim) ? ['--output-schema', paths[2]] : []), '-'];
        } else {
            const allowed = [...new Set([...local.approvedTools.map(t => `mcp__agora__${t}`), ...perms.claude])];
            args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'manual', '--permission-prompts', 'none',
                '--strict-mcp-config', '--mcp-config', paths[0],
                ...(model !== null ? ['--model', model] : []),
                ...(effort !== null ? ['--effort', effort] : []),
                ...(!isLurkRun(claim) ? ['--json-schema', JSON.stringify(resultSchema)] : []),
                ...(allowed.length ? ['--allowedTools', allowed.join(',')] : []),
                ...(local.caps.maxBudgetUsd !== undefined ? ['--max-budget-usd', String(local.caps.maxBudgetUsd)] : []),
                ...(claim.session.nativeSessionId ? ['--resume', claim.session.nativeSessionId] : [])];
        }
        return { executable: local.executable, args, env, cwd: workspace.cwd, workspace, adapter: local.adapter, stdin: prompt ?? wakePrompt(claim, ports, workspace.branch, handoffs), cleanup, lurk: isLurkRun(claim),
            ...(local.adapter === 'codex' ? { sandbox: perms.codex.sandbox } : {}), unknownPresets: perms.unknownPresets };
    } catch (err) { await cleanup(); throw err; }
}

const numeric = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
function sumUsage(usage: unknown, keys: string[]): number | null {
    if (!usage || typeof usage !== 'object') return null;
    const u = usage as Record<string, unknown>;
    if (!numeric(u.input_tokens) || !numeric(u.output_tokens)) return null;
    const values = keys.map(k => u[k] ?? 0);
    if (!values.every(numeric)) return null;
    const total = values.reduce((a, b) => a + b, 0);
    return Number.isSafeInteger(total) ? total : null;
}
function summary(value: unknown): string | null {
    if (typeof value === 'string' && value.trim() === '[pass]') return '[pass]';
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
    return value && typeof value === 'object' && typeof (value as { summary?: unknown }).summary === 'string'
        ? (value as { summary: string }).summary.slice(0, 16000) : null;
}
export function parseOutput(adapter: 'codex' | 'claude', stdout: string, exitCode: number | null, sandbox?: string, lurk = false): Result {
    const changedPaths = new Set<string>();
    let nativeSessionId: string | null = null; let tokensUsed: number | null = null; let final: string | null = null; let success = false;
    try {
        if (adapter === 'claude') {
            const events: any[] = [];
            let invalid = false;
            for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
                try { events.push(JSON.parse(line)); } catch { invalid = true; break; }
            }
            const r = [...events].reverse().find((e: any) => e.type === 'result') ?? {};
            const messages = new Map<string, number>();
            for (const [index, e] of events.entries()) {
                if (e.type === 'assistant') {
                    const usage = sumUsage(e.message?.usage, ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']);
                    if (usage !== null) messages.set(e.message?.id ?? String(index), usage);
                }
            }
            if (messages.size) tokensUsed = [...messages.values()].reduce((a, b) => a + b, 0);
            nativeSessionId = typeof r.session_id === 'string' ? r.session_id : null;
            tokensUsed = sumUsage(r.usage, ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) ?? tokensUsed;
            final = summary(r.structured_output ?? r.result);
            success = !invalid && r.type === 'result' && r.subtype === 'success' && r.is_error === false && (final !== null || lurk);
        } else {
            for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
                const e = JSON.parse(line);
                if (e.type === 'thread.started' && typeof e.thread_id === 'string') nativeSessionId = e.thread_id;
                if (e.type === 'item.completed' && e.item?.type === 'file_change' && e.item.status !== 'failed') {
                    for (const change of e.item.changes ?? [])
                        if (typeof change.path === 'string' && change.path.length > 0 && change.path.length <= 4096 && changedPaths.size < 1000) changedPaths.add(change.path);
                }
                if (e.type === 'item.completed' && e.item?.type === 'agent_message') final = summary(e.item.text);
                if (e.type === 'turn.completed') {
                    const used = sumUsage(e.usage, ['input_tokens', 'output_tokens']);
                    tokensUsed = used === null ? null : (tokensUsed ?? 0) + used; success = true;
                }
                if (e.type === 'turn.failed') success = false;
            }
            success &&= final !== null || lurk;
        }
    } catch { success = false; }
    success &&= exitCode === 0;
    // Only for a finished process; heartbeats parse partial output just for usage
    const { deniedTools, rateLimit } = exitCode === null ? { deniedTools: [], rateLimit: null } : detectSignals(adapter, stdout, !success, sandbox);
    return { success, nativeSessionId, tokensUsed, summary: final === '[pass]' ? null : final, changedPaths: [...changedPaths], ...(success ? {} : { error: 'cli_failed_or_invalid_output' }),
        ...(deniedTools.length ? { deniedTools } : {}), ...(rateLimit ? { rateLimit } : {}) };
}
