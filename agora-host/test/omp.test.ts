import { fileURLToPath, pathToFileURL } from 'node:url';
import { chmod, copyFile, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { childEnv, prepare, testedCliVersion, verifyProfile, type Launch } from '../src/adapters.js';
import { BOX_ADAPTERS } from '../src/box-adapters.js';
import { boxConfig, boxConfigCommand, boxMode } from '../src/box.js';
import { configSchema, loadConfig } from '../src/config.js';
import { ProcessRunner } from '../src/process.js';
import { git } from '../src/workspaces.js';
import { ompApproval, ompSettings, plainPath } from '../src/acp/omp.js';
import { profileReport } from '../src/terms.js';
import { claim, config, id, tempDir } from './helpers.js';

/**
 * oh-my-pi (`omp acp`) on a machine and in a box (acp/omp.ts, README "oh-my-pi"): an OpenRouter
 * key only, nothing from the repository loaded, every write, command and Agora tool asked for on
 * a machine and answered from the rules, `--yolo` only in a box.
 */

const unix = process.platform !== 'win32';
const FIXTURE = resolve('test/fixtures/fake-omp-agent.mjs');
const FAKE_OMP = fileURLToPath(new URL('../../box/fake/fake-omp.mjs', import.meta.url));
const HOST_TOKEN = 'ah_01J0000000000000000000HOST.hostsecretvalue';
const cleanups: Array<() => Promise<void>> = [];
const saved = { marker: boxMode.marker, env: { ...process.env } };
let marker: string;

beforeEach(async () => {
    const t = await tempDir(); cleanups.push(t.cleanup);
    marker = join(t.dir, 'agora-box'); await writeFile(marker, 'agora-box 1\n');
    // A machine by default: the real marker never exists on a test machine
    boxMode.marker = join(t.dir, 'missing');
});
afterEach(async () => {
    boxMode.marker = saved.marker;
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
    for (const c of cleanups.splice(0).reverse()) await c();
});
function enterBox() { boxMode.marker = marker; process.env.AGORA_HOST_IN_BOX = '1'; }
async function repo() {
    const t = await tempDir(); cleanups.push(t.cleanup);
    await git(t.dir, ['init']);
    await git(t.dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture']);
    return t.dir;
}
function bare(dir: string) {
    const { protocol: _p, auth: _a, acpArgs: _g, apiKeyEnv: _k, ...rest } = config(dir).profiles.builder;
    return rest;
}
function omp(dir: string, profile: object = {}) {
    return configSchema.parse({ ...config(dir), profiles: { builder: { ...bare(dir), adapter: 'omp', ...profile } } });
}
function delivery(model: string | null = 'qwen/qwen3-coder') {
    const c = claim(); c.profile.adapter = 'omp'; c.profile.model = model; c.profile.effort = null; c.profile.authMode = 'api_key';
    return c;
}
const settingsOf = async (launch: Launch) => JSON.parse(await readFile(launch.args[launch.args.indexOf('--config') + 1], 'utf8'));

describe('omp profiles', () => {
    it('default to ACP on an OpenRouter key and refuse anything else, its own switches included', async () => {
        const t = await tempDir(); cleanups.push(t.cleanup);
        const p = omp(t.dir).profiles.builder;
        expect(p).toMatchObject({ protocol: 'acp', acpArgs: ['acp'], auth: 'api_key', apiKeyEnv: 'OPENROUTER_API_KEY' });
        expect(profileReport({ builder: p })).toEqual([{ name: 'builder', adapter: 'omp', authMode: 'api_key', apiKeyEnv: 'OPENROUTER_API_KEY', runApproval: false }]);

        const base = config(t.dir); const path = join(t.dir, 'host.local.json'); await writeFile(base.mcp.entrypoint, '');
        const load = async (profile: object) => {
            await writeFile(path, JSON.stringify({ ...base, profiles: { builder: { ...bare(t.dir), adapter: 'omp', ...profile } } }));
            try { await loadConfig(path); return 'ok'; } catch (e) { return (e as Error).message; }
        };
        expect(await load({})).toContain('OPENROUTER_API_KEY is not set');
        process.env.OPENROUTER_API_KEY = 'sk-or-secret';
        expect(await load({})).toBe('ok');
        // Never one of omp's subscription logins, never its own headless mode
        expect(await load({ auth: 'subscription' })).toContain('oh-my-pi (omp) is hosted only over ACP with an OpenRouter key');
        expect(await load({ protocol: 'cli', acpArgs: [] })).toContain('hosted only over ACP');
        // Arguments that would turn its approvals off on a machine
        for (const acpArgs of [['acp', '--yolo'], ['acp', '--approval-mode', 'yolo'], ['acp', '--auto-approve'], ['--yolo', 'acp'], []])
            expect(await load({ acpArgs })).toContain('hosted only over ACP');
        // Only an OpenRouter key, one per agent if wanted
        expect(await load({ apiKeyEnv: 'ANTHROPIC_API_KEY' })).toContain('apiKeyEnv set to one of OPENROUTER_API_KEY or OPENROUTER_API_KEY_<NAME>');
        expect(await load({ apiKeyEnv: 'ANTHROPIC_OAUTH_TOKEN' })).toContain('apiKeyEnv set to one of');
        process.env.OPENROUTER_API_KEY_OMP = 'sk-or-omp';
        expect(await load({ apiKeyEnv: 'OPENROUTER_API_KEY_OMP' })).toBe('ok');
        expect(await load({ caps: { maxBudgetUsd: 5 } })).toContain('ACP has no verified USD cap');
        expect(await load({ auth: 'subscription' })).not.toContain('sk-or-secret');
    });

    it('keep the user\'s credentials and every other provider\'s key out of the agent\'s environment', async () => {
        const t = await tempDir(); cleanups.push(t.cleanup);
        const p = omp(t.dir, { apiKeyEnv: 'OPENROUTER_API_KEY_OMP' }).profiles.builder;
        const home = join(t.dir, 'userhome'); await mkdir(home); await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Owner\n');
        const source = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, OPENROUTER_API_KEY_OMP: 'sk-or-omp', OPENROUTER_API_KEY: 'sk-or-other',
            ANTHROPIC_API_KEY: 'sk-ant', ANTHROPIC_OAUTH_TOKEN: 'oat', CLAUDE_CODE_OAUTH_TOKEN: 'cc', OPENAI_API_KEY: 'sk-oa', OPENAI_CODEX_OAUTH_TOKEN: 'cx',
            COPILOT_GITHUB_TOKEN: 'gh', CURSOR_ACCESS_TOKEN: 'cu', DEVIN_API_KEY: 'dv', WINDSURF_API_KEY: 'ws', AGORA_HOST_TOKEN: HOST_TOKEN, OMP_PROFILE: 'evil',
            PI_CONFIG_DIR: '.evil', OMP_AUTH_BROKER_URL: 'https://broker.example' };
        const env = childEnv(p, source);
        // Only this agent's own OpenRouter key, under the one name omp reads
        expect(env.OPENROUTER_API_KEY).toBe('sk-or-omp');
        for (const name of ['OPENROUTER_API_KEY_OMP', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENAI_CODEX_OAUTH_TOKEN',
            'COPILOT_GITHUB_TOKEN', 'CURSOR_ACCESS_TOKEN', 'DEVIN_API_KEY', 'WINDSURF_API_KEY', 'AGORA_HOST_TOKEN', 'OMP_PROFILE', 'PI_CONFIG_DIR', 'OMP_AUTH_BROKER_URL'])
            expect(env[name], name).toBeUndefined();
        // Its own agent folder and home in the state directory: never ~/.omp, ~/.env or a login saved there
        expect(env).toMatchObject({ PI_CODING_AGENT_DIR: join(p.stateDir, 'agent'), HOME: join(p.stateDir, 'home'), USERPROFILE: join(p.stateDir, 'home'),
            OTEL_SDK_DISABLED: 'true', PI_NO_TITLE: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), AGORA_HOOKS: 'off' });
        // No ~/.gitconfig: nothing pointed at
        expect(childEnv(p, { ...source, HOME: t.dir, USERPROFILE: t.dir }).GIT_CONFIG_GLOBAL).toBeUndefined();
    });
});

