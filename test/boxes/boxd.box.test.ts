import { randomBytes } from 'node:crypto';
import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoxDocker } from '../../src/boxes/boxd/docker';
import { Reconciler, type ReconcileConfig } from '../../src/boxes/boxd/reconcile';
import { parsePools } from '../../src/boxes/boxd/subnets';
import { boxContainerName, boxNetworkName, boxVolumeName } from '../../src/lib/boxes/contract';
import { generateUlid } from '../../src/utils/ulid';
import { preflight } from '../../src/boxd-main';
import { MemoryStore, quietLog } from './boxd-fakes';
import { docker, until } from './harness';

/**
 * boxd's reconcile loop against a real Docker engine (Docker Desktop or any Linux engine), with
 * runc (AGORA_BOX_INSECURE_DEV=1), a stand-in box image and a stand-in edge container. The DB is
 * an in-memory store: token minting is covered by test/integration/box-tokens.integration.test.ts.
 *
 * boxd talks to Docker through a real wollomatic/socket-proxy started here with the allowlist
 * docker-compose.prod.yml gives box-socket-proxy, so every call boxd makes is checked against it.
 * If that image isn't on the engine the test talks to Docker directly and says so.
 * Everything it creates is named agora-boxtest-bd<random>* and removed at the end.
 */

const INSTANCE = `agora-boxtest-bd${randomBytes(2).toString('hex')}`;
const IMAGE = 'agora/box:boxtest';
const EDGE = `${INSTANCE}-box-edge-1`;
const PROXY = `${INSTANCE}-proxy`;
const IMGSRC = `${INSTANCE}-imgsrc`;
const PROXY_IMAGE = 'wollomatic/socket-proxy:1.13.1';

/** The box-socket-proxy allowlist (docker-compose.prod.yml), for this test's instance name. */
function boxProxyArgs(instance: string): string[] {
    const c = `${instance}-box-[0-9a-z]{26}`;
    const n = `${instance}_box_[0-9a-z]{26}`;
    return [
        '-loglevel=info',
        '-listenip=0.0.0.0',
        '-allowfrom=0.0.0.0/0',
        '-allowbindmountfrom=/nonexistent-agora-no-bind-mounts',
        '-allowHEAD=(/v1\\.[0-9]+)?/_ping',
        `-allowGET=(/v1\\.[0-9]+)?/(_ping|version|info|containers/json|networks|volumes|containers/${c}/json|networks/${n}|volumes/${c}-home|images/agora/box:[0-9A-Za-z._-]+/json)`,
        `-allowPOST=(/v1\\.[0-9]+)?/(containers/create|containers/${c}/(start|stop|restart|kill)|networks/create|networks/${n}/(connect|disconnect)|volumes/create)`,
        `-allowDELETE=(/v1\\.[0-9]+)?/(containers/${c}|networks/${n}|volumes/${c}-home)`,
    ];
}

