import { readFile, access, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { presetSchema } from './presets.js';
import { VERIFY_COMMAND } from './verify.js';
import { API_KEY_ENVS, GEMINI_SUBSCRIPTION_REFUSAL, HostConfigError } from './terms.js';

const absolute = z.string().refine(isAbsolute, 'must be an absolute path');
const executable = absolute.refine(p => !/\.(cmd|bat|ps1)$/i.test(p), 'use a native executable, not a shell shim');
const tool = z.enum(['chat_history', 'chat_read', 'chat_send', 'channel_list', 'thread_start', 'thread_list',
    'thread_close', 'who_directs', 'file_search', 'file_read', 'session_start', 'session_end', 'session_list', 'session_wake', 'session_lurk',
    'file_reserve', 'file_renew', 'file_release', 'file_reservations', 'project_context', 'canvas_publish', 'canvas_read', 'browser_preview']);
const profile = z.object({
    // gemini runs only with protocol "acp" and an API key (terms.ts, acp/session.ts)
    adapter: z.enum(['codex', 'claude', 'gemini']), workdir: absolute, workdirAlias: z.string().min(1),
    executable, stateDir: absolute,
    sandbox: z.enum(['read-only', 'workspace-write']).default('workspace-write'),
    // Codex's Windows sandbox mode. --ignore-user-config drops the user's [windows] sandbox
    // setting, and without one Codex rejects every shell command, so the host sets it.
    windowsSandbox: z.enum(['elevated', 'unelevated']).default('elevated'),
    approvedTools: z.array(tool).default([]),
    caps: z.object({ maxTokens: z.number().int().positive().optional(), maxBudgetUsd: z.number().positive().optional() }).strict().default({}),
    allowUntestedVersion: z.boolean().default(false),
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
    // "acp": drive an Agent Client Protocol agent (gemini --acp, claude-code-acp, codex-acp) over
    // JSON-RPC on its stdio instead of the CLI's own headless mode (acp/session.ts)
    protocol: z.enum(['cli', 'acp']).default('cli'),
    // Fixed local arguments for the ACP agent, e.g. ["--acp"]; Agora never supplies any
    acpArgs: z.array(z.string().min(1).max(1000).regex(/^[^\r\n\0]*$/)).max(20).default([]),
}).strict().superRefine((p, ctx) => {
    if (p.auth === 'api_key' && (!p.apiKeyEnv || !API_KEY_ENVS[p.adapter].includes(p.apiKeyEnv)))
        ctx.addIssue({ code: 'custom', message: `auth "api_key" needs apiKeyEnv set to one of ${API_KEY_ENVS[p.adapter].join(', ')} for ${p.adapter}` });
    if (p.auth !== 'api_key' && p.apiKeyEnv !== undefined)
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
    if (p.protocol === 'acp' && p.caps.maxBudgetUsd !== undefined) ctx.addIssue({ code: 'custom', message: 'ACP has no verified USD cap' });
    if (p.caps.maxTokens !== undefined) ctx.addIssue({ code: 'custom', message: 'Neither verified CLI supports a hard per-run token cap; omit maxTokens explicitly' });
    if (p.adapter === 'codex' && p.caps.maxBudgetUsd !== undefined) ctx.addIssue({ code: 'custom', message: 'Codex has no verified USD cap' });
});
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
    siwc: z.object({ dir: absolute.optional(), callbackPort: z.number().int().min(0).max(65535).default(1455) }).strict().default({}),
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
        if (p.auth === 'api_key' && !process.env[p.apiKeyEnv!]?.trim())
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
