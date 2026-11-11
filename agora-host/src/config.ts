import { readFile, access, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { presetSchema } from './presets.js';
import { VERIFY_COMMAND } from './verify.js';
import { NEMOCLAW_SANDBOX } from './nemoclaw.js';
import { API_KEY_ENVS, apiKeyEnvAllowed, DEVIN_SUBSCRIPTION_ONLY, GEMINI_SUBSCRIPTION_REFUSAL, HostConfigError, NEMOCLAW_API_KEY_ONLY, OMP_ACP_ONLY, OPENCODE_ACP_ONLY, OPENROUTER_ADAPTERS, type Adapter } from './terms.js';

const absolute = z.string().refine(isAbsolute, 'must be an absolute path');
const executable = absolute.refine(p => !/\.(cmd|bat|ps1)$/i.test(p), 'use a native executable, not a shell shim');
const tool = z.enum(['chat_history', 'chat_read', 'chat_send', 'channel_list', 'thread_start', 'thread_list',
    'thread_close', 'who_directs', 'file_search', 'file_read', 'session_start', 'session_end', 'session_list', 'session_wake', 'session_lurk',
    'file_reserve', 'file_renew', 'file_release', 'file_reservations', 'project_context', 'canvas_publish', 'canvas_read', 'browser_preview']);
/**
 * opencode and omp run only over ACP on an OpenRouter key, and Devin only over ACP (`devin acp`)
 * on the owner's own Devin login, so those are their defaults.
 */
function acpDefaults(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object') return raw;
    const p = raw as Record<string, unknown>;
    if (p.adapter === 'devin') return { ...p, protocol: p.protocol ?? 'acp', acpArgs: p.acpArgs ?? ['acp'] };
    if (!OPENROUTER_ADAPTERS.has(p.adapter as Adapter)) return raw;
    return { ...p, protocol: p.protocol ?? 'acp', acpArgs: p.acpArgs ?? ['acp'], auth: p.auth ?? 'api_key',
        ...(p.apiKeyEnv === undefined && (p.auth ?? 'api_key') === 'api_key' ? { apiKeyEnv: 'OPENROUTER_API_KEY' } : {}) };
}
const profile = z.preprocess(acpDefaults, z.object({
    // gemini, opencode and omp run only with protocol "acp" and an API key, devin only over ACP
    // on the owner's login (terms.ts, acp/session.ts)
    adapter: z.enum(['codex', 'claude', 'gemini', 'opencode', 'omp', 'devin', 'nemoclaw']), workdir: absolute, workdirAlias: z.string().min(1),
    executable, stateDir: absolute,
    sandbox: z.enum(['read-only', 'workspace-write']).default('workspace-write'),
    // Codex's Windows sandbox mode. --ignore-user-config drops the user's [windows] sandbox
    // setting, and without one Codex rejects every shell command, so the host sets it.
    windowsSandbox: z.enum(['elevated', 'unelevated']).default('elevated'),
    approvedTools: z.array(tool).default([]),
    caps: z.object({ maxTokens: z.number().int().positive().optional(), maxBudgetUsd: z.number().positive().optional() }).strict().default({}),
    allowUntestedVersion: z.boolean().default(false),
    // Devin on a machine only: run it although no logged-in turn has yet shown that its file edits
    // reach agora-host's approvals (terms.ts DEVIN_HOST_UNVERIFIED). Never needed in a box.
    allowUnverifiedApprovals: z.boolean().default(false),
    // How the CLI signs in (docs/provider-terms.md): its own account login, an API key
    // read from this host's environment variable `apiKeyEnv` and passed to the child, or
    // (codex only) a ChatGPT plan through Sign in with ChatGPT (docs/codex-chatgpt-plan.md).
    auth: z.enum(['subscription', 'api_key', 'siwc']).default('subscription'),
    apiKeyEnv: z.string().optional(),
    // Gemini only: run on a Google account login anyway, with owner approval of every run
    allowSubscriptionAtOwnRisk: z.boolean().default(false),
    // Every wake waits for the owner to approve it on a card in the channel
    requireRunApproval: z.boolean().default(false),
    // Verify before yield (verify.ts): the exact commands this host may run in a session
    // worktree when a channel's owner asks for one. Without this, no verify command runs.
    verify: z.object({
        commands: z.array(z.string().max(300).refine(command => VERIFY_COMMAND.test(command),
            "verify commands are plain words separated by single spaces, and the first word can't be a .cmd or .bat file")).max(20),
        timeoutSeconds: z.number().int().min(10).max(3600).default(600),
    }).strict().optional(),
    // "acp": drive an Agent Client Protocol agent (gemini --acp, claude-code-acp, codex-acp, opencode acp, devin acp) over
    // JSON-RPC on its stdio instead of the CLI's own headless mode (acp/session.ts)
    protocol: z.enum(['cli', 'acp']).default('cli'),
    // Fixed local arguments for the ACP agent, e.g. ["--acp"]; Agora never supplies any
    acpArgs: z.array(z.string().min(1).max(1000).regex(/^[^\r\n\0]*$/)).max(20).default([]),
    // Agent boxes (box.ts): pass HTTPS_PROXY/HTTP_PROXY/NO_PROXY to the CLI. Written only by
    // `agora-host box-config`, and ignored outside box mode.
    proxyEnv: z.boolean().default(false),
    // NemoClaw on this machine (nemoclaw.ts): the sandbox each wake runs in, the HTTPS URL of
    // Agora's MCP endpoint as the sandbox reaches it (docs/mcp-http.md), whether that host is a
    // private address NemoClaw must be told to trust (a tailnet name), and on Windows the WSL
    // distro and the nemoclaw path in it (the profile's executable is then wsl.exe).
    nemoclaw: z.object({
        sandbox: z.string().regex(NEMOCLAW_SANDBOX, 'a NemoClaw sandbox name: 1-19 lowercase letters, digits and single hyphens'),
        mcpUrl: z.string().url().refine(s => { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; },
            'mcpUrl must be an https URL without credentials, query or fragment (NemoClaw takes only HTTPS)'),
        trustPrivateHost: z.boolean().default(false),
        wsl: z.object({ distro: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), nemoclawPath: z.string().regex(/^\/[^\0\r\n]*$/, 'an absolute path inside the distro') }).strict().optional(),
    }).strict().optional(),
}).strict().superRefine((p, ctx) => {
    if (p.adapter === 'nemoclaw') {
        // On a machine (a nemoclaw block) the key is the sandbox's; in a box it is NVIDIA_API_KEY
        if (p.protocol !== 'cli' || p.auth !== 'api_key' || (p.nemoclaw ? p.apiKeyEnv !== undefined : p.apiKeyEnv !== 'NVIDIA_API_KEY'))
            ctx.addIssue({ code: 'custom', message: NEMOCLAW_API_KEY_ONLY });
        if (p.nemoclaw?.wsl && !/(^|[\\/])wsl\.exe$/i.test(p.executable))
            ctx.addIssue({ code: 'custom', message: 'nemoclaw.wsl needs the profile executable to be wsl.exe' });
    } else if (p.nemoclaw) ctx.addIssue({ code: 'custom', message: 'the nemoclaw block applies only to a nemoclaw profile' });
    if (p.auth === 'api_key' && p.adapter !== 'devin' && p.adapter !== 'nemoclaw' && (!p.apiKeyEnv || !apiKeyEnvAllowed(p.adapter, p.apiKeyEnv)))
        ctx.addIssue({ code: 'custom', message: `auth "api_key" needs apiKeyEnv set to one of ${API_KEY_ENVS[p.adapter].join(', ')}${OPENROUTER_ADAPTERS.has(p.adapter) ? ' or OPENROUTER_API_KEY_<NAME>' : ''} for ${p.adapter}` });
    if (p.auth !== 'api_key' && p.apiKeyEnv !== undefined && p.adapter !== 'nemoclaw')
        ctx.addIssue({ code: 'custom', message: 'apiKeyEnv is only used with auth "api_key"' });
    if (p.auth === 'siwc' && p.adapter !== 'codex')
        ctx.addIssue({ code: 'custom', message: 'auth "siwc" (Sign in with ChatGPT) is only for codex profiles' });
    if (p.auth === 'siwc' && p.protocol === 'acp')
        ctx.addIssue({ code: 'custom', message: 'auth "siwc" runs codex app-server; use protocol "cli"' });
    if (p.allowSubscriptionAtOwnRisk && (p.adapter !== 'gemini' || p.auth !== 'subscription'))
        ctx.addIssue({ code: 'custom', message: 'allowSubscriptionAtOwnRisk applies only to a gemini profile with auth "subscription"' });
    if (p.protocol !== 'acp' && p.acpArgs.length) ctx.addIssue({ code: 'custom', message: 'acpArgs is only used with protocol "acp"' });
    // Agora never hosts a Google account login, not even at the operator's own risk
    if (p.adapter === 'gemini' && p.protocol === 'acp' && p.auth !== 'api_key')
        ctx.addIssue({ code: 'custom', message: 'a hosted gemini profile must use auth "api_key" (GEMINI_API_KEY); Agora never runs Gemini on a Google account login' });
    // docs/provider-terms.md: only the unmodified official CLI may run on a personal login. ACP
    // agents are other clients (claude-agent-acp wraps the Agent SDK; codex-acp embeds Codex's
    // core and reads the login itself), so they need an API key.
    if (p.protocol === 'acp' && p.adapter === 'claude' && p.auth === 'subscription')
        ctx.addIssue({ code: 'custom', message: 'Claude over ACP (claude-agent-acp, the Agent SDK) must use auth "api_key" (ANTHROPIC_API_KEY); a Claude subscription is for the unmodified claude CLI (protocol "cli") or the Claude Channel, see docs/provider-terms.md' });
    if (p.protocol === 'acp' && p.adapter === 'codex' && p.auth === 'subscription')
        ctx.addIssue({ code: 'custom', message: 'Codex over ACP (codex-acp) must use auth "api_key" (CODEX_API_KEY or OPENAI_API_KEY); codex-acp is not the official codex binary and reads the ChatGPT login itself, so use protocol "cli" for a subscription, see docs/provider-terms.md' });
    // opencode has no login of its own to host, and Agora never lets it fall back to OpenCode Zen
    if (p.adapter === 'opencode' && (p.protocol !== 'acp' || p.auth !== 'api_key')) ctx.addIssue({ code: 'custom', message: OPENCODE_ACP_ONLY });
    // omp: an OpenRouter key only (never its subscription logins), and only the host's own
    // arguments: `--yolo` or `--approval-mode` in acpArgs would turn its approvals off (acp/omp.ts)
    if (p.adapter === 'omp' && (p.protocol !== 'acp' || p.auth !== 'api_key' || p.acpArgs.length !== 1 || p.acpArgs[0] !== 'acp'))
        ctx.addIssue({ code: 'custom', message: OMP_ACP_ONLY });
    // Devin: its own ACP server on the owner's own login (docs/provider-terms.md, "Devin")
    if (p.adapter === 'devin' && (p.protocol !== 'acp' || p.auth !== 'subscription')) ctx.addIssue({ code: 'custom', message: DEVIN_SUBSCRIPTION_ONLY });
    if (p.allowUnverifiedApprovals && p.adapter !== 'devin') ctx.addIssue({ code: 'custom', message: 'allowUnverifiedApprovals applies only to a devin profile' });
    // For opencode the cap is the OpenRouter key's own credit limit (README, "opencode and OpenRouter")
    if (p.protocol === 'acp' && p.caps.maxBudgetUsd !== undefined) ctx.addIssue({ code: 'custom', message: 'ACP has no verified USD cap' });
    if (p.caps.maxTokens !== undefined) ctx.addIssue({ code: 'custom', message: 'Neither verified CLI supports a hard per-run token cap; omit maxTokens explicitly' });
    if (p.adapter === 'codex' && p.caps.maxBudgetUsd !== undefined) ctx.addIssue({ code: 'custom', message: 'Codex has no verified USD cap' });
}));
export const configSchema = z.object({
    instance: z.string().url().refine(s => { const u = new URL(s); return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/'; }, 'instance must be an HTTP(S) origin'),
    hostToken: z.string().regex(/^ah_[^\s]+$/),
    mcp: z.object({ executable, entrypoint: absolute }).strict(),
    profiles: z.record(z.string().min(1), profile), botTokens: z.record(z.string(), z.string().regex(/^bot_[^\s]+$/)),
    maxConcurrent: z.number().int().min(1).max(16).default(2),
    // Redefine a built-in tool preset (readonly, dev, research) or add one (#73)
    presets: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), presetSchema).default({}),
    // How long a Codex app-server approval waits for its tool-request card before it is denied (#93)
    approvalWaitSeconds: z.number().int().min(10).max(3600).default(300),
    // Sign in with ChatGPT (auth "siwc"): where this host keeps its host id and credentials
    // (default ~/.agora-host/siwc) and the loopback callback port (0: any free port)
    siwc: z.object({ dir: absolute.optional(), callbackPort: z.number().int().min(0).max(65535).default(1455) }).strict().prefault({}),
    // Browser preview (src/preview.ts): a local Chromium/Chrome/Edge, and each session gets
    // portsPerSession ports from portBase up for the dev servers it wants screenshotted
    preview: z.object({
        browser: executable, stateDir: absolute,
        portBase: z.number().int().min(1024).max(65000).default(42000),
        portsPerSession: z.number().int().min(1).max(100).default(10),
        slots: z.number().int().min(1).max(1000).default(100),
    }).strict().refine(p => p.portBase + p.slots * p.portsPerSession - 1 <= 65535, 'preview ports must end at or below 65535').optional(),
}).strict();
export type Config = z.infer<typeof configSchema>;
export type LocalProfile = Config['profiles'][string];

