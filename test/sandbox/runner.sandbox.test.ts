import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { dockerFromEnv, SandboxDocker } from '../../src/runtime/docker';
import { processRun, reconcileInterruptedRuns, startRunnerWorker, RUNTIME_QUEUE, type RunnerDeps } from '../../src/runtime/runner';
import { resolveLimits, type RunLimits } from '../../src/runtime/limits';

/**
 * WBS 3.2: the runner against real containers (through the socket proxy).
 * Local runs use runc (insecure dev mode); CI with gVisor sets SANDBOX_TEST_RUNTIME=runsc.
 */

const IMAGE = process.env.AGORA_SANDBOX_IMAGE ?? 'agora/sandbox-deno:dev';
const NETWORK = process.env.AGORA_SANDBOX_NETWORK ?? 'agora_sandbox';
const RUNTIME = (process.env.SANDBOX_TEST_RUNTIME as 'runsc' | 'runc') ?? 'runc';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let serverId: string;
let sandbox: SandboxDocker;
let deps: RunnerDeps;
const finished: { runId: string; status: string }[] = [];

async function insertRun(code: string, opts: { limits?: Partial<RunLimits>; gate?: 'auto_run' | 'needs_approval'; approved?: boolean; status?: string } = {}) {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO exec_runs (id, server_id, code, code_sha256, limits, gate_decision, approved_at, status, requested_capabilities)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, serverId, code, createHash('sha256').update(code).digest('hex'),
         JSON.stringify({ ...resolveLimits('standard'), ...opts.limits }),
         opts.gate ?? 'auto_run', opts.approved ? new Date() : null, opts.status ?? 'queued', ['search']]
    );
    return id;
}

async function getRun(id: string) {
    return (await ctx.db.query('SELECT * FROM exec_runs WHERE id = $1', [id])).rows[0];
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    const owner = await authedUser(ctx.request, 'sandboxowner');
    ({ serverId } = await createServer(ctx.request, owner.auth, 'Sandbox Server'));

    sandbox = new SandboxDocker(dockerFromEnv(process.env.AGORA_DOCKER_HOST ?? 'http://127.0.0.1:2375'));
    const { runtime } = await sandbox.preflight({ image: IMAGE, network: NETWORK, requireGvisor: RUNTIME === 'runsc' });
    deps = {
        db: ctx.db,
        sandbox,
        config: { image: IMAGE, network: NETWORK, runtime, capUrl: 'http://cap-gateway:8080', perServerConcurrency: 2, capacityRetryMs: 100 },
        onFinished: async (runId, status) => { finished.push({ runId, status }); },
    };
});

afterAll(async () => {
    await ctx.close();
});

describe('preflight', () => {
    test('refuses to run without gVisor unless insecure dev mode is on', async () => {
        if (RUNTIME === 'runsc') return; // gVisor present: nothing to refuse
        await expect(sandbox.preflight({ image: IMAGE, network: NETWORK, requireGvisor: true }))
            .rejects.toThrow('gVisor (runsc) is not registered');
    });

    test('refuses a missing network or image', async () => {
        await expect(sandbox.preflight({ image: IMAGE, network: 'agora_sandbox_missing', requireGvisor: false }))
            .rejects.toThrow('does not exist');
        await expect(sandbox.preflight({ image: 'agora/does-not-exist:none', network: NETWORK, requireGvisor: false }))
            .rejects.toThrow('not present');
    });
});

