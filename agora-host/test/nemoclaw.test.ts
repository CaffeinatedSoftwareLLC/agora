import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema, loadConfig } from '../src/config.js';
import { childEnv, prepare, verifyProfile } from '../src/adapters.js';
import { boxConfig, boxMode } from '../src/box.js';
import { ProcessRunner } from '../src/process.js';
import { git } from '../src/workspaces.js';
import { HostConfigError, NEMOCLAW_API_KEY_ONLY } from '../src/terms.js';
import {
    mcpAddArgs, turnTimeout, NEMOCLAW_BOX_ONLY, openclawExecArgs, openclawModel, openclawVersion, NEMOCLAW_HOST_ONLY, NEMOCLAW_NOT_OPENCLAW, NEMOCLAW_WAKE_NOTE, nemoclawAgentArgs, nemoclawCommand,
    nemoclawEnv, nemoclawSetup, nemoclawVersion, openclawSessionId, parseOpenClaw,
} from '../src/nemoclaw.js';
import { claim, config, id, tempDir } from './helpers.js';

/**
 * NVIDIA NemoClaw on a machine (src/nemoclaw.ts): each wake is `nemoclaw <sandbox> agent` with
 * the prompt on stdin, Agora's tools come from the sandbox's managed MCP (the /mcp endpoint),
 * and the bot token never reaches a run. The fake CLI (box/fake/fake-nemoclaw.mjs) answers as
 * NemoClaw v0.0.143 documents it, so no NVIDIA key or Docker is needed.
 */

