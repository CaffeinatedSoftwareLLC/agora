/**
 * A real agora-host running REAL agent CLIs (Claude Code, Codex, Gemini over ACP) against the
 * e2e API, for the agent E2E of beta-test-plan §3. It wraps the fake host's building blocks
 * (lib/fake-host.ts: build from this checkout with provenance, tree kill, temp cleanup).
 *
 * Isolation (§3.1), enforced here rather than documented:
 * - Profiles are `auth: "api_key"` only. A `subscription` or `siwc` profile is refused before
 *   anything is registered or started (`assertApiKeyOnly`), and the generated config is checked
 *   again before it is written (`checkHostConfig`).
 * - Every profile gets a fresh, empty temp `stateDir` (CLAUDE_CONFIG_DIR / CODEX_HOME /
 *   GEMINI_CLI_HOME point there, never at ~/.claude, ~/.codex, ~/.gemini). They are asserted
 *   empty right before the host starts, and deleted with the whole temp folder by stop().
 * - Keys: `AGORA_TEST_*_KEY` (lib/agent-keys.ts) go into the agora-host child's environment
 *   under the provider's own name, and only there. The test runner's process.env never gets
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY; every provider variable it may have is
 *   stripped from what the child inherits.
 * - Workdir: a throwaway git repo per run with a tiny Node project (one function with a bug,
 *   one failing `node --test` test, an index.html). Never the Agora checkout.
 * - Caps: wake budget 10, token budget 200,000, run timeout 300 s on every server profile;
 *   `caps.maxBudgetUsd: 0.50` on Claude CLI profiles. Models come from E2E_MODEL_CLAUDE /
 *   E2E_MODEL_CODEX / E2E_MODEL_GEMINI (required in live mode, no defaults).
 *
 * Mode "fake" (E2E_AGENT_FAKE=1 or `mode: 'fake'`) points every profile at the fake CLI
 * (fake-cli/fake-claude.mjs, adapter claude) with dummy key values, so the whole harness can be
 * exercised with no provider and no spend.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Api } from './api';
import { artifactsDir, e2eEnv, SECRETS_DIR } from './env';
import { addSecretsToSeed, buildLauncher, ensureBuilt, git, HOST_DIR, killTree, MCP_DIR, rmrf, waitFor } from './fake-host';
import { liveGate, PROVIDER_ENVS, providerKeyEnv, testKey, type AgentAdapter } from './agent-keys';
import { Sensitive } from './sensitive';
import type { Seed } from './seed-types';

export type AgentMode = 'live' | 'fake';
export type AuthMode = 'api_key' | 'subscription' | 'siwc';

/** §3.1 caps, applied to every server profile (and maxBudgetUsd to Claude CLI profiles). */
export const AGENT_CAPS = { wakeBudget: 10, tokenBudget: Number(process.env.E2E_AGENT_SESSION_BUDGET ?? 200_000), runTimeoutSec: 300, claudeMaxBudgetUsd: 0.5 } as const;

export const MODEL_VARS: Record<AgentAdapter, string> = { claude: 'E2E_MODEL_CLAUDE', codex: 'E2E_MODEL_CODEX', gemini: 'E2E_MODEL_GEMINI' };

/** MCP tools every profile may call without asking (agora-host config `approvedTools`). */
const APPROVED_TOOLS = ['chat_history', 'chat_read', 'chat_send', 'thread_start', 'thread_list', 'who_directs', 'project_context',
    'file_search', 'file_read', 'file_reserve', 'file_renew', 'file_release', 'file_reservations', 'canvas_publish', 'canvas_read'];

