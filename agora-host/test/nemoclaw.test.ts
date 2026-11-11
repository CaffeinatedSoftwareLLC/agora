import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema, loadConfig } from '../src/config.js';
import { prepare, verifyProfile } from '../src/adapters.js';
import { boxMode } from '../src/box.js';
import { ProcessRunner } from '../src/process.js';
import { git } from '../src/workspaces.js';
import { HostConfigError, NEMOCLAW_API_KEY_ONLY } from '../src/terms.js';
import {
    mcpAddArgs, NEMOCLAW_BOX_ONLY, NEMOCLAW_HOST_ONLY, NEMOCLAW_NOT_OPENCLAW, NEMOCLAW_WAKE_NOTE, nemoclawAgentArgs, nemoclawCommand,
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
            .toEqual({ executable: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu', '--exec', '/home/me/.local/bin/nemoclaw', '--version'] });
    });

    it('turns telemetry and prompts off, and through WSL passes those variables with WSLENV', () => {
        const local = nemoclawEnv({ nemoclaw: { ...NEMO, trustPrivateHost: false } }, { PATH: '/bin' });
        expect(local).toMatchObject({ PATH: '/bin', NEMOCLAW_DISABLE_TELEMETRY: '1', NEMOCLAW_NON_INTERACTIVE: '1' });
        expect(local.WSLENV).toBeUndefined();
        const wsl = nemoclawEnv({ nemoclaw: { ...NEMO, trustPrivateHost: false, wsl: { distro: 'Ubuntu', nemoclawPath: '/x' } } },
            { WSLENV: 'USERPROFILE/p' }, { AGORA_MCP_TOKEN: 'bot_x' });
        expect(wsl.WSLENV).toBe('USERPROFILE/p:NEMOCLAW_DISABLE_TELEMETRY/u:NEMOCLAW_NON_INTERACTIVE/u:AGORA_MCP_TOKEN/u');
    });

    it('one wake: the session id, JSON, the model and a timeout; the session is named after Agora\'s', () => {
        const settings = { ...NEMO, trustPrivateHost: false };
        expect(nemoclawAgentArgs(settings, 'agora-01j', null, 900)).toEqual(['agora-nemo', 'agent', '--session-id', 'agora-01j', '--json', '--timeout', '900']);
        expect(nemoclawAgentArgs(settings, 's', 'nvidia/nemotron-3-super-120b-a12b', 0)).toEqual(['agora-nemo', 'agent', '--session-id', 's', '--json', '--model', 'nvidia/nemotron-3-super-120b-a12b']);
        const c = delivery();
        expect(openclawSessionId(c)).toBe(`agora-${id(2).toLowerCase()}`);
        c.session.nativeSessionId = 'review-42';
        expect(openclawSessionId(c)).toBe('review-42');
    });

    it('attaches the MCP endpoint by its environment variable, trusting a private host only when told', () => {
        expect(mcpAddArgs({ ...NEMO, trustPrivateHost: false })).toEqual(['agora-nemo', 'mcp', 'add', 'agora', '--url', NEMO.mcpUrl, '--env', 'AGORA_MCP_TOKEN']);
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
        expect(launch.args).toEqual(['agora-nemo', 'agent', '--session-id', `agora-${id(2).toLowerCase()}`, '--json', '--timeout', '900']);
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
        expect(await nemoclawSetup(p, 'bot_selected.secret', true, l => lines.push(l))).toBe(0);
        const log = await calls();
        expect(log.map(c => c.argv.slice(1, 3).join(' '))).toEqual(['mcp remove', 'mcp add', 'mcp status']);
        const add = log.find(c => c.argv[2] === 'add');
        expect(add.argv).toEqual(['agora-nemo', 'mcp', 'add', 'agora', '--url', NEMO.mcpUrl, '--env', 'AGORA_MCP_TOKEN']);
        expect(add).toMatchObject({ tokenInArgv: false });
        expect(add.set).toContain('AGORA_MCP_TOKEN');
        expect(log.filter(c => c.argv[2] !== 'add').every(c => !c.set.includes('AGORA_MCP_TOKEN'))).toBe(true);
        expect(lines.at(-1)).toMatch(/openclaw-bundle-mcp/);
    });
});
