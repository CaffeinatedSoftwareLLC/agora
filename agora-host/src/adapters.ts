import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile, unlink, rmdir } from 'node:fs/promises';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config, LocalProfile } from './config.js';
import type { Claim, Result } from './types.js';
import { isLurkRun, wakePrompt } from './prompt.js';
import { ensureWorkspace, git, type Workspace } from './workspaces.js';
import { handoffNotes } from './handoff.js';
import { CODEX_WORDS, resolvePermissions, type Permissions } from './presets.js';
import { detectSignals } from './signals.js';
import { ACP_API_KEY_METHODS, checkTerms, DEVIN_HOST_UNVERIFIED, DEVIN_SUBSCRIPTION_ONLY, GEMINI_NOT_HOSTED, HostConfigError, OMP_ACP_ONLY, OPENCODE_ACP_ONLY, opencodeProvider, OPENROUTER_ADAPTERS, TermsRefusal, type Adapter, type SiwcRunError } from './terms.js';
import { accessToken, type AccessToken } from './siwc/session.js';
import { SiwcError } from './siwc/oauth.js';
import { DEFAULT_DIR } from './siwc/store.js';
import { PROVIDER_ARGS, type AppServerPlan } from './siwc/appserver.js';
import { sessionPorts } from './preview.js';
import { probeAcp, SESSION_ID, type AcpPlan } from './acp/session.js';
import { geminiPolicy } from './acp/permissions.js';
import { OMP_HOST_APPROVAL, ompArgs, ompDirs, ompModel, ompSettings } from './acp/omp.js';
import { CODEX_BOX_QUIET, inBox, proxyVars } from './box.js';
import { BOX_ADAPTERS, boxAdapter } from './box-adapters.js';
import { NEMOCLAW_BOX_ONLY, NEMOCLAW_HOST_ONLY, NEMOCLAW_WAKE_NOTE, nemoclawAgentArgs, nemoclawCommand, nemoclawEnv, openclawBoxConfig, openclawExecArgs, OPENCLAW_SESSION_ID, openclawSessionId, openclawVersion, verifyNemoclaw, type NemoclawSettings } from './nemoclaw.js';

