/**
 * A real agora-host process against the e2e API, with profiles that run the fake CLI
 * (e2e/fake-cli/fake-claude.mjs) instead of a model (beta-test-plan §2.1 "Fake agent host").
 *
 * - Everything is registered through the HTTP API (never SQL): a run-tagged host, channel and
 *   agents. The seeded host from global-setup is not used (no process runs for it).
 * - The host config (host token, bot tokens) is written to e2e/secrets/ (gitignored, deleted on
 *   teardown and by finalize); the workdir is a throwaway git repo in a temp folder.
 * - agora-host and agora-mcp come from this checkout (built here if dist/ is missing).
 * - stop() kills the host's whole process tree (taskkill /T /F on Windows) and removes the temp
 *   folder and config. An exit hook does the same if the worker dies first.
 *
 * The host token and bot tokens are added to secrets/seed.json so the leak scan looks for them.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Api } from './api';
import { artifactsDir, E2E_DIR, e2eEnv, runId, SECRETS_DIR, SEED_FILE } from './env';
import type { Seed } from './seed-types';

const REPO = path.resolve(E2E_DIR, '..');
const HOST_DIR = path.join(REPO, 'agora-host');
const MCP_DIR = path.join(REPO, 'agora-mcp');
const FAKE_SCRIPT = path.join(E2E_DIR, 'fake-cli', 'fake-claude.mjs');
const LAUNCHER_SRC = path.join(E2E_DIR, 'fake-cli', 'launcher.cs');
/** Passed to api_key profiles; the fake CLI never uses it and it is not a real key. */
const FAKE_KEY = 'e2e-fake-provider-key-unused';

export interface FakeProfileSpec {
    /** Short key used in the agent name: claude-e2e-<key>-<tag> (lowercase letters/digits). */
    key: string;
    requireRunApproval?: boolean;
    /** verify.commands for this profile (agora-host verify.ts). */
    verifyCommands?: string[];
    approvedTools?: string[];
}
export interface FakeAgent {
    key: string; name: string; profileId: string; botId: string; token: string; stateDir: string;
    /** Bot-token API client. */
    bot: Api;
}
export interface FakeHost {
    tag: string; serverId: string; hostId: string; hostName: string;
    channelId: string; channelName: string;
    agents: Record<string, FakeAgent>;
    workdir: string;
    /** The fake CLI's per-run trace lines for one agent (directives, outcome, cwd). */
    traces(key: string): any[];
    /** The host's own log (fixed status codes only, never secrets). */
    log(): string;
    running(): boolean;
    /**
     * Connect one agent's bot as a terminal session: agora-mcp from this checkout with presence
     * on (the bring-your-own-CLI path, #112). stop() closes its stdin, so it exits.
     */
    terminal(key: string): Promise<{ stop(): Promise<void> }>;
    stop(): Promise<void>;
}
export interface FakePreview { browser: string; portBase: number; portsPerSession?: number }

function git(cwd: string, args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000, everyMs = 500): Promise<T> {
    const end = Date.now() + timeoutMs;
    let last: unknown;
    for (;;) {
        try { const v = await fn(); if (v) return v as T; } catch (e) { last = e; }
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? `: ${String((last as Error).message ?? last).slice(0, 300)}` : ''}`);
        await new Promise(r => setTimeout(r, everyMs));
    }
}

/**
 * Build agora-host and agora-mcp from this checkout once per run, whatever dist/ already
 * holds: an old dist/ would run code other than what the run claims to test. What was built
 * goes to artifacts/<run-id>/build-provenance.json (commit, a hash of uncommitted changes in
 * both packages, node version).
 */
function ensureBuilt() {
    const marker = path.join(SECRETS_DIR, `built-${runId()}`);
    if (fs.existsSync(marker)) return;
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    for (const dir of [HOST_DIR, MCP_DIR]) {
        if (!fs.existsSync(path.join(dir, 'node_modules'))) execFileSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'ignore', shell: process.platform === 'win32' });
        execFileSync(npm, ['run', 'build'], { cwd: dir, stdio: 'ignore', shell: process.platform === 'win32' });
    }
    const dirty = git(REPO, ['status', '--porcelain', '--', 'agora-host', 'agora-mcp']);
    const diff = dirty ? git(REPO, ['diff', 'HEAD', '--', 'agora-host', 'agora-mcp']) + dirty : '';
    const provenance = {
        commit: git(REPO, ['rev-parse', 'HEAD']),
        dirty: dirty !== '',
        dirtyHash: dirty ? crypto.createHash('sha256').update(diff).digest('hex') : null,
        node: process.version,
        builtAt: new Date().toISOString(),
        packages: ['agora-host', 'agora-mcp'],
    };
    fs.mkdirSync(artifactsDir(), { recursive: true });
    fs.writeFileSync(path.join(artifactsDir(), 'build-provenance.json'), JSON.stringify(provenance, null, 2));
    fs.mkdirSync(SECRETS_DIR, { recursive: true });
    fs.writeFileSync(marker, '');
}

/** The fake CLI as a native executable the host accepts (no .cmd/.js shims on Windows). */
function buildLauncher(dir: string): string {
    if (process.platform !== 'win32') {
        const exe = path.join(dir, 'claude');
        fs.writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SCRIPT}" "$@"\n`, { mode: 0o755 });
        return exe;
    }
    const csc = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    if (!fs.existsSync(csc)) throw new Error('csc.exe (.NET Framework 4) not found: cannot build the fake CLI launcher');
    const src = fs.readFileSync(LAUNCHER_SRC, 'utf8').replace('__NODE__', process.execPath.replace(/"/g, '')).replace('__SCRIPT__', FAKE_SCRIPT.replace(/"/g, ''));
    const cs = path.join(dir, 'launcher.cs');
    fs.writeFileSync(cs, src);
    const exe = path.join(dir, 'claude.exe');
    execFileSync(csc, ['-nologo', '-optimize', `-out:${exe}`, cs], { windowsHide: true, stdio: 'ignore' });
    return exe;
}

