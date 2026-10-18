import { z } from 'zod';
import { TOOL_RULE } from './types.js';

/**
 * Tool presets (#73). The owner picks presets per agent in Settings → Agents; every claim
 * carries the profile's preset names, its "always allowed" rules and this run's one-time
 * grants. The host turns them into each CLI's own allow mechanism, so a new permission
 * needs neither a settings edit nor a restart:
 *
 * - Claude: `--allowedTools` rules (Claude Code permission-rule syntax).
 * - Codex: the sandbox mode, workspace network access and live web search. Codex has no
 *   per-command allow list in `exec` mode, so its rules are the capability words
 *   `write`, `network` and `web_search`, plus Agora MCP tools (`mcp__agora__<tool>`).
 *
 * The host's config may redefine a preset or add new ones (`presets` in host.local.json).
 */

export const presetSchema = z.object({
    claude: z.array(z.string().regex(TOOL_RULE)).max(100).default([]),
    codex: z.object({
        sandbox: z.enum(['read-only', 'workspace-write']).optional(),
        network: z.boolean().optional(),
        webSearch: z.boolean().optional(),
    }).strict().default({}),
}).strict();
export type Preset = z.infer<typeof presetSchema>;

const READ = ['Read', 'Glob', 'Grep'];
export const BUILTIN_PRESETS: Record<string, Preset> = {
    // Look, don't touch: read files and git history
    readonly: { claude: [...READ, 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'], codex: { sandbox: 'read-only' } },
    // Edit the workdir and use git, gh and npm
    dev: {
        claude: [...READ, 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash(git:*)', 'Bash(gh:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)',
            'PowerShell(git:*)', 'PowerShell(gh:*)', 'PowerShell(npm:*)', 'PowerShell(npx:*)', 'PowerShell(node:*)'],
        codex: { sandbox: 'workspace-write', network: true },
    },
    // Search the web and read pages
    research: { claude: ['WebSearch', 'WebFetch'], codex: { network: true, webSearch: true } },
};

/** Rules that only mean something to Codex; never passed to Claude. */
const CODEX_WORDS = new Set(['write', 'network', 'web_search']);

export interface Permissions {
    /** Claude `--allowedTools` rules, beyond the Agora MCP tools in `approvedTools`. */
    claude: string[];
    codex: { sandbox: 'read-only' | 'workspace-write'; network: boolean; webSearch: boolean; mcpTools: string[] };
    /** Preset names this host doesn't define; logged, never fatal. */
    unknownPresets: string[];
}

/**
 * Resolve the claim's presets and rules for one profile. Without any preset the profile's
 * local `sandbox` stays in charge (the behaviour before presets existed).
 */
export function resolvePermissions(defaultSandbox: 'read-only' | 'workspace-write', presetNames: string[], rules: string[],
                                   overrides: Record<string, Preset> = {}): Permissions {
    const defs = { ...BUILTIN_PRESETS, ...overrides };
    const claude = new Set<string>();
    const unknownPresets: string[] = [];
    let write = false; let network = false; let webSearch = false;
    for (const name of presetNames) {
        const preset = Object.prototype.hasOwnProperty.call(defs, name) ? defs[name] : undefined;
        if (!preset) { unknownPresets.push(name); continue; }
        for (const rule of preset.claude) claude.add(rule);
        write ||= preset.codex.sandbox === 'workspace-write';
        network ||= !!preset.codex.network;
        webSearch ||= !!preset.codex.webSearch;
    }
    const mcpTools: string[] = [];
    for (const rule of rules) {
        if (!TOOL_RULE.test(rule)) continue;
        if (!CODEX_WORDS.has(rule)) claude.add(rule);
        if (rule === 'write') write = true;
        else if (rule === 'network') network = true;
        else if (rule === 'web_search' || rule === 'WebSearch') webSearch = true;
        else if (/^mcp__agora__[a-z_]+$/.test(rule)) mcpTools.push(rule.slice('mcp__agora__'.length));
    }
    const known = presetNames.length > unknownPresets.length;
    const sandbox = write ? 'workspace-write' : known ? 'read-only' : defaultSandbox;
    return { claude: [...claude], codex: { sandbox, network: network && sandbox === 'workspace-write', webSearch, mcpTools }, unknownPresets };
}