async function must(...args: string[]) {
    const r = await docker(...args);
    if (r.code !== 0) throw new Error(`docker ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
}
const inspect = async (name: string) => JSON.parse(await must('inspect', name))[0];
const exists = async (kind: 'container' | 'network' | 'volume', name: string) => (await docker(kind, 'inspect', name)).code === 0;

let store: MemoryStore;
let r: Reconciler;
let viaProxy = false;
let boxDocker: BoxDocker;

beforeAll(async () => {
    const v = await docker('version', '--format', '{{.Server.Os}}');
    if (v.code !== 0) throw new Error(`Docker is not reachable: ${v.stderr}`);

    // Stand-in box image: alpine with the version label, /home/agent owned by the box user, a long sleep
    await must('run', '--name', IMGSRC, 'alpine:latest', 'sh', '-c', 'mkdir -p /home/agent && chown 1000:1000 /home/agent');
    await must('commit', '--change', 'LABEL org.agora.box.version=1', '--change', 'CMD ["sleep", "1000000"]', '--change', 'WORKDIR /home/agent',
        // sleep as PID 1 ignores SIGTERM; the real image's PID 1 is agora-box-init, which handles it
        '--change', 'STOPSIGNAL SIGKILL', IMGSRC, IMAGE);
    await docker('rm', '-f', IMGSRC);
    // Stand-in edge: any container with the edge's name
    await must('run', '-d', '--name', EDGE, '--label', `org.agora.instance=${INSTANCE}`, 'alpine:latest', 'sleep', '1000000');

    let api: Docker;
    if ((await docker('image', 'inspect', PROXY_IMAGE)).code === 0) {
        // Root only here: Docker Desktop's socket isn't group-readable by nobody (compose uses DOCKER_GID)
        await must('run', '-d', '--name', PROXY, '--user', '0:0', '-p', '127.0.0.1::2375',
            '-v', '/var/run/docker.sock:/var/run/docker.sock:ro', PROXY_IMAGE, ...boxProxyArgs(INSTANCE));
        const port = Number((await must('port', PROXY, '2375')).split('\n')[0].split(':').pop());
        api = new Docker({ host: '127.0.0.1', port });
        await until('socket proxy', async () => { await api.ping(); return true; }, 30_000, 500);
        viaProxy = true;
    } else {
        console.warn(`[boxd.box] ${PROXY_IMAGE} is not on this engine: talking to Docker directly, the allowlist is not exercised`);
        api = new Docker();
    }
    boxDocker = new BoxDocker(api);
    const { runtime, imageVersion } = await preflight(boxDocker, { image: IMAGE, insecureDev: true });
    expect(runtime).toBe('runc');
    expect(imageVersion).toBe(1);

    store = new MemoryStore();
    const config: ReconcileConfig = {
        instance: INSTANCE, image: IMAGE, imageVersion, runtime, edgeContainer: EDGE, subnets: parsePools('10.213.0.0/16'),
    };
    r = new Reconciler({ docker: boxDocker, store, config, log: quietLog });
});

afterAll(async () => {
    const label = `label=org.agora.instance=${INSTANCE}`;
    const ids = (await docker('ps', '-aq', '--filter', label)).stdout.split(/\s+/).filter(Boolean);
    if (ids.length) await docker('rm', '-f', ...ids);
    await docker('rm', '-f', EDGE, PROXY, IMGSRC);
    const nets = (await docker('network', 'ls', '-q', '--filter', label)).stdout.split(/\s+/).filter(Boolean);
    if (nets.length) await docker('network', 'rm', ...nets);
    const vols = (await docker('volume', 'ls', '-q', '--filter', label)).stdout.split(/\s+/).filter(Boolean);
    if (vols.length) await docker('volume', 'rm', '-f', ...vols);
    await docker('rmi', '-f', IMAGE);
});

describe('boxd on a real engine', () => {
    let boxId: string;
    let c: string; let n: string; let vol: string;
    let subnet: string;
    const prefix = () => subnet.split('/')[0].split('.').slice(0, 3).join('.');
    const lastOctet = () => Number(subnet.split('/')[0].split('.')[3]);
    const at = (offset: number) => `${prefix()}.${lastOctet() + offset}`;
    const envOf = (info: any) => Object.fromEntries((info.Config.Env as string[]).map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));

    it('creates the /28 network with the edge at .2 and the box at .3, and starts the box', async () => {
        boxId = generateUlid();
        c = boxContainerName(INSTANCE, boxId); n = boxNetworkName(INSTANCE, boxId); vol = boxVolumeName(INSTANCE, boxId);
        store.add({ id: boxId, name: 'boxtest' });
        await r.pass();

        const row = store.get(boxId);
        expect(row.lastError).toBeNull();
        expect(row.state).toBe('running');
        expect(row.generation).toBe(1);
        subnet = row.subnet!;
        expect(subnet).toMatch(/^10\.213\.\d+\.\d+\/28$/);

        const net = await inspect(n);
        expect(net.Internal).toBe(true);
        expect(net.IPAM.Config[0].Subnet).toBe(subnet);
        const eps = Object.values(net.Containers) as any[];
        expect(eps.find(e => e.Name === EDGE)?.IPv4Address).toBe(`${at(2)}/28`);
        expect(eps.find(e => e.Name === c)?.IPv4Address).toBe(`${at(3)}/28`);
        expect(eps).toHaveLength(2);

        const info = await inspect(c);
        expect(info.State.Running).toBe(true);
        expect(info.HostConfig.ReadonlyRootfs).toBe(true);
        expect(info.HostConfig.CapDrop).toEqual(['ALL']);
        // The init's four, no more; the container starts as root only so the init can start the two users apart
        expect([...info.HostConfig.CapAdd].map((x: string) => x.replace(/^CAP_/, '')).sort()).toEqual(['KILL', 'SETGID', 'SETPCAP', 'SETUID']);
        expect(info.Config.User).toBe('0:0');
        expect(info.HostConfig.ExtraHosts).toEqual([`edge:${at(2)}`]);
        expect(envOf(info).AGORA_BOX_GENERATION).toBe('1');
        expect(info.Mounts.map((m: any) => m.Name)).toEqual([vol]);

        // Inside, as the agent: a read-only root, the pinned edge, a private /run/agora, the operator's home and the as-agent channel
        const inside = await must('exec', '-u', '1000', c, 'sh', '-c', 'id -u; grep -w edge /etc/hosts; touch /etc/x 2>&1 || echo ro; stat -c "%a %u" /run/agora; stat -c "home-operator %a %u" /home/operator; stat -c "as-agent %a %u %g" /run/as-agent; touch /home/agent/ok && echo home-rw');
        expect(inside).toContain('1000');
        expect(inside).toContain(at(2));
        expect(inside).toContain('ro');
        expect(inside).toContain('700 1000');
        expect(inside).toContain('home-operator 700 1001');
        expect(inside).toContain('as-agent 710 1000 1001');
        expect(inside).toContain('home-rw');
    });

    it('a second pass changes nothing', async () => {
        const before = (await inspect(c)).Id;
        await r.pass();
        expect((await inspect(c)).Id).toBe(before);
        expect(store.minted).toHaveLength(1);
    });

    it('re-attaches a recreated edge at .2 without touching the box', async () => {
        const before = (await inspect(c)).Id;
        await must('rm', '-f', EDGE);
        await must('run', '-d', '--name', EDGE, '--label', `org.agora.instance=${INSTANCE}`, 'alpine:latest', 'sleep', '1000000');
        await r.pass();
        const eps = Object.values((await inspect(n)).Containers) as any[];
        expect(eps.find(e => e.Name === EDGE)?.IPv4Address).toBe(`${at(2)}/28`);
        expect((await inspect(c)).Id).toBe(before);
    });

    it('restart keeps the container', async () => {
        const before = await inspect(c);
        store.request(boxId, 'restart');
        await r.pass();
        const after = await inspect(c);
        expect(after.Id).toBe(before.Id);
        expect(after.State.StartedAt).not.toBe(before.State.StartedAt);
        expect(store.get(boxId).pendingAction).toBeNull();
        expect(store.minted).toHaveLength(1);
    });

    it('rebuild replaces the container with a new generation and keeps the home volume', async () => {
        await must('exec', '-u', '1000', c, 'sh', '-c', 'echo kept > /home/agent/marker');
        const before = (await inspect(c)).Id;
        store.request(boxId, 'rebuild');
        await r.pass();
        const after = await inspect(c);
        expect(after.Id).not.toBe(before);
        expect(envOf(after).AGORA_BOX_GENERATION).toBe('2');
        expect(after.Config.Labels['org.agora.box.generation']).toBe('2');
        expect(store.get(boxId).state).toBe('running');
        expect(await must('exec', '-u', '1000', c, 'cat', '/home/agent/marker')).toBe('kept');
    });

    it('refuses to start a container that is not what boxd made', async () => {
        const gen = store.get(boxId).generation;
        await must('rm', '-f', c);
        // Same name, labels, network and address, plus a capability and without the home volume
        await must('create', '--name', c,
            '--label', `org.agora.instance=${INSTANCE}`, '--label', `org.agora.box=${boxId}`,
            '--label', 'org.agora.box.version=1', '--label', `org.agora.box.generation=${gen}`,
            '--network', n, '--ip', at(3), '--cap-add', 'NET_ADMIN', '--user', '1000:1000',
            '--memory', '1024m', '--memory-swap', '1024m', '--cpus', '2', '--pids-limit', '256', IMAGE);
        await r.pass();
        const info = await inspect(c);
        expect(info.State.Running).toBe(false);
        expect(info.State.StartedAt).toMatch(/^0001-/);
        const row = store.get(boxId);
        expect(row.state).toBe('failed');
        expect(row.lastError).toMatch(/cap-drop|cap-add|read-only|mounts/);
        expect(store.notices.filter(x => x.kind === 'drift')).toHaveLength(1);

        // The owner rebuilds: a container from the constants again, home folder intact
        store.request(boxId, 'rebuild');
        await r.pass();
        expect(store.get(boxId).state).toBe('running');
        expect(store.get(boxId).generation).toBe(gen + 1);
        expect([...(await inspect(c)).HostConfig.CapAdd].map((x: string) => x.replace(/^CAP_/, '')).sort()).toEqual(['KILL', 'SETGID', 'SETPCAP', 'SETUID']);
        expect(await must('exec', '-u', '1000', c, 'cat', '/home/agent/marker')).toBe('kept');
    });

    it('reset replaces the home volume', async () => {
        const gen = store.get(boxId).generation;
        store.request(boxId, 'reset');
        await r.pass();
        expect(store.get(boxId).state).toBe('running');
        expect(store.get(boxId).generation).toBe(gen + 1);
        expect((await docker('exec', '-u', '1000', c, 'cat', '/home/agent/marker')).code).not.toBe(0);
    });

    it('delete removes container and network, keeps the volume until purge', async () => {
        Object.assign(store.get(boxId), { desiredState: 'deleted', volumePurgeAfter: new Date(Date.now() + 7 * 86400_000) });
        await r.pass();
        expect(await exists('container', c)).toBe(false);
        expect(await exists('network', n)).toBe(false);
        expect(await exists('volume', vol)).toBe(true);
        expect(await exists('container', EDGE)).toBe(true);
        expect(store.get(boxId).state).toBe('deleted');
        expect(store.get(boxId).subnet).toBeNull();

        store.get(boxId).volumePurgeAfter = new Date(Date.now() - 1000);
        await r.pass();
        expect(await exists('volume', vol)).toBe(false);
    });

    it('used only endpoints the box socket proxy allows', async () => {
        if (!viaProxy) return;
        console.log(`[boxd.box] boxd went through ${PROXY_IMAGE} with the box allowlist`);
        const logs = await docker('logs', PROXY);
        // The proxy logs a blocked request as "request blocked"
        const blocked = (logs.stdout + logs.stderr).split('\n').filter(l => /blocked/i.test(l));
        expect(blocked).toEqual([]);
    });

    it('the proxy refuses anything outside the allowlist', async () => {
        if (!viaProxy) return;
        const port = Number((await must('port', PROXY, '2375')).split('\n')[0].split(':').pop());
        const call = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
            method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
        }).then(res => res.status);
        const other = `agora2-box-${'0'.repeat(26)}`;
        expect(await call('GET', `/containers/${other}/json`)).toBe(403);
        expect(await call('GET', `/containers/${EDGE}/json`)).toBe(403);
        expect(await call('POST', `/containers/${boxContainerName(INSTANCE, generateUlid())}/exec`, {})).toBe(403);
        expect(await call('POST', '/images/create?fromImage=alpine')).toBe(403);
        expect(await call('POST', '/build')).toBe(403);
        expect(await call('GET', '/images/alpine:latest/json')).toBe(403);
        expect(await call('DELETE', `/volumes/${INSTANCE}-files-data`)).toBe(403);
        // A bind mount in a create body is refused by -allowbindmountfrom
        expect(await call('POST', `/containers/create?name=${boxContainerName(INSTANCE, generateUlid())}`, {
            Image: IMAGE, HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock'] },
        })).toBe(403);
        // The check in the previous test would have seen these
        const logs = await docker('logs', PROXY);
        expect((logs.stdout + logs.stderr).split('\n').filter(l => /blocked/i.test(l)).length).toBeGreaterThanOrEqual(8);
    });
});