export interface Launch {
    lurk?: boolean;
    workspace?: Workspace;
    executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string;
    adapter: Adapter; cleanup(): Promise<void>;
    /** Codex's sandbox for this run, so denials can be read from its output. */
    sandbox?: 'read-only' | 'workspace-write';
    /** Preset names the claim used that this host doesn't define. */
    unknownPresets?: string[];
    /** auth "siwc": drive `codex app-server` on a ChatGPT plan instead of `codex exec`. */
    appServer?: AppServerPlan;
    /** protocol "acp": one ACP session turn instead of the CLI's headless mode. */
    acp?: AcpPlan;
    /** nemoclaw: the OpenClaw session this turn runs in, kept when its output names none. */
    openclawSession?: string;
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
/** opencode keeps its config, logins, sessions and caches in the XDG directories, on every OS. */
const OPENCODE_DIRS = { XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state' } as const;
/**
 * opencode 1.18 switches. The worktree's own opencode.json and .opencode/ could add MCP servers,
 * plugins (code opencode runs at start) or providers, so project config is off; so are external
 * plugins, the user's ~/.claude skills and prompts, sharing, update checks and LSP downloads.
 */
const OPENCODE_FLAGS = ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_PURE', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_EXTERNAL_SKILLS',
    'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_SHARE', 'OPENCODE_DISABLE_LSP_DOWNLOAD'];
/**
 * Devin (3000.11) keeps its config, MCP servers, login, sessions and logs in the XDG directories
 * on Linux and macOS (the same layout as opencode's). On Windows it ignores those, and APPDATA on
 * its own, and uses %USERPROFILE%\AppData\{Roaming,Local}\devin; so its child gets a home of its
 * own in the state directory, with APPDATA and LOCALAPPDATA inside it, and HOME there too (checked
 * on 3000.11.234: with the owner logged in, `devin auth status` in that environment says "Not
 * logged in"). Git keeps the user's identity through GIT_CONFIG_GLOBAL (childEnv).
 */
export function devinDirs(stateDir: string, platform = process.platform): Record<string, string> {
    if (platform !== 'win32') return Object.fromEntries(Object.entries(OPENCODE_DIRS).map(([name, dir]) => [name, posix.join(stateDir, dir)]));
    const home = win32.join(stateDir, 'home');
    return { USERPROFILE: home, HOME: home, APPDATA: win32.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: win32.join(home, 'AppData', 'Local') };
}
/** Make Devin's own directories (Windows Devin fails to start without its profile folders). */
export async function ensureDevinDirs(profile: LocalProfile, platform = process.platform): Promise<void> {
    for (const dir of new Set(Object.values(devinDirs(profile.stateDir, platform)))) await mkdir(dir, { recursive: true, mode: 0o700 });
}
/** Every source Devin would import settings, rules, skills, hooks or MCP servers from (its docs: read_config_from). */
const DEVIN_IMPORTS = ['agents_standard', 'cursor', 'windsurf', 'claude', 'copilot', 'opencode', 'zed', 'cloud'] as const;
/**
 * Permission rules, as Devin's own reference (bundled with 3000.11.234, docs/reference/
 * permissions.mdx) spells them: whole tools by name (`read`, `edit`, `grep`, `glob`, `exec`, the
 * only tool names it accepts) and paths with `Write(glob)`, which covers both the `edit` and the
 * `write` tool; an absolute `/**` reaches files outside the working directory, a bare `**` the
 * ones in it. Devin's loader takes any string without a word (a typo is silently no rule, checked
 * on 3000.11.234), so these come from the reference, and its own example mixes the two forms in
 * one `ask` list. There is no catch-all rule; anything no rule decides prompts in Code mode
 * except edits in the workspace, which the `edit` and `Write` asks cover.
 */
const DEVIN_TOOLS = ['read', 'edit', 'grep', 'glob', 'exec'] as const;
const DEVIN_WRITES = ['Write(**)', 'Write(/**)'] as const;
/** Devin's web tools (from the 3000.11.234 binary): a search and a fetch that may run on Devin's side, around the edge. */
export const DEVIN_WEB_TOOLS = ['web_search', 'webfetch'] as const;
/**
 * The Devin user config for one run (`devin --config <file> acp`, which replaces the user's own
 * ~/.config/devin/config.json with its permission rules and hooks). No auto-update, no OTel
 * export, and no imports: by default Devin loads Claude Code's, Cursor's, Windsurf's, opencode's,
 * Zed's and Copilot's MCP servers, rules, skills and hooks, and its Devin Cloud ones (it started
 * the Claude Code MCP servers of the user it ran as when tried).
 *
 * On a machine every tool asks (`ask` rules come before the session mode, Devin's "Code" mode,
 * which would otherwise let workspace edits through), so acp/session.ts answers each request from
 * the claim's rules and a denial becomes an approval card. That an edit really reaches the host
 * this way is not yet seen with a logged-in Devin, so host mode needs `allowUnverifiedApprovals`
 * (DEVIN_HOST_UNVERIFIED). The Agora tools the owner always allows are allowed here, since Devin
 * names an MCP call its own way. `.devin/` can't be written: a hooks file there would run
 * commands at the next session start (devinProjectConfig).
 *
 * `boxed` (yeet mode in an agent box): every tool allowed in Devin's own rules, the web tools
 * denied there, and the session stays in Code mode rather than bypass, so whatever Devin still
 * asks reaches the host, which allows it unless it is a web tool (acp/session.ts allowAllExcept).
 */
export function devinConfig(boxed: boolean, agoraTools: readonly string[] = []): string {
    const base = { auto_update: false, read_config_from: Object.fromEntries(DEVIN_IMPORTS.map(k => [k, false])), otel: { enabled: false }, permission_mode: 'normal' };
    return `${JSON.stringify(boxed
        ? { ...base, permissions: { allow: [...DEVIN_TOOLS, ...DEVIN_WRITES, 'mcp__agora__*'], deny: [...DEVIN_WEB_TOOLS] } }
        : { ...base, permissions: {
            allow: [...new Set(agoraTools)].map(t => `mcp__agora__${t}`),
            ask: [...DEVIN_TOOLS, ...DEVIN_WRITES],
            deny: ['Write(.devin/**)', 'Write(**/.devin/**)', 'Write(/**/.devin/**)'],
        } }, null, 2)}\n`;
}
/** The ACP session mode every Devin turn runs in, set again on a resumed session: "Code". */
export const DEVIN_SESSION_MODE = 'accept-edits';
export const DEVIN_PROJECT_CONFIG =
    'This Devin agent did not start: there is a .devin folder in its worktree or a folder above it. Devin runs the hooks and MCP servers in .devin/ without asking, '
    + 'so agora-host runs Devin on a machine only where there is none. Remove it, or run the agent in a box.';
async function present(path: string) { try { await lstat(path); return true; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } }
/**
 * Whether Devin could find project config for this worktree: a `.devin` folder in it or in any
 * folder above it up to the filesystem root (the user's home included), or one anywhere in its
 * tracked or untracked files. Devin runs project hooks at session start without a permission
 * request, whatever the user config says (checked on 3000.11.234: a `.devin/hooks.v1.json` in the
 * worktree ran with every import off; one above the repository root or in $HOME did not, but
 * that is Devin's discovery rule today, not a promise), so on a machine such a worktree is
 * refused. Other tools' project files (`.claude/settings.json` hooks, `.mcp.json`,
 * `.cursor/mcp.json`, `.windsurf/`, `opencode.json`, `.zed/`) did not load with every
 * `read_config_from` source off, so they need no refusal. In a box the box is the sandbox.
 */
export async function devinProjectConfig(cwd: string): Promise<boolean> {
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
        if (await present(join(dir, '.devin'))) return true;
        if (dirname(dir) === dir) break;
    }
    return (await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(glob)**/.devin/**'])).length > 0;
}
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
/** Tests replace this; agora-host otherwise asks the file system. */
export const gitConfigExists = { check: (path: string) => existsSync(path) };
/**
 * The user's global git config on Windows: `%USERPROFILE%\.gitconfig`, or git's XDG location
 * `%USERPROFILE%\.config\git\config` when only that exists. Null when the user has neither (or
 * no profile folder is known): git then runs without one.
 */
export function userGitConfig(userProfile: string | undefined, files: { check(path: string): boolean } = gitConfigExists): string | null {
    // A drive or UNC path only: `/c/Users/...` (a Git Bash HOME) is rooted but not a Windows profile folder
    if (!userProfile || !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(userProfile)) return null;
    for (const path of [win32.join(userProfile, '.gitconfig'), win32.join(userProfile, '.config', 'git', 'config')]) if (files.check(path)) return path;
    return null;
}
/** Set a variable, replacing it under any spelling (Windows variable names ignore case). */
function setVar(env: NodeJS.ProcessEnv, name: string, value: string) {
    for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key];
    env[name] = value;
}
const getVar = (env: NodeJS.ProcessEnv, name: string) => Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1];
export function childEnv(profile: LocalProfile, source: NodeJS.ProcessEnv = process.env, platform = process.platform): NodeJS.ProcessEnv {
    const env = osEnv(source, platform);
    // Each CLI keeps its settings and login in the profile's stateDir. For Gemini that also keeps
    // the user's own ~/.gemini (and any Google login cached there) out of hosted runs; for
    // opencode the user's ~/.config/opencode and the logins under ~/.local/share/opencode.
    if (profile.adapter === 'opencode') {
        for (const [name, dir] of Object.entries(OPENCODE_DIRS)) env[name] = join(profile.stateDir, dir);
        for (const name of OPENCODE_FLAGS) env[name] = '1';
    } else if (profile.adapter === 'devin') {
        // Devin's config, MCP servers, login and sessions: the user's own stay out of hosted runs.
        // On Windows its home is in the state directory too; git still finds the user's identity
        // (from the user's own profile folder, read before it is redirected: a HOME set by Git Bash
        // can be /c/Users/...)
        if (platform === 'win32') {
            const gitconfig = userGitConfig(getVar(env, 'USERPROFILE'), gitConfigExists);
            if (gitconfig) setVar(env, 'GIT_CONFIG_GLOBAL', gitconfig);
        }
        for (const [name, dir] of Object.entries(devinDirs(profile.stateDir, platform))) setVar(env, name, dir);
    } else if (profile.adapter === 'omp') Object.assign(env, ompEnv(profile, source));
    else if (profile.adapter === 'nemoclaw') {
        // On a machine NemoClaw keeps its sandboxes in the user's own ~/.nemoclaw, so HOME stays;
        // nothing of the agent's lives on this side of the sandbox
    } else env[STATE_DIR_ENV[profile.adapter]] = profile.stateDir;
    // A profile's stateDir can be the user's own CLI folder (Codex runs often share it), so the
    // user's agora-mcp hooks may be configured there. They must never act in a hosted run: Stop
    // would keep a headless run going (docs/claude-code-hooks.md). Codex hands hooks the
    // environment it was started with. AGORA_HOOKS turns all agora-mcp hooks off (0.8.1);
    // AGORA_STOP_HOOK is what a 0.8.0 Stop hook knows.
    env.AGORA_HOOKS = 'off';
    env.AGORA_STOP_HOOK = 'off';
    // api_key mode: only this profile's key variable, never logged (docs/provider-terms.md).
    // The codex CLI (0.163 `exec`, no login in CODEX_HOME) reads only CODEX_API_KEY and ignores
    // OPENAI_API_KEY (#165), so it always gets the key under that name. codex-acp keeps the
    // configured name: its `openai-api-key` / `codex-api-key` methods each read their own (terms.ts).
    if (profile.auth === 'api_key' && profile.apiKeyEnv) {
        const key = source[profile.apiKeyEnv];
        // opencode and omp read only OPENROUTER_API_KEY, whichever OPENROUTER_API_KEY_<NAME> holds this agent's key
        const name = profile.adapter === 'codex' && profile.protocol !== 'acp' ? 'CODEX_API_KEY'
            : OPENROUTER_ADAPTERS.has(profile.adapter) ? opencodeProvider(profile.apiKeyEnv)?.env ?? profile.apiKeyEnv : profile.apiKeyEnv;
        if (key) env[name] = key;
    }
    // In an agent box the CLI reaches allowed domains only through the edge's proxy (box.ts)
    if (profile.proxyEnv && inBox(source)) {
        Object.assign(env, proxyVars(source));
        // In a box only the allowlisted hosts answer: no telemetry, error reports or update checks
        // to be blocked (each would be an approval card), and the CLI is pinned in the image anyway
        // (each adapter's switches: box-adapters.ts `quiet.env`)
        const box = boxAdapter(profile.adapter);
        Object.assign(env, box?.quiet.env ?? {});
        // Its own local server stays off the proxy (box-adapters.ts `noProxy`)
        if (box?.noProxy.length) {
            const noProxy = [...new Set([...(env.NO_PROXY ?? '').split(','), ...box.noProxy].map(h => h.trim()).filter(Boolean))].join(',');
            env.NO_PROXY = noProxy; env.no_proxy = noProxy;
        }
    }
    return env;
}
/**
 * oh-my-pi's folders and switches (acp/omp.ts): its agent folder (settings, sessions, the
 * agent.db that would hold a login) in the profile's state directory, and on a machine a home
 * folder there too, so omp never reads the user's ~/.env, ~/.omp or a login saved there. Git
 * still finds the user's identity (~/.gitconfig). In a box the box's home stays (its git
 * identity and npm prefix); it holds nothing but what the box made.
 */
