/**
 * Docker control for the outage scenarios (beta-test-plan §3.5 OP-03): pause/unpause, exec
 * and a throwaway stub container, only ever on containers named `agora-e2e-*`.
 *
 * - Every call that names a container goes through `target()`, which refuses any name without
 *   the `agora-e2e-` prefix and then reads the container's labels: it must belong to the
 *   `agora-e2e` compose project, or be a stub this file started (label `agora-e2e.ops-stub=1`).
 * - Only the subcommands below are ever run; nothing here starts, stops, recreates or removes a
 *   compose container, and nothing prunes.
 * - On Windows the WSL `Ubuntu` daemon is reached through wsl.exe (never a second engine; set
 *   E2E_WSL_DISTRO for another distro name); on Linux and macOS plain `docker`.
 *
 * Specs call `restoreAll()` in afterEach: it unpauses any paused agora-e2e container (and, with
 * removeStubs, removes leftover stubs), so a failed test never leaves the instance degraded.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';

export const PROJECT = 'agora-e2e';
export const NETWORK = 'agora-e2e_net';
const NAME_RE = /^agora-e2e-[a-z0-9][a-z0-9_.-]{0,100}$/;
const STUB_LABEL = 'agora-e2e.ops-stub';
const SUBCOMMANDS = new Set(['ps', 'inspect', 'pause', 'unpause', 'exec', 'logs', 'run', 'rm']);

export type Service = 'postgres' | 'redis' | 'api' | 'web';

export function assertE2EName(name: string): string {
    if (!NAME_RE.test(name)) throw new Error(`refusing container "${name}": only agora-e2e-* containers may be controlled`);
    return name;
}

export interface DockerResult { stdout: string; stderr: string; code: number }

/** Run one whitelisted docker subcommand on the e2e daemon. Throws on a non-zero exit unless allowFail. */
export function docker(args: string[], opts: { timeoutMs?: number; allowFail?: boolean } = {}): Promise<DockerResult> {
    if (!SUBCOMMANDS.has(args[0])) throw new Error(`refusing docker ${args[0]}: not used by the outage helpers`);
    // --exec: no Linux shell in between, so arguments (SQL, format strings) arrive verbatim
    const [file, argv] = process.platform === 'win32'
        ? ['wsl.exe', ['-d', process.env.E2E_WSL_DISTRO ?? 'Ubuntu', '--exec', 'docker', ...args]]
        : ['docker', args];
    return new Promise((resolve, reject) => {
        execFile(file, argv, { timeout: opts.timeoutMs ?? 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
            const r = { stdout: String(stdout), stderr: String(stderr), code };
            if (code !== 0 && !opts.allowFail) reject(new Error(`docker ${args[0]} exited ${code}: ${r.stderr.trim().slice(0, 300)}`));
            else resolve(r);
        });
    });
}

interface Inspected {
    Name: string;
    Config: { Labels: Record<string, string> | null; Image: string };
    State: { Running: boolean; Paused: boolean; Health?: { Status: string } };
}