function killTree(pid: number) {
    try {
        if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else process.kill(-pid, 'SIGKILL');
    } catch { /* already gone */ }
}

function addSecretsToSeed(values: Record<string, string>) {
    try {
        const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
        seed.secrets.extra = { ...(seed.secrets.extra ?? {}), ...values };
        fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2), { mode: 0o600 });
    } catch { /* seed gone: nothing to scan against */ }
}

function rmrf(p: string) {
    for (let i = 0; i < 5; i++) {
        try { fs.rmSync(p, { recursive: true, force: true }); return; } catch { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},400)']); }
    }
}

export async function startFakeHost(seed: Seed, opts: { label: string; profiles: FakeProfileSpec[]; preview?: FakePreview }): Promise<FakeHost> {
    ensureBuilt();
    const { apiURL } = e2eEnv();
    const base = new Api(apiURL);
    const owner = base.with(`Bearer ${seed.secrets.ownerToken}`);
    const tag = crypto.randomBytes(2).toString('hex');
    const sid = seed.serverId;

    const channelName = `${opts.label}-${tag}`;
    const channelId: string = ((await owner.ok('POST', `/servers/${sid}/channels`, { name: channelName, channelType: 3 }, [201])) as any).id.trim();
    const hostName = `e2e-fakehost-${tag}`;
    const created = (await owner.ok('POST', `/servers/${sid}/agent-hosts`, { name: hostName }, [201])) as any;
    const hostId: string = created.host.id.trim();
    const hostToken: string = created.token;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-e2e-fh-'));
    try {
        return await launch(seed, opts, { base, owner, tag, sid, channelName, channelId, hostName, hostId, hostToken, root, apiURL });
    } catch (e) { rmrf(root); throw e; }
}

