import { isAbsolute, join } from 'node:path';
import type { ToolCallInfo } from './permissions.js';

/**
 * oh-my-pi (`omp acp`, github.com/can1357/oh-my-pi, MIT): what the host passes it and how its
 * approval prompts are answered (README, "oh-my-pi"; docs/provider-terms.md).
 *
 * omp is permissive by default, so every run gets a settings overlay (`--config`, which outranks
 * the worktree's own project settings) and fixed arguments:
 * - **API key only.** Every model provider but OpenRouter is disabled (`disabledProviders` is
 *   checked before any credential, so a stored Claude, ChatGPT, Copilot, Cursor or Devin login
 *   could never be used), and the host never calls omp's `authenticate`.
 * - **Nothing from the repository runs.** Every config discovery source is disabled (the
 *   worktree's `.omp/`, `.claude/`, `.codex/`, ... settings, hooks, custom tools, extensions,
 *   rules, MCP servers), extensions, skills and rules are off, and omp starts in its own home
 *   folder (in its state directory), not the worktree, so the repository's `.env` is never loaded. Only the
 *   worktree's AGENTS.md is read, as instructions.
 * - **No non-essential traffic:** no update check or install, OTLP export, auto-QA reports,
 *   Spotlight experiment or Exa search; web search and the browser are denied tools.
 * - **On a machine** (host mode): `--approval-mode always-ask`. Shell commands, deletes and
 *   moves come as `session/request_permission`; writes, edits, reads, searches and Agora tools
 *   as `elicitation/create` prompts (`Allow tool: <name>`), which acp/session.ts answers from
 *   the claim's rules through ompApproval() below. omp's own folders and the run's are
 *   restricted folders, so the agent can't rewrite its own settings. Only the tools the host can
 *   judge exist (`--tools`, OMP_HOST_TOOLS), and no language server starts (`--no-lsp`: omp
 *   would run the worktree's own lsp.json and node_modules/.bin servers after a write).
 * - **In a box**: `--yolo`; the box is the sandbox (docs/agent-boxes.md §8.1).
 */


/** omp 18.17's model providers (packages/catalog provider-ids), all disabled but OpenRouter. */
const MODEL_PROVIDERS = ['abliteration', 'aiand', 'aimlapi', 'alibaba-coding-plan', 'alibaba-token-plan', 'amazon-bedrock', 'anthropic', 'apple',
    'azure', 'baseten', 'bedrock-mantle', 'cerebras', 'charm-hyper', 'cline-pass', 'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'commandcode',
    'coralbricks', 'coreweave', 'cursor', 'deepinfra', 'deepseek', 'devin', 'factory-droid', 'firepass', 'fireworks', 'github-copilot', 'gitlab-duo',
    'gitlab-duo-agent', 'gmi-cloud', 'google', 'google-antigravity', 'google-gemini-cli', 'google-vertex', 'groq', 'helmcode', 'huggingface',
    'inception', 'kilo', 'kimi-code', 'litellm', 'llama.cpp', 'lm-studio', 'local', 'meta', 'minimax', 'minimax-code', 'minimax-code-cn', 'mistral', 'modular',
    'moonshot', 'muse-code', 'nanogpt', 'novita', 'nvidia', 'ollama', 'ollama-cloud', 'openai', 'openai-codex', 'opencode-go', 'opencode-zen',
    'qianfan', 'qwen-portal', 'sakana', 'sambanova', 'scaleway', 'siliconflow', 'siliconflow-cn', 'singularityapi-dev', 'singularityapi-tech',
    'snowflake', 'stepfun', 'synthetic', 'together', 'typesafe', 'umans', 'venice', 'vercel-ai-gateway', 'vllm', 'wafer-serverless', 'web', 'xai',
    'xai-oauth', 'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'yolo-auto', 'zai', 'zenmux', 'zhipu-coding-plan'] as const;
/** omp 18.17's config discovery sources, all disabled but `agents-md` (AGENTS.md, text only). */
const DISCOVERY_SOURCES = ['agent-plugins', 'agents', 'claude', 'claude-md', 'claude-plugins', 'cline', 'codex', 'cursor', 'custom-context', 'gemini',
    'github', 'mcp-json', 'native', 'omp-plugins', 'opencode', 'skillshare', 'ssh-json', 'vscode', 'windsurf'] as const;
/** Tools that reach around the box edge or the host's approvals, denied in every mode. */
const DENIED_TOOLS = ['web_search', 'browser', 'computer'] as const;
/**
 * On a machine omp gets only the tools the host can judge (`--tools`, an allowlist; Agora's MCP
 * tools come on top): its shell, file and search tools and its to-do list. Everything else is
 * also denied by name, in case a tool slips past the list: subagents (`task`, which run without
 * prompts), LSP (language servers from the repository's own config and node_modules), `github`
 * (the user's gh login), `eval`, `debug`, checkpoints and the rest.
 */
export const OMP_HOST_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'find', 'todo'] as const;
const HOST_DENIED_TOOLS = ['task', 'lsp', 'github', 'debug', 'eval', 'checkpoint', 'rewind', 'ssh', 'ida', 'learn', 'manage_skill', 'memory_edit',
    'security_scan', 'ask', 'vibe_spawn', 'vibe_send', 'vibe_kill', 'vibe_list', 'vibe_wait', 'image_gen', 'tts', 'irc'] as const;
