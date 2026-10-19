import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
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

export interface ToolCallInfo { kind?: string | null; title?: string | null; name?: string | null; rawInput?: unknown; locations?: string[] }
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
        // A bare name is matched without its Windows extension. A path (`./git`, `C:/repo/git.exe`)
        // is never shortened to the name it ends with: only a rule naming that exact absolute path
        // matches it, and executableTrust() still refuses one inside the worktree or repository.
        if (!/[\\/]/.test(words[0])) words[0] = words[0].replace(/\.(exe|cmd|bat|com)$/i, '');
        else if (!path.isAbsolute(words[0])) return false;
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

const FILE_KINDS = new Set(['read', 'edit', 'delete', 'move']);
const FILE_TOOLS = new Set(['Read', ...EDIT_TOOLS]);
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

function within(root: string, target: string): boolean {
    const rel = path.relative(norm(root), norm(target));
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

/** Resolve links of the deepest existing ancestor, so a new file under a link is judged by where the link leads. */
async function realTarget(target: string): Promise<string> {
    let head = target; const tail: string[] = [];
    for (;;) {
        try { return path.join(await realpath(head), ...tail.reverse()); } catch {
            const parent = path.dirname(head);
            if (parent === head) return target;
            tail.push(path.basename(head)); head = parent;
        }
    }
}

/** Paths a file tool call says it touches: its locations and the path fields of its raw input. */
function pathsOf(call: ToolCallInfo): unknown[] {
    const out: unknown[] = [...(call.locations ?? [])];
    const input = (call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}) as Record<string, unknown>;
    for (const k of ['file_path', 'path', 'notebook_path', 'filePath']) if (input[k] !== undefined) out.push(input[k]);
    return out;
}

/**
 * Whether a file tool call stays inside the run's worktree. Read/Write rules say nothing about
 * where, so without this they would allow a CLI login file. A file call without a known
 * path, or with any path outside `cwd` (after resolving links), is not allowed. An execute call
 * must name a trusted executable (executableTrust). Other calls pass.
 */
export async function locationsInside(call: ToolCallInfo, cwd: string, ctx: Omit<ExecContext, 'cwd'> = {}): Promise<Trust> {
    if (call.kind === 'execute') return executableTrust(call, { ...ctx, cwd });
    const rule = ruleForCall(call);
    const bare = rule ? rule.replace(/\(.*$/, '') : '';
    const paths = pathsOf(call);
    const isFile = FILE_KINDS.has(call.kind ?? '') || FILE_TOOLS.has(bare);
    if (!isFile && !(call.kind === 'search' && paths.length)) return 'ok';
    if (!paths.length) return 'unknown';
    const root = await realTarget(path.resolve(cwd));
    for (const p of paths) {
        if (typeof p !== 'string' || !p || p.includes('\0')) return 'unknown';
        const abs = path.resolve(root, p);
        if (!within(root, abs) || !within(root, await realTarget(abs))) return 'outside';
    }
    return 'ok';
}

export type Trust = 'ok' | 'outside' | 'unknown' | 'untrusted';
export interface ExecContext {
    /** The run's worktree: the default cwd of every call. */
    cwd: string;
    /** Other directories whose files are the repository's, e.g. the profile's workdir. */
    roots?: string[];
    /** The claim's rules: a bare `Bash` grant allows any command, so it needs no executable check. */
    rules?: ReadonlySet<string>;
    /** The agent's environment, for PATH and PATHEXT (default: this process's). */
    env?: NodeJS.ProcessEnv;
}

const envVar = (env: NodeJS.ProcessEnv, name: string) => {
    const key = Object.keys(env).find(k => k.toUpperCase() === name);
    return key ? env[key] : undefined;
};
async function isFile(p: string) { try { return (await stat(p)).isFile(); } catch { return false; } }

/** Names a bare command can take on disk: Windows adds PATHEXT extensions. */
function candidates(name: string, env: NodeJS.ProcessEnv): string[] {
    if (process.platform !== 'win32') return [name];
    const exts = (envVar(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    const hasExt = exts.some(e => name.toLowerCase().endsWith(e.toLowerCase()));
    return [...(hasExt ? [name] : []), ...exts.map(e => name + e.toLowerCase())];
}

/**
 * Whether an execute call's program is one a command grant can mean (#111 review). A rule such
 * as `Bash(git status:*)` names a trusted program, not whatever file called `git` the repository
 * ships. So the program must resolve through absolute PATH entries outside the worktree and
 * repository; a relative path (`./git`, `bin\git.exe`) never does; an absolute path counts only
 * outside them (allowedCall() matches it only against a rule naming that exact path); and on
 * Windows, where a bare name is looked up in the current directory first, a same-named file
 * there refuses the call. A bare `Bash` grant already allows any command, so it passes.
 */
export async function executableTrust(call: ToolCallInfo, ctx: ExecContext): Promise<Trust> {
    if (ctx.rules?.has(toolName(call, 'Bash'))) return 'ok';
    const command = commandFor(call);
    // No narrow rule can allow these, so allowedCall() decides them alone
    if (!command || SHELL_SYNTAX.test(command)) return 'ok';
    const env = ctx.env ?? process.env;
    const input = (call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}) as Record<string, unknown>;
    const dirs = [path.resolve(ctx.cwd)];
    if (typeof input.cwd === 'string' && input.cwd && !input.cwd.includes('\0')) dirs.push(path.resolve(ctx.cwd, input.cwd));
    const roots = await Promise.all([...dirs, ...(ctx.roots ?? []).map(r => path.resolve(r))].map(realTarget));
    const inRepo = async (p: string) => {
        const real = await realTarget(p);
        return roots.some(r => within(r, p) || within(r, real));
    };
    const trusted = async (program: string): Promise<boolean> => {
        if (/[\\/]/.test(program)) return path.isAbsolute(program) && !(await inRepo(path.resolve(program)));
        const names = candidates(program, env);
        if (process.platform === 'win32') {
            for (const d of dirs) for (const n of names) if (await isFile(path.join(d, n))) return false;
        }
        for (const raw of (envVar(env, 'PATH') ?? '').split(path.delimiter)) {
            const entry = raw.replace(/^"(.*)"$/, '$1');
            // `.`, an empty entry or any other relative entry means the current directory: never trusted
            if (!entry || !path.isAbsolute(entry) || (await inRepo(entry))) continue;
            for (const n of names) {
                const p = path.join(entry, n);
                if (await isFile(p)) return !(await inRepo(p));
            }
        }
        return false;
    };
    // `["bash", "-lc", "<script>"]` is matched by its script (commandOf), but the shell runs too
    const argv = input.command ?? input.cmd;
    if (Array.isArray(argv) && typeof argv[0] === 'string' && !(await trusted(argv[0]))) return 'untrusted';
    return (await trusted(command.split(/\s+/)[0])) ? 'ok' : 'untrusted';
}
