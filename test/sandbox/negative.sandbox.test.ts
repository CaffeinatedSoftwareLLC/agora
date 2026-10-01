import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { dockerFromEnv, SandboxDocker } from '../../src/runtime/docker';
import { processRun, type RunnerDeps } from '../../src/runtime/runner';
import { resolveLimits, type RunLimits } from '../../src/runtime/limits';
import { containerName } from '../../src/runtime/container-spec';
import { startGatewayHarness, FORWARDER } from './gateway-harness';

/**
 * WBS 3.9: the negative security suite (sandbox-isolation-spec §14). Every test
 * asserts that an attack fails AND that the run ends in a sane status.
 *
 * Where each §14 item is tested:
 *    1  core services, file volume ........ here ("core services…", "the container has no mounts…", "the network itself…")
 *    2  internet, raw TCP, DNS ............ here ("no route to the internet…", "the network itself…")
 *    3  remote imports .................... here
 *    4  environment ....................... here
 *    5  sensitive files, Docker socket .... here
 *    6  writes outside scratch, 64 MB cap . here
 *    7  fork bomb ......................... here
 *    8  infinite loop → timeout ........... runner.sandbox.test.ts
 *    9  memory exhaustion ................. runner.sandbox.test.ts
 *   10  output flood → truncated .......... runner.sandbox.test.ts
 *   11  call cap → 429 .................... test/integration/cap-gateway ("per-run call cap")
 *   12  another run's token, dead token ... gateway-e2e.sandbox.test.ts, test/integration/cap-gateway (authentication)
 *   13  self-approval, unapproved run ..... test/integration/runtime-api, runner.sandbox.test.ts
 *   14  HTML / mislabelled artifacts ...... test/integration/cap-gateway ("spec §14 item 14")
 *   15  no gVisor in production ........... runner.sandbox.test.ts (preflight)
 *
 * Runs under runc on Docker Desktop and under gVisor on a Linux engine
 * (scripts/test-sandbox-gvisor.sh). `docker` here is the host CLI, used only for the
 * network-level probes; runs themselves go through the restricted socket proxy.
 */

const IMAGE = process.env.AGORA_SANDBOX_IMAGE ?? 'agora/sandbox-deno:dev';
const NETWORK = process.env.AGORA_SANDBOX_NETWORK ?? 'agora_sandbox';
const DOCKER_HOST = process.env.AGORA_DOCKER_HOST ?? 'http://127.0.0.1:2375';
const PROBE_IMAGE = 'alpine/socat:latest'; // has busybox sh, nc, nslookup; already used by the harness
const TARGET = 'agora-neg-target';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let serverId: string;
let deps: RunnerDeps;
let runtime: 'runsc' | 'runc';
let gateway: Awaited<ReturnType<typeof startGatewayHarness>>;

