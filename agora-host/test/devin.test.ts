import { fileURLToPath } from 'node:url';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { childEnv, DEVIN_PROJECT_CONFIG, devinConfig, devinDirs, devinProjectConfig, prepare, verifyProfile, type Launch } from '../src/adapters.js';
import { ACP_FATAL, type AcpPlan } from '../src/acp/session.js';
import { boxConfig, boxMode } from '../src/box.js';
import { configSchema, loadConfig } from '../src/config.js';
import { ProcessRunner } from '../src/process.js';
import { checkTerms, DEVIN_HOST_UNVERIFIED, HostConfigError, profileReport, TermsRefusal } from '../src/terms.js';
import { git } from '../src/workspaces.js';
import { claim, config, id, tempDir } from './helpers.js';

/**
 * Devin over ACP (`devin acp`) on the owner's own Devin login, on a machine and in an agent box
 * (agora-host README "Devin", docs/provider-terms.md "Devin"). The fake devin is box/fake/fake-acp.mjs
 * under the name devin.mjs, as in the box test image.
 */

const unix = process.platform !== 'win32';
const FAKE_ACP = fileURLToPath(new URL('../../box/fake/fake-acp.mjs', import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
const saved = { marker: boxMode.marker, env: { ...process.env } };
let marker: string;
beforeEach(async () => {
    const t = await tempDir(); cleanups.push(t.cleanup);
    marker = join(t.dir, 'agora-box'); await writeFile(marker, 'agora-box 3\n');
});
afterEach(async () => {
    boxMode.marker = saved.marker;
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
    for (const c of cleanups.splice(0).reverse()) await c();
});
function enterBox() { boxMode.marker = marker; process.env.AGORA_HOST_IN_BOX = '1'; }
/**
 * A folder in the OS temp dir: agora-host's own .cache lies inside the checkout, and a folder above
 * a checkout can have a .devin of its own (an owner's Devin grants), which devinProjectConfig refuses.
 */
async function osTemp(): Promise<{ dir: string; cleanup(): Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), 'agora-devin-test-'));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
async function repo() {
    const t = await osTemp(); cleanups.push(t.cleanup);
    await git(t.dir, ['init']);
    await git(t.dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture']);
    return t.dir;
}
/** The test profile without the defaults parsing filled in, so devin's own apply. */
function bare(dir: string) {
    const { protocol: _p, auth: _a, acpArgs: _g, apiKeyEnv: _k, ...rest } = config(dir).profiles.builder;
    return rest;
}
/** A devin profile; on a machine the tests opt in to its unverified approvals unless they say otherwise. */
function devin(dir: string, profile: object = {}) {
    return configSchema.parse({ ...config(dir), profiles: { builder: { ...bare(dir), adapter: 'devin', allowUnverifiedApprovals: true, ...profile } } });
}
function delivery() {
    const c = claim(); c.profile.adapter = 'devin'; c.profile.model = null; c.profile.effort = null; c.profile.authMode = 'subscription';
    // The owner's own message (the subscription rule)
    c.inbox = [{ ...c.inbox[0], reason: 'direct', authorBot: false, authority: 'owner' }];
    return c;
}
/** A copy of the fake ACP CLI named devin.mjs (its name picks the CLI it plays). */
async function fakeDevin(edit?: (source: string) => string) {
    const t = await tempDir(); cleanups.push(t.cleanup);
    const exe = join(t.dir, 'devin.mjs');
    if (edit) await writeFile(exe, edit(await readFile(FAKE_ACP, 'utf8'))); else await copyFile(FAKE_ACP, exe);
    await chmod(exe, 0o755);
    return exe;
}
/** Run a prepared launch with the fake devin through node (Windows can't run a .mjs file itself). */
async function turn(launch: Launch, exe: string) {
    return new ProcessRunner().start({ ...launch, executable: process.execPath, args: [exe, ...launch.args] }).result;
}
async function lastCall(stateDir: string) { return JSON.parse(await readFile(join(stateDir, '.fake-last-call.json'), 'utf8')); }
/** Devin's own login, as `devin auth login` leaves it (the host never reads it). */
async function logIn(stateDir: string) {
    const data = unix ? join(stateDir, 'data') : join(stateDir, 'home', 'AppData', 'Roaming');
    await mkdir(join(data, 'devin'), { recursive: true }); await writeFile(join(data, 'devin', 'credentials.toml'), 'fake_login = true\n');
}

describe('devin profiles', () => {
    it('default to ACP on the owner\'s login and refuse anything else', async () => {
        const t = await tempDir(); cleanups.push(t.cleanup);
        const p = devin(t.dir).profiles.builder;
        expect(p).toMatchObject({ adapter: 'devin', protocol: 'acp', acpArgs: ['acp'], auth: 'subscription' });
        expect(profileReport({ builder: p })).toEqual([{ name: 'builder', adapter: 'devin', authMode: 'subscription', apiKeyEnv: null, runApproval: false }]);
        const base = config(t.dir); const path = join(t.dir, 'host.local.json'); await writeFile(base.mcp.entrypoint, '');
        const load = async (profile: object) => {
            await writeFile(path, JSON.stringify({ ...base, profiles: { builder: { ...bare(t.dir), adapter: 'devin', ...profile } } }));
            try { await loadConfig(path); return 'ok'; } catch (e) { return (e as Error).message; }
        };
        expect(await load({})).toBe('ok');
        process.env.WINDSURF_API_KEY = 'devin-token-secret';
        // No API key mode: the token is the account's own, and a Devin account is its holder's
        for (const bad of [{ auth: 'api_key', apiKeyEnv: 'WINDSURF_API_KEY' }, { protocol: 'cli' }, { auth: 'siwc' }])
            expect(await load(bad)).toContain('Devin is hosted only over ACP on the owner\'s own Devin login');
        expect(await load({ auth: 'api_key', apiKeyEnv: 'WINDSURF_API_KEY' })).not.toContain('devin-token-secret');
        expect(await load({ caps: { maxBudgetUsd: 5 } })).toContain('ACP has no verified USD cap');
        expect(await load({ allowUnverifiedApprovals: true })).toBe('ok');
        await writeFile(path, JSON.stringify({ ...base, profiles: { builder: { ...bare(t.dir), allowUnverifiedApprovals: true } } }));
        await expect(loadConfig(path)).rejects.toThrow('allowUnverifiedApprovals applies only to a devin profile');
    });
    it('wake only for the owner (subscription rule)', async () => {
        const t = await tempDir(); cleanups.push(t.cleanup);
        const p = devin(t.dir).profiles.builder;
        expect(() => checkTerms(p, delivery())).not.toThrow();
        const other = delivery(); other.inbox = [{ ...other.inbox[0], authority: 'director', authorId: id(12) }];
        expect(() => checkTerms(p, other)).toThrow(TermsRefusal);
        const notStarted = delivery(); notStarted.session.startedByOwner = false;
        expect(() => checkTerms(p, notStarted)).toThrow('runs on the owner\'s personal subscription');
    });
});

describe('devin child environment', () => {
    const source = { PATH: '/usr/bin', HOME: '/home/me', XDG_CONFIG_HOME: '/home/me/.config', XDG_DATA_HOME: '/home/me/.local/share',
        WINDSURF_API_KEY: 'secret', DEVIN_PERMISSION_MODE: 'dangerous', DEVIN_MODEL: 'opus', AGORA_HOST_TOKEN: 'ah_x' };
    it('Linux and macOS: its XDG directories in the state directory, the user\'s home kept for git', () => {
        const p = { ...devin('/srv/repo').profiles.builder, stateDir: '/srv/state/devin' };
        const env = childEnv(p, source, 'linux');
        expect(env).toMatchObject({ HOME: '/home/me', XDG_CONFIG_HOME: '/srv/state/devin/config', XDG_DATA_HOME: '/srv/state/devin/data',
            XDG_CACHE_HOME: '/srv/state/devin/cache', XDG_STATE_HOME: '/srv/state/devin/state' });
        // Never the host's own Devin token, permission mode or model, nor the host token
        for (const name of ['WINDSURF_API_KEY', 'DEVIN_PERMISSION_MODE', 'DEVIN_MODEL', 'AGORA_HOST_TOKEN']) expect(env[name]).toBeUndefined();
    });
    it('Windows: a profile folder of its own, HOME in it too (Devin ignores XDG and APPDATA alone there); git keeps the user\'s identity', () => {
        const p = { ...devin('/srv/repo').profiles.builder, stateDir: 'C:\\state\\devin' };
        const env = childEnv(p, { Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
            LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', WINDSURF_API_KEY: 'secret', GIT_CONFIG_GLOBAL: 'C:\\elsewhere' }, 'win32');
        expect(env).toMatchObject({ HOME: 'C:\\state\\devin\\home', USERPROFILE: 'C:\\state\\devin\\home', APPDATA: 'C:\\state\\devin\\home\\AppData\\Roaming',
            LOCALAPPDATA: 'C:\\state\\devin\\home\\AppData\\Local', GIT_CONFIG_GLOBAL: 'C:\\Users\\me\\.gitconfig' });
        // A HOME the user set wins for git's identity
        expect(childEnv(p, { USERPROFILE: 'C:\\Users\\me', HOME: 'D:\\home\\me' }, 'win32').GIT_CONFIG_GLOBAL).toBe('D:\\home\\me\\.gitconfig');
        expect(env.WINDSURF_API_KEY).toBeUndefined();
        expect(Object.keys(env).filter(k => k.toUpperCase() === 'APPDATA')).toEqual(['APPDATA']);
        expect(devinDirs('C:\\state\\devin', 'win32').USERPROFILE).toBe(win32.join('C:\\state\\devin', 'home'));
    });
});

describe('devin config', () => {
    const IMPORTS = ['agents_standard', 'claude', 'cloud', 'copilot', 'cursor', 'opencode', 'windsurf', 'zed'];
    it('on a machine: no imports or updates, every tool asks, .devin/ can\'t be written, the owner\'s Agora tools allowed', () => {
        const c = JSON.parse(devinConfig(false, ['chat_send', 'chat_history', 'chat_send']));
        expect(c.auto_update).toBe(false);
        expect(Object.keys(c.read_config_from).sort()).toEqual(IMPORTS);
        expect(Object.values(c.read_config_from).every(v => v === false)).toBe(true);
        expect(c.otel).toEqual({ enabled: false });
        expect(c.permission_mode).toBe('normal');
        // Devin's documented tool names, and Write() for the write tool and for paths
        expect(c.permissions).toEqual({ allow: ['mcp__agora__chat_send', 'mcp__agora__chat_history'],
            ask: ['read', 'edit', 'grep', 'glob', 'exec', 'Write(**)', 'Write(/**)'],
            deny: ['Write(.devin/**)', 'Write(**/.devin/**)', 'Write(/**/.devin/**)'] });
    });
    it('in a box: every tool allowed in Devin\'s own rules but its web tools; no bypass', () => {
        const c = JSON.parse(devinConfig(true, ['chat_send']));
        expect(Object.values(c.read_config_from).every(v => v === false)).toBe(true);
        expect(c).toMatchObject({ auto_update: false, permission_mode: 'normal', permissions: {
            allow: ['read', 'edit', 'grep', 'glob', 'exec', 'Write(**)', 'Write(/**)', 'mcp__agora__*'], deny: ['web_search', 'webfetch'] } });
        expect(c.permissions.ask).toBeUndefined();
    });
});

describe('devin on a machine', () => {
    it('needs the owner\'s opt-in to unverified approvals; a box doesn\'t', async () => {
        const dir = await repo(); const c = devin(dir, { allowUnverifiedApprovals: false });
        const err = await prepare(c, delivery()).catch(e => e);
        expect(err).toBeInstanceOf(HostConfigError);
        expect(err.message).toBe(DEVIN_HOST_UNVERIFIED);
        await expect(verifyProfile(c.profiles.builder)).rejects.toThrow(DEVIN_HOST_UNVERIFIED);
        enterBox();
        const launch = await prepare(c, delivery()); cleanups.push(launch.cleanup);
        expect(launch.acp!.allowAll).toBe(true);
    });
    it('prepares `devin --config <run file> acp` in Code mode, with the Agora MCP server from session/new', async () => {
        const dir = await repo(); const c = devin(dir);
        const launch = await prepare(c, delivery()); cleanups.push(launch.cleanup);
        const file = launch.args[1];
        expect(launch.args).toEqual(['--config', file, 'acp']);
        expect(file.startsWith(join(c.profiles.builder.stateDir, 'run-'))).toBe(true);
        expect(await readFile(file, 'utf8')).toBe(devinConfig(false, c.profiles.builder.approvedTools));
        expect(launch.acp).toMatchObject({ sessionMode: 'accept-edits', authMethod: null, model: null });
        expect(launch.acp!.allowAll).toBeUndefined();
        expect(launch.acp!.mcpServers.map(s => s.name)).toEqual(['agora']);
        expect(launch.env.AGORA_BOT_TOKEN).toBe('bot_selected.secret');
        await launch.cleanup();
        expect(existsSync(file)).toBe(false);
    });
    it('refuses a worktree with .devin/ (Devin runs its hooks unasked), at the top or anywhere tracked; a box allows it', async () => {
        const dir = await repo(); const c = devin(dir);
        expect(await devinProjectConfig(dir)).toBe(false);
        await mkdir(join(dir, 'pkg', '.devin'), { recursive: true });
        await writeFile(join(dir, 'pkg', '.devin', 'hooks.v1.json'), '{"SessionStart":[]}');
        // Untracked files count too (a previous run in the same worktree could have made one)
        expect(await devinProjectConfig(dir)).toBe(true);
        await git(dir, ['add', '.']);
        await git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'hooks']);
        const err = await prepare(c, delivery()).catch(e => e);
        expect(err).toBeInstanceOf(HostConfigError);
        expect(err.message).toBe(DEVIN_PROJECT_CONFIG);
        const top = await repo();
        await mkdir(join(top, '.devin'));
        expect(await devinProjectConfig(top)).toBe(true);
        // Above the repository root too, up to the filesystem root (the user's home included)
        const above = await osTemp(); cleanups.push(above.cleanup);
        const nested = join(above.dir, 'projects', 'repo');
        await mkdir(nested, { recursive: true }); await git(nested, ['init']);
        expect(await devinProjectConfig(nested)).toBe(false);
        await mkdir(join(above.dir, '.devin'));
        expect(await devinProjectConfig(nested)).toBe(true);
        enterBox();
        const launch = await prepare(c, delivery()); cleanups.push(launch.cleanup);
        expect(launch.acp!.allowAll).toBe(true);
    });
    it('a turn: every call, the workspace edit included, reaches the host; what the owner hasn\'t allowed becomes a card', async () => {
        const exe = await fakeDevin();
        const dir = await repo(); const c = devin(dir);
        await logIn(c.profiles.builder.stateDir);
        const launch = await prepare(c, delivery()); cleanups.push(launch.cleanup);
        const result = await turn(launch, exe);
        expect(result).toMatchObject({ success: true, summary: 'fake devin turn', tokensUsed: 15 });
        expect(result.deniedTools).toEqual(['Edit', 'Bash(git:*)', 'WebSearch', 'WebFetch(domain:example.com)']);
        const call = await lastCall(c.profiles.builder.stateDir);
        expect(call.args).toEqual(['--config', launch.args[1], 'acp']);
        expect(call.modes).toEqual(['accept-edits']);
        // The fake decides as Devin's reference says: Code mode would run the edit by itself; the ask rules send it to the host
        expect(call.calls).toEqual([{ tool: 'edit', outcome: 'asked:reject' }, { tool: 'exec', outcome: 'asked:reject' },
            { tool: 'web_search', outcome: 'asked:reject' }, { tool: 'read_url', outcome: 'asked:reject' }]);
        expect(call.envNames).not.toContain('AGORA_HOST_TOKEN');
    });
    it('without the ask rules Code mode runs the workspace edit unasked (what the rules are for)', async () => {
        const exe = await fakeDevin();
        const dir = await repo(); const c = devin(dir);
        await logIn(c.profiles.builder.stateDir);
        const launch = await prepare(c, delivery()); cleanups.push(launch.cleanup);
        const cfg = JSON.parse(await readFile(launch.args[1], 'utf8'));
        delete cfg.permissions.ask;
        await writeFile(launch.args[1], JSON.stringify(cfg));
        await turn(launch, exe);
        const call = await lastCall(c.profiles.builder.stateDir);
        expect(call.calls[0]).toEqual({ tool: 'edit', outcome: 'auto' });
        expect(call.calls[1]).toEqual({ tool: 'exec', outcome: 'asked:reject' });
    });
    it('a turn with the tool allowed for this run, and none without a login', async () => {
        const exe = await fakeDevin();
        const dir = await repo(); const c = devin(dir);
        const d = delivery(); d.run.grantedTools = ['Bash(git status:*)', 'Edit', 'WebSearch', 'WebFetch(domain:example.com)'];
        let launch = await prepare(c, d); cleanups.push(launch.cleanup);
        // ACP's auth_required: never retried, the owner logs the profile in
        expect(await turn(launch, exe)).toMatchObject({ success: false, error: 'acp_auth_required' });
        await logIn(c.profiles.builder.stateDir);
        launch = await prepare(c, d); cleanups.push(launch.cleanup);
        const result = await turn(launch, exe);
        expect(result.success).toBe(true);
        expect(result.deniedTools).toBeUndefined();
        expect((await lastCall(c.profiles.builder.stateDir)).answers).toEqual(['once', 'once', 'once', 'once']);
    });
    it('a mode the agent doesn\'t offer fails the run, and is never retried', async () => {
        const exe = await fakeDevin();
        const dir = await repo(); const c = devin(dir);
        await logIn(c.profiles.builder.stateDir);
        const launch = await prepare(c, delivery()); cleanups.push(launch.cleanup);
        const result = await turn({ ...launch, acp: { ...launch.acp!, sessionMode: 'yolo' } as AcpPlan }, exe);
        expect(result).toMatchObject({ success: false, error: 'acp_mode_unavailable' });
        expect(ACP_FATAL.has('acp_mode_unavailable')).toBe(true);
    });
});

describe('devin in a box', () => {
    const env = (p: object = {}) => ({ AGORA_INSTANCE_URL: 'http://edge:8080', AGORA_HOST_TOKEN: 'ah_01J0000000000000000000HOST.hostsecretvalue', AGORA_BOT_ID: id(5),
        AGORA_BOT_TOKEN: 'bot_box.botsecretvalue', AGORA_BOX_PROFILE: JSON.stringify({ name: 'devin', adapter: 'devin', auth: 'subscription', workdirAlias: 'work', repos: [], ...p }) });
    it('box config: the pinned CLI over ACP on the owner\'s login; an API key is refused', () => {
        const c = boxConfig(env(), { home: '/home/agent', exists: () => false });
        expect(c.profiles.devin).toEqual({ adapter: 'devin', executable: '/opt/agora/bin/devin', workdir: '/home/agent/scratch', workdirAlias: 'work',
            protocol: 'acp', acpArgs: ['acp'], stateDir: '/home/agent/.agora/state/devin', auth: 'subscription', proxyEnv: true });
        expect(configSchema.safeParse(c).success).toBe(true);
        expect(() => boxConfig(env({ auth: 'api_key', apiKeyEnv: 'WINDSURF_API_KEY' }), { home: '/home/agent', exists: () => false }))
            .toThrow('AGORA_BOX_PROFILE: devin in a box signs in with subscription');
    });
    it('yeet: Devin\'s rules allow every tool, the host allows what it still asks but web tools; never on a machine', async () => {
        const exe = await fakeDevin();
        const dir = await repo(); const c = devin(dir, { proxyEnv: true });
        Object.assign(process.env, { HTTPS_PROXY: 'http://edge:3128', NO_PROXY: 'edge' });
        // The flag alone (no marker file) is a machine: every tool asks
        process.env.AGORA_HOST_IN_BOX = '1'; boxMode.marker = join(marker, '..', 'missing');
        let launch = await prepare(c, delivery()); cleanups.push(launch.cleanup);
        expect(launch.acp).toMatchObject({ sessionMode: 'accept-edits' });
        expect(launch.acp!.allowAll).toBeUndefined();
        expect(JSON.parse(await readFile(launch.args[1], 'utf8')).permissions.ask).toBeDefined();
        expect(launch.env.HTTPS_PROXY).toBeUndefined();
        enterBox();
        launch = await prepare(c, delivery()); cleanups.push(launch.cleanup);
        expect(launch.args).toEqual(['--config', launch.args[1], 'acp']);
        expect(launch.acp).toMatchObject({ sessionMode: 'accept-edits', allowAll: true,
            allowAllExcept: { names: ['web_search', 'websearch', 'search_web', 'webfetch', 'web_fetch'], kinds: ['fetch'] } });
        expect(await readFile(launch.args[1], 'utf8')).toBe(devinConfig(true, c.profiles.builder.approvedTools));
        expect(launch.env).toMatchObject({ HTTPS_PROXY: 'http://edge:3128', https_proxy: 'http://edge:3128', NO_PROXY: 'edge' });
        await logIn(c.profiles.builder.stateDir);
        const result = await turn(launch, exe);
        expect(result).toMatchObject({ success: true, summary: 'fake devin turn' });
        expect(result.deniedTools).toBeUndefined();
        const call = await lastCall(c.profiles.builder.stateDir);
        // Edit and shell run by Devin's own rules; its search is denied there; a fetch no rule names
        // asks, and the host refuses it (a box reaches the web only through the edge)
        expect(call.modes).toEqual(['accept-edits']);
        expect(call.calls).toEqual([{ tool: 'edit', outcome: 'auto' }, { tool: 'exec', outcome: 'auto' },
            { tool: 'web_search', outcome: 'denied' }, { tool: 'read_url', outcome: 'asked:reject' }]);
    });
});

describe.skipIf(!unix)('devin start-up check', () => {
    it('the pinned line passes with its version; another one only with allowUntestedVersion', async () => {
        const dir = await repo();
        const exe = await fakeDevin();
        expect(await verifyProfile(devin(dir, { executable: exe }).profiles.builder)).toBe('devin 3000.11.234, acp/1 0.0.0-dev');
        const newer = await fakeDevin(s => s.replace("'3000.11.234'", "'3000.12.1'"));
        await expect(verifyProfile(devin(dir, { executable: newer }).profiles.builder)).rejects.toThrow('unsupported_cli_version');
        expect(await verifyProfile(devin(dir, { executable: newer, allowUntestedVersion: true }).profiles.builder)).toBe('devin 3000.12.1, acp/1 0.0.0-dev');
        // The probe got a run's config (nothing imported, no update) and ran in the state directory
        const call = await lastCall(devin(dir).profiles.builder.stateDir);
        expect(call.cwd).toBe(devin(dir).profiles.builder.stateDir);
        expect(call.args).toEqual(['--config', join(devin(dir).profiles.builder.stateDir, 'devin-probe.json'), 'acp']);
        expect(call.config.read_config_from.claude).toBe(false);
        expect(call.config.auto_update).toBe(false);
    });
});