describe('omp on a machine', () => {
    it('prepares a turn: always-ask, OpenRouter only, nothing from the repository, started in its state directory', async () => {
        process.env.OPENROUTER_API_KEY = 'sk-or-secret';
        const dir = await repo();
        const c = omp(dir);
        const d = delivery(); d.profile.toolPresets = ['readonly'];
        const launch = await prepare(c, d); cleanups.push(launch.cleanup);
        const state = c.profiles.builder.stateDir;
        expect(launch.args.slice(0, 3)).toEqual(['acp', '--approval-mode', 'always-ask']);
        for (const off of ['--yolo', '--auto-approve']) expect(launch.args).not.toContain(off);
        expect(launch.args).toEqual(expect.arrayContaining(['--no-extensions', '--no-skills', '--no-rules', '--no-title']));
        const model = 'openrouter/qwen/qwen3-coder';
        for (const role of ['--model', '--smol', '--slow', '--plan']) expect(launch.args[launch.args.indexOf(role) + 1]).toBe(model);
        expect(launch.args).not.toContain('--append-system-prompt');
        expect(launch.acp).toMatchObject({ authMethod: null, model, elicitation: 'omp', spawnCwd: join(state, 'home') });
        expect(launch.acp!.allowAll).toBeUndefined();
        expect(launch.cwd).not.toBe(state);

        const s = await settingsOf(launch);
        // Every model provider but OpenRouter, the subscription ones first among them
        for (const p of ['anthropic', 'openai-codex', 'github-copilot', 'cursor', 'devin', 'google-gemini-cli', 'google-antigravity', 'xai-oauth', 'kimi-code',
            'qwen-portal', 'factory-droid', 'gitlab-duo', 'openai', 'ollama', 'lm-studio', 'opencode-zen'])
            expect(s.disabledProviders, p).toContain(p);
        expect(s.disabledProviders).not.toContain('openrouter');
        // Every config discovery source (the worktree's .omp/, .claude/, .codex/...) but AGENTS.md
        for (const source of ['native', 'claude', 'codex', 'cursor', 'gemini', 'opencode', 'mcp-json', 'omp-plugins', 'claude-plugins', 'agent-plugins', 'agents'])
            expect(s.disabledProviders, source).toContain(source);
        expect(s.disabledProviders).not.toContain('agents-md');
        expect(s).toMatchObject({ enabledProviders: [], update: { auto: false }, startup: { checkUpdate: false }, telemetry: { otlpExportEnabled: false },
            dev: { autoqa: false }, spotlight: { experiment: { enabled: false } }, exa: { enabled: false }, mcp: { enableProjectConfig: false }, bash: { direnv: 'off' },
            tools: { approvalMode: 'always-ask', xdev: false,
                approval: { task: 'deny', web_search: 'deny', browser: 'deny', computer: 'deny', read: 'prompt', grep: 'prompt', glob: 'prompt', find: 'prompt', ast_grep: 'prompt' } } });
        // The overlay is the host's, written for this run; omp's own folders and the run's are
        // restricted (every action there needs a person), not the worktrees beside them
        const overlay = launch.args[launch.args.indexOf('--config') + 1];
        expect(overlay.startsWith(state)).toBe(true);
        expect(s.tools.restrictedFolders).toEqual([join(state, 'agent'), join(state, 'home'), join(overlay, '..')]);
        expect(launch.cwd.startsWith(join(overlay, '..'))).toBe(false);
        for (const r of s.tools.restrictedFolders) expect(launch.cwd.startsWith(r)).toBe(false);

        expect(launch.env).toMatchObject({ OPENROUTER_API_KEY: 'sk-or-secret', PI_CODING_AGENT_DIR: join(state, 'agent'), HOME: join(state, 'home') });
        expect(launch.acp!.rules).toEqual(expect.arrayContaining(['Read', 'mcp__agora__chat_send']));
        expect(JSON.stringify(launch.acp!.mcpServers)).not.toContain('sk-or-secret');
        expect(launch.acp!.prompt).not.toContain('sk-or-secret');

        // omp's own default would be whatever its catalog lists first
        await expect(prepare(c, delivery(null))).rejects.toThrow('omp_model_required');
        // An OpenRouter ID with its prefix is used as it is
        const prefixed = await prepare(c, delivery('openrouter/qwen/qwen3-coder')); cleanups.push(prefixed.cleanup);
        expect(prefixed.acp!.model).toBe(model);
    });

    it('checks its version at start: 18.17.x, or any with allowUntestedVersion', async () => {
        const t = await tempDir(); cleanups.push(t.cleanup);
        process.env.OPENROUTER_API_KEY = 'sk-or-secret';
        const log = join(t.dir, 'acp.log');
        // The executable is node, so `acp` (its only allowed argument) is a script in the
        // directory omp starts in: its home folder in the state directory. It loads the fixture with a version.
        const profile = omp(t.dir, { executable: process.execPath }).profiles.builder;
        const agent = async (version: string) => {
            await mkdir(profile.stateDir, { recursive: true });
            await mkdir(join(profile.stateDir, 'home'), { recursive: true });
            await writeFile(join(profile.stateDir, 'home', 'acp'), `process.env.ACP_LOG = ${JSON.stringify(log)}; process.env.OMP_VERSION = ${JSON.stringify(version)};\n`
                + `import(${JSON.stringify(pathToFileURL(FIXTURE).href)});\n`);
        };
        await agent('18.17.0');
        expect(await verifyProfile(profile)).toBe('acp/1 18.17.0');
        const first = JSON.parse((await readFile(log, 'utf8')).split('\n')[0]);
        // Started in its own home folder (so no worktree .env), with the switches every run gets
        expect(first.cwd).toBe(resolve(profile.stateDir, 'home'));
        expect(first.argv).toEqual(['--approval-mode', 'always-ask', '--no-extensions', '--no-skills', '--no-rules']);
        await agent('18.18.0');
        await expect(verifyProfile(profile)).rejects.toThrow('unsupported_cli_version');
        // The box image's pin passes the gate
        expect(testedCliVersion('omp', BOX_ADAPTERS.omp.version)).toBe(true);
        expect(testedCliVersion('omp', '18.16.0')).toBe(false);
        expect(await verifyProfile({ ...profile, allowUntestedVersion: true })).toBe('acp/1 18.18.0');
    });
});

