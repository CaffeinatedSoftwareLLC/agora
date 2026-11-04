import { fileURLToPath } from 'node:url';
import { copyFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { childEnv, prepare, verifyProfile } from '../src/adapters.js';
import { boxConfig, boxConfigCommand, boxMode, inBox, proxyVars, readBoxProfile } from '../src/box.js';
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
        boxMode.marker = join(marker, '..', 'missing');
        expect(childEnv(c.profiles.builder, source).HTTPS_PROXY).toBeUndefined();
        expect(proxyVars({ HTTPS_PROXY: 'http://edge:3128\nX: y' })).toEqual({});
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
    it('builds one profile on the first repo once it is cloned, else ~/work/scratch', () => {
        const cloned = boxConfig(env(), { home: '/home/agent', exists: p => p === '/home/agent/work/widgets/.git' });
        expect(cloned).toEqual({
            instance: 'http://edge:8080/', hostToken: HOST_TOKEN,
            mcp: { executable: process.execPath, entrypoint: '/opt/agora/agora-mcp/dist/index.js' },
            profiles: { 'box-one': { adapter: 'codex', executable: '/opt/agora/bin/codex', workdir: '/home/agent/work/widgets', workdirAlias: 'work',
                stateDir: '/home/agent/.agora/state/box-one', auth: 'subscription', proxyEnv: true } },
            botTokens: { [id(5)]: BOX_BOT_TOKEN },
        });
        expect(configSchema.safeParse(cloned).success).toBe(true);
        expect(boxConfig(env(), { home: '/home/agent', exists: () => false }).profiles['box-one'].workdir).toBe('/home/agent/work/scratch');
        expect(boxConfig(env({ repos: [] }), { home: '/home/agent', exists: () => true }).profiles['box-one'].workdir).toBe('/home/agent/work/scratch');
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
        expect(written.profiles['box-one'].workdir).toBe(posix.join(t.dir, 'work', 'scratch'));
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
