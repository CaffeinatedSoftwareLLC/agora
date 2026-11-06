import { fileURLToPath } from 'node:url';
import { copyFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { childEnv, prepare, testedCliVersion, verifyProfile } from '../src/adapters.js';
import { BOX_ADAPTERS } from '../src/box-adapters.js';
import { boxConfig, boxConfigCommand, boxMode, inBox, originMatches, proxyVars, readBoxProfile, repoDir } from '../src/box.js';
import { configSchema, type Config } from '../src/config.js';
import { ProcessRunner } from '../src/process.js';
import { git } from '../src/workspaces.js';
import { claim, config, id, tempDir } from './helpers.js';

const unix = process.platform !== 'win32';
const FAKE_CLI = fileURLToPath(new URL('../../box/fake/fake-cli.mjs', import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
const saved = { marker: boxMode.marker, env: { ...process.env } };
const HOST_TOKEN = 'ah_01J0000000000000000000HOST.hostsecretvalue';
const BOX_BOT_TOKEN = 'bot_box.botsecretvalue';
let marker: string;

beforeEach(async () => {
    const t = await tempDir(); cleanups.push(t.cleanup);
    marker = join(t.dir, 'agora-box'); await writeFile(marker, 'agora-box 1\n');
});
afterEach(async () => {
    boxMode.marker = saved.marker;
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
    for (const c of cleanups.splice(0).reverse()) await c();
});
/** Box mode on: the flag and the (temporary) marker file. */
function enterBox() { boxMode.marker = marker; process.env.AGORA_HOST_IN_BOX = '1'; }
async function repo() {
    const t = await tempDir(); cleanups.push(t.cleanup);
    await git(t.dir, ['init']);
    await git(t.dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture']);
    return t.dir;
}
async function setup(adapter: 'codex' | 'claude') {
    const dir = await repo();
    const c = config(dir); const delivery = claim();
    c.profiles.builder.adapter = adapter; delivery.profile.adapter = adapter;
    c.profiles.builder.proxyEnv = true;
    return { c, delivery, dir };
}
const BYPASS = ['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox'];

describe('box mode detection', () => {
    it('needs both AGORA_HOST_IN_BOX=1 and the marker file', () => {
        boxMode.marker = marker;
        expect(inBox({})).toBe(false);
        expect(inBox({ AGORA_HOST_IN_BOX: 'true' })).toBe(false);
        expect(inBox({ AGORA_HOST_IN_BOX: '1' })).toBe(true);
        boxMode.marker = join(marker, '..', 'missing');
        expect(inBox({ AGORA_HOST_IN_BOX: '1' })).toBe(false);
        // The real marker path doesn't exist on a development machine or a CI runner
        boxMode.marker = saved.marker;
        if (!unix || process.env.CI) expect(inBox({ AGORA_HOST_IN_BOX: '1' })).toBe(false);
    });
});

describe('yeet flags', () => {
    it('never appear outside box mode, even with the flag set', async () => {
        process.env.AGORA_HOST_IN_BOX = '1';
        boxMode.marker = join(marker, '..', 'missing');
        for (const adapter of ['codex', 'claude'] as const) {
            const { c, delivery } = await setup(adapter);
            delivery.profile.toolPresets = ['dev'];
            const launch = await prepare(c, delivery); cleanups.push(launch.cleanup);
            for (const flag of BYPASS) expect(launch.args).not.toContain(flag);
            if (adapter === 'codex') { expect(launch.args).toContain('-s'); expect(launch.args).toContain('approval_policy="never"'); }
            else { expect(launch.args).toContain('--permission-mode'); expect(launch.args).toContain('--allowedTools'); }
        }
    });
    it('Codex in a box: sandbox and approvals bypassed, no -s, web search off', async () => {
        enterBox();
        const { c, delivery } = await setup('codex');
        delivery.profile.toolPresets = ['research', 'dev'];
        const launch = await prepare(c, delivery); cleanups.push(launch.cleanup);
        expect(launch.args.slice(0, 3)).toEqual(['exec', '--ignore-user-config', '--dangerously-bypass-approvals-and-sandbox']);
        expect(launch.args).not.toContain('-s');
        expect(launch.args).not.toContain('approval_policy="never"');
        expect(launch.args).not.toContain('web_search="live"');
        expect(launch.args).toContain('web_search="disabled"');
        expect(launch.args).not.toContain('--dangerously-skip-permissions');
        expect(launch.sandbox).toBeUndefined();
        expect(launch.args.at(-1)).toBe('-');
        // Its metrics, feedback reports and update check are off (ab.chatgpt.com, Sentry)
        for (const key of ['analytics.enabled=false', 'feedback.enabled=false', 'check_for_update_on_startup=false']) {
            expect(launch.args[launch.args.indexOf(key) - 1]).toBe('-c');
        }
    });
    it('Codex on a machine keeps its own settings for metrics and updates', async () => {
        const { c, delivery } = await setup('codex');
        const launch = await prepare(c, delivery); cleanups.push(launch.cleanup);
        expect(launch.args).not.toContain('analytics.enabled=false');
    });
    it('Claude in a box: no permission prompts, every tool but WebSearch, no allow list', async () => {
        enterBox();
        const { c, delivery } = await setup('claude');
        delivery.profile.allowedTools = ['Bash(gh:*)'];
        const launch = await prepare(c, delivery); cleanups.push(launch.cleanup);
        expect(launch.args).toContain('--dangerously-skip-permissions');
        expect(launch.args[launch.args.indexOf('--disallowedTools') + 1]).toBe('WebSearch');
        expect(launch.args).not.toContain('--permission-mode');
        expect(launch.args).not.toContain('--allowedTools');
        expect(launch.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
        expect(launch.args).toContain('--strict-mcp-config');
    });
});

describe('child environment in a box', () => {
    const proxies = { HTTPS_PROXY: 'http://edge:3128', HTTP_PROXY: 'http://edge:3128', NO_PROXY: 'edge' };
    it('passes the proxy variables only in box mode and only with proxyEnv', async () => {
        const { c } = await setup('codex');
        const source = { PATH: '/usr/bin', HOME: '/home/agent', ...proxies, AGORA_HOST_IN_BOX: '1', OTHER: 'x' };
        boxMode.marker = marker;
        const env = childEnv(c.profiles.builder, source);
        expect(env).toMatchObject({ ...proxies, https_proxy: 'http://edge:3128', http_proxy: 'http://edge:3128', no_proxy: 'edge' });
        expect(env.OTHER).toBeUndefined(); expect(env.AGORA_HOST_IN_BOX).toBeUndefined();
        expect(childEnv({ ...c.profiles.builder, proxyEnv: false }, source).HTTPS_PROXY).toBeUndefined();
        // Only an adapter with a local server of its own adds to NO_PROXY (box-adapters.ts noProxy)
        expect(env.NO_PROXY).toBe('edge');
        boxMode.marker = join(marker, '..', 'missing');
        expect(childEnv(c.profiles.builder, source).HTTPS_PROXY).toBeUndefined();
        expect(proxyVars({ HTTPS_PROXY: 'http://edge:3128\nX: y' })).toEqual({});
    });
    it('turns Claude Code non-essential traffic off in a box, so no telemetry host needs a card', async () => {
        const { c } = await setup('claude');
        const source = { PATH: '/usr/bin', HOME: '/home/agent', ...proxies, AGORA_HOST_IN_BOX: '1' };
        boxMode.marker = marker;
        expect(childEnv(c.profiles.builder, source)).toMatchObject({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
            CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1' });
        boxMode.marker = join(marker, '..', 'missing');
        expect(childEnv(c.profiles.builder, source).CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
    });
    it('never gives the CLI the host token; the bot token only as agora-host passes it for agora-mcp', async () => {
        enterBox();
        Object.assign(process.env, proxies, { AGORA_HOST_TOKEN: HOST_TOKEN, AGORA_BOT_TOKEN: 'bot_from_env.value', AGORA_BOX_PROFILE: '{}', ANTHROPIC_API_KEY: 'sk-not-this-profile' });
        for (const adapter of ['codex', 'claude'] as const) {
            const { c, delivery } = await setup(adapter);
            c.hostToken = HOST_TOKEN;
            const launch = await prepare(c, delivery); cleanups.push(launch.cleanup);
            const values = Object.values(launch.env).join('\n') + launch.args.join('\n') + launch.stdin;
            expect(values).not.toContain('hostsecretvalue');
            expect(values).not.toContain('bot_from_env');
            expect(values).not.toContain('sk-not-this-profile');
            expect(launch.env.AGORA_HOST_TOKEN).toBeUndefined();
            expect(launch.env.AGORA_BOX_PROFILE).toBeUndefined();
            // As on a machine: the profile's bot token, for the agora-mcp server the CLI starts
            expect(launch.env.AGORA_BOT_TOKEN).toBe(c.botTokens[delivery.profile.botId]);
            expect(launch.env.HTTPS_PROXY).toBe('http://edge:3128');
        }
    });
});

describe('box config from the environment', () => {
    const profile = (p: object = {}) => JSON.stringify({ name: 'box-one', adapter: 'codex', auth: 'subscription', apiKeyEnv: null, workdirAlias: 'work', repos: ['acme/widgets', 'acme/docs'], ...p });
    const env = (p: object = {}) => ({ AGORA_INSTANCE_URL: 'http://edge:8080', AGORA_HOST_TOKEN: HOST_TOKEN, AGORA_BOT_ID: id(5),
        AGORA_BOT_TOKEN: BOX_BOT_TOKEN, AGORA_BOX_PROFILE: profile(p) });
    const ORIGIN_OK = '[core]\n\tbare = false\n[remote "origin"]\n\turl = http://edge:8080/git/github.com/acme/widgets.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';
    const cloned = (gitConfig: string | null) => ({ home: '/home/agent', exists: (p: string) => p === '/home/agent/work/acme/widgets/.git',
        readFile: (p: string) => (p === '/home/agent/work/acme/widgets/.git/config' ? gitConfig : null) });
    it('builds one profile on the first repo once it is cloned, else ~/scratch', () => {
        const c = boxConfig(env(), cloned(ORIGIN_OK));
        expect(c).toEqual({
            instance: 'http://edge:8080/', hostToken: HOST_TOKEN,
            mcp: { executable: process.execPath, entrypoint: '/opt/agora/agora-mcp/dist/index.js' },
            profiles: { 'box-one': { adapter: 'codex', executable: '/opt/agora/bin/codex', workdir: '/home/agent/work/acme/widgets', workdirAlias: 'work',
                stateDir: '/home/agent/.agora/state/box-one', auth: 'subscription', proxyEnv: true } },
            botTokens: { [id(5)]: BOX_BOT_TOKEN },
        });
        expect(configSchema.safeParse(c).success).toBe(true);
        expect(boxConfig(env(), { home: '/home/agent', exists: () => false }).profiles['box-one'].workdir).toBe('/home/agent/scratch');
        expect(boxConfig(env({ repos: [] }), { home: '/home/agent', exists: () => true }).profiles['box-one'].workdir).toBe('/home/agent/scratch');
    });
    // Codex review #7: a home kept across a repo change must not pass one repo's clone off as another's
    it('uses a kept clone only when its origin is that repo through the edge', () => {
        const workdir = (gitConfig: string | null, repos = ['acme/widgets']) => boxConfig(env({ repos }), cloned(gitConfig)).profiles['box-one'].workdir;
        expect(workdir(ORIGIN_OK)).toBe('/home/agent/work/acme/widgets');
        // other/widgets after acme/widgets: a different folder, so the old clone is never it
        expect(workdir(ORIGIN_OK, ['other/widgets'])).toBe('/home/agent/scratch');
        expect(workdir(ORIGIN_OK.replace('acme/widgets', 'other/widgets'))).toBe('/home/agent/scratch');
        expect(workdir(ORIGIN_OK.replace('http://edge:8080/git/', 'https://'))).toBe('/home/agent/scratch');
        expect(workdir(ORIGIN_OK + '[remote "origin"]\n\turl = http://evil.example/x.git\n')).toBe('/home/agent/scratch');
        expect(workdir(null)).toBe('/home/agent/scratch');
        // An attached repo named scratch lives under its owner, never in the fallback
        expect(repoDir('/home/agent', 'acme/scratch')).toBe('/home/agent/work/acme/scratch');
        expect(originMatches(ORIGIN_OK, 'http://edge:8080/', 'acme/widgets')).toBe(true);
    });
    it('carries an api_key profile and the Claude CLI path', () => {
        const c = boxConfig(env({ adapter: 'claude', auth: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY' }), { home: '/home/agent', exists: () => false });
        expect(c.profiles['box-one']).toMatchObject({ adapter: 'claude', executable: '/opt/agora/bin/claude', auth: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY' });
    });
    it('refuses a bad environment without echoing any value', () => {
        const bad = (e: NodeJS.ProcessEnv) => { try { boxConfig(e, { home: '/home/agent', exists: () => false }); return null; } catch (err) { return (err as Error).message; } };
        expect(bad({ ...env(), AGORA_HOST_TOKEN: '' })).toMatch(/missing AGORA_HOST_TOKEN/);
        expect(bad({ ...env(), AGORA_BOX_PROFILE: '{nope' })).toBe('AGORA_BOX_PROFILE is not JSON');
        for (const repos of [['../etc'], ['acme/..'], ['acme/a/b'], ['acme/x.git'], ['a_b/x'], ['acme/a b']])
            expect(bad(env({ repos }))).toMatch(/AGORA_BOX_PROFILE is invalid/);
        expect(bad(env({ adapter: 'gemini' }))).toMatch(/invalid \(adapter\)/);
        expect(bad(env({ auth: 'siwc' }))).toMatch(/invalid \(auth\)/);
        expect(bad(env({ auth: 'api_key' }))).toMatch(/needs apiKeyEnv/);
        const message = bad({ ...env(), AGORA_HOST_TOKEN: 'not-a-host-token-secretvalue' });
        expect(message).toMatch(/Box config is invalid \(hostToken\)/);
        expect(message).not.toContain('secretvalue');
        expect(bad({ ...env(), AGORA_BOT_ID: 'x' })).toBe('AGORA_BOT_ID is not an ID');
        expect(readBoxProfile(env()).repos).toEqual(['acme/widgets', 'acme/docs']);
    });
    it('box-config writes the file with mode 0600 and prints the repos', async () => {
        const t = await tempDir(); cleanups.push(t.cleanup);
        const out = join(t.dir, 'host.json');
        expect(await boxConfigCommand(['--out', out, '--home', t.dir], env())).toBe(0);
        const written = JSON.parse(await readFile(out, 'utf8')) as Config;
        expect(written.profiles['box-one'].workdir).toBe(posix.join(t.dir, 'scratch'));
        if (unix) expect((await stat(out)).mode & 0o777).toBe(0o600);
        expect(await boxConfigCommand(['--out', 'relative.json'], env())).toBe(2);
        expect(await boxConfigCommand(['--repos'], { ...env(), AGORA_BOT_TOKEN: '' })).toBe(2);
    });
});

// The box test image's fake CLIs, driven by agora-host exactly as in a box
describe.skipIf(!unix)('fake CLIs from box/fake', () => {
    async function fakeProfile(adapter: 'codex' | 'claude') {
        const { c, delivery, dir } = await setup(adapter);
        const bin = join(dir, '..', `${adapter}-bin-${Date.now()}`); await mkdir(bin, { recursive: true });
        cleanups.push(async () => { const { rm } = await import('node:fs/promises'); await rm(bin, { recursive: true, force: true }); });
        const exe = join(bin, `${adapter}.mjs`); await copyFile(FAKE_CLI, exe); await chmod(exe, 0o755);
        c.profiles.builder.executable = exe;
        await mkdir(c.profiles.builder.stateDir, { recursive: true });
        return { c, delivery };
    }
    for (const adapter of ['codex', 'claude'] as const) {
        it(`${adapter}: verified version, a turn agora-host parses, and what the CLI saw`, async () => {
            enterBox();
            process.env.AGORA_HOST_TOKEN = HOST_TOKEN;
            const { c, delivery } = await fakeProfile(adapter);
            expect(await verifyProfile(c.profiles.builder)).toBe(adapter === 'codex' ? '0.163.0' : '2.1.311');
            // Not logged in: the turn fails as the real CLI's does
            let launch = await prepare(c, delivery); cleanups.push(launch.cleanup);
            expect((await new ProcessRunner().start(launch).result).success).toBe(false);
            await writeFile(join(c.profiles.builder.stateDir, '.fake-login'), 'x');
            launch = await prepare(c, delivery); cleanups.push(launch.cleanup);
            const result = await new ProcessRunner().start(launch).result;
            expect(result).toMatchObject({ success: true, summary: `fake ${adapter} turn`, tokensUsed: 15 });
            expect(result.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
            const call = JSON.parse(await readFile(join(c.profiles.builder.stateDir, '.fake-last-call.json'), 'utf8'));
            expect(call.args).toContain(adapter === 'codex' ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions');
            expect(call.envNames).not.toContain('AGORA_HOST_TOKEN');
            expect(call.envNames).not.toContain('AGORA_HOST_IN_BOX');
            expect(call.envNames).toContain('AGORA_BOT_TOKEN');
        });
    }
});

// ─── opencode, the first ACP box adapter (box-adapters.ts) ───

const FAKE_ACP = fileURLToPath(new URL('../../box/fake/fake-acp.mjs', import.meta.url));
async function opencodeSetup(executable = process.execPath) {
    const dir = await repo();
    const base = config(dir);
    const c = configSchema.parse({ ...base, profiles: { builder: { adapter: 'opencode', executable, workdir: dir, workdirAlias: 'agora',
        stateDir: join(dir, 'state'), approvedTools: ['chat_history', 'chat_send'], proxyEnv: true } } });
    const delivery = claim();
    Object.assign(delivery.profile, { adapter: 'opencode', model: 'qwen/qwen3-coder', effort: null, authMode: 'api_key' });
    process.env.OPENROUTER_API_KEY = 'sk-or-box-secret';
    return { c, delivery, dir };
}

describe('the box image pins', () => {
    it('every CLI pin is a version this host verifies (verifyProfile), so a box never starts on an untested CLI', () => {
        for (const [name, spec] of Object.entries(BOX_ADAPTERS)) {
            // ACP agents are checked by their protocol version instead
            if (spec.protocol === 'cli') expect(testedCliVersion(name, spec.version), name).toBe(true);
        }
        expect(testedCliVersion('codex', '0.164.0')).toBe(false);
        expect(testedCliVersion('claude', '2.2.0')).toBe(false);
        expect(testedCliVersion('opencode', '1.18.34')).toBe(false);
    });
});

describe('opencode in a box', () => {
    const profile = (p: object = {}) => JSON.stringify({ name: 'qwen', adapter: 'opencode', auth: 'api_key', apiKeyEnv: 'OPENROUTER_API_KEY', workdirAlias: 'work', repos: [], ...p });
    const env = (p: object = {}) => ({ AGORA_INSTANCE_URL: 'http://edge:8080', AGORA_HOST_TOKEN: HOST_TOKEN, AGORA_BOT_ID: id(5),
        AGORA_BOT_TOKEN: BOX_BOT_TOKEN, AGORA_BOX_PROFILE: profile(p) });
    it('box config: the pinned CLI over ACP on its OpenRouter key; a subscription is refused', () => {
        const c = boxConfig(env(), { home: '/home/agent', exists: () => false });
        expect(c.profiles.qwen).toEqual({ adapter: 'opencode', executable: '/opt/agora/bin/opencode', workdir: '/home/agent/scratch', workdirAlias: 'work',
            protocol: 'acp', acpArgs: ['acp'], stateDir: '/home/agent/.agora/state/qwen', auth: 'api_key', apiKeyEnv: 'OPENROUTER_API_KEY', proxyEnv: true });
        expect(configSchema.safeParse(c).success).toBe(true);
        expect(() => boxConfig(env({ auth: 'subscription', apiKeyEnv: null }), { home: '/home/agent', exists: () => false }))
            .toThrow('AGORA_BOX_PROFILE: opencode in a box signs in with api_key');
    });
    it('yeet: every tool allowed but web search, every permission request allowed, quiet; never on a machine', async () => {
        const { c, delivery } = await opencodeSetup();
        Object.assign(process.env, { HTTPS_PROXY: 'http://edge:3128', NO_PROXY: 'edge' });
        // On a machine (flag set, no marker): opencode asks and the host answers from the rules
        process.env.AGORA_HOST_IN_BOX = '1'; boxMode.marker = join(marker, '..', 'missing');
        let launch = await prepare(c, delivery); cleanups.push(launch.cleanup);
        expect(launch.acp!.allowAll).toBeUndefined();
        expect(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!).permission).toEqual({ '*': 'ask', todowrite: 'allow', todoread: 'allow' });
        expect(launch.env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBeUndefined();
        expect(launch.env.HTTPS_PROXY).toBeUndefined();
        enterBox();
        launch = await prepare(c, delivery); cleanups.push(launch.cleanup);
        expect(launch.acp!.allowAll).toBe(true);
        expect(launch.args).toEqual(['acp']);
        const inline = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
        expect(inline).toMatchObject({ model: 'openrouter/qwen/qwen3-coder', enabled_providers: ['openrouter'], share: 'disabled', autoupdate: false,
            permission: { '*': 'allow', websearch: 'deny', codesearch: 'deny' } });
        expect(launch.env).toMatchObject({ OPENROUTER_API_KEY: 'sk-or-box-secret', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
            OPENCODE_DISABLE_SHARE: '1', HTTPS_PROXY: 'http://edge:3128', https_proxy: 'http://edge:3128' });
        // opencode's own server on 127.0.0.1 stays off the edge's proxy (its session/new fails otherwise)
        expect(launch.env.NO_PROXY).toBe('edge,localhost,127.0.0.1,::1');
        expect(launch.env.no_proxy).toBe('edge,localhost,127.0.0.1,::1');
        expect(launch.env.AGORA_HOST_TOKEN).toBeUndefined();
    });
    it('refuses an OpenRouter :online model in a box (provider-side web search around the edge), not on a machine', async () => {
        const { c, delivery } = await opencodeSetup();
        delivery.profile.model = 'qwen/qwen3-coder:online';
        process.env.AGORA_HOST_IN_BOX = '1'; boxMode.marker = join(marker, '..', 'missing');
        const launch = await prepare(c, delivery); cleanups.push(launch.cleanup);
        expect(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!).model).toBe('openrouter/qwen/qwen3-coder:online');
        enterBox();
        await expect(prepare(c, delivery)).rejects.toThrow('box_model_not_allowed');
    });
    it.skipIf(!unix)('box-config --state links each CLI\'s rules file and writes its settings once', async () => {
        const t = await tempDir(); cleanups.push(t.cleanup);
        const { readlink } = await import('node:fs/promises');
        for (const [adapter, auth, key] of [['claude', 'subscription', null], ['codex', 'subscription', null], ['opencode', 'api_key', 'OPENROUTER_API_KEY'], ['devin', 'subscription', null]] as const) {
            const e = env({ name: `box-${adapter}`, adapter, auth, apiKeyEnv: key });
            expect(await boxConfigCommand(['--state', '--home', t.dir], e)).toBe(0);
            const state = join(t.dir, '.agora', 'state', `box-${adapter}`);
            const rules = { claude: 'CLAUDE.md', codex: 'AGENTS.md', opencode: join('config', 'opencode', 'AGENTS.md'), devin: join('config', 'devin', 'AGENTS.md') }[adapter];
            expect(await readlink(join(state, rules))).toBe('/opt/agora/AGENTS.md');
            // Devin's user config (read by its login; each run gets its own): no update, no imports
            if (adapter === 'devin') {
                const settings = JSON.parse(await readFile(join(state, 'config', 'devin', 'config.json'), 'utf8'));
                expect(settings.auto_update).toBe(false);
                expect(Object.values(settings.read_config_from).every(v => v === false)).toBe(true);
            }
            if (adapter === 'claude') {
                expect(await readFile(join(state, 'settings.json'), 'utf8')).toBe('{\n  "env": { "DISABLE_AUTOUPDATER": "1" }\n}\n');
                expect((await stat(join(state, 'settings.json'))).mode & 0o777).toBe(0o600);
                // An owner's edit is kept at the next start
                await writeFile(join(state, 'settings.json'), '{}');
                expect(await boxConfigCommand(['--state', '--home', t.dir], e)).toBe(0);
                expect(await readFile(join(state, 'settings.json'), 'utf8')).toBe('{}');
            }
        }
    });
    it.skipIf(!unix)('the fake opencode from box/fake runs a turn as agora-host drives it in a box', async () => {
        const bin = await tempDir(); cleanups.push(bin.cleanup);
        const exe = join(bin.dir, 'opencode.mjs'); await copyFile(FAKE_ACP, exe); await chmod(exe, 0o755);
        enterBox();
        process.env.AGORA_HOST_TOKEN = HOST_TOKEN;
        const { c, delivery } = await opencodeSetup(exe);
        await mkdir(c.profiles.builder.stateDir, { recursive: true });
        expect(await verifyProfile(c.profiles.builder)).toBe('acp/1 1.18.34');
        const launch = await prepare(c, delivery); cleanups.push(launch.cleanup);
        const result = await new ProcessRunner().start(launch).result;
        expect(result).toMatchObject({ success: true, summary: 'fake opencode turn', tokensUsed: 15 });
        const call = JSON.parse(await readFile(join(c.profiles.builder.stateDir, '.fake-last-call.json'), 'utf8'));
        expect(call.args).toEqual(['acp']);
        // Its permission request was allowed: the box is the sandbox
        expect(call.answers).toEqual(['once']);
        expect(call.permission).toEqual({ '*': 'allow', websearch: 'deny', codesearch: 'deny' });
        expect(call.envNames).toContain('OPENROUTER_API_KEY');
        expect(call.envNames).not.toContain('AGORA_HOST_TOKEN');
        expect(call.envNames).not.toContain('AGORA_HOST_IN_BOX');
    });
});