async function inspect(name: string): Promise<Inspected> {
    const r = await docker(['inspect', '--type', 'container', assertE2EName(name)]);
    const [c] = JSON.parse(r.stdout) as Inspected[];
    if (!c || c.Name.replace(/^\//, '') !== name) throw new Error(`inspect ${name}: unexpected result`);
    return c;
}

/** Name check plus label check: an agora-e2e compose container or one of our stubs. */
async function target(name: string): Promise<Inspected> {
    const c = await inspect(assertE2EName(name));
    const labels = c.Config.Labels ?? {};
    if (labels['com.docker.compose.project'] !== PROJECT && labels[STUB_LABEL] !== '1') {
        throw new Error(`refusing container "${name}": not part of the ${PROJECT} project`);
    }
    return c;
}

/** The container of one compose service of the agora-e2e project (exactly one, or it throws). */
export async function serviceContainer(service: Service): Promise<string> {
    const r = await docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`,
        '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.Names}}']);
    const names = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (names.length !== 1) throw new Error(`expected one ${PROJECT} ${service} container, found ${names.length}`);
    await target(names[0]);
    return names[0];
}

export async function state(name: string) {
    const c = await target(name);
    return { running: c.State.Running, paused: c.State.Paused, health: c.State.Health?.Status ?? null };
}

export async function pause(name: string) {
    await target(name);
    await docker(['pause', name]);
}

export async function unpause(name: string) {
    if ((await state(name)).paused) await docker(['unpause', name]);
}

/** Pause a container while `fn` runs; always unpaused afterwards, even when `fn` throws. */
export async function withPaused<T>(name: string, fn: () => Promise<T>): Promise<T> {
    await pause(name);
    try { return await fn(); } finally { await unpause(name); }
}

/** docker exec (optionally as a given user) in an agora-e2e container. */
export async function exec(name: string, argv: string[], opts: { user?: string; env?: Record<string, string>; allowFail?: boolean; timeoutMs?: number } = {}) {
    await target(name);
    const env = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    return docker(['exec', ...(opts.user ? ['-u', opts.user] : []), ...env, name, ...argv], { allowFail: opts.allowFail, timeoutMs: opts.timeoutMs });
}

/** One read-only query in the e2e database (Postgres enforces read-only); rows as tab-separated lines. */
export async function readOnlyQuery(sql: string): Promise<string[]> {
    const pg = await serviceContainer('postgres');
    const r = await exec(pg, ['psql', '-U', 'accord', '-d', 'agora', '-v', 'ON_ERROR_STOP=1', '-tA', '-F', '\t', '-c', sql],
        { env: { PGOPTIONS: '-c default_transaction_read_only=on' } });
    return r.stdout.split(/\r?\n/).filter(Boolean);
}

/** A host directory as the e2e daemon sees it (WSL mounts Windows drives under /mnt). */
export function daemonPath(p: string): string {
    if (process.platform !== 'win32') return path.resolve(p);
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(path.resolve(p));
    if (!m) throw new Error(`cannot map ${p} into WSL`);
    return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/**
 * Start a throwaway container on the e2e network from one of the e2e images, labelled as our
 * stub so restoreAll() and removeStub() can find it. `mountDir` is mounted read-only at /stub.
 */
export async function startStub(name: string, opts: { image: string; mountDir: string; cmd: string[]; env?: Record<string, string> }) {
    assertE2EName(name);
    if (!/^agora-e2e-[a-z0-9-]+:e2e$/.test(opts.image)) throw new Error(`refusing image ${opts.image}: only the e2e images`);
    await removeStub(name);
    const env = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    await docker(['run', '-d', '--name', name, '--label', `${STUB_LABEL}=1`, '--network', NETWORK,
        '-v', `${daemonPath(opts.mountDir)}:/stub:ro`, ...env, opts.image, ...opts.cmd]);
    const c = await target(name);
    if (!c.State.Running) throw new Error(`stub ${name} is not running`);
}

/** Remove a stub this file started (refuses anything without the stub label). */
export async function removeStub(name: string) {
    assertE2EName(name);
    const r = await docker(['inspect', '--type', 'container', name], { allowFail: true });
    if (r.code !== 0) return;
    const labels = (JSON.parse(r.stdout)[0]?.Config?.Labels ?? {}) as Record<string, string>;
    if (labels[STUB_LABEL] !== '1') throw new Error(`refusing to remove ${name}: not an ops stub`);
    await docker(['rm', '-f', name]);
}

export async function logs(name: string): Promise<string> {
    await target(name);
    const r = await docker(['logs', name]);
    return r.stdout + r.stderr;
}

/** Unpause every paused agora-e2e compose container (and remove stubs if asked). Returns what it fixed. */
export async function restoreAll(opts: { removeStubs?: boolean } = {}): Promise<string[]> {
    const fixed: string[] = [];
    const ps = await docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--format', '{{.Names}}']);
    for (const name of ps.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
        if (!NAME_RE.test(name)) continue;
        if ((await state(name)).paused) { await docker(['unpause', name]); fixed.push(`unpaused ${name}`); }
    }
    if (!opts.removeStubs) return fixed;
    const stubs = await docker(['ps', '-a', '--filter', `label=${STUB_LABEL}=1`, '--format', '{{.Names}}']);
    for (const name of stubs.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
        if (!NAME_RE.test(name)) continue;
        await removeStub(name); fixed.push(`removed ${name}`);
    }
    return fixed;
}

/** Every agora-e2e compose container is running and not paused. */
export async function allRunning(): Promise<string[]> {
    const ps = await docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--format', '{{.Names}}']);
    const bad: string[] = [];
    for (const name of ps.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
        // migrate is a one-shot service: it exits after running the migrations
        if (/-migrate-\d+$/.test(name)) continue;
        const s = await state(name);
        if (!s.running || s.paused) bad.push(`${name}: ${s.paused ? 'paused' : 'not running'}`);
    }
    return bad;
}