describe('running code', () => {
    test('succeeds, captures stdout, redacts the run token, revokes it after', async () => {
        const id = await insertRun('console.log("hello sandbox"); console.log("token:", Deno.env.get("AGORA_RUN_TOKEN"));');
        const result = await processRun(deps, id);
        expect(result).toEqual({ kind: 'ran', status: 'succeeded' });

        const run = await getRun(id);
        expect(run.status).toBe('succeeded');
        expect(run.exit_code).toBe(0);
        expect(run.stdout_tail).toContain('hello sandbox');
        expect(run.stdout_tail).toContain('token: [REDACTED]');
        expect(run.stdout_tail).not.toMatch(/art_[A-Za-z0-9_-]{20,}/);
        expect(run.container_id).toBeTruthy();
        expect(run.started_at).toBeTruthy();
        expect(run.finished_at).toBeTruthy();

        const tokens = await ctx.db.query('SELECT capabilities, revoked_at, expires_at FROM exec_run_tokens WHERE run_id = $1', [id]);
        expect(tokens.rows).toHaveLength(1);
        expect(tokens.rows[0].capabilities).toEqual(['search']);
        expect(tokens.rows[0].revoked_at).toBeTruthy();
        expect(finished).toContainEqual({ runId: id, status: 'succeeded' });
    });

    test('non-zero exit is failed, with stderr', async () => {
        const id = await insertRun('console.error("bad input"); Deno.exit(3);');
        expect(await processRun(deps, id)).toEqual({ kind: 'ran', status: 'failed' });
        const run = await getRun(id);
        expect(run.exit_code).toBe(3);
        expect(run.stderr_tail).toContain('bad input');
    });

    test('uncaught errors fail the run', async () => {
        const id = await insertRun('throw new Error("kaboom")');
        expect(await processRun(deps, id)).toEqual({ kind: 'ran', status: 'failed' });
        expect((await getRun(id)).stderr_tail).toContain('kaboom');
    });

    test('infinite loop is killed at the deadline and the container is removed', async () => {
        const id = await insertRun('while (true) {}', { limits: { wallClockMs: 3000 } });
        const started = Date.now();
        expect(await processRun(deps, id)).toEqual({ kind: 'ran', status: 'timeout' });
        expect(Date.now() - started).toBeLessThan(20_000);
        const run = await getRun(id);
        expect(run.error).toContain('time limit');
        expect(run.exit_code).toBeNull();
        const leftovers = await dockerFromEnv(process.env.AGORA_DOCKER_HOST ?? 'http://127.0.0.1:2375')
            .listContainers({ all: true, filters: { label: [`agora.run=${id}`] } });
        expect(leftovers).toHaveLength(0);
    });

    test('pausing the submitting bot kills its running container (3.8)', async () => {
        const botId = generateUlid();
        await ctx.db.query(
            `INSERT INTO users (id, username, bot, server_id) VALUES ($1, $2, true, $3)`,
            [botId, `pausebot${botId.slice(-6).toLowerCase()}`, serverId]
        );
        const id = await insertRun('while (true) {}', { limits: { wallClockMs: 30_000 } });
        await ctx.db.query('UPDATE exec_runs SET submitted_by = $1 WHERE id = $2', [botId, id]);

        const started = Date.now();
        const pending = processRun({ ...deps, config: { ...deps.config, stopPollMs: 200 } }, id);
        for (let i = 0; i < 100 && !(await getRun(id)).container_id; i++) await new Promise(r => setTimeout(r, 100));
        await ctx.db.query('UPDATE users SET bot_paused_at = NOW() WHERE id = $1', [botId]);

        expect(await pending).toEqual({ kind: 'ran', status: 'killed' });
        expect(Date.now() - started).toBeLessThan(20_000);
        expect((await getRun(id)).error).toContain('bot was paused');
        const leftovers = await dockerFromEnv(process.env.AGORA_DOCKER_HOST ?? 'http://127.0.0.1:2375')
            .listContainers({ all: true, filters: { label: [`agora.run=${id}`] } });
        expect(leftovers).toHaveLength(0);
    });

    test('output is truncated to the limit', async () => {
        const id = await insertRun('console.log("x".repeat(200_000))', { limits: { outputBytes: 1024 } });
        await processRun(deps, id);
        const run = await getRun(id);
        expect(run.stdout_tail.length).toBeLessThan(1100);
        expect(run.stdout_tail).toContain('[output truncated]');
    });

    test('memory exhaustion fails or is killed; the host is unaffected', async () => {
        const id = await insertRun('const a = []; while (true) a.push(new Array(1e6).fill(1));', { limits: { memoryMb: 128, wallClockMs: 30_000 } });
        const result = await processRun(deps, id);
        expect(result.kind).toBe('ran');
        expect(['failed', 'killed']).toContain((result as any).status);
    });

    test('no internet, no internal DNS, no subprocesses, no writes outside scratch', async () => {
        const id = await insertRun(`
            const results = {};
            const probe = async (name, fn) => { try { await fn(); results[name] = 'REACHED'; } catch (e) { results[name] = e.name; } };
            await probe('internet', () => fetch('https://example.com'));
            await probe('postgres', () => fetch('http://postgres:5432'));
            await probe('dns', () => Deno.resolveDns('example.com', 'A'));
            await probe('run', () => new Deno.Command(Deno.execPath(), { args: ['--version'] }).output());
            await probe('write', () => Deno.writeTextFile('/tmp/x', 'y'));
            await probe('read', () => Deno.readTextFile('/etc/passwd'));
            await probe('import', () => import('https://esm.sh/lodash-es@4'));
            await Deno.writeTextFile('/scratch/ok.txt', 'fine');
            console.log(JSON.stringify(results));
        `);
        expect(await processRun(deps, id)).toEqual({ kind: 'ran', status: 'succeeded' });
        const results = JSON.parse((await getRun(id)).stdout_tail.trim());
        for (const [probe, outcome] of Object.entries(results)) {
            expect(outcome, probe).not.toBe('REACHED');
        }
    });
});