function ompEnv(profile: LocalProfile, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const dirs = ompDirs(profile.stateDir);
    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: dirs.agent, OTEL_SDK_DISABLED: 'true', PI_NO_TITLE: '1' };
    if (!inBox(source)) {
        const home = source.HOME ?? source.USERPROFILE;
        const gitconfig = home ? join(home, '.gitconfig') : null;
        if (gitconfig && existsSync(gitconfig)) env.GIT_CONFIG_GLOBAL = gitconfig;
        env.HOME = dirs.home; env.USERPROFILE = dirs.home;
    }
    return env;
}

/** The switches and settings overlay the start-up probe runs omp with, as every run gets them (acp/omp.ts). */
export function ompProbeArgs(profile: LocalProfile, settingsFile: string, boxed = inBox()): string[] {
    return [...profile.acpArgs, ...(boxed ? ['--yolo'] : OMP_HOST_APPROVAL), '--no-extensions', '--no-skills', '--no-rules', '--config', settingsFile];
}

/** The Devin versions this host was tested with: 3000.11.x (Devin ships every few days). */
export const DEVIN_TESTED = /^3000\.11\.\d+$/;
export async function verifyProfile(profile: LocalProfile): Promise<string> {
    if (profile.adapter === 'nemoclaw') {
        await mkdir(profile.stateDir, { recursive: true, mode: 0o700 });
        if (profile.nemoclaw) return verifyNemoclaw(profile as LocalProfile & { nemoclaw: NemoclawSettings }, childEnv(profile));
        // The box form: OpenClaw itself, pinned in the box image (box-adapters.ts)
        if (!inBox()) throw new HostConfigError(NEMOCLAW_BOX_ONLY);
        const { stdout } = await promisify(execFile)(profile.executable, ['--version'], { env: childEnv(profile), cwd: profile.stateDir, windowsHide: true, timeout: 10000, maxBuffer: 4096 });
        const version = openclawVersion(stdout);
        if (!version || (!testedCliVersion('nemoclaw', version) && !profile.allowUntestedVersion)) throw new Error('unsupported_cli_version');
        return `openclaw ${version}`;
    }
    if (profile.adapter === 'omp') {
        // omp is pinned (it releases every few days): its version is checked as well as ACP's,
        // started outside the worktree as every run is (acp/omp.ts)
        const dirs = ompDirs(profile.stateDir);
        await mkdir(dirs.home, { recursive: true, mode: 0o700 }); await mkdir(dirs.agent, { recursive: true, mode: 0o700 });
        const settingsFile = join(dirs.home, 'omp-probe.yml');
        const boxed = inBox();
        await writeFile(settingsFile, JSON.stringify(ompSettings({ boxed, restricted: [dirs.agent, dirs.home] })), { mode: 0o600 });
        const probe = await probeAcp({ executable: profile.executable, args: ompProbeArgs(profile, settingsFile, boxed), cwd: profile.workdir, spawnCwd: dirs.home, env: childEnv(profile) });
        const version = probe.split(' ')[1] ?? '';
        if (!testedCliVersion('omp', version) && !profile.allowUntestedVersion) throw new Error('unsupported_cli_version');
        return probe;
    }
    if (profile.adapter === 'devin') {
        if (profile.protocol !== 'acp' || profile.auth !== 'subscription') throw new HostConfigError(DEVIN_SUBSCRIPTION_ONLY);
        if (!inBox() && !profile.allowUnverifiedApprovals) throw new HostConfigError(DEVIN_HOST_UNVERIFIED);
        // Its ACP server calls itself 0.0.0-dev, so the CLI's own version is the gate, then ACP v1.
        // Both run in the state directory: nothing in the owner's workdir is Devin's project there
        await mkdir(profile.stateDir, { recursive: true, mode: 0o700 });
        await ensureDevinDirs(profile);
        const env = childEnv(profile);
        const { stdout } = await promisify(execFile)(profile.executable, ['--version'], { env, cwd: profile.stateDir, windowsHide: true, timeout: 10000, maxBuffer: 4096 });
        const version = /\bdevin (\d+\.\d+\.\d+)\b/.exec(stdout)?.[1];
        if (!version || (!testedCliVersion('devin', version) && !profile.allowUntestedVersion)) throw new Error('unsupported_cli_version');
        // The probe starts no session, but gets a run's config, so nothing is imported or updated
        const probeConfig = join(profile.stateDir, 'devin-probe.json');
        await writeFile(probeConfig, devinConfig(inBox()), { mode: 0o600 });
        return `devin ${version}, ${await probeAcp({ executable: profile.executable, args: ['--config', probeConfig, ...profile.acpArgs], cwd: profile.stateDir, env })}`;
    }
    // ACP: the protocol version is the gate, not the CLI's version string
    if (profile.protocol === 'acp') return probeAcp({ executable: profile.executable, args: profile.acpArgs, cwd: profile.workdir, env: childEnv(profile) });
    if (profile.adapter === 'gemini') throw new HostConfigError(GEMINI_NOT_HOSTED);
    if (profile.adapter === 'opencode') throw new HostConfigError(OPENCODE_ACP_ONLY);
    const { stdout } = await promisify(execFile)(profile.executable, ['--version'], {
        env: childEnv(profile), cwd: profile.workdir, windowsHide: true, timeout: 10000, maxBuffer: 4096,
    });
    const version = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
    if (!version || (!testedCliVersion(profile.adapter, version[0]) && !profile.allowUntestedVersion)) throw new Error('unsupported_cli_version');
    return version[0];
}