function docker(args: string[], opts: { ignoreErrors?: boolean } = {}): string {
    try {
        return execFileSync('docker', args, { stdio: 'pipe', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).toString().trim();
    } catch (err: any) {
        if (!opts.ignoreErrors) throw new Error(`docker ${args.join(' ')} failed: ${err.stderr?.toString() || err.message}`);
        return (err.stdout?.toString() ?? '').trim();
    }
}

async function insertRun(code: string, limits: Partial<RunLimits> = {}) {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO exec_runs (id, server_id, code, code_sha256, limits, gate_decision, status, requested_capabilities)
         VALUES ($1, $2, $3, $4, $5, 'auto_run', 'queued', $6)`,
        [id, serverId, code, createHash('sha256').update(code).digest('hex'), JSON.stringify({ ...resolveLimits('standard'), ...limits }), ['search']]
    );
    return id;
}

async function getRun(id: string) {
    return (await ctx.db.query('SELECT * FROM exec_runs WHERE id = $1', [id])).rows[0];
}

type Probe = { reached: boolean; value?: unknown; error?: string };

/**
 * Run `body` in a sandbox with a `probe(name, fn)` helper and return what each probe
 * saw. "reached" means the operation succeeded, which for an attack is the failure.
 */
async function runProbes(body: string, limits: Partial<RunLimits> = {}): Promise<{ status: string; probes: Record<string, Probe>; run: any }> {
    const id = await insertRun(`
        const results = {};
        const probe = async (name, fn) => {
            try { const v = await fn(); results[name] = { reached: true, value: v === undefined ? null : v }; }
            catch (e) { results[name] = { reached: false, error: (e && e.name) + ': ' + String(e && e.message).slice(0, 160) }; }
        };
        ${body}
        console.log('PROBES' + JSON.stringify(results));
    `, limits);
    const result = await processRun(deps, id);
    const run = await getRun(id);
    const line = String(run.stdout_tail ?? '').split('\n').find((l: string) => l.startsWith('PROBES'));
    if (!line) throw new Error(`no probe output; result=${JSON.stringify(result)} stderr=${run.stderr_tail}`);
    return { status: (result as any).status, probes: JSON.parse(line.slice('PROBES'.length)), run };
}

function expectNoneReached(probes: Record<string, Probe>) {
    for (const [name, p] of Object.entries(probes)) {
        expect(p.reached, `${name} was reached (${JSON.stringify(p.value)})`).toBe(false);
    }
}

async function leftoverContainers(runId: string) {
    return dockerFromEnv(DOCKER_HOST).listContainers({ all: true, filters: { label: [`agora.run=${runId}`] } });
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    const owner = await authedUser(ctx.request, 'negowner');
    ({ serverId } = await createServer(ctx.request, owner.auth, 'Negative Suite'));

    const sandbox = new SandboxDocker(dockerFromEnv(DOCKER_HOST));
    ({ runtime } = await sandbox.preflight({ image: IMAGE, network: NETWORK, requireGvisor: process.env.SANDBOX_TEST_RUNTIME === 'runsc' }));
    // The gateway a sandbox may reach. Under gVisor the runner pins its address, so it must exist.
    gateway = await startGatewayHarness(NETWORK, () => ({ status: 404, body: { error: 'not found', code: 'not_found' } }));
    deps = {
        db: ctx.db,
        sandbox,
        config: { image: IMAGE, network: NETWORK, runtime, capUrl: 'http://cap-gateway:8080', perServerConcurrency: 4, capacityRetryMs: 100, capContainer: FORWARDER },
    };
});

afterAll(async () => {
    docker(['rm', '-f', TARGET], { ignoreErrors: true });
    await gateway?.stop();
    await ctx.close();
});

describe('spec §14: what a run cannot reach', () => {

    test('the suite runs on the runtime it was asked for', () => {
        const kernel = docker(['run', '--rm', `--runtime=${runtime}`, '--entrypoint', 'uname', PROBE_IMAGE, '-r']);
        console.log(`sandbox runtime: ${runtime}; kernel seen inside a container: ${kernel}`);
        if (process.env.SANDBOX_TEST_RUNTIME === 'runsc') {
            expect(runtime).toBe('runsc');
            // gVisor presents its own kernel, not the host's
            expect(kernel).toContain('gvisor');
        }
    });

    test('core services and the file volume are out of reach (item 1)', async () => {
        const { status, probes } = await runProbes(`
            await probe('fetch postgres', () => fetch('http://postgres:5432'));
            await probe('fetch redis', () => fetch('http://redis:6379'));
            await probe('fetch api', () => fetch('http://api:3000/health'));
            await probe('tcp postgres', async () => { const c = await Deno.connect({ hostname: 'postgres', port: 5432 }); c.close(); });
            await probe('tcp redis', async () => { const c = await Deno.connect({ hostname: 'redis', port: 6379 }); c.close(); });
            await probe('list /data/files', () => [...Deno.readDirSync('/data/files')].length);
            await probe('stat /data', () => Deno.statSync('/data').isDirectory);
        `);
        expect(status).toBe('succeeded');
        expectNoneReached(probes);
    });

    test('the container has no mounts, no extra network, and the hardened settings (items 1, 5)', async () => {
        const id = await insertRun('await new Promise(r => setTimeout(r, 6000));', { wallClockMs: 20_000 });
        const pending = processRun(deps, id);
        try {
            let info: any;
            for (let i = 0; i < 100 && !info; i++) {
                await new Promise(r => setTimeout(r, 100));
                try {
                    const candidate = await dockerFromEnv(DOCKER_HOST).getContainer(containerName(id)).inspect();
                    if (candidate.State?.Running) info = candidate;
                } catch { /* not created yet */ }
            }
            expect(info, 'container never started').toBeTruthy();

            // No volume and no bind mount: the uploads volume (files-data) cannot be inside
            expect(info.Mounts).toEqual([]);
            expect(info.HostConfig.Binds ?? []).toEqual([]);
            expect(Object.keys(info.NetworkSettings.Networks)).toEqual([NETWORK]);
            expect(info.HostConfig.Runtime).toBe(runtime);
            expect(info.HostConfig.ReadonlyRootfs).toBe(true);
            expect(info.HostConfig.Privileged).toBe(false);
            expect(info.HostConfig.CapDrop).toEqual(['ALL']);
            expect(info.HostConfig.CapAdd ?? []).toEqual([]);
            expect(info.HostConfig.SecurityOpt).toContain('no-new-privileges');
            expect(info.Config.User).toBe('65532:65532');
            expect(info.HostConfig.PortBindings ?? {}).toEqual({});
        } finally {
            expect(await pending).toEqual({ kind: 'ran', status: 'succeeded' });
        }
        expect(await leftoverContainers(id)).toHaveLength(0);
    });

    test('no route to the internet: fetch, raw TCP and DNS all fail (item 2)', async () => {
        const { status, probes } = await runProbes(`
            await probe('fetch example.com', () => fetch('https://example.com'));
            await probe('fetch by IP', () => fetch('http://1.1.1.1'));
            await probe('raw TCP 1.1.1.1:53', async () => { const c = await Deno.connect({ hostname: '1.1.1.1', port: 53 }); c.close(); });
            await probe('raw UDP', () => Deno.listenDatagram({ port: 0, transport: 'udp' }));
            await probe('resolve public name', () => Deno.resolveDns('example.com', 'A'));
            await probe('listen', () => Deno.listen({ port: 8081 }));
        `);
        expect(status).toBe('succeeded');
        expectNoneReached(probes);
    });

    test('the network itself has no route out, whatever the process is allowed to do (items 1, 2; decision D2)', async () => {
        // Deno's permissions deny the probes above before a packet is sent. This test
        // removes Deno from the picture: a plain container with a shell on the sandbox
        // network must still be unable to reach a service on another network, the host,
        // or the internet. A control container on the default bridge proves the targets are up.
        docker(['rm', '-f', TARGET], { ignoreErrors: true });
        docker(['run', '-d', '--name', TARGET, PROBE_IMAGE, 'TCP-LISTEN:5432,fork,reuseaddr', 'SYSTEM:echo hello']);
        const targetIp = docker(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', TARGET]);
        expect(targetIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

        const check = (name: string, cmd: string) => `if ${cmd} >/dev/null 2>&1; then echo "${name}=REACHED"; else echo "${name}=BLOCKED"; fi`;
        const script = [
            check('other-network-service', `nc -z -w 3 ${targetIp} 5432`),
            // The host, where this test's gateway server listens (same route the forwarder uses)
            check('host-gateway-port', `nc -z -w 3 host.docker.internal ${gateway.port}`),
            check('internet-tcp', 'nc -z -w 3 1.1.1.1 53'),
            check('internet-dns', 'timeout 6 nslookup example.com'),
        ].join('; ');
        const parse = (out: string) => Object.fromEntries(out.split('\n').filter(l => l.includes('=')).map(l => l.trim().split('=')));

        const hostAlias = '--add-host=host.docker.internal:host-gateway';
        const control = parse(docker(['run', '--rm', hostAlias, '--entrypoint', 'sh', PROBE_IMAGE, '-c', script], { ignoreErrors: true }));
        expect(control['other-network-service'], 'control: target should be reachable from the default bridge').toBe('REACHED');
        expect(control['host-gateway-port'], 'control: the host port should be reachable from the default bridge').toBe('REACHED');

        const fromSandboxNet = parse(docker(
            ['run', '--rm', `--runtime=${runtime}`, '--network', NETWORK, hostAlias, '--entrypoint', 'sh', PROBE_IMAGE, '-c', script],
            { ignoreErrors: true },
        ));
        expect(fromSandboxNet).toEqual({
            'other-network-service': 'BLOCKED',
            'host-gateway-port': 'BLOCKED',
            'internet-tcp': 'BLOCKED',
            'internet-dns': 'BLOCKED',
        });
    });

    test('remote imports fail, dynamic and static (item 3)', async () => {
        const { status, probes } = await runProbes(`
            await probe('dynamic https import', () => import('https://esm.sh/lodash-es@4'));
            await probe('dynamic jsr import', () => import('jsr:@std/path'));
            await probe('dynamic npm import', () => import('npm:lodash-es@4'));
        `);
        expect(status).toBe('succeeded');
        expectNoneReached(probes);

        // A static remote import fails before any user code runs
        const id = await insertRun('import lodash from "https://esm.sh/lodash-es@4";\nconsole.log("LOADED", typeof lodash);');
        expect(await processRun(deps, id)).toEqual({ kind: 'ran', status: 'failed' });
        expect((await getRun(id)).stdout_tail ?? '').not.toContain('LOADED');
    });

    test('the environment holds the gateway address and the run token, nothing else (item 4)', async () => {
        const { status, probes } = await runProbes(`
            await probe('toObject', () => Object.keys(Deno.env.toObject()));
            await probe('cap url', () => Deno.env.get('AGORA_CAP_URL'));
            await probe('token present', () => typeof Deno.env.get('AGORA_RUN_TOKEN') === 'string' && Deno.env.get('AGORA_RUN_TOKEN').length > 20);
            await probe('code chunk', () => Deno.env.get('AGORA_CODE_0') ?? null);
            await probe('DENO_DIR', () => Deno.env.get('DENO_DIR'));
            await probe('PATH', () => Deno.env.get('PATH'));
            await probe('HOME', () => Deno.env.get('HOME'));
            await probe('HOSTNAME', () => Deno.env.get('HOSTNAME'));
        `);
        expect(status).toBe('succeeded');
        // Listing the whole environment is denied; if a Deno version ever allows it, only the two names may show
        if (probes['toObject'].reached) {
            expect((probes['toObject'].value as string[]).sort()).toEqual(['AGORA_CAP_URL', 'AGORA_RUN_TOKEN']);
        }
        expect(probes['cap url']).toMatchObject({ reached: true, value: 'http://cap-gateway:8080' });
        expect(probes['token present']).toMatchObject({ reached: true, value: true });
        // The code that was passed in through the environment is gone before user code runs
        expect(probes['code chunk']).toMatchObject({ reached: true, value: null });
        for (const name of ['DENO_DIR', 'PATH', 'HOME', 'HOSTNAME']) expect(probes[name].reached, name).toBe(false);
    });

    test('sensitive files and the Docker socket cannot be read (item 5)', async () => {
        const { status, probes } = await runProbes(`
            await probe('/etc/shadow', () => Deno.readTextFileSync('/etc/shadow').length);
            await probe('/etc/passwd', () => Deno.readTextFileSync('/etc/passwd').length);
            await probe('/proc/1/environ', () => Deno.readTextFileSync('/proc/1/environ').length);
            await probe('/proc/self/environ', () => Deno.readTextFileSync('/proc/self/environ').length);
            await probe('/proc/self/mounts', () => Deno.readTextFileSync('/proc/self/mounts').length);
            await probe('stat docker.sock', () => Deno.statSync('/var/run/docker.sock').isSocket);
            await probe('connect docker.sock', async () => { const c = await Deno.connect({ transport: 'unix', path: '/var/run/docker.sock' }); c.close(); });
            await probe('list /', () => [...Deno.readDirSync('/')].length);
        `);
        expect(status).toBe('succeeded');
        expectNoneReached(probes);
    });

    test('writes outside scratch fail, and scratch is capped at its size limit (item 6)', async () => {
        const { status, probes } = await runProbes(`
            await probe('write /etc', () => Deno.writeTextFileSync('/etc/agora-probe', 'x'));
            await probe('write /tmp', () => Deno.writeTextFileSync('/tmp/agora-probe', 'x'));
            await probe('overwrite std lib', () => Deno.writeTextFileSync('/opt/agora-std/std.ts', '// replaced'));
            await probe('write /', () => Deno.writeTextFileSync('/agora-probe', 'x'));
            await probe('execute a file written to scratch', () => { Deno.writeTextFileSync('/scratch/a.sh', '#!/bin/sh'); return new Deno.Command('/scratch/a.sh').outputSync().code; });

            // Fill scratch 8 MB at a time, well past its limit
            const chunk = new Uint8Array(8 * 1024 * 1024).fill(120);
            let written = 0, failure = null;
            try {
                const f = Deno.openSync('/scratch/fill.bin', { write: true, create: true });
                for (let i = 0; i < 13; i++) { let off = 0; while (off < chunk.length) off += f.writeSync(chunk.subarray(off)); written += chunk.length; }
                f.close();
            } catch (e) { failure = e.name + ': ' + String(e.message).slice(0, 80); }
            results['scratch fill'] = { reached: failure === null, value: { writtenMb: Math.round(written / 1048576), failure } };
        `);
        expect(status).toBe('succeeded');
        const fill = probes['scratch fill'];
        delete probes['scratch fill'];
        expectNoneReached(probes);
        // 104 MB attempted against a 64 MB scratch: it must stop, at or below the limit
        expect(fill.reached, 'filling scratch past its limit did not fail').toBe(false);
        expect((fill.value as any).writtenMb).toBeLessThanOrEqual(64);
    });

    test('a fork bomb is denied or contained, and the host carries on (item 7)', async () => {
        // Subprocesses are denied outright
        const { probes } = await runProbes(`
            await probe('spawn deno', () => new Deno.Command(Deno.execPath(), { args: ['--version'] }).outputSync().code);
            await probe('spawn sh', () => new Deno.Command('/bin/sh', { args: ['-c', 'true'] }).outputSync().code);
        `);
        expectNoneReached(probes);

        // Threads are the remaining way to multiply: spin up far more workers than the PID limit allows
        const id = await insertRun(`
            const src = URL.createObjectURL(new Blob(['while (true) {}'], { type: 'application/javascript' }));
            let spawned = 0;
            try { for (let i = 0; i < 2000; i++) { new Worker(src, { type: 'module' }); spawned++; } }
            catch (e) { console.log('worker limit hit after', spawned, e.name); }
            console.log('spawned', spawned);
            await new Promise(r => setTimeout(r, 60000));
        `, { wallClockMs: 8000 });
        const started = Date.now();
        const result = await processRun(deps, id);
        expect(result.kind).toBe('ran');
        expect(['failed', 'killed', 'timeout']).toContain((result as any).status);
        expect(Date.now() - started).toBeLessThan(40_000);
        expect(await leftoverContainers(id)).toHaveLength(0);

        // The engine is still healthy: an ordinary run works straight afterwards
        const after = await insertRun('console.log("still fine")');
        expect(await processRun(deps, after)).toEqual({ kind: 'ran', status: 'succeeded' });
    });
});