export async function loadConfig(path: string): Promise<Config> {
    // Never include input values (which may be credentials) in validation errors.
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Cannot read host JSON configuration'); }
    const result = configSchema.safeParse(parsed);
    // Custom issue messages are fixed text from this file, never input values
    if (!result.success) throw new HostConfigError(`Invalid host config (${result.error.issues.map(i => i.code === 'custom' ? i.message : i.code).join(', ')})`);
    const config = result.data;
    for (const [name, p] of Object.entries(config.profiles)) {
        if (p.adapter === 'gemini' && p.auth === 'subscription' && !p.allowSubscriptionAtOwnRisk)
            throw new HostConfigError(`Profile "${name}": ${GEMINI_SUBSCRIPTION_REFUSAL}`);
        // The variable's name is printed, never its value
        if (p.auth === 'api_key' && p.apiKeyEnv !== undefined && !process.env[p.apiKeyEnv]?.trim())
            throw new HostConfigError(`Profile "${name}" uses auth "api_key" but ${p.apiKeyEnv} is not set in the host's environment`);
    }
    for (const p of Object.values(config.profiles)) {
        await access(p.executable); await access(p.workdir);
        if (!(await stat(p.workdir)).isDirectory()) throw new Error('Configured workdir is not a directory');
    }
    await access(config.mcp.executable); await access(config.mcp.entrypoint);
    if (config.preview) await access(config.preview.browser);
    const states = Object.values(config.profiles).map(p => resolve(p.stateDir).toLowerCase());
    if (new Set(states).size !== states.length) throw new Error('Each profile must have its own CLI stateDir');
    return config;
}