async function launch(seed: Seed, opts: { label: string; profiles: FakeProfileSpec[]; preview?: FakePreview }, ctx: {
    base: Api; owner: Api; tag: string; sid: string; channelName: string; channelId: string; hostName: string; hostId: string; hostToken: string; root: string; apiURL: string;
}): Promise<FakeHost> {
    const { base, owner, tag, sid, channelName, channelId, hostName, hostId, hostToken, root, apiURL } = ctx;
    const workdir = path.join(root, 'repo');
    fs.mkdirSync(path.join(workdir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workdir, 'README.md'), `# e2e fake repo ${tag}\n`);
    fs.writeFileSync(path.join(workdir, 'src', 'app.txt'), 'original line\n');
    git(workdir, ['init', '-q', '-b', 'main']);
    git(workdir, ['config', 'core.autocrlf', 'false']);
    git(workdir, ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', 'add', '-A']);
    git(workdir, ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', 'commit', '-q', '-m', 'initial']);
    // A local bare "origin" so a PR action can push; gh then fails without a login (GH_CONFIG_DIR empty)
    const origin = path.join(root, 'origin.git');
    git(root, ['init', '-q', '--bare', origin]);
    git(workdir, ['remote', 'add', 'origin', origin]);
    git(workdir, ['push', '-q', 'origin', 'main']);
    const ghDir = path.join(root, 'gh-empty');
    fs.mkdirSync(ghDir);
    const exe = buildLauncher(root);

    const agents: Record<string, FakeAgent> = {};
    const profiles: Record<string, unknown> = {};
    const botTokens: Record<string, string> = {};
    for (const p of opts.profiles) {
        const name = `claude-e2e-${p.key}-${tag}`;
        const r = (await owner.ok('POST', `/servers/${sid}/agents`, { name, adapter: 'claude', hostId, workdirAlias: 'e2e', channelId }, [201])) as any;
        const stateDir = path.join(root, `s-${p.key}`);
        agents[p.key] = { key: p.key, name, profileId: r.profile.id.trim(), botId: r.bot.id.trim(), token: r.token, stateDir, bot: base.with(`Bot ${r.token}`) };
        botTokens[r.bot.id.trim()] = r.token;
        profiles[name] = {
            adapter: 'claude', executable: exe, workdir, workdirAlias: 'e2e', stateDir,
            auth: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY', allowUntestedVersion: false,
            requireRunApproval: !!p.requireRunApproval,
            approvedTools: p.approvedTools ?? ['chat_history', 'chat_send', 'thread_start', 'thread_list', 'who_directs', 'project_context',
                'file_reserve', 'file_renew', 'file_release', 'file_reservations', 'canvas_publish', ...(opts.preview ? ['browser_preview'] : [])],
            ...(p.verifyCommands ? { verify: { commands: p.verifyCommands, timeoutSeconds: 60 } } : {}),
        };
    }
    addSecretsToSeed({ [`fakeHost_${tag}`]: hostToken, ...Object.fromEntries(Object.values(agents).map(a => [`fakeBot_${a.key}_${tag}`, a.token])) });

    fs.mkdirSync(SECRETS_DIR, { recursive: true });
    const configFile = path.join(SECRETS_DIR, `fake-host-${tag}.json`);
    fs.writeFileSync(configFile, JSON.stringify({
        instance: `${apiURL}/`, hostToken,
        mcp: { executable: process.execPath, entrypoint: path.join(MCP_DIR, 'dist', 'index.js') },
        profiles, botTokens, maxConcurrent: 4, approvalWaitSeconds: 60,
        ...(opts.preview ? { preview: { browser: opts.preview.browser, stateDir: path.join(root, 'preview'), portBase: opts.preview.portBase,
            portsPerSession: opts.preview.portsPerSession ?? 2, slots: 8 } } : {}),
    }, null, 2), { mode: 0o600 });

    const logFile = path.join(SECRETS_DIR, `fake-host-${tag}.log`);
    const logFd = fs.openSync(logFile, 'a');
    const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: FAKE_KEY, GH_CONFIG_DIR: ghDir, GIT_TERMINAL_PROMPT: '0' };
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'NODE_OPTIONS']) delete env[k];
    const child: ChildProcess = spawn(process.execPath, [path.join(HOST_DIR, 'dist', 'index.js'), '--config', configFile], {
        cwd: HOST_DIR, env, stdio: ['ignore', logFd, logFd], windowsHide: true, detached: process.platform !== 'win32',
    });
    let exited = false;
    child.on('exit', () => { exited = true; });
    const terminals = new Set<ChildProcess>();
    const onExit = () => {
        if (!exited && child.pid) killTree(child.pid);
        for (const t of terminals) if (t.pid && t.exitCode === null) killTree(t.pid);
    };
    process.on('exit', onExit);

    const host: FakeHost = {
        tag, serverId: sid, hostId, hostName, channelId, channelName, agents, workdir,
        traces(key) {
            const f = path.join(agents[key].stateDir, 'fake-runs.jsonl');
            if (!fs.existsSync(f)) return [];
            return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
        },
        log() { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } },
        running() { return !exited; },
        async terminal(key) {
            const a = agents[key];
            const t = spawn(process.execPath, [path.join(MCP_DIR, 'dist', 'index.js')], {
                cwd: root, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
                env: { ...process.env, AGORA_INSTANCE: apiURL, AGORA_BOT_TOKEN: a.token, AGORA_DEFAULT_CHANNEL: channelId },
            });
            terminals.add(t);
            return {
                async stop() {
                    try { t.stdin?.end(); } catch { /* closed */ }
                    await waitFor('terminal exit', async () => t.exitCode !== null, 5_000, 100).catch(() => { if (t.pid) killTree(t.pid); });
                    terminals.delete(t);
                },
            };
        },
        async stop() {
            for (const t of terminals) if (t.pid && t.exitCode === null) killTree(t.pid);
            terminals.clear();
            if (!exited && child.pid) killTree(child.pid);
            await waitFor('host exit', async () => exited, 10_000, 100).catch(() => undefined);
            process.off('exit', onExit);
            try { fs.closeSync(logFd); } catch { /* closed */ }
            for (const f of [configFile, logFile]) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
            rmrf(root);
        },
    };

    try {
        // Ready when the server has seen the host (it reports profiles, then long-polls for runs)
        await waitFor('fake host to report in', async () => {
            if (exited) throw new Error(`agora-host exited: ${host.log().slice(-600)}`);
            const hosts = (await owner.ok('GET', `/servers/${sid}/agent-hosts`)) as any;
            const list: any[] = Array.isArray(hosts) ? hosts : (hosts.hosts ?? []);
            const h = list.find(x => String(x.id).trim() === hostId);
            return h && (h.lastSeenAt ?? h.last_seen_at) ? h : null;
        }, 30_000);
    } catch (e) { await host.stop(); throw e; }
    return host;
}

/** Bearer clients for the seeded owner/member from a seed. */
export function ownerApi(seed: Seed) { return new Api(e2eEnv().apiURL).with(`Bearer ${seed.secrets.ownerToken}`); }