/** Read-tier tools omp would run without asking; on a machine they ask, so paths are checked. */
const HOST_PROMPTED_TOOLS = ['read', 'grep', 'glob', 'find', 'ast_grep'] as const;

/**
 * The settings overlay (`--config`) for one run. `restricted`: on a machine, omp's own folders
 * and the run's (its settings, its home, this overlay), where every action needs a person, so
 * the agent can't rewrite what the host gave it. Not the whole state directory: the session
 * worktrees live there too.
 */
export function ompSettings(o: { boxed: boolean; restricted: string[] }): Record<string, unknown> {
    const approval: Record<string, string> = Object.fromEntries(DENIED_TOOLS.map(t => [t, 'deny']));
    if (!o.boxed) {
        for (const t of HOST_DENIED_TOOLS) approval[t] = 'deny';
        for (const t of HOST_PROMPTED_TOOLS) approval[t] = 'prompt';
    }
    return {
        disabledProviders: [...MODEL_PROVIDERS, ...DISCOVERY_SOURCES],
        enabledProviders: [],
        startup: { checkUpdate: false },
        update: { auto: false },
        telemetry: { otlpExportEnabled: false },
        dev: { autoqa: false },
        spotlight: { experiment: { enabled: false } },
        exa: { enabled: false },
        mcp: { enableProjectConfig: false },
        // A repository's .envrc stays out of the agent's shell
        bash: { direnv: 'off' },
        // On a machine no language servers: their config (lsp.json in the worktree) and binaries
        // (node_modules/.bin, .venv) can be the repository's own, and omp starts them after writes
        ...(o.boxed ? {} : { lsp: { enabled: false, diagnosticsOnWrite: false, diagnosticsOnEdit: false, formatOnWrite: false } }),
        tools: {
            approvalMode: o.boxed ? 'yolo' : 'always-ask',
            // MCP tools (Agora's) as ordinary tools, not behind xd:// device paths
            xdev: false,
            approval,
            ...(o.boxed ? {} : { restrictedFolders: o.restricted }),
        },
    };
}

/** The model as omp names an OpenRouter model: `openrouter/<id>`. */
export function ompModel(model: string): string {
    return model.toLowerCase().startsWith('openrouter/') ? model : `openrouter/${model}`;
}

/**
 * On a machine every write, command and Agora tool asks, only the host's tools exist and no
 * language server starts; in a box the registry's `--yolo`.
 */
export const OMP_HOST_APPROVAL = ['--approval-mode', 'always-ask', '--no-lsp', '--tools', OMP_HOST_TOOLS.join(',')] as const;

/**
 * omp's arguments after `acp`: the approval mode, discovery off, the settings overlay, the
 * model for every role (so nothing falls back to another model), and in a box the box rules.
 */
export function ompArgs(o: { approval: readonly string[]; settingsFile: string; model: string; rulesFile?: string }): string[] {
    return [...o.approval,
        '--no-extensions', '--no-skills', '--no-rules', '--no-title', '--config', o.settingsFile,
        '--model', o.model, '--smol', o.model, '--slow', o.model, '--plan', o.model,
        ...(o.rulesFile ? ['--append-system-prompt', o.rulesFile] : [])];
}