describe('omp approval prompts on a machine', () => {
    async function run(steps: object[], rules: string[], extra: Partial<Launch['acp'] & object> = {}) {
        const t = await tempDir(); cleanups.push(t.cleanup);
        const cwd = join(t.dir, 'work'); await mkdir(cwd); await writeFile(join(cwd, 'a.txt'), 'hi');
        const spawnCwd = join(t.dir, 'state'); await mkdir(spawnCwd);
        const log = join(t.dir, 'acp.log');
        const launch: Launch = {
            executable: process.execPath, args: [FIXTURE], cwd, env: { PATH: process.env.PATH, ACP_LOG: log, OMP_STEPS: JSON.stringify(steps) },
            adapter: 'omp', stdin: '', cleanup: async () => {},
            acp: { prompt: 'Do the task', nativeSessionId: null, model: 'openrouter/qwen/qwen3-coder', effort: null, authMethod: null, rules, mcpServers: [],
                rpcTimeoutMs: 5000, elicitation: 'omp', spawnCwd, ...extra },
        };
        const result = await new ProcessRunner().start(launch).result;
        const messages = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
        const answers = messages.filter(m => m.elicitation || m.permission).map(m => m.answer.content?.value ?? m.answer.outcome?.optionId ?? m.answer.action);
        return { result, messages, answers, cwd, spawnCwd };
    }
    const write = (path: string) => ({ calls: [{ title: `write: ${path}`, kind: 'edit', rawInput: { path, content: 'x' } }], elicit: { message: `Allow tool: write\nPath: ${path}\nContent:\nx`, choices: ['Approve', 'Approve write for this session', 'Deny'] } });
    const agora = (tool: string) => ({ calls: [{ title: `mcp__agora_${tool}`, kind: 'other', rawInput: { content: 'hi' } }], elicit: { message: `Allow tool: mcp__agora_${tool}\nArguments:\n{}`, choices: ['Approve', `Approve mcp__agora_${tool} for this session`, 'Deny'] } });

    it('advertises form elicitation, starts outside the worktree and answers from the rules', async () => {
        const { result, messages, answers, cwd, spawnCwd } = await run([
            write('a.txt'),
            write('/etc/evil'),
            agora('chat_send'),
            agora('thread_close'),
            { calls: [{ title: 'read: a.txt', kind: 'read', rawInput: { path: 'a.txt' } }], elicit: { message: 'Allow tool: read' } },
            { calls: [{ title: 'https://evil.example/?leak', kind: 'read', rawInput: { path: 'https://evil.example/?leak' } }], elicit: { message: 'Allow tool: read' } },
            { calls: [{ title: 'grep: /etc', kind: 'search', rawInput: { pattern: 'root', path: '/etc' } }], elicit: { message: 'Allow tool: grep' } },
            { calls: [{ title: 'grep: src', kind: 'search', rawInput: { pattern: 'x' } }], elicit: { message: 'Allow tool: grep' } },
            { calls: [{ title: '$ git status', kind: 'execute', rawInput: { command: 'git status' } }], permission: true },
        ], ['Edit', 'Read', 'Grep', 'mcp__agora__chat_send']);
        expect(messages[0].cwd).toBe(spawnCwd);
        expect(messages.find(m => m.method === 'initialize').params.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } });
        expect(messages.find(m => m.method === 'session/new').params.cwd).toBe(cwd);
        // Inside the worktree with Edit; outside never; Agora's tools by their rules; reads and
        // searches inside only; a URL read never; git without a Bash rule refused at its request
        expect(answers).toEqual(['Approve', 'Deny', 'Approve', 'Deny', 'Approve', 'Deny', 'Deny', 'Approve', 'reject_once']);
        // Cards for what a rule would allow; nothing for paths outside or URLs
        expect(result.deniedTools).toEqual(['mcp__agora__thread_close', 'Bash(git:*)']);
        expect(result.success).toBe(true);
    });

    it('matches a prompt to its call by the tool name omp sends, and asks for rules by their usual names', async () => {
        const { result, answers } = await run([
            // omp sends the tool's name in its updates: a write prompt can't approve a waiting read
            { calls: [{ name: 'read', title: 'write: a.txt', kind: 'edit', rawInput: { path: 'a.txt', content: 'x' } }], elicit: { message: 'Allow tool: write\nPath: a.txt' } },
            { calls: [{ name: 'write', title: 'write: a.txt', kind: 'edit', rawInput: { path: 'a.txt', content: 'x' } }], elicit: { message: 'Allow tool: write\nPath: a.txt' } },
            { calls: [{ name: 'mcp__agora_thread_close', title: 'mcp__agora_thread_close', kind: 'other', rawInput: {} }], elicit: { message: 'Allow tool: mcp__agora_thread_close' } },
            { calls: [{ name: 'bash', title: '$ git status', kind: 'execute', rawInput: { command: 'git status' } }], permission: true },
        ], ['Edit']);
        expect(answers).toEqual(['Deny', 'Approve', 'Deny', 'reject_once']);
        // Bash and Agora's tool by the names the owner's rules use, never omp's lowercase ones
        expect(result.deniedTools).toEqual(['mcp__agora__thread_close', 'Bash(git:*)']);
    });

    it('asks for Edit when it has no rule, and never picks a remembered choice', async () => {
        const { result, answers } = await run([write('a.txt')], []);
        expect(answers).toEqual(['Deny']);
        expect(result.deniedTools).toEqual(['Edit']);
    });

    it('refuses what it cannot pin to one call: parallel calls, a reason line, another tool, unknown tools', async () => {
        const { result, answers } = await run([
            { calls: [{ title: 'write: a.txt', kind: 'edit', rawInput: { path: 'a.txt', content: 'x' } }, { title: 'write: /etc/x', kind: 'edit', rawInput: { path: '/etc/x', content: 'x' } }],
                elicit: { message: 'Allow tool: write\nPath: a.txt\nContent:\nx' } },
            { calls: [{ title: 'write: a.txt', kind: 'edit', rawInput: { path: 'a.txt', content: 'x' } }], elicit: { message: 'Allow tool: write\nReason: Restricted folder: /state\nPath: a.txt' } },
            { calls: [{ title: 'https://evil.example/x', kind: 'read', rawInput: { path: 'https://evil.example/x' } }], elicit: { message: 'Allow tool: write\nPath: a.txt' } },
            { calls: [{ title: '[?]\n1', kind: 'execute', rawInput: { language: 'py', code: '1' } }], elicit: { message: 'Allow tool: eval' } },
            { calls: [{ title: 'task', kind: 'other', rawInput: {} }], elicit: { message: 'Allow tool: task' } },
            // Not an approval prompt at all: declined
            { calls: [{ title: 'ask', kind: 'other', rawInput: {} }], elicit: { message: 'Which file?', choices: ['a', 'b'] } },
        ], ['Edit', 'Bash', 'write']);
        expect(answers).toEqual(['Deny', 'Deny', 'Deny', 'Deny', 'Deny', 'decline']);
        expect(result.deniedTools).toBeUndefined();
    });

    it('checks an edit by the files omp lists, and only when every line is one', async () => {
        const edit = (message: string) => ({ calls: [{ title: 'edit', kind: 'edit', rawInput: { input: '[a.txt#ABCD]\n...' } }], elicit: { message } });
        const { answers } = await run([
            edit('Allow tool: edit\nFile: a.txt'),
            edit('Allow tool: edit\nFile: a.txt\nFile: /etc/passwd'),
            edit('Allow tool: edit\nFile: x\n/../../../etc/passwd'),
            edit('Allow tool: edit\nFile: (unknown)'),
            edit('Allow tool: edit\nFile: src/very/long[…40ch elided…]'),
        ], ['Edit']);
        expect(answers).toEqual(['Approve', 'Deny', 'Deny', 'Deny', 'Deny']);
    });
});

