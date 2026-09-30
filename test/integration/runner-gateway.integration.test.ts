import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { SandboxDocker } from '../../src/runtime/docker';
import { processRun, type RunnerConfig } from '../../src/runtime/runner';
import { resolveLimits } from '../../src/runtime/limits';

/**
 * Under gVisor, Docker's embedded DNS doesn't resolve container names on the sandbox
 * network (google/gvisor#7469), so the runner looks up the gateway's IP and pins it
 * in each run's /etc/hosts. The real SandboxDocker runs over a fake Docker API here.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let serverId: string;

function fakeDocker(network: { containers?: Record<string, { Name: string; IPv4Address: string }>; fail?: boolean }) {
    const created: any[] = [];
    let resolveWait: () => void = () => {};
    const waited = new Promise<void>(r => { resolveWait = r; });
    const container = {
        start: async () => { setTimeout(resolveWait, 5); },
        wait: () => waited,
        kill: async () => {},
        inspect: async () => ({ State: { ExitCode: 0, OOMKilled: false } }),
        logs: async () => Buffer.alloc(0),
        remove: async () => {},
    };
    const docker = {
        createContainer: async (spec: any) => { created.push(spec); return { id: 'fake' }; },
        getContainer: () => container,
        getNetwork: (name: string) => ({
            inspect: async () => {
                if (network.fail) throw new Error('socket proxy: 403 Forbidden');
                return { Name: name, Internal: true, Containers: network.containers ?? {} };
            },
        }),
    };
    return { sandbox: new SandboxDocker(docker as any), created };
}

const GATEWAY = { abc123: { Name: 'agora-cap-gateway-1', IPv4Address: '172.18.0.2/16' } };

function config(runtime: 'runsc' | 'runc', extra: Partial<RunnerConfig> = {}): RunnerConfig {
    return { image: 'img', network: 'agora_sandbox', runtime, capUrl: 'http://cap-gateway:8080', perServerConcurrency: 10, capacityRetryMs: 100, ...extra };
}

async function run(sandbox: SandboxDocker, cfg: RunnerConfig) {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO exec_runs (id, server_id, code, code_sha256, limits, gate_decision, status)
         VALUES ($1, $2, 'console.log(1)', $3, $4, 'auto_run', 'queued')`,
        [id, serverId, 'a'.repeat(64), JSON.stringify(resolveLimits('standard'))]
    );
    const result = await processRun({ db: ctx.db, sandbox, config: cfg }, id);
    const row = (await ctx.db.query('SELECT status, error FROM exec_runs WHERE id = $1', [id])).rows[0];
    return { result, row };
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    const owner = await authedUser(ctx.request, 'gwlookup');
    ({ serverId } = await createServer(ctx.request, owner.auth, 'Gateway Lookup'));
});

afterAll(async () => {
    await ctx.close();
});

describe('gateway address for sandbox runs', () => {
    test('runsc: the gateway\'s sandbox-network IP is pinned in /etc/hosts', async () => {
        const { sandbox, created } = fakeDocker({ containers: { ...GATEWAY, other: { Name: 'agora-run-01x', IPv4Address: '172.18.0.9/16' } } });
        const { result } = await run(sandbox, config('runsc'));
        expect(result).toEqual({ kind: 'ran', status: 'succeeded' });
        expect(created[0].HostConfig.ExtraHosts).toEqual(['cap-gateway:172.18.0.2']);
        expect(created[0].Env).toContain('AGORA_CAP_URL=http://cap-gateway:8080');
    });

    test('runsc: a missing gateway fails the run with a clear error and starts no container', async () => {
        const { sandbox, created } = fakeDocker({ containers: {} });
        const { result, row } = await run(sandbox, config('runsc'));
        expect(result).toEqual({ kind: 'ran', status: 'error' });
        expect(row.error).toBe('Capability gateway container "cap-gateway" was not found on the "agora_sandbox" network');
        expect(created).toHaveLength(0);
    });

    test('runsc: a failed lookup fails the run', async () => {
        const { sandbox, created } = fakeDocker({ fail: true });
        const { row } = await run(sandbox, config('runsc'));
        expect(row).toEqual({ status: 'error', error: 'socket proxy: 403 Forbidden' });
        expect(created).toHaveLength(0);
    });

    test('runc (dev): Docker DNS works, so a missing gateway or failed lookup is not fatal', async () => {
        for (const net of [{ containers: {} }, { fail: true }]) {
            const { sandbox, created } = fakeDocker(net);
            const { result } = await run(sandbox, config('runc'));
            expect(result).toEqual({ kind: 'ran', status: 'succeeded' });
            expect(created[0].HostConfig.ExtraHosts).toEqual([]);
        }
    });

    test('the container name can be overridden, and a literal IP URL needs no lookup', async () => {
        const custom = fakeDocker({ containers: { x: { Name: 'prod-gw-7', IPv4Address: '10.9.0.3/24' } } });
        await run(custom.sandbox, config('runsc', { capContainer: 'prod-gw' }));
        expect(custom.created[0].HostConfig.ExtraHosts).toEqual(['cap-gateway:10.9.0.3']);

        const literal = fakeDocker({ fail: true });
        const { result } = await run(literal.sandbox, config('runsc', { capUrl: 'http://10.9.0.3:8080' }));
        expect(result).toEqual({ kind: 'ran', status: 'succeeded' });
        expect(literal.created[0].HostConfig.ExtraHosts).toEqual([]);
    });
});