/**
 * The CLI versions this host was tested with: Codex 0.163.x, Claude Code 2.1.x, oh-my-pi 18.17.0
 * exactly (it releases every few days, and the provider, discovery and tool lists in acp/omp.ts
 * are that version's; checked from its ACP agentInfo, verifyProfile). The box image's
 * pins (box-adapters.ts) must pass it; agora-host/test/box.test.ts checks that they do.
 */
export function testedCliVersion(adapter: string, version: string): boolean {
    const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!v) return false;
    return adapter === 'codex' ? v[1] === '0' && v[2] === '163' : adapter === 'claude' ? v[1] === '2' && v[2] === '1'
        : adapter === 'omp' ? version === '18.17.0' : adapter === 'devin' ? DEVIN_TESTED.test(version)
            // nemoclaw in a box runs OpenClaw itself (box-adapters.ts); on a machine NemoClaw's version is checked (nemoclaw.ts)
            : adapter === 'nemoclaw' ? version === '2026.11.3' : false;
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

/**
 * The opencode model ID for a profile's model: `provider/model`. An OpenRouter ID as OpenRouter
 * writes it (`qwen/qwen3-coder`) gets the `openrouter/` prefix opencode lists it under.
 */
export function opencodeModel(model: string, provider: string): string {
    return model.toLowerCase().startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

/**
 * opencode's inline config (OPENCODE_CONFIG_CONTENT, which overrides every config file but a
 * managed one). Only the key's provider is enabled, so opencode can't fall back to another
 * provider or to OpenCode Zen; the profile's model is also the small model (titles), so every
 * call is billed to the model the owner picked. Every tool asks, and acp/session.ts answers
 * from the claim's rules, except its own to-do list, which touches nothing outside the session.
 *
 * `boxed` (yeet mode in an agent box, box-adapters.ts): the box is the sandbox, so every tool is
 * allowed without asking, except web and code search (Exa): they would go through the edge like
 * anything else, but a box has no open web and searches through Agora, so they are off as Claude's
 * WebSearch is. The real way around the edge is a provider-side search model (OpenRouter
 * `:online`), refused for box agents in prepare() and by Agora.
 */
export function opencodeConfig(model: string, provider: string, boxed = false): string {
    return JSON.stringify({ model, small_model: model, enabled_providers: [provider], share: 'disabled', autoupdate: false,
        permission: boxed ? { '*': 'allow', websearch: 'deny', codesearch: 'deny' } : { '*': 'ask', todowrite: 'allow', todoread: 'allow' } });
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
    const { effort } = claim.profile;
    let { model } = claim.profile;
    if (effort !== null && efforts && !efforts.includes(effort)) throw new Error('unsupported_effort');
    // opencode's own default would be an OpenCode Zen model, so an opencode profile names its model
    const provider = local.adapter === 'opencode' ? opencodeProvider(local.apiKeyEnv)?.provider ?? null : null;
    if (local.adapter === 'opencode') {
        if (!provider) throw new HostConfigError(OPENCODE_ACP_ONLY);
        if (model === null) throw new Error('opencode_model_required');
        model = opencodeModel(model, provider);
    }
    // omp has OpenRouter only (acp/omp.ts), so its model is an OpenRouter model, named
    if (local.adapter === 'omp') {
        if (opencodeProvider(local.apiKeyEnv)?.provider !== 'openrouter') throw new HostConfigError(OMP_ACP_ONLY);
        if (model === null) throw new Error('omp_model_required');
        model = ompModel(model);
    }
    // In a box, no OpenRouter `:online` model: it searches the web on the provider's side, which
    // the edge never sees (Agora refuses one at box creation too)
    if (inBox() && model !== null && /:online$/i.test(model)) throw new Error('box_model_not_allowed');
    // ACP session IDs are the agent's own; the CLIs use UUIDs
    const nativeId = acp ? SESSION_ID : local.adapter === 'nemoclaw' ? OPENCLAW_SESSION_ID : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (claim.session.nativeSessionId && !nativeId.test(claim.session.nativeSessionId)) throw new Error('invalid_native_session_id');
    await mkdir(local.stateDir, { recursive: true, mode: 0o700 });
    const workspace = await ensureWorkspace(local, claim);
    // Handoff offers: is the sender's pinned commit here, and how to apply it (handoff.ts)
    const handoffs = await handoffNotes(claim, workspace.cwd);
    const dir = await mkdtemp(join(local.stateDir, 'run-'));
    const paths = ['mcp.json', 'mcp.toml', 'schema.json', 'policy.toml', 'omp.yml', 'devin.json', 'openclaw.json'].map(p => join(dir, p));
    const cleanup = async () => {
        // Only remove these known files and the empty directory we created; no recursive deletion.
        await Promise.all(paths.map(p => unlink(p).catch(() => {})));
        await rmdir(dir).catch(() => {});
    };
    // Presets and allowed tools come with every claim (#73): no restart after an edit
    const rules = [...claim.profile.allowedTools, ...claim.run.grantedTools];
    const perms = resolvePermissions(local.sandbox, claim.profile.toolPresets, rules, config.presets);
    // Box mode (box.ts, docs/agent-boxes.md §8.1): the box is the sandbox, so the CLI runs with
    // its own sandbox and permission prompts off (box-adapters.ts `yeet`). Both the box flag and
    // the image's marker file are needed; never on a machine.
    const yeet = inBox();
    const box = yeet ? boxAdapter(local.adapter) : null;
    const allowAll = !!box?.yeet.acpAllowAll && acp;
    try {
        if (local.adapter === 'nemoclaw') {
            // OpenClaw has its own thinking levels, and no verified mapping from Agora's efforts
            if (effort !== null) throw new Error('unsupported_effort');
            const sessionId = openclawSessionId(claim);
            if (!OPENCLAW_SESSION_ID.test(sessionId)) throw new Error('invalid_native_session_id');
            if (local.nemoclaw) {
                if (yeet) throw new HostConfigError(NEMOCLAW_HOST_ONLY);
                // The agent is in its own sandbox: no worktree, browser preview or MCP config on
                // this side, and no bot token in its environment (OpenShell holds it, nemoclaw.ts)
                const text = prompt ?? wakePrompt(claim, undefined, undefined, [NEMOCLAW_WAKE_NOTE, ...handoffs]);
                const cmd = nemoclawCommand(local, nemoclawAgentArgs(local.nemoclaw, sessionId, model, claim.run.timeoutSeconds));
                return { ...cmd, env: nemoclawEnv(local, childEnv(local)), cwd: local.stateDir, workspace, adapter: 'nemoclaw', stdin: text, cleanup,
                    lurk: isLurkRun(claim), unknownPresets: perms.unknownPresets, openclawSession: sessionId };
            }
            if (!yeet || !box) throw new HostConfigError(NEMOCLAW_BOX_ONLY);
            // In a box: one `openclaw agent exec` turn in the worktree. It can't continue a
            // session, so every wake starts fresh with the session's summary (wakePrompt). Agora's
            // tools come from the stdio agora-mcp through the box's edge, as for every box adapter.
            const env = childEnv(local);
            await repoFreePath(env, [workspace.cwd, workspace.workdir, local.workdir]);
            const server = { command: config.mcp.executable, args: [config.mcp.entrypoint, '--no-presence'] };
            await writeFile(paths[6], openclawBoxConfig(server, { AGORA_INSTANCE: config.instance, AGORA_BOT_TOKEN: token,
                AGORA_DEFAULT_CHANNEL: claim.session.channelId, AGORA_HOOKS: 'off', AGORA_STOP_HOOK: 'off' }), { mode: 0o600 });
            const rules = await readFile(join(local.stateDir, box.state.rulesFile), 'utf8').catch(() => '');
            const wake = prompt ?? wakePrompt({ ...claim, session: { ...claim.session, nativeSessionId: null } }, undefined, workspace.branch, handoffs);
            return { executable: local.executable, args: openclawExecArgs(paths[6], workspace.cwd, model, claim.run.timeoutSeconds), env, cwd: workspace.cwd,
                workspace, adapter: 'nemoclaw', stdin: rules.trim() ? `${rules.trim()}\n\n${wake}` : wake, cleanup, lurk: isLurkRun(claim), unknownPresets: perms.unknownPresets };
        }
        // This session's own preview ports: the only ones browser_preview will load
        const ports = config.preview ? await sessionPorts(config.preview, claim.session.id, new Set([...active, claim.session.id])) : undefined;
        const env: NodeJS.ProcessEnv = { ...childEnv(local), AGORA_INSTANCE: config.instance, AGORA_BOT_TOKEN: token, AGORA_DEFAULT_CHANNEL: claim.session.channelId,
            ...(ports ? { AGORA_PREVIEW_PORTS: `${ports.first}-${ports.last}` } : {}),
            ...(provider && model ? { OPENCODE_CONFIG_CONTENT: opencodeConfig(model, provider, allowAll) } : {}) };
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
                ...(allowAll ? { allowAll: true } : {}),
                // In a box, the requests the box still refuses (Devin's web tools, box-adapters.ts)
                ...(allowAll && box?.yeet.acpDeny ? { allowAllExcept: { names: [...box.yeet.acpDeny.names], kinds: [...box.yeet.acpDeny.kinds] } } : {}),
            };
            // In a box, after the ACP arguments: the adapter's yeet and quiet arguments (box-adapters.ts)
            let args = box ? [...local.acpArgs, ...box.yeet.args, ...box.quiet.args] : local.acpArgs;
            const policy = local.adapter === 'gemini' ? geminiPolicy(acpRules) : '';
            if (policy) { await writeFile(paths[3], policy, { mode: 0o600 }); args = [...args, '--policy', paths[3]]; }
            if (local.adapter === 'omp') {
                // Its settings overlay for this run and its switches (acp/omp.ts). On a machine its
                // approval prompts come as elicitations the host answers. It starts in its own home
                // folder (a restricted folder), so the worktree's .env is never read.
                const own = ompDirs(local.stateDir);
                await mkdir(own.home, { recursive: true, mode: 0o700 });
                await writeFile(paths[4], JSON.stringify(ompSettings({ boxed: !!box, restricted: [own.agent, own.home, dir] })), { mode: 0o600 });
                args = [...local.acpArgs, ...ompArgs({ approval: box ? [...box.yeet.args, ...box.quiet.args] : OMP_HOST_APPROVAL, settingsFile: paths[4], model: model!,
                    ...(box ? { rulesFile: join(local.stateDir, box.state.rulesFile) } : {}) })];
                acpPlan.spawnCwd = own.home;
                if (!box) acpPlan.elicitation = 'omp';
            }
            if (local.adapter === 'devin') {
                // On a machine: only with the owner's opt-in to unverified approvals, and never in a
                // worktree with Devin project config (its hooks run unasked)
                if (!yeet && !local.allowUnverifiedApprovals) throw new HostConfigError(DEVIN_HOST_UNVERIFIED);
                if (!yeet && await devinProjectConfig(workspace.cwd)) throw new HostConfigError(DEVIN_PROJECT_CONFIG);
                await ensureDevinDirs(local);
                // `--config` is a global option, so it comes before `acp`
                await writeFile(paths[5], devinConfig(allowAll, local.approvedTools), { mode: 0o600 });
                args = ['--config', paths[5], ...args];
                acpPlan.sessionMode = DEVIN_SESSION_MODE;
            }
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
                args = ['app-server', '--listen', 'stdio://', ...PROVIDER_ARGS, ...(yeet ? CODEX_BOX_QUIET : []),
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
            // Box mode (box.ts, docs/agent-boxes.md §8.1): the box is the sandbox, so Codex runs
            // with its own sandbox and approvals off. Presets don't apply inside a box; web search
            // stays off because a box has no open web (§4.2). Never on a machine.
            const codexBox = BOX_ADAPTERS.codex;
            const policy = yeet ? [...codexBox.yeet.args, '-c', `mcp_servers=${mcp}`, ...codexBox.yeet.noOpenWeb, ...codexBox.quiet.args]
                : ['-s', perms.codex.sandbox, '-c', 'approval_policy="never"', '-c', `mcp_servers=${mcp}`,
                    ...(perms.codex.network ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
                    ...(perms.codex.webSearch ? ['-c', 'web_search="live"'] : []),
                    ...(process.platform === 'win32' ? ['-c', `windows.sandbox=${JSON.stringify(local.windowsSandbox)}`] : [])];
            args = ['exec', '--ignore-user-config', ...policy,
                ...(model !== null ? ['-m', model] : []),
                ...(effort !== null ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
                ...(claim.session.nativeSessionId ? ['resume', claim.session.nativeSessionId] : []),
                '--json', ...(!isLurkRun(claim) ? ['--output-schema', paths[2]] : []), '-'];
        } else {
            const allowed = [...new Set([...local.approvedTools.map(t => `mcp__agora__${t}`), ...perms.claude])];
            // Box mode: no permission prompts and every tool but WebSearch, which would reach the
            // open web around the edge (docs/agent-boxes.md §4.2, §8.1). Never on a machine.
            const claudeBox = BOX_ADAPTERS.claude;
            const policy = yeet ? [...claudeBox.yeet.args, ...claudeBox.yeet.noOpenWeb, ...claudeBox.quiet.args]
                : ['--permission-mode', 'manual', '--permission-prompts', 'none'];
            args = ['-p', '--output-format', 'stream-json', '--verbose', ...policy,
                '--strict-mcp-config', '--mcp-config', paths[0],
                ...(model !== null ? ['--model', model] : []),
                ...(effort !== null ? ['--effort', effort] : []),
                ...(!isLurkRun(claim) ? ['--json-schema', JSON.stringify(resultSchema)] : []),
                ...(!yeet && allowed.length ? ['--allowedTools', allowed.join(',')] : []),
                ...(local.caps.maxBudgetUsd !== undefined ? ['--max-budget-usd', String(local.caps.maxBudgetUsd)] : []),
                ...(claim.session.nativeSessionId ? ['--resume', claim.session.nativeSessionId] : [])];
        }
        return { executable: local.executable, args, env, cwd: workspace.cwd, workspace, adapter: local.adapter, stdin: prompt ?? wakePrompt(claim, ports, workspace.branch, handoffs), cleanup, lurk: isLurkRun(claim),
            ...(local.adapter === 'codex' && !yeet ? { sandbox: perms.codex.sandbox } : {}), unknownPresets: perms.unknownPresets };
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