const unix = process.platform !== 'win32';
const FAKE = fileURLToPath(new URL('../../box/fake/fake-nemoclaw.mjs', import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
const saved = { marker: boxMode.marker, env: { ...process.env } };
let marker: string;
beforeEach(async () => {
    const t = await tempDir(); cleanups.push(t.cleanup);
    marker = join(t.dir, 'agora-box'); await writeFile(marker, 'agora-box 5\n');
});
afterEach(async () => {
    boxMode.marker = saved.marker;
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
    for (const c of cleanups.splice(0).reverse()) await c();
});
function enterBox() { boxMode.marker = marker; process.env.AGORA_HOST_IN_BOX = '1'; }

async function repo() {
    const dir = await mkdtemp(join(tmpdir(), 'agora-nemoclaw-test-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await git(dir, ['init']);
    await git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture']);
    return dir;
}
const NEMO = { sandbox: 'agora-nemo', mcpUrl: 'https://agora.tail1234.ts.net/mcp' };
function bare(dir: string) {
    const { protocol: _p, auth: _a, acpArgs: _g, apiKeyEnv: _k, approvedTools: _t, ...rest } = config(dir).profiles.builder;
    return rest;
}
function nemoclaw(dir: string, profile: object = {}) {
    return configSchema.parse({ ...config(dir), profiles: { builder: { ...bare(dir), adapter: 'nemoclaw', auth: 'api_key', nemoclaw: NEMO, ...profile } } });
}
function delivery() {
    const c = claim(); c.profile.adapter = 'nemoclaw'; c.profile.model = null; c.profile.effort = null; c.profile.authMode = 'api_key';
    c.inbox = [{ ...c.inbox[0], reason: 'direct', authorBot: false, authority: 'director' }];
    return c;
}
async function fake() {
    const t = await tempDir(); cleanups.push(t.cleanup);
    const exe = join(t.dir, 'nemoclaw');
    await copyFile(FAKE, exe); await chmod(exe, 0o755);
    const log = join(t.dir, 'calls.jsonl');
    // Its settings file: a run gets only the OS variables, so the fake can't read FAKE_* ones
    const set = (settings: object = {}) => writeFile(`${exe}.json`, JSON.stringify({ log, ...settings }));
    await set();
    const calls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    return { exe, calls, set };
}

describe('nemoclaw profile config', () => {
    it('a machine profile: a sandbox, an https MCP URL, an API-key auth with no key variable', async () => {
        const dir = await repo();
        const p = nemoclaw(dir).profiles.builder;
        expect(p).toMatchObject({ adapter: 'nemoclaw', protocol: 'cli', auth: 'api_key', nemoclaw: { ...NEMO, trustPrivateHost: false } });
        expect(p.apiKeyEnv).toBeUndefined();
        // loadConfig doesn't look for a key variable the profile doesn't have
        const file = join(dir, 'host.json');
        await writeFile(join(dir, 'mcp.js'), '');
        await writeFile(file, JSON.stringify({ ...config(dir), profiles: { builder: { ...bare(dir), adapter: 'nemoclaw', auth: 'api_key', nemoclaw: NEMO } } }));
        expect((await loadConfig(file)).profiles.builder.adapter).toBe('nemoclaw');
    });

    it('refuses a subscription, ACP, a key variable on a machine, and a box form without NVIDIA_API_KEY', async () => {
        const dir = await repo();
        const issues = (profile: object) => {
            const r = configSchema.safeParse({ ...config(dir), profiles: { builder: { ...bare(dir), adapter: 'nemoclaw', ...profile } } });
            return r.success ? [] : r.error.issues.map(i => i.message);
        };
        expect(issues({ nemoclaw: NEMO })).toContain(NEMOCLAW_API_KEY_ONLY);
        expect(issues({ auth: 'api_key', protocol: 'acp', nemoclaw: NEMO })).toContain(NEMOCLAW_API_KEY_ONLY);
        expect(issues({ auth: 'api_key', apiKeyEnv: 'NVIDIA_API_KEY', nemoclaw: NEMO })).toContain(NEMOCLAW_API_KEY_ONLY);
        expect(issues({ auth: 'api_key' })).toContain(NEMOCLAW_API_KEY_ONLY);
        expect(issues({ auth: 'api_key', apiKeyEnv: 'NVIDIA_API_KEY' })).toEqual([]);
    });

    it('refuses an http or credentialed MCP URL, a bad sandbox name, WSL without wsl.exe, and the block on other adapters', async () => {
        const dir = await repo();
        const bad = (nemo: object, extra: object = {}) => !configSchema.safeParse({ ...config(dir),
            profiles: { builder: { ...bare(dir), adapter: 'nemoclaw', auth: 'api_key', nemoclaw: { ...NEMO, ...nemo }, ...extra } } }).success;
        expect(bad({ mcpUrl: 'http://agora.example.com/mcp' })).toBe(true);
        expect(bad({ mcpUrl: 'https://user:pw@agora.example.com/mcp' })).toBe(true);
        expect(bad({ mcpUrl: 'https://agora.example.com/mcp?token=x' })).toBe(true);
        for (const name of ['Agora', '1agora', 'agora--nemo', 'agora-', 'a'.repeat(20)]) expect(bad({ sandbox: name })).toBe(true);
        expect(bad({ sandbox: 'a' })).toBe(false);
        expect(bad({ wsl: { distro: 'Ubuntu', nemoclawPath: '/home/me/.local/bin/nemoclaw' } })).toBe(true);
        const wslExe = process.platform === 'win32' ? 'C:\\Windows\\System32\\wsl.exe' : '/mnt/c/Windows/System32/wsl.exe';
        expect(bad({ wsl: { distro: 'Ubuntu', nemoclawPath: '/home/me/.local/bin/nemoclaw' } }, { executable: wslExe })).toBe(false);
        expect(configSchema.safeParse({ ...config(dir), profiles: { builder: { ...config(dir).profiles.builder, nemoclaw: NEMO } } }).success).toBe(false);
    });
});

describe('nemoclaw commands', () => {
    it('runs nemoclaw directly, or through wsl.exe with the distro and the path in it', () => {
        expect(nemoclawCommand({ executable: '/usr/local/bin/nemoclaw', nemoclaw: { ...NEMO, trustPrivateHost: false } }, ['--version']))
            .toEqual({ executable: '/usr/local/bin/nemoclaw', args: ['--version'] });
        expect(nemoclawCommand({ executable: 'C:\\Windows\\System32\\wsl.exe',
            nemoclaw: { ...NEMO, trustPrivateHost: false, wsl: { distro: 'Ubuntu', nemoclawPath: '/home/me/.local/bin/nemoclaw' } } }, ['--version']))
            .toEqual({ executable: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu', '--exec', '/bin/bash', '-lc', 'exec "$0" "$@"', '/home/me/.local/bin/nemoclaw', '--version'] });
    });

    it('turns telemetry and prompts off, and through WSL passes those variables with WSLENV', () => {
        const local = nemoclawEnv({ nemoclaw: { ...NEMO, trustPrivateHost: false } }, { PATH: '/bin' });
        expect(local).toMatchObject({ PATH: '/bin', NEMOCLAW_DISABLE_TELEMETRY: '1', NEMOCLAW_NON_INTERACTIVE: '1' });
        expect(local.WSLENV).toBeUndefined();
        const wsl = nemoclawEnv({ nemoclaw: { ...NEMO, trustPrivateHost: false, wsl: { distro: 'Ubuntu', nemoclawPath: '/x' } } },
            { WSLENV: 'USERPROFILE/p' }, { AGORA_MCP_TOKEN: 'bot_x' });
        expect(wsl.WSLENV).toBe('USERPROFILE/p:NEMOCLAW_DISABLE_TELEMETRY/u:NEMOCLAW_NON_INTERACTIVE/u:AGORA_MCP_TOKEN/u');
        // passEnv: the named host variables, and only those, through WSL too
        const passing = nemoclawEnv({ nemoclaw: { ...NEMO, trustPrivateHost: false, passEnv: ['DOCKER_HOST', 'NEMOCLAW_GATEWAY_RUNTIME'],
            wsl: { distro: 'Ubuntu', nemoclawPath: '/x' } } }, {}, {}, { DOCKER_HOST: 'unix:///run/user/1000/docker.sock', OTHER: 'x' });
        expect(passing).toMatchObject({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' });
        expect(passing.OTHER).toBeUndefined();
        expect(passing.WSLENV).toBe('DOCKER_HOST/u:NEMOCLAW_DISABLE_TELEMETRY/u:NEMOCLAW_NON_INTERACTIVE/u');
    });

    it('passEnv takes container settings only, never a key', async () => {
        const dir = await repo();
        const ok = (names: string[]) => configSchema.safeParse({ ...config(dir), profiles: { builder: { ...bare(dir), adapter: 'nemoclaw', auth: 'api_key',
            nemoclaw: { ...NEMO, passEnv: names } } } }).success;
        expect(ok(['DOCKER_HOST', 'NEMOCLAW_GATEWAY_RUNTIME', 'XDG_RUNTIME_DIR'])).toBe(true);
        for (const bad of ['NVIDIA_INFERENCE_API_KEY', 'OPENROUTER_API_KEY', 'AGORA_BOT_TOKEN', 'PATH']) expect(ok([bad]), bad).toBe(false);
    });

    it('one wake: the session id, JSON, the model and a timeout; the session is named after Agora\'s', () => {
        const settings = { ...NEMO, trustPrivateHost: false };
        expect(nemoclawAgentArgs(settings, 'agora-01j', null, 900)).toEqual(['agora-nemo', 'agent', '--session-id', 'agora-01j', '--json', '--timeout', '810']);
        expect(nemoclawAgentArgs(settings, 's', 'nvidia/nemotron-3-super-120b-a12b', 120)).toEqual(['agora-nemo', 'agent', '--session-id', 's', '--json', '--model', 'nvidia/nemotron-3-super-120b-a12b', '--timeout', '60']);
        // The turn's own deadline always ends inside the run's timeout
        for (const t of [60, 120, 299, 300, 900, 7200]) expect(turnTimeout(t), String(t)).toBeLessThan(t);
        expect(turnTimeout(60)).toBe(30);
        const c = delivery();
        expect(openclawSessionId(c)).toBe(`agora-${id(2).toLowerCase()}`);
        c.session.nativeSessionId = 'review-42';
        expect(openclawSessionId(c)).toBe('review-42');
    });

    it('attaches the MCP endpoint by its environment variable, trusting a private host only when told', () => {
        // --no-probe: NemoClaw's own probe would bind the token to its client, not OpenClaw's
        expect(mcpAddArgs({ ...NEMO, trustPrivateHost: false })).toEqual(['agora-nemo', 'mcp', 'add', 'agora', '--url', NEMO.mcpUrl, '--env', 'AGORA_MCP_TOKEN', '--no-probe']);
        expect(mcpAddArgs({ ...NEMO, trustPrivateHost: true }).slice(-2)).toEqual(['--trusted-private-host', 'agora.tail1234.ts.net']);
        expect(nemoclawVersion('nemoclaw v0.0.143\n')).toBe('0.0.143');
        expect(nemoclawVersion('v0.0.143')).toBeNull();
    });
});

describe('parseOpenClaw', () => {
    const usage = { input: 1000, output: 50, cacheRead: 200, cacheWrite: 10 };
    it('reads the gateway envelope: the visible reply as the summary, the session and the tokens', () => {
        const out = JSON.stringify({ status: 'ok', result: { payloads: [{ text: 'plan', isReasoning: true }, { text: '{"summary":"Posted the review"}' }],
            meta: { agentMeta: { sessionId: 'agora-01j', usage } } } });
        expect(parseOpenClaw(out, 0)).toEqual({ success: true, nativeSessionId: 'agora-01j', tokensUsed: 1260, summary: 'Posted the review', changedPaths: [] });
    });
    it('reads the agent exec envelope, and plain reply text as the summary', () => {
        const out = JSON.stringify({ ok: true, status: 'ok', final: 'Tests pass.', payloads: [{ text: 'Tests pass.' }], usage: { input: 120, output: 8, total: 128 }, sessionId: 's1' });
        expect(parseOpenClaw(out, 0)).toMatchObject({ success: true, summary: 'Tests pass.', tokensUsed: 128, nativeSessionId: 's1' });
    });
    it('fails on an error in the envelope, a CLI error, a non-zero exit, no reply or no JSON', () => {
        const meta = (extra: object) => JSON.stringify({ payloads: [{ text: 'x' }], meta: { agentMeta: { sessionId: 's', usage }, ...extra } });
        expect(parseOpenClaw(meta({ error: { kind: 'incomplete_turn', message: 'x' } }), 0).success).toBe(false);
        expect(parseOpenClaw(meta({ aborted: true }), 0).success).toBe(false);
        expect(parseOpenClaw(JSON.stringify({ ok: false, error: { type: 'cli_error', message: 'bad' } }), 1).success).toBe(false);
        expect(parseOpenClaw(JSON.stringify({ ok: false, status: 'timeout', final: null, payloads: [] }), 2)).toMatchObject({ success: false, error: 'cli_failed_or_invalid_output' });
        expect(parseOpenClaw(meta({}), 1).success).toBe(false);
        expect(parseOpenClaw(JSON.stringify({ payloads: [{ text: 'hidden', isStatusNotice: true }], meta: {} }), 0).success).toBe(false);
        expect(parseOpenClaw('not json', 0)).toMatchObject({ success: false, nativeSessionId: null });
    });
    it('keeps the session it asked for when the output names none, and lets a lurk run pass silently', () => {
        expect(parseOpenClaw(JSON.stringify({ payloads: [{ text: 'done' }], meta: {} }), 0, false, 'agora-01j').nativeSessionId).toBe('agora-01j');
        expect(parseOpenClaw(JSON.stringify({ payloads: [{ text: '[pass]' }], meta: {} }), 0, true)).toMatchObject({ success: true, summary: null });
        expect(parseOpenClaw(JSON.stringify({ payloads: [], meta: {} }), 0, true).success).toBe(true);
    });
    it('reads the last JSON line when something printed before it', () => {
        expect(parseOpenClaw(`warming up\n${JSON.stringify({ payloads: [{ text: 'ok' }], meta: {} })}\n`, 0).summary).toBe('ok');
    });
});

describe('nemoclaw wakes on a machine', () => {
    it('runs one turn in the sandbox with the prompt on stdin, no bot token, no worktree line', async () => {
        const dir = await repo();
        const launch = await prepare(nemoclaw(dir, { executable: '/opt/nemoclaw/bin/nemoclaw' }), delivery()); cleanups.push(launch.cleanup);
        expect(launch.executable).toBe('/opt/nemoclaw/bin/nemoclaw');
        expect(launch.args).toEqual(['agora-nemo', 'agent', '--session-id', `agora-${id(2).toLowerCase()}`, '--json', '--timeout', '810']);
        expect(launch.adapter).toBe('nemoclaw');
        expect(launch.acp).toBeUndefined();
        expect(launch.env.AGORA_BOT_TOKEN).toBeUndefined();
        expect(Object.values(launch.env).some(v => typeof v === 'string' && v.includes('bot_selected'))).toBe(false);
        expect(launch.env.NEMOCLAW_DISABLE_TELEMETRY).toBe('1');
        expect(launch.stdin).toContain(NEMOCLAW_WAKE_NOTE);
        expect(launch.stdin).not.toContain('Your working directory is already');
        expect(launch.stdin).not.toContain('browser_preview');
        expect(launch.openclawSession).toBe(`agora-${id(2).toLowerCase()}`);
    });

    it('refuses an effort, the machine form in a box, and the box form on a machine', async () => {
        const dir = await repo();
        const effort = delivery(); effort.profile.effort = 'high';
        await expect(prepare(nemoclaw(dir), effort)).rejects.toThrow('unsupported_effort');
        const boxForm = configSchema.parse({ ...config(dir), profiles: { builder: { ...bare(dir), adapter: 'nemoclaw', auth: 'api_key', apiKeyEnv: 'NVIDIA_API_KEY' } } });
        process.env.NVIDIA_API_KEY = 'nvapi-test';
        const err = await prepare(boxForm, delivery()).catch(e => e);
        expect(err).toBeInstanceOf(HostConfigError);
        expect(err.message).toBe(NEMOCLAW_BOX_ONLY);
        await expect(verifyProfile(boxForm.profiles.builder)).rejects.toThrow(NEMOCLAW_BOX_ONLY);
        enterBox();
        await expect(prepare(nemoclaw(dir), delivery())).rejects.toThrow(NEMOCLAW_HOST_ONLY);
    });
});

describe.skipIf(!unix)('nemoclaw with the fake CLI', () => {
    it('start-up check: a tested version and an OpenClaw sandbox; others refused', async () => {
        const dir = await repo(); const { exe, set } = await fake();
        expect(await verifyProfile(nemoclaw(dir, { executable: exe }).profiles.builder))
            .toBe('nemoclaw 0.0.143, sandbox agora-nemo (nvidia-prod nvidia/nemotron-3.5-super-vl-120b-a12b)');
        await set({ version: '0.0.150' });
        await expect(verifyProfile(nemoclaw(dir, { executable: exe }).profiles.builder)).rejects.toThrow('unsupported_cli_version');
        expect(await verifyProfile(nemoclaw(dir, { executable: exe, allowUntestedVersion: true }).profiles.builder)).toMatch(/^nemoclaw 0\.0\.150/);
        await set({ found: false });
        await expect(verifyProfile(nemoclaw(dir, { executable: exe }).profiles.builder)).rejects.toThrow('nemoclaw_sandbox_not_found');
        await set({ agent: 'hermes' });
        await expect(verifyProfile(nemoclaw(dir, { executable: exe }).profiles.builder)).rejects.toThrow(NEMOCLAW_NOT_OPENCLAW);
    });

    it('a wake end to end: the turn\'s summary, session and tokens; the prompt only on stdin', async () => {
        const dir = await repo(); const { exe, calls } = await fake();
        const launch = await prepare(nemoclaw(dir, { executable: exe }), delivery()); cleanups.push(launch.cleanup);
        const result = await new ProcessRunner().start(launch).result;
        const sid = `agora-${id(2).toLowerCase()}`;
        expect(result).toMatchObject({ success: true, nativeSessionId: sid, tokensUsed: 1600, summary: `Handled ${sid}` });
        const agent = (await calls()).find(c => c.argv[1] === 'agent');
        expect(agent).toMatchObject({ worktreeNote: true, tokenInArgv: false, set: ['NEMOCLAW_DISABLE_TELEMETRY', 'NEMOCLAW_NON_INTERACTIVE'] });
        expect(agent.stdinBytes).toBe(Buffer.byteLength(launch.stdin));
    });

    it('a failed turn fails the run', async () => {
        const dir = await repo(); const { exe, set } = await fake();
        await set({ turn: 'error' });
        const launch = await prepare(nemoclaw(dir, { executable: exe }), delivery()); cleanups.push(launch.cleanup);
        expect(await new ProcessRunner().start(launch).result).toMatchObject({ success: false, error: 'cli_failed_or_invalid_output', tokensUsed: 1600 });
    });

    it('setup: the token only in mcp add\'s environment, then a probe; --replace removes the old server first', async () => {
        const dir = await repo(); const { exe, calls } = await fake();
        const p = nemoclaw(dir, { executable: exe }).profiles.builder as any;
        const lines: string[] = [];
        expect(await nemoclawSetup(p, 'bot_selected.secret', true, l => lines.push(l), childEnv(p))).toBe(0);
        const log = await calls();
        expect(log.map(c => c.argv.slice(1, 3).join(' '))).toEqual(['mcp remove', 'mcp add', 'mcp status']);
        const add = log.find(c => c.argv[2] === 'add');
        expect(add.argv).toEqual(['agora-nemo', 'mcp', 'add', 'agora', '--url', NEMO.mcpUrl, '--env', 'AGORA_MCP_TOKEN', '--no-probe']);
        // Nothing probes the endpoint from NemoClaw's own client
        expect(log.every(c => !c.argv.includes('--probe'))).toBe(true);
        expect(add).toMatchObject({ tokenInArgv: false });
        expect(add.set).toContain('AGORA_MCP_TOKEN');
        expect(log.filter(c => c.argv[2] !== 'add').every(c => !c.set.includes('AGORA_MCP_TOKEN'))).toBe(true);
        expect(lines.at(-1)).toMatch(/openclaw-bundle-mcp/);
    });
});

describe('nemoclaw in a box: OpenClaw itself', () => {
    const HOST_TOKEN = 'ah_01J0000000000000000000HOST.hostsecretvalue';
    const profile = (p: object = {}) => JSON.stringify({ name: 'nemo', adapter: 'nemoclaw', auth: 'api_key', apiKeyEnv: 'NVIDIA_API_KEY', workdirAlias: 'work', repos: [], ...p });
    const env = (p: object = {}) => ({ AGORA_INSTANCE_URL: 'http://edge:8080', AGORA_HOST_TOKEN: HOST_TOKEN, AGORA_BOT_ID: id(5),
        AGORA_BOT_TOKEN: 'bot_box.botsecretvalue', AGORA_BOX_PROFILE: profile(p) });
    async function boxSetup(executable = process.execPath) {
        const dir = await repo();
        const c = configSchema.parse({ ...config(dir), profiles: { builder: { adapter: 'nemoclaw', executable, workdir: dir, workdirAlias: 'agora',
            stateDir: join(dir, 'state'), auth: 'api_key', apiKeyEnv: 'NVIDIA_API_KEY', proxyEnv: true } } });
        process.env.NVIDIA_API_KEY = 'nvapi-box-secret';
        return { c, dir };
    }

    it('box config: the pinned OpenClaw on an NVIDIA key; a subscription is refused', () => {
        const c = boxConfig(env(), { home: '/home/agent', exists: () => false });
        expect(c.profiles.nemo).toEqual({ adapter: 'nemoclaw', executable: '/opt/agora/bin/nemoclaw', workdir: '/home/agent/scratch', workdirAlias: 'work',
            stateDir: '/home/agent/.agora/state/nemo', auth: 'api_key', apiKeyEnv: 'NVIDIA_API_KEY', proxyEnv: true });
        expect(configSchema.safeParse(c).success).toBe(true);
        expect(() => boxConfig(env({ auth: 'subscription', apiKeyEnv: null }), { home: '/home/agent', exists: () => false }))
            .toThrow('AGORA_BOX_PROFILE: nemoclaw in a box signs in with api_key');
    });

    it('models, versions and exec arguments', () => {
        expect(openclawModel(null)).toBe('nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b');
        expect(openclawModel('meta/llama-3.3-70b-instruct')).toBe('nvidia/meta/llama-3.3-70b-instruct');
        expect(openclawModel('nvidia/nvidia/nemotron-3-super-120b-a12b')).toBe('nvidia/nvidia/nemotron-3-super-120b-a12b');
        expect(openclawVersion('OpenClaw 2026.11.3 (847611d)\n')).toBe('2026.11.3');
        expect(openclawVersion('openclaw 2026.11.3')).toBeNull();
        expect(openclawExecArgs('/run/openclaw.json', '/work', null, 900)).toEqual(['agent', 'exec', '--json', '--config', '/run/openclaw.json', '--cwd', '/work',
            '--model', 'nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b', '--timeout', '810', '--message-file', '-']);
        expect(openclawExecArgs('/c', '/w', null, 60)).toContain('30');
    });

    it('a box turn: exec in the worktree, agora-mcp on stdio through the edge, the box rules first, the NVIDIA key, quiet, no resume', async () => {
        const { c, dir } = await boxSetup('/opt/agora/bin/nemoclaw');
        Object.assign(process.env, { HTTPS_PROXY: 'http://edge:3128', NO_PROXY: 'edge', HOME: '/home/agent' });
        enterBox();
        const state = c.profiles.builder.stateDir;
        await mkdir(join(state, 'openclaw'), { recursive: true });
        await writeFile(join(state, 'openclaw', 'AGENTS.md'), '# Box rules\nThe box is your sandbox.\n');
        const d = delivery(); d.session.nativeSessionId = 'f0000000-0000-4000-8000-000000000001';
        const launch = await prepare(c, d); cleanups.push(launch.cleanup);
        expect(launch.executable).toBe('/opt/agora/bin/nemoclaw');
        expect(launch.args.slice(0, 3)).toEqual(['agent', 'exec', '--json']);
        expect(launch.args[launch.args.indexOf('--cwd') + 1]).toBe(launch.cwd);
        expect(launch.args[launch.args.indexOf('--model') + 1]).toBe('nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b');
        expect(launch.openclawSession).toBeUndefined();
        const cfg = JSON.parse(await readFile(launch.args[launch.args.indexOf('--config') + 1], 'utf8'));
        expect(cfg.tools).toEqual({ toolSearch: false });
        expect(cfg.mcp.servers.agora).toEqual({ command: c.mcp.executable, args: [c.mcp.entrypoint, '--no-presence'],
            env: { AGORA_INSTANCE: c.instance, AGORA_BOT_TOKEN: 'bot_selected.secret', AGORA_DEFAULT_CHANNEL: d.session.channelId, AGORA_HOOKS: 'off', AGORA_STOP_HOOK: 'off' } });
        expect(launch.stdin.startsWith('# Box rules\nThe box is your sandbox.')).toBe(true);
        expect(launch.stdin).toContain('Your working directory is already this session\'s git worktree');
        // No resume: the prior summary goes in, as for a fresh conversation
        expect(launch.stdin).toContain('Prior session summary (untrusted)');
        expect(launch.stdin).not.toContain(NEMOCLAW_WAKE_NOTE);
        expect(launch.env).toMatchObject({ NVIDIA_API_KEY: 'nvapi-box-secret', OPENCLAW_NO_AUTO_UPDATE: '1', DO_NOT_TRACK: '1',
            HTTPS_PROXY: 'http://edge:3128', NO_PROXY: 'edge' });
        expect(launch.env.AGORA_BOT_TOKEN).toBeUndefined();
        expect(launch.env.AGORA_HOST_TOKEN).toBeUndefined();
        void dir;
    });

    it('the box form refuses to run outside a box, the machine form inside one', async () => {
        const { c } = await boxSetup();
        await expect(prepare(c, delivery())).rejects.toThrow(NEMOCLAW_BOX_ONLY);
        await expect(verifyProfile(c.profiles.builder)).rejects.toThrow(NEMOCLAW_BOX_ONLY);
    });

    it.skipIf(!unix)('the fake OpenClaw from box/fake: start-up check and a turn, not resumable', async () => {
        const { exe, calls, set } = await fake();
        await set({ mode: 'openclaw' });
        enterBox();
        const { c } = await boxSetup(exe);
        expect(await verifyProfile(c.profiles.builder)).toBe('openclaw 2026.11.3');
        const launch = await prepare(c, delivery()); cleanups.push(launch.cleanup);
        const result = await new ProcessRunner().start(launch).result;
        expect(result).toMatchObject({ success: true, nativeSessionId: null, tokensUsed: 960, summary: 'Handled in a box' });
        const run = (await calls()).find(c => c.argv[1] === 'exec');
        expect(run).toMatchObject({ nvidiaKey: true, toolSearch: false, mcp: { envNames: ['AGORA_BOT_TOKEN', 'AGORA_DEFAULT_CHANNEL', 'AGORA_HOOKS', 'AGORA_INSTANCE', 'AGORA_STOP_HOOK'] } });
        await set({ mode: 'openclaw', version: '2026.12.1' });
        await expect(verifyProfile(c.profiles.builder)).rejects.toThrow('unsupported_cli_version');
    });
});