describe('omp approval helpers', () => {
    it('reads paths as omp resolves them, or not at all', () => {
        expect(plainPath('src/a.ts')).toBe('src/a.ts');
        expect(plainPath('[src/a.ts#1A2B]')).toBe('src/a.ts');
        expect(plainPath('[/etc/passwd#1a2b]')).toBe('/etc/passwd');
        expect(plainPath('app/[id]/page.tsx')).toBe('app/[id]/page.tsx');
        for (const bad of ['https://x.example', 'xd://lsp/x', 'artifact://1', '~/.ssh/id_rsa', 'C:evil', 'a\nb', '', 42, null, 'x'.repeat(5000)])
            expect(plainPath(bad), String(bad)).toBeNull();
    });
    it('maps Agora tool prompts to their rules and nothing else', () => {
        const pending = (title: string) => [{ title, kind: 'other', status: 'pending' }];
        expect(ompApproval('Allow tool: mcp__agora_chat_send\nArguments:', pending('mcp__agora_chat_send'))).toEqual({ call: { kind: 'other', name: 'mcp__agora__chat_send', rawInput: {} } });
        expect(ompApproval('Allow tool: mcp__evil_chat_send', pending('mcp__evil_chat_send'))).toHaveProperty('deny');
        expect(ompApproval('Allow tool: mcp__agora_chat_send', pending('mcp__agora_thread_close'))).toHaveProperty('deny');
        expect(ompApproval('Allow tool: mcp__agora_chat_send', [])).toHaveProperty('deny');
        expect(ompApproval('Please allow mcp__agora_chat_send', pending('mcp__agora_chat_send'))).toHaveProperty('deny');
    });
    it('a box gets --yolo semantics in its settings, and no restricted folder', () => {
        const s = ompSettings({ boxed: true, restricted: ['/home/agent/.agora/state/p/agent'] }) as any;
        expect(s.tools.approvalMode).toBe('yolo');
        expect(s.tools.restrictedFolders).toBeUndefined();
        expect(s.tools.approval).toEqual({ web_search: 'deny', browser: 'deny', computer: 'deny' });
        expect(s.disabledProviders).toContain('anthropic');
    });
});