export interface AgentProfileSpec {
    /** Short key (lowercase letters/digits): agent name `<key>-e2e-<tag>`. */
    key: string;
    adapter: AgentAdapter;
    /** Server-side tool presets (#73). Default ['dev'] so the agent can edit and run node/npm. */
    toolPresets?: string[];
    /** Server-side always-allowed rules, e.g. mcp__agora__subtask_start. */
    allowedTools?: string[];
    /** Host verify.commands for this profile. */
    verifyCommands?: string[];
    /** Only for the harness refusal test: anything but api_key is refused. */
    auth?: AuthMode;
}
export interface AgentHostOptions {
    label: string;
    profiles: AgentProfileSpec[];
    mode: AgentMode;
    preview?: { browser: string; portBase: number; portsPerSession?: number };
    /** Fake mode only: the dummy value to give each provider variable (default: random dummies). */
    dummyKeys?: Partial<Record<string, string>>;
}
export interface HostedAgent {
    key: string; adapter: AgentAdapter; name: string; profileId: string; botId: string; token: string; stateDir: string;
    /** The provider variable the host gives this profile's CLI. */
    apiKeyEnv: string;
    bot: Api;
    /** The session worktree agora-host creates: <stateDir>/wt-<last 10 of the session id>. */
    worktree(sessionId: string): string;
}
export interface AgentHost {
    mode: AgentMode; tag: string; serverId: string; hostId: string; hostName: string;
    agents: Record<string, HostedAgent>;
    root: string; workdir: string; initialMainSha: string; previewStateDir: string | null;
    /** Names of the provider variables set in the agora-host child's environment (never values). */
    childKeyNames: string[];
    log(): string;
    /** Fake mode: the fake CLI's trace lines for one agent. */
    traces(key: string): any[];
    running(): boolean;
    stop(): Promise<void>;
}

export class AgentHostRefusal extends Error {}

/** Which mode the agent specs run in: fake (switch), live (approved and keyed), or none. */
export function agentMode(): { mode: AgentMode } | { mode: null; reason: string } {
    if (process.env.E2E_AGENT_FAKE === '1') return { mode: 'fake' };
    const gate = liveGate();
    if (!gate.ok) return { mode: null, reason: gate.reason };
    const models = (Object.values(MODEL_VARS)).filter(v => !process.env[v]?.trim());
    if (models.length) return { mode: null, reason: `blocked: ${models.join(', ')} not set (the coordinator picks and verifies model IDs and prices first)` };
    return { mode: 'live' };
}

/** Refuse any profile that is not api_key (plan §3.1: never a subscription or ChatGPT plan login). */
export function assertApiKeyOnly(profiles: Array<{ key?: string; auth?: string }>) {
    for (const p of profiles) {
        const auth = p.auth ?? 'api_key';
        if (auth !== 'api_key') throw new AgentHostRefusal(`refused: profile ${p.key ?? '?'} uses auth "${auth}"; the agent E2E runs api_key profiles only (beta-test-plan §3.1)`);
    }
}

/** The generated host config, checked once more before it is written. */
export function checkHostConfig(config: { profiles: Record<string, any> }) {
    for (const [name, p] of Object.entries(config.profiles)) {
        if (p.auth !== 'api_key') throw new AgentHostRefusal(`refused: profile ${name} uses auth "${p.auth}"; the agent E2E runs api_key profiles only (beta-test-plan §3.1)`);
        if (!p.apiKeyEnv) throw new AgentHostRefusal(`refused: profile ${name} has no apiKeyEnv`);
        const home = os.homedir().toLowerCase();
        const sd = path.resolve(p.stateDir).toLowerCase();
        for (const own of ['.claude', '.codex', '.gemini']) {
            if (sd === path.join(home, own) || sd.startsWith(path.join(home, own) + path.sep)) throw new AgentHostRefusal(`refused: profile ${name} stateDir points into ~/${own}`);
        }
    }
}

/** Every state dir exists and is empty (fresh per run). */
export function assertEmptyStateDirs(dirs: string[]) {
    for (const d of dirs) {
        if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new AgentHostRefusal(`refused: state dir ${path.basename(d)} missing`);
        const entries = fs.readdirSync(d);
        if (entries.length) throw new AgentHostRefusal(`refused: state dir ${path.basename(d)} is not empty (${entries.length} entries)`);
    }
}

function npmRoot(): string {
    return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true }).trim();
}