/** omp's own folders, inside the profile's state directory (adapters.ts childEnv). */
export function ompDirs(stateDir: string) {
    return { home: join(stateDir, 'home'), agent: join(stateDir, 'agent') };
}

// ---- approval prompts (elicitation/create) on a machine

/** A tool call as acp/session.ts tracks it; `agentName` is the tool's own name as omp sent it. */
export interface OmpCall extends ToolCallInfo { status?: string; agentName?: string }

/**
 * omp's tool name (sent in its tool call updates) as the rule name the host matches: its shell
 * is `Bash`, Agora's tools `mcp__agora__<tool>`; its file tools are judged by their kind (Read,
 * Edit, Grep), so they have none; others keep their own name.
 */
export function ompRuleName(name: unknown): string | undefined {
    if (typeof name !== 'string') return undefined;
    if (name === 'bash') return 'Bash';
    const agora = /^mcp__agora_([a-z][a-z_]{0,63})$/.exec(name);
    if (agora) return `mcp__agora__${agora[1]}`;
    return ['read', 'write', 'edit', 'ast_edit', 'delete', 'move', 'grep', 'glob', 'find', 'ast_grep'].includes(name) ? undefined : name;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
/** A URL or omp internal URL (`xd://`, `artifact://`, `file:`...), or a Windows drive-relative path: never a worktree file. */
const NOT_A_FILE = /^(?:[A-Za-z][A-Za-z0-9+.-]+:|[A-Za-z]:(?![\\/]))/;
/**
 * What omp rewrites before it resolves a path (its resolveToCwd / expandPath): a leading `@`,
 * `:`, `~` or `!`, quotes; and path lists it splits on `;`, `,` and whitespace, running each
 * part. Any of them, or a `..` segment anywhere, and the host doesn't try to follow it.
 */
const REWRITTEN = /^[@:~!]|[\s;,"'`]|(?:^|[\\/])\.\.(?:[\\/]|$)/;
/** On Windows omp maps `/c/...` and `/mnt/c/...` to `C:\...`. */
const DRIVE_ALIAS = /^[\\/](?:mnt[\\/])?[A-Za-z](?:[\\/]|$)/;
/** `[path#ABCD]`, omp's hashline header around a write or edit target. */
const HASHLINE = /^\[(.+?)(?:#[0-9A-Fa-f]{4})?\]$/;

/**
 * A path the host can be sure omp resolves as it does: relative to the worktree or absolute,
 * after its hashline header (`[path#ABCD]`) is taken off, and with nothing omp would rewrite or
 * split (REWRITTEN); null for anything else, which is refused. Where omp would keep a bracketed
 * name as it is, it is relative, so inside the worktree either way. A read selector
 * (`a.ts:10-20`) only lengthens the last segment. The call's own absolute locations, which omp
 * resolved itself, are checked as well (ompApproval).
 */
export function plainPath(value: unknown, platform = process.platform): string | null {
    if (typeof value !== 'string' || !value || value.length > 4096 || CONTROL.test(value)) return null;
    let p = value;
    const header = HASHLINE.exec(p);
    if (header) p = header[1];
    // `…` is omp's mark for a path it shortened in a prompt
    if (!p || NOT_A_FILE.test(p) || REWRITTEN.test(p) || p.includes('…')) return null;
    if (platform === 'win32' && DRIVE_ALIAS.test(p)) return null;
    return p;
}

export type OmpVerdict =
    /** Judge this call (its locations are the paths omp will touch) against the rules. `id`: the waiting call it answers. */
    | { call: ToolCallInfo; id?: string }
    /** Refuse without a card: a prompt the host can't map to one call and its paths. */
    | { deny: string; id?: string };

/**
 * What an omp approval prompt (`elicitation/create` with `Allow tool: <name>` and an Approve /
 * Deny choice) asks about, for acp/session.ts to judge as it judges a permission request. The
 * prompt doesn't say which tool call it is for, so it must be the only pending call, of that
 * tool; anything else (parallel calls, a reason line such as a restricted folder, a path the
 * host can't read the way omp will) is refused. A refusal only costs the agent a retry.
 */
export function ompApproval(message: string, pending: Array<OmpCall & { id?: string }>): OmpVerdict {
    const verdict = judgeApproval(message, pending);
    // The call it was matched to is answered: acp/session.ts never matches it again
    return pending.length === 1 ? { ...verdict, id: pending[0].id } : verdict;
}

function judgeApproval(message: string, pending: OmpCall[]): OmpVerdict {
    const lines = message.split('\n');
    const head = /^Allow tool: ([A-Za-z0-9_.-]{1,128})$/.exec(lines[0] ?? '');
    if (!head) return { deny: 'Denied a prompt the host does not answer' };
    const tool = head[1];
    // Restricted folder (omp's state), a critical command, a forced prompt: never from rules
    if (lines.slice(1, 3).some(l => l.startsWith('Reason: '))) return { deny: `Denied ${tool}: omp marked it as needing a person` };
    if (pending.length !== 1) return { deny: `Denied ${tool}: more than one tool call was waiting` };
    const [call] = pending;
    const title = typeof call.title === 'string' ? call.title : '';
    const input = (call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}) as Record<string, unknown>;
    // omp names the tool in its updates; without that name, its title starts with it
    const ours = call.agentName !== undefined ? call.agentName === tool : title === tool || title.startsWith(`${tool}:`);
    if (!ours) return { deny: `Denied ${tool}: the waiting tool call is another one` };
    // Agora's tools: omp names them mcp__<server>_<tool>, the host only passes the agora server
    const agora = /^mcp__agora_([a-z][a-z_]{0,63})$/.exec(tool);
    if (agora) return { call: { kind: 'other', name: `mcp__agora__${agora[1]}`, rawInput: input } };
    // omp's own absolute locations for the call (it resolved them) must be inside too
    const own = (call.locations ?? []).filter((l): l is string => typeof l === 'string');
    if (own.some(l => !isAbsolute(l) || CONTROL.test(l))) return { deny: `Denied ${tool}: a path the host can't check` };
    const one = (p: string | null): OmpVerdict => (p ? { call: { kind: tool === 'read' ? 'read' : tool === 'write' ? 'edit' : 'search', locations: [p, ...own] } } : { deny: `Denied ${tool}: a path the host can't check` });
    switch (tool) {
        case 'write': return call.kind === 'edit' ? one(plainPath(input.path)) : { deny: 'Denied write' };
        case 'read': return one(plainPath(input.path));
        case 'edit': {
            // omp lists the files an edit writes (its own parse of the payload), one `File:` line
            // each. Every other line, a truncated path or an unknown one refuses it.
            const files = lines.slice(1).map(l => /^File: (.+)$/.exec(l)?.[1] ?? null);
            if (!files.length || files.some(f => f === null || f === '(unknown)')) return { deny: 'Denied edit: a path the host can\'t check' };
            const paths = files.map(f => plainPath(f));
            return paths.every(Boolean) ? { call: { kind: 'edit', locations: [...paths as string[], ...own] } } : { deny: 'Denied edit: a path the host can\'t check' };
        }
        case 'grep': case 'glob': case 'find': case 'ast_grep': {
            // A search runs in the worktree unless it names a root (`path`, `paths`; a list in one
            // string is refused by plainPath), or a glob pattern that starts at one: refused
            const roots: unknown[] = [];
            if (input.path !== undefined) roots.push(input.path);
            if (Array.isArray(input.paths)) roots.push(...input.paths);
            const pattern = typeof input.pattern === 'string' ? input.pattern : '';
            if ((tool === 'glob' || tool === 'find') && (isAbsolute(pattern) || REWRITTEN.test(pattern) || NOT_A_FILE.test(pattern))) return { deny: `Denied ${tool}: a pattern the host can't check` };
            const paths = roots.map(r => plainPath(r));
            if (paths.some(p => p === null)) return { deny: `Denied ${tool}: a path the host can't check` };
            return { call: { kind: 'search', name: 'Grep', locations: [...(paths.length ? paths as string[] : ['.']), ...own] } };
        }
        default: return { deny: `Denied ${tool}: not available to omp on a machine` };
    }
}

/** The Approve choice of an omp prompt (only the one-time one), or null. */
export function approveChoice(choices: unknown[]): string | null {
    return (choices.find(c => c === 'Approve' || c === 'Approve Once') as string | undefined) ?? null;
}