describe('omp in a box', () => {
    const profile = (p: object = {}) => JSON.stringify({ name: 'pi', adapter: 'omp', auth: 'api_key', apiKeyEnv: 'OPENROUTER_API_KEY', workdirAlias: 'work', repos: [], ...p });
    const env = (p: object = {}) => ({ AGORA_INSTANCE_URL: 'http://edge:8080', AGORA_HOST_TOKEN: HOST_TOKEN, AGORA_BOT_ID: id(5),
        AGORA_BOT_TOKEN: 'bot_box.botsecretvalue', AGORA_BOX_PROFILE: profile(p) });
    async function boxSetup(executable = process.execPath) {
        const dir = await repo();
        const base = config(dir);
        const c = configSchema.parse({ ...base, profiles: { builder: { adapter: 'omp', executable, workdir: dir, workdirAlias: 'agora',
            stateDir: join(dir, 'state'), approvedTools: ['chat_history', 'chat_send'], proxyEnv: true } } });
        process.env.OPENROUTER_API_KEY = 'sk-or-box-secret';
        return { c, d: delivery(), dir };
    }

    it('box config: the pinned binary over ACP on its OpenRouter key; a subscription is refused', () => {
        const c = boxConfig(env(), { home: '/home/agent', exists: () => false });
        expect(c.profiles.pi).toEqual({ adapter: 'omp', executable: '/opt/agora/bin/omp', workdir: '/home/agent/scratch', workdirAlias: 'work',
            protocol: 'acp', acpArgs: ['acp'], stateDir: '/home/agent/.agora/state/pi', auth: 'api_key', apiKeyEnv: 'OPENROUTER_API_KEY', proxyEnv: true });
        expect(configSchema.safeParse(c).success).toBe(true);
        expect(() => boxConfig(env({ auth: 'subscription', apiKeyEnv: null }), { home: '/home/agent', exists: () => false }))
            .toThrow('AGORA_BOX_PROFILE: omp in a box signs in with api_key');
    });

    it('yeet only in a box: --yolo, the box rules, quiet, proxied, the box home kept', async () => {
        const { c, d } = await boxSetup();
        Object.assign(process.env, { HTTPS_PROXY: 'http://edge:3128', NO_PROXY: 'edge', HOME: '/home/agent' });
        // The flag without the image's marker is a machine
        process.env.AGORA_HOST_IN_BOX = '1';
        let launch = await prepare(c, d); cleanups.push(launch.cleanup);
        expect(launch.args).not.toContain('--yolo');
        expect(launch.args).toContain('always-ask');
        expect(launch.env.HTTPS_PROXY).toBeUndefined();
        enterBox();
        launch = await prepare(c, d); cleanups.push(launch.cleanup);
        const state = c.profiles.builder.stateDir;
        expect(launch.args.slice(0, 2)).toEqual(['acp', '--yolo']);
        expect(launch.args).not.toContain('--approval-mode');
        expect(launch.args[launch.args.indexOf('--append-system-prompt') + 1]).toBe(join(state, 'agent', 'AGENTS.md'));
        expect(launch.acp).toMatchObject({ allowAll: true, spawnCwd: join(state, 'agent', '..', 'home') });
        expect(launch.acp!.elicitation).toBeUndefined();
        const s = await settingsOf(launch);
        expect(s.tools).toMatchObject({ approvalMode: 'yolo', approval: { web_search: 'deny', browser: 'deny', computer: 'deny' } });
        expect(s.disabledProviders).toContain('anthropic');
        expect(launch.env).toMatchObject({ OPENROUTER_API_KEY: 'sk-or-box-secret', OTEL_SDK_DISABLED: 'true', PI_CODING_AGENT_DIR: join(state, 'agent'),
            HTTPS_PROXY: 'http://edge:3128', https_proxy: 'http://edge:3128', NO_PROXY: 'edge', HOME: '/home/agent' });
        expect(launch.env.AGORA_HOST_TOKEN).toBeUndefined();
    });

    it.skipIf(!unix)('box-config --state links the box rules where the host passes them to omp', async () => {
        const t = await tempDir(); cleanups.push(t.cleanup);
        expect(await boxConfigCommand(['--state', '--home', t.dir], env())).toBe(0);
        expect(await readlink(join(t.dir, '.agora', 'state', 'pi', 'agent', 'AGENTS.md'))).toBe('/opt/agora/AGENTS.md');
    });

    it.skipIf(!unix)('the fake omp from box/fake runs a turn as agora-host drives it in a box', async () => {
        const bin = await tempDir(); cleanups.push(bin.cleanup);
        const exe = join(bin.dir, 'omp.mjs'); await copyFile(FAKE_OMP, exe); await chmod(exe, 0o755);
        enterBox();
        process.env.AGORA_HOST_TOKEN = HOST_TOKEN;
        const { c, d } = await boxSetup(exe);
        await mkdir(c.profiles.builder.stateDir, { recursive: true });
        expect(await verifyProfile(c.profiles.builder)).toBe('acp/1 18.17.0');
        const launch = await prepare(c, d); cleanups.push(launch.cleanup);
        const result = await new ProcessRunner().start(launch).result;
        expect(result).toMatchObject({ success: true, summary: 'fake omp turn', tokensUsed: 15 });
        const call = JSON.parse(await readFile(join(c.profiles.builder.stateDir, '.fake-last-call.json'), 'utf8'));
        expect(call.args.slice(0, 2)).toEqual(['acp', '--yolo']);
        expect(call.cwd).toBe(join(c.profiles.builder.stateDir, 'home'));
        expect(call.answers).toEqual(['allow_once']);
        expect(call.settings.tools.approvalMode).toBe('yolo');
        expect(call.clientCapabilities.elicitation).toBeUndefined();
        expect(call.envNames).toContain('OPENROUTER_API_KEY');
        for (const name of ['AGORA_HOST_TOKEN', 'AGORA_HOST_IN_BOX', 'ANTHROPIC_API_KEY']) expect(call.envNames).not.toContain(name);
    });
});
