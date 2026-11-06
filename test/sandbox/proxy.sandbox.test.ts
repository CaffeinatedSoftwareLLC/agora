import Docker from 'dockerode';
import { generateUlid } from '../../src/utils/ulid';
import { containerName } from '../../src/runtime/container-spec';
import { SandboxDocker } from '../../src/runtime/docker';
import { hostDocker, containerExists } from './host-docker';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { socketProxyArgs } = require('../../scripts/lib/socket-proxy-rules.js');

/**
 * #126 against the real socket proxy: two installs on one engine, each with the runner proxy
 * docker-compose.prod.yml defines (its rules read from that file). Install B's proxy must refuse
 * to list, inspect, stop or remove install A's run containers; A's own proxy manages them.
 * test/unit/socket-proxy-rules.unit.test.ts checks the same rules path by path.
 */

const PROXY_IMAGE = 'wollomatic/socket-proxy:1.13.1';
const PROBE_IMAGE = 'alpine/socat:latest';
const A = 'agora-pxa';
const B = 'agora-pxb';
const proxies: string[] = [];
const made: string[] = [];

/** Start one install's runner proxy; returns a Docker client that talks to it. */
function startProxy(instance: string): Docker {
    const name = `${instance}-test-socket-proxy`;
    hostDocker(['rm', '-f', name], { ignoreErrors: true });
    // As in docker-compose.prod.yml, but reachable from this test (any client, a published port)
    hostDocker(['run', '-d', '--name', name, '--user', '0:0', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '-v', '/var/run/docker.sock:/var/run/docker.sock:ro',
        '-p', '127.0.0.1::2375', PROXY_IMAGE, ...socketProxyArgs(instance, { allowFrom: '0.0.0.0/0' })]);
    proxies.push(name);
    const port = Number(hostDocker(['port', name, '2375/tcp']).split('\n')[0].split(':').pop());
    return new Docker({ protocol: 'http', host: '127.0.0.1', port });
}

/** A running container named as one of `instance`'s runs, made with the host CLI. */
function runOf(instance: string): string {
    const name = containerName(generateUlid(), instance);
    hostDocker(['run', '-d', '--name', name, '--network', 'none', '--label', 'agora.managed=runtime',
        '--label', `agora.instance=${instance}`, '--entrypoint', 'sleep', PROBE_IMAGE, '300']);
    made.push(name);
    return name;
}

const status = (p: Promise<unknown>) => p.then(() => 'ok', (e: any) => e.statusCode ?? e.message);

let viaA: Docker;
let viaB: Docker;

beforeAll(async () => {
    viaA = startProxy(A);
    viaB = startProxy(B);
    for (let i = 0; i < 50; i++) {
        if (await status(viaA.ping()) === 'ok' && await status(viaB.ping()) === 'ok') return;
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('the test proxies did not come up');
});

afterAll(() => {
    hostDocker(['rm', '-f', ...made, ...proxies], { ignoreErrors: true });
});

describe('the runner socket proxy keeps installs apart (#126)', () => {
    test("install B can't list, inspect, stop or remove install A's runs", async () => {
        const runA = runOf(A);
        const id = hostDocker(['inspect', '-f', '{{.Id}}', runA]);

        expect(await status(viaB.listContainers({ all: true }))).toBe(403);
        expect(await status(viaB.listContainers({ all: true, filters: { label: [`agora.instance=${B}`] } }))).toBe(403);
        const c = viaB.getContainer(runA);
        expect(await status(c.inspect())).toBe(403);
        expect(await status(c.logs({ stdout: true }))).toBe(403);
        expect(await status(c.kill({ signal: 'SIGKILL' }))).toBe(403);
        expect(await status(c.wait())).toBe(403);
        expect(await status(c.remove({ force: true }))).toBe(403);
        // Docker takes an ID in place of a name; the proxy doesn't
        expect(await status(viaB.getContainer(id).remove({ force: true }))).toBe(403);
        expect(await status(viaB.getContainer(id.slice(0, 12)).kill())).toBe(403);
        // The runner's own cleanup, pointed at A's name, removes nothing
        const { removed, failed } = await new SandboxDocker(viaB).removeRunContainers([runA]);
        expect([removed, failed.length]).toEqual([0, 1]);

        expect(hostDocker(['inspect', '-f', '{{.State.Running}}', runA])).toBe('true');
    });

    test("install A manages its own runs, and lists nobody's", async () => {
        const runA = runOf(A);
        expect(await status(viaA.listContainers({ all: true }))).toBe(403);
        const c = viaA.getContainer(runA);
        expect(((await c.inspect()) as any).Name).toBe(`/${runA}`);
        expect(await status(c.kill({ signal: 'SIGKILL' }))).toBe('ok');
        expect(await new SandboxDocker(viaA).removeRunContainers([runA])).toEqual({ removed: 1, failed: [] });
        expect(containerExists(runA)).toBe(false);
    });

    test("install B's own runs stay its own", async () => {
        const runB = runOf(B);
        expect(await status(viaA.getContainer(runB).remove({ force: true }))).toBe(403);
        expect(await status(viaB.getContainer(runB).remove({ force: true }))).toBe('ok');
        expect(containerExists(runB)).toBe(false);
    });
});