/** Local CLI paths: env overrides, else the usual install locations on this machine. */
export function cliPaths(adapters: AgentAdapter[]): { claude?: string; codex?: string; geminiJs?: string } {
    const out: { claude?: string; codex?: string; geminiJs?: string } = {};
    const need = (what: string, p: string | undefined, env: string) => {
        if (!p || !fs.existsSync(p)) throw new Error(`${what} not found${p ? ` at ${p}` : ''}; set ${env}`);
        return p;
    };
    if (adapters.includes('claude')) {
        const def = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
        out.claude = need('claude CLI', process.env.E2E_CLAUDE_EXE ?? def, 'E2E_CLAUDE_EXE');
    }
    if (adapters.includes('codex')) {
        const def = process.platform === 'win32'
            ? path.join(npmRoot(), '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
            : undefined;
        out.codex = need('codex native executable', process.env.E2E_CODEX_EXE ?? def, 'E2E_CODEX_EXE');
    }
    if (adapters.includes('gemini')) {
        out.geminiJs = need('gemini-cli bundle/gemini.js', process.env.E2E_GEMINI_JS ?? path.join(npmRoot(), '@google', 'gemini-cli', 'bundle', 'gemini.js'), 'E2E_GEMINI_JS');
    }
    return out;
}

/** The tiny Node project every run works on: sum() subtracts, and its test expects 5. */
export function writeTinyProject(dir: string, tag: string) {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `e2e-sum-${tag}`, version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'src', 'sum.js'), 'function sum(a, b) {\n    return a - b;\n}\n\nmodule.exports = { sum };\n');
    fs.writeFileSync(path.join(dir, 'test', 'sum.test.js'),
        "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('../src/sum.js');\n\ntest('sum adds two numbers', () => {\n    assert.strictEqual(sum(2, 3), 5);\n});\n");
    fs.writeFileSync(path.join(dir, 'README.md'), `# e2e sum ${tag}\n\nA tiny project for the Agora agent E2E. \`npm test\` runs \`node --test\`.\n`);
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>E2E sum</title><h1 style="font-family:sans-serif">E2E sum project</h1>\n');
}

