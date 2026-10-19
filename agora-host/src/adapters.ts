import { mkdir, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config, LocalProfile } from './config.js';
import type { Claim, Result } from './types.js';
import { isLurkRun, wakePrompt } from './prompt.js';
import { ensureWorkspace, type Workspace } from './workspaces.js';
import { resolvePermissions } from './presets.js';
import { detectSignals } from './signals.js';
import { checkTerms, GEMINI_NOT_HOSTED, HostConfigError, TermsRefusal, type SiwcRunError } from './terms.js';
import { accessToken, type AccessToken } from './siwc/session.js';
import { SiwcError } from './siwc/oauth.js';
import { DEFAULT_DIR } from './siwc/store.js';
import { PROVIDER_ARGS, type AppServerPlan } from './siwc/appserver.js';

export interface Launch {
    lurk?: boolean;
    workspace?: Workspace;
    executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string;
    adapter: 'codex' | 'claude'; cleanup(): Promise<void>;
    /** Codex's sandbox for this run, so denials can be read from its output. */
    sandbox?: 'read-only' | 'workspace-write';
    /** Preset names the claim used that this host doesn't define. */
    unknownPresets?: string[];
    /** auth "siwc": drive `codex app-server` on a ChatGPT plan instead of `codex exec`. */
    appServer?: AppServerPlan;
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
const osKeys = new Set(['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'COMSPEC']);
export function childEnv(profile: LocalProfile, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(source)) if (osKeys.has(key.toUpperCase()) && value !== undefined) env[key] = value;
    if (profile.adapter !== 'gemini') env[profile.adapter === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = profile.stateDir;
    // api_key mode: only this profile's key variable, never logged (docs/provider-terms.md)
    if (profile.auth === 'api_key' && profile.apiKeyEnv) {
        const key = source[profile.apiKeyEnv];
        if (key) env[profile.apiKeyEnv] = key;
    }
    return env;
}
export async function verifyProfile(profile: LocalProfile): Promise<string> {
    if (profile.adapter === 'gemini') throw new HostConfigError(GEMINI_NOT_HOSTED);
    const { stdout } = await promisify(execFile)(profile.executable, ['--version'], {
        env: childEnv(profile), cwd: profile.workdir, windowsHide: true, timeout: 10000, maxBuffer: 4096,
    });
    const version = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
    const tested = version && (profile.adapter === 'codex' ? version[1] === '0' && version[2] === '163' : version[1] === '2' && version[2] === '1');
    if (!version || (!tested && !profile.allowUntestedVersion)) throw new Error('unsupported_cli_version');
    return version[0];
}

export async function prepare(config: Config, claim: Claim): Promise<Launch> {
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
    const efforts = local.adapter === 'codex' ? ['minimal', 'low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high', 'xhigh', 'max'];
    const { model, effort } = claim.profile;
    if (effort !== null && !efforts.includes(effort)) throw new Error('unsupported_effort');
    if (claim.session.nativeSessionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claim.session.nativeSessionId)) throw new Error('invalid_native_session_id');
    await mkdir(local.stateDir, { recursive: true, mode: 0o700 });
    const workspace = await ensureWorkspace(local, claim);
    const dir = await mkdtemp(join(local.stateDir, 'run-'));
    const paths = ['mcp.json', 'mcp.toml', 'schema.json'].map(p => join(dir, p));
    const cleanup = async () => {
        // Only remove these known files and the empty directory we created; no recursive deletion.
        await Promise.all(paths.map(p => unlink(p).catch(() => {})));
        await rmdir(dir).catch(() => {});
    };
    // Presets and allowed tools come with every claim (#73): no restart after an edit
    const perms = resolvePermissions(local.sandbox, claim.profile.toolPresets, [...claim.profile.allowedTools, ...claim.run.grantedTools], config.presets);
    try {
        const env: NodeJS.ProcessEnv = { ...childEnv(local), AGORA_INSTANCE: config.instance, AGORA_BOT_TOKEN: token, AGORA_DEFAULT_CHANNEL: claim.session.channelId };
        // The plan's OAuth access token reaches app-server only through its environment
        if (plan) env.ACCESS_TOKEN = plan.accessToken;
        // Hosted runs are not bring-your-own sessions: no presence socket (agora-mcp src/socket.ts)
        const server = { command: config.mcp.executable, args: [config.mcp.entrypoint, '--no-presence'] };
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
                args = ['app-server', '--listen', 'stdio://', ...PROVIDER_ARGS,
                    '-c', 'approval_policy="never"', '-c', `mcp_servers=${mcp}`,
                    ...(perms.codex.network ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
                    ...(perms.codex.webSearch ? ['-c', 'web_search="live"'] : []),
                    ...(process.platform === 'win32' ? ['-c', `windows.sandbox=${JSON.stringify(local.windowsSandbox)}`] : [])];
                const profileName = claim.profile.name;
                const appServer: AppServerPlan = {
                    threadId: claim.session.nativeSessionId, prompt: wakePrompt(claim),
                    outputSchema: isLurkRun(claim) ? null : resultSchema, model, effort, sandbox: perms.codex.sandbox,
                    refresh: async () => (await siwcToken(config, profileName, true)).accessToken,
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
        return { executable: local.executable, args, env, cwd: workspace.cwd, workspace, adapter: local.adapter, stdin: wakePrompt(claim), cleanup, lurk: isLurkRun(claim),
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
