import { TOOL_RULE } from '../types.js';
import { ruleFor } from '../signals.js';

/**
 * ACP permission requests (#73, #93). An ACP agent asks the client before a tool call it
 * may not run on its own (`session/request_permission`), with the call's kind and raw input.
 * The host answers from the claim's rules, never by asking anyone mid-turn:
 *
 * - allowed: the call matches a rule from the profile's presets, its "always" rules or a
 *   one-time grant → `allow_once`;
 * - otherwise → `reject_once`, and the rule that would allow it is reported as a denied tool,
 *   so Agora posts its usual approval card. Approving it lets the session's next run use it.
 *
 * Rules use Claude Code's permission-rule syntax for every ACP agent, since ACP describes
 * tool calls the same way for all of them: `Bash(git:*)`, `Edit`, `WebFetch(domain:host)`,
 * `mcp__agora__chat_send`. Codex's capability words still count: `write` allows edits,
 * `network` fetches and `web_search` searches.
 *
 * The host never picks `allow_always` or `reject_always`: those would be remembered by the
 * agent itself, outside Agora's control.
 */

export interface ToolCallInfo { kind?: string | null; title?: string | null; name?: string | null; rawInput?: unknown }
export interface PermissionOption { optionId: string; kind: string }

const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const MCP_TOOL = /^mcp__[A-Za-z0-9_-]{1,64}__[A-Za-z0-9_-]{1,64}$/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Anything that can chain, redirect or substitute: only a bare `Bash` rule allows these
const SHELL_SYNTAX = /[;&|<>`$(){}\r\n]/;
const SHELLS = /^(?:ba|z|da)?sh$|^(?:pwsh|powershell|cmd)(?:\.exe)?$/i;

/** The command line of an execute call, unwrapping `["bash", "-lc", "<script>"]`. */
export function commandOf(rawInput: unknown): string | null {
    const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
    const command = input.command ?? input.cmd;
    if (typeof command === 'string') return command.trim() || null;
    if (Array.isArray(command) && command.length > 0 && command.every(p => typeof p === 'string')) {
        const parts = command as string[];
        const program = parts[0].split(/[\\/]/).pop()!;
        if (SHELLS.test(program) && parts.length === 3 && /^(?:-l?c|\/c|-Command)$/i.test(parts[1])) return parts[2].trim() || null;
        return parts.join(' ').trim() || null;
    }
    return null;
}

/** An execute call's command: its raw input, else its title (Gemini titles a shell call with the command). */
function commandFor(call: ToolCallInfo): string | null {
    return commandOf(call.rawInput) ?? (typeof call.title === 'string' && call.title.trim() ? call.title.trim() : null);
}

function toolName(call: ToolCallInfo, fallback: string): string {
    return typeof call.name === 'string' && IDENT.test(call.name) ? call.name : fallback;
}

/** The rule to ask the owner for, or null when no safe rule describes this call. */
export function ruleForCall(call: ToolCallInfo): string | null {
    const named = typeof call.name === 'string' && (IDENT.test(call.name) || MCP_TOOL.test(call.name)) ? call.name : null;
    switch (call.kind) {
        case 'execute': {
            const tool = toolName(call, 'Bash');
            const command = commandFor(call);
            if (!command) return tool;
            // A compound command needs the whole shell; say so rather than ask for a narrow rule
            return SHELL_SYNTAX.test(command) ? tool : ruleFor(tool, { command });
        }
        case 'fetch': {
            const input = (call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}) as Record<string, unknown>;
            if (typeof input.url === 'string') return ruleFor(toolName(call, 'WebFetch'), { url: input.url });
            return typeof input.query === 'string' ? toolName(call, 'WebSearch') : toolName(call, 'WebFetch');
        }
        case 'edit': case 'delete': case 'move': return named ?? 'Edit';
        case 'read': return named ?? 'Read';
        case 'search': return named ?? 'Grep';
        default:
            if (named) return named;
            // claude-code-acp titles an MCP call with the tool's full name
            return typeof call.title === 'string' && MCP_TOOL.test(call.title) ? call.title : null;
    }
}

/** Whether the claim's rules allow this call. */
export function allowedCall(call: ToolCallInfo, rules: ReadonlySet<string>): boolean {
    const rule = ruleForCall(call);
    if (!rule) return false;
    if (rules.has(rule)) return true;
    const bare = rule.replace(/\(.*$/, '');
    if (call.kind === 'execute') {
        if (rules.has(bare)) return true;
        const command = commandFor(call);
        if (!command || SHELL_SYNTAX.test(command)) return false;
        const words = command.split(/\s+/);
        words[0] = words[0].split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat)$/i, '');
        const normalized = words.join(' ');
        // Prefix rules as Claude Code reads them: `Bash(git status:*)` allows `git status -s`
        for (const r of rules) {
            const m = /^([A-Za-z][A-Za-z0-9_]*)\((.+?)(:\*)?\)$/.exec(r);
            if (!m || m[1] !== bare) continue;
            if (m[3] ? normalized === m[2] || normalized.startsWith(`${m[2]} `) : normalized === m[2]) return true;
        }
        return false;
    }
    if (rules.has(bare)) return true;
    // `mcp__agora` allows every tool of that server
    if (MCP_TOOL.test(rule) && rules.has(rule.split('__').slice(0, 2).join('__'))) return true;
    if (EDIT_TOOLS.has(bare) || ['edit', 'delete', 'move'].includes(call.kind ?? '')) return rules.has('write');
    if (bare === 'WebFetch') return rules.has('network');
    if (bare === 'WebSearch') return rules.has('web_search');
    return false;
}

/** The ACP outcome for a decision: a one-time option, never a remembered one. */
export function outcome(options: PermissionOption[], allow: boolean) {
    const option = options.find(o => o.kind === (allow ? 'allow_once' : 'reject_once'));
    return option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
}

/** A rule worth reporting on an approval card. */
export const reportable = (rule: string | null): rule is string => !!rule && TOOL_RULE.test(rule);

/**
 * Gemini CLI asks for MCP calls without the tool's name (only a title built from the
 * arguments), so the host can't map those requests to rules. Instead it hands Gemini the
 * same rules as a policy file (`--policy`), as `--allowedTools` does for Claude Code:
 * Agora MCP tools, shell prefixes, edits, fetch and search. Anything else still comes back
 * as a permission request.
 */
export function geminiPolicy(rules: Iterable<string>): string {
    const blocks = new Set<string>();
    const allow = (fields: Record<string, string | string[]>) => blocks.add(['[[rule]]',
        ...Object.entries(fields).map(([k, v]) => `${k} = ${JSON.stringify(v)}`), 'decision = "allow"', 'priority = 900'].join('\n'));
    for (const r of rules) {
        let m: RegExpExecArray | null;
        if ((m = /^mcp__([A-Za-z0-9_-]{1,64})__([A-Za-z0-9_-]{1,64})$/.exec(r))) allow({ mcpName: m[1], toolName: m[2] });
        else if ((m = /^mcp__([A-Za-z0-9_-]{1,64})$/.exec(r))) allow({ mcpName: m[1], toolName: '*' });
        else if (r === 'Bash' || r === 'PowerShell') allow({ toolName: 'run_shell_command' });
        else if ((m = /^(?:Bash|PowerShell)\(([^()*]+):\*\)$/.exec(r))) allow({ toolName: 'run_shell_command', commandPrefix: m[1] });
        else if (EDIT_TOOLS.has(r) || r === 'write') allow({ toolName: ['replace', 'write_file'] });
        else if (r === 'WebFetch' || r === 'network') allow({ toolName: 'web_fetch' });
        else if (r === 'WebSearch' || r === 'web_search') allow({ toolName: 'google_web_search' });
    }
    return blocks.size ? `${[...blocks].join('\n\n')}\n` : '';
}