describe('gate and concurrency (defense in depth)', () => {
    test('a run that needs approval but has none is not executed', async () => {
        const id = await insertRun('console.log("should not run")', { gate: 'needs_approval', approved: false });
        expect(await processRun(deps, id)).toEqual({ kind: 'skipped', reason: 'not claimable' });
        expect((await getRun(id)).status).toBe('queued');
    });

    test('an approved run executes', async () => {
        const id = await insertRun('console.log("approved")', { gate: 'needs_approval', approved: true });
        expect(await processRun(deps, id)).toEqual({ kind: 'ran', status: 'succeeded' });
    });

    test('runs not in the queued state are skipped', async () => {
        const id = await insertRun('console.log("x")', { status: 'awaiting_approval' });
        expect((await processRun(deps, id)).kind).toBe('skipped');
    });

    test('server at capacity defers the run', async () => {
        const busy1 = await insertRun('1', { status: 'running' });
        const busy2 = await insertRun('1', { status: 'running' });
        const id = await insertRun('console.log("waiting")');
        expect(await processRun(deps, id)).toEqual({ kind: 'deferred' });
        expect((await getRun(id)).status).toBe('queued');
        await ctx.db.query("UPDATE exec_runs SET status = 'succeeded' WHERE id = ANY($1)", [[busy1, busy2]]);
    });

    test('startup reconciliation marks interrupted runs as error', async () => {
        const id = await insertRun('1', { status: 'running' });
        expect(await reconcileInterruptedRuns(ctx.db)).toBeGreaterThanOrEqual(1);
        const run = await getRun(id);
        expect(run.status).toBe('error');
        expect(run.error).toContain('Runner restarted');
    });
});

describe('queue worker', () => {
    test('a job on the runtime queue runs end to end', async () => {
        const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
        const connection = {
            host: redis.hostname, port: Number(redis.port || 6379),
            db: redis.pathname.length > 1 ? Number(redis.pathname.slice(1)) : 0,
            maxRetriesPerRequest: null,
        };
        const worker = startRunnerWorker(deps, connection, 2);
        const queue = new Queue(RUNTIME_QUEUE, { connection });
        try {
            const id = await insertRun('console.log("via queue")');
            await queue.add('run', { runId: id }, { removeOnComplete: true, removeOnFail: true });
            for (let i = 0; i < 120; i++) {
                const run = await getRun(id);
                if (run.status === 'succeeded') break;
                await new Promise(r => setTimeout(r, 250));
            }
            expect((await getRun(id)).stdout_tail).toContain('via queue');
        } finally {
            await queue.obliterate({ force: true }).catch(() => {});
            await queue.close();
            await worker.close();
        }
    });
});

describe('orphan cleanup', () => {
    test('removes leftover agora-run containers only', async () => {
        const docker = dockerFromEnv(process.env.AGORA_DOCKER_HOST ?? 'http://127.0.0.1:2375');
        const name = `agora-run-${generateUlid().toLowerCase()}`;
        await docker.createContainer({ name, Image: IMAGE, Cmd: ['--version'], Labels: { 'agora.managed': 'runtime' }, HostConfig: { NetworkMode: NETWORK } });
        expect(await sandbox.removeOrphans()).toBeGreaterThanOrEqual(1);
        const left = await docker.listContainers({ all: true, filters: { name: [name] } });
        expect(left).toHaveLength(0);
    });
});