/** `node --test` in a directory: exit code and the tail of the output (no secrets in there). */
export function nodeTest(cwd: string): { code: number; out: string } {
    try {
        const out = execFileSync(process.execPath, ['--test'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' } });
        return { code: 0, out: out.slice(-600) };
    } catch (e: any) { return { code: typeof e.status === 'number' ? e.status : 1, out: String(e.stdout ?? '').slice(-600) }; }
}

function dummyFor(v: string) { return `e2e-dummy-${v.toLowerCase()}-${crypto.randomBytes(9).toString('hex')}`; }

export async function startAgentHost(seed: Seed, opts: AgentHostOptions): Promise<AgentHost> {
    // Refusals first: nothing is registered, written or started for a refused profile
    assertApiKeyOnly(opts.profiles);
    const live = opts.mode === 'live';
    if (live) {
        const gate = liveGate();
        if (!gate.ok) throw new AgentHostRefusal(gate.reason);
        const missing = [...new Set(opts.profiles.map(p => p.adapter))].filter(a => !process.env[MODEL_VARS[a]]?.trim()).map(a => MODEL_VARS[a]);
        if (missing.length) throw new AgentHostRefusal(`refused: ${missing.join(', ')} not set (the coordinator picks and verifies model IDs and prices first)`);
    }
    const paths = live ? cliPaths([...new Set(opts.profiles.map(p => p.adapter))]) : {};
    ensureBuilt();
    const { apiURL } = e2eEnv();
    const base = new Api(apiURL);
    const owner = base.with(`Bearer ${seed.secrets.ownerToken}`);
    const tag = crypto.randomBytes(2).toString('hex');
    const sid = seed.serverId;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-e2e-ah-'));
    let child: ChildProcess | null = null;
    try {
        const workdir = path.join(root, 'repo');
        writeTinyProject(workdir, tag);
        const gitc = (args: string[]) => git(workdir, ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', ...args]);
        git(workdir, ['init', '-q', '-b', 'main']);
        git(workdir, ['config', 'core.autocrlf', 'false']);
        gitc(['add', '-A']);
        gitc(['commit', '-q', '-m', 'initial: sum() with a failing test']);
        const initialMainSha = git(workdir, ['rev-parse', 'refs/heads/main']);
        const origin = path.join(root, 'origin.git');
        git(root, ['init', '-q', '--bare', origin]);
        git(workdir, ['remote', 'add', 'origin', origin]);
        git(workdir, ['push', '-q', 'origin', 'main']);
        const ghDir = path.join(root, 'gh-empty');
        fs.mkdirSync(ghDir);
        const fakeExe = live ? null : buildLauncher(root);

        const hostName = `e2e-agenthost-${tag}`;
        const created = (await owner.ok('POST', `/servers/${sid}/agent-hosts`, { name: hostName }, [201])) as any;
        const hostId: string = created.host.id.trim();
        const hostToken: string = created.token;

        const agents: Record<string, HostedAgent> = {};
        const profiles: Record<string, any> = {};
        const botTokens: Record<string, string> = {};
        const keyValues = new Map<string, string>();
        for (const p of opts.profiles) {
            // The fake CLI speaks Claude's stream-json only: in fake mode every profile is a claude one
            const adapter: AgentAdapter = live ? p.adapter : 'claude';
            const name = `${p.key}-e2e-${tag}`;
            const model = live ? process.env[MODEL_VARS[p.adapter]]!.trim() : null;
            const r = (await owner.ok('POST', `/servers/${sid}/agents`, { name, adapter, hostId, workdirAlias: 'e2e', model }, [201])) as any;
            const profileId = r.profile.id.trim();
            await owner.ok('PATCH', `/servers/${sid}/agent-profiles/${profileId}`, {
                wakeBudget: AGENT_CAPS.wakeBudget, tokenBudget: AGENT_CAPS.tokenBudget, runTimeoutSec: AGENT_CAPS.runTimeoutSec,
                toolPresets: p.toolPresets ?? ['dev'], allowedTools: p.allowedTools ?? [],
            });
            const stateDir = path.join(root, `s-${p.key}`);
            fs.mkdirSync(stateDir);
            const apiKeyEnv = live ? providerKeyEnv(p.adapter) : 'ANTHROPIC_API_KEY';
            if (!keyValues.has(apiKeyEnv)) keyValues.set(apiKeyEnv, live ? testKey(p.adapter) : (opts.dummyKeys?.[apiKeyEnv] ?? dummyFor(apiKeyEnv)));
            agents[p.key] = {
                key: p.key, adapter: p.adapter, name, profileId, botId: r.bot.id.trim(), token: r.token, stateDir, apiKeyEnv,
                bot: base.with(`Bot ${r.token}`), worktree: (sessionId: string) => path.join(stateDir, `wt-${sessionId.slice(-10)}`),
            };
            botTokens[r.bot.id.trim()] = r.token;
            const common = {
                workdir, workdirAlias: 'e2e', stateDir, auth: p.auth ?? 'api_key', apiKeyEnv,
                approvedTools: [...APPROVED_TOOLS, ...(opts.preview ? ['browser_preview'] : [])],
                ...(p.verifyCommands ? { verify: { commands: p.verifyCommands, timeoutSeconds: 120 } } : {}),
            };
            if (!live) profiles[name] = { adapter: 'claude', executable: fakeExe, ...common, caps: { maxBudgetUsd: AGENT_CAPS.claudeMaxBudgetUsd } };
            else if (p.adapter === 'claude') profiles[name] = { adapter: 'claude', executable: paths.claude, ...common, caps: { maxBudgetUsd: AGENT_CAPS.claudeMaxBudgetUsd } };
            else if (p.adapter === 'codex') profiles[name] = { adapter: 'codex', executable: paths.codex, ...common, sandbox: 'workspace-write',
                ...(process.env.E2E_CODEX_WINDOWS_SANDBOX ? { windowsSandbox: process.env.E2E_CODEX_WINDOWS_SANDBOX } : {}) };
            else profiles[name] = { adapter: 'gemini', protocol: 'acp', executable: process.execPath, acpArgs: [paths.geminiJs!, '--acp'], ...common };
        }
        // Tokens and (fake-mode) dummy keys go where the leak scan looks; real keys stay in memory
        // (lib/finalize.ts reads them from lib/agent-keys.ts)
        addSecretsToSeed({ [`agentHost_${tag}`]: hostToken, ...Object.fromEntries(Object.values(agents).map(a => [`agentBot_${a.key}_${tag}`, a.token])) });
        if (!live) { const s = new Sensitive(); for (const v of keyValues.values()) s.add(v); }

        const previewStateDir = opts.preview ? path.join(root, 'preview') : null;
        const config = {
            instance: `${apiURL}/`, hostToken,
            mcp: { executable: process.execPath, entrypoint: path.join(MCP_DIR, 'dist', 'index.js') },
            profiles, botTokens, maxConcurrent: 3, approvalWaitSeconds: 120,
            ...(opts.preview ? { preview: { browser: opts.preview.browser, stateDir: previewStateDir, portBase: opts.preview.portBase, portsPerSession: opts.preview.portsPerSession ?? 2, slots: 16 } } : {}),
        };
        checkHostConfig(config);
        fs.mkdirSync(SECRETS_DIR, { recursive: true });
        const configFile = path.join(SECRETS_DIR, `agent-host-${tag}.json`);
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });

        // The child env: the runner's env minus every provider credential, plus this run's keys
        const env: NodeJS.ProcessEnv = { ...process.env, GH_CONFIG_DIR: ghDir, GIT_TERMINAL_PROMPT: '0' };
        for (const k of [...PROVIDER_ENVS, 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'NODE_OPTIONS',
            'AGORA_TEST_ANTHROPIC_KEY', 'AGORA_TEST_OPENAI_KEY', 'AGORA_TEST_GEMINI_KEY']) delete env[k];
        for (const [k, v] of keyValues) env[k] = v;
        const childKeyNames = [...keyValues.keys()].sort();

        assertEmptyStateDirs(Object.values(agents).map(a => a.stateDir));
        const logFile = path.join(SECRETS_DIR, `agent-host-${tag}.log`);
        const logFd = fs.openSync(logFile, 'a');
        child = spawn(process.execPath, [path.join(HOST_DIR, 'dist', 'index.js'), '--config', configFile], {
            cwd: HOST_DIR, env, stdio: ['ignore', logFd, logFd], windowsHide: true, detached: process.platform !== 'win32',
        });
        const proc = child;
        let exited = false;
        proc.on('exit', () => { exited = true; });
        const onExit = () => { if (!exited && proc.pid) killTree(proc.pid); };
        process.on('exit', onExit);

        const host: AgentHost = {
            mode: opts.mode, tag, serverId: sid, hostId, hostName, agents, root, workdir, initialMainSha, previewStateDir, childKeyNames,
            log() { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } },
            traces(key) {
                const f = path.join(agents[key].stateDir, 'fake-runs.jsonl');
                if (!fs.existsSync(f)) return [];
                return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
            },
            running() { return !exited; },
            async stop() {
                if (!exited && proc.pid) killTree(proc.pid);
                await waitFor('host exit', async () => exited, 10_000, 100).catch(() => undefined);
                process.off('exit', onExit);
                try { fs.closeSync(logFd); } catch { /* closed */ }
                // E2E_AGENT_KEEP_LOGS=1: keep the host log and each CLI's own transcripts for
                // debugging. They land in artifacts/, so the end-of-run leak scan quarantines any
                // file that holds a key or another known secret.
                if (process.env.E2E_AGENT_KEEP_LOGS === '1') {
                    const out = path.join(artifactsDir(), 'host');
                    try {
                        fs.mkdirSync(out, { recursive: true });
                        fs.copyFileSync(logFile, path.join(out, 'agora-host.log'));
                        for (const [key, a] of Object.entries(agents)) {
                            for (const sub of ['sessions', 'projects', 'tmp', '.gemini']) {
                                const src = path.join(a.stateDir, sub);
                                if (fs.existsSync(src)) fs.cpSync(src, path.join(out, key, sub), { recursive: true, filter: f => !/[\/]wt-/.test(f) });
                            }
                        }
                    } catch (e) { console.warn(`keep logs: ${(e as Error).message}`); }
                }
                for (const f of [configFile, logFile]) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
                rmrf(root);
            },
        };
        try {
            await waitFor('agent host to report in', async () => {
                if (exited) throw new Error(`agora-host exited: ${host.log().slice(-600)}`);
                const hosts = (await owner.ok('GET', `/servers/${sid}/agent-hosts`)) as any;
                const list: any[] = Array.isArray(hosts) ? hosts : (hosts.hosts ?? []);
                const h = list.find(x => String(x.id).trim() === hostId);
                return h && (h.lastSeenAt ?? h.last_seen_at) ? h : null;
            }, 60_000);
        } catch (e) { await host.stop(); throw e; }
        return host;
    } catch (e) {
        if (child?.pid && child.exitCode === null) killTree(child.pid);
        rmrf(root);
        throw e;
    }
}
