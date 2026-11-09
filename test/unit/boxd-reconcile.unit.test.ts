import { beforeEach, describe, expect, it } from 'vitest';
import { BACKOFF_START_MS, FAIL_LIMIT, Reconciler, UPGRADE_WAIT_MS, type ReconcileConfig } from '../../src/boxes/boxd/reconcile';
import { boxContainerName, boxNetworkName, boxVolumeName } from '../../src/lib/boxes/contract';
import { parsePools } from '../../src/boxes/boxd/subnets';
import { FakeDocker } from '../boxes/boxd-fake-docker';
import { MemoryStore, fakeBoxId, quietLog } from '../boxes/boxd-fakes';

const EDGE = 'agora-box-edge-1';

function setup(over: Partial<ReconcileConfig> = {}) {
    const docker = new FakeDocker();
    const store = new MemoryStore();
    let now = 1_000_000;
    const config: ReconcileConfig = {
        instance: 'agora', image: 'agora/box:1', imageVersion: 1, runtime: 'runc', edgeContainer: EDGE,
        subnets: parsePools('10.213.0.0/24'), ...over,
    };
    const r = new Reconciler({ docker, store, config, log: quietLog, now: () => now });
    return { docker, store, r, config, tick: (ms: number) => { now += ms; }, setConfig: (c: Partial<ReconcileConfig>) => Object.assign(config, c) };
}
const names = (id: string) => ({ c: boxContainerName('agora', id), n: boxNetworkName('agora', id), v: boxVolumeName('agora', id) });
const envOf = (info: any) => Object.fromEntries((info.Config.Env as string[]).map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));

describe('boxd reconcile', () => {
    let t: ReturnType<typeof setup>;
    beforeEach(() => { t = setup(); });

    it('creates network, edge at .2, volume and container at .3, mints once and starts it', async () => {
        // Something else on the engine already uses the first /28s of the pool
        t.docker.addForeignNetwork('someone_else', '10.213.0.0/27');
        const box = t.store.add();
        await t.r.pass();

        const n = names(box.id);
        const row = t.store.get(box.id);
        expect(row.subnet).toBe('10.213.0.32/28');
        expect(row.state).toBe('running');
        expect(row.generation).toBe(1);
        expect(row.imageVersion).toBe(1);
        const net = t.docker.networks.get(n.n)!;
        expect(net.Internal).toBe(true);
        const eps = Object.values(net.Containers);
        expect(eps).toContainEqual({ Name: EDGE, IPv4Address: '10.213.0.34/28' });
        expect(eps).toContainEqual({ Name: n.c, IPv4Address: '10.213.0.35/28' });
        expect(t.docker.volumes.has(n.v)).toBe(true);
        const info = t.docker.containers.get(n.c);
        expect(info.State.Running).toBe(true);
        expect(info.HostConfig.ExtraHosts).toEqual(['edge:10.213.0.34']);
        const env = envOf(info);
        expect(env.AGORA_BOX_GENERATION).toBe('1');
        expect(env.AGORA_HOST_TOKEN).toBe(t.store.minted[0].hostToken);
        expect(env.AGORA_BOT_TOKEN).toBe(t.store.minted[0].botToken);
        expect(t.store.minted).toHaveLength(1);
    });

    it('leaves a good running box alone on later passes', async () => {
        const box = t.store.add();
        await t.r.pass();
        const calls = t.docker.calls.length;
        await t.r.pass();
        await t.r.pass();
        expect(t.store.minted).toHaveLength(1);
        expect(t.docker.calls.slice(calls).filter(c => !c.startsWith('imageInspect'))).toEqual([]);
        expect(t.store.get(box.id).state).toBe('running');
    });

    it('re-attaches the edge when it was recreated (lost its box networks)', async () => {
        const box = t.store.add();
        await t.r.pass();
        const n = names(box.id);
        await t.docker.disconnectNetwork(n.n, EDGE);
        await t.r.pass();
        expect(Object.values(t.docker.networks.get(n.n)!.Containers)).toContainEqual({ Name: EDGE, IPv4Address: '10.213.0.2/28' });
        // No restart of the box is needed: its /etc/hosts pins .2
        expect(t.store.minted).toHaveLength(1);
    });

    it('re-attaches the edge to a box that is backing off or failed, without waiting out the backoff', async () => {
        const box = t.store.add();
        await t.r.pass();
        const n = names(box.id);
        // The box hits an error and backs off; then the edge is recreated
        t.docker.failNext.set('startContainer', Object.assign(new Error('OCI runtime create failed'), { statusCode: 500 }));
        await t.docker.stopContainer(n.c);
        await t.r.pass();
        await t.docker.disconnectNetwork(n.n, EDGE);
        await t.r.pass();
        expect(Object.values(t.docker.networks.get(n.n)!.Containers)).toContainEqual({ Name: EDGE, IPv4Address: '10.213.0.2/28' });
        // Held as failed: still re-attached
        t.store.get(box.id).state = 'failed';
        await t.docker.disconnectNetwork(n.n, EDGE);
        await t.r.pass();
        expect(Object.values(t.docker.networks.get(n.n)!.Containers)).toContainEqual({ Name: EDGE, IPv4Address: '10.213.0.2/28' });
    });

    it('disconnects anything but the edge and the box from a box network', async () => {
        const box = t.store.add();
        await t.r.pass();
        t.docker.others.add('agora-postgres-1');
        await t.docker.connectNetwork(names(box.id).n, 'agora-postgres-1', '10.213.0.9');
        await t.r.pass();
        expect(Object.values(t.docker.networks.get(names(box.id).n)!.Containers).map(e => e.Name)).not.toContain('agora-postgres-1');
    });

    it('keeps the box when the edge container is missing, and attaches it once it is back', async () => {
        t.docker.others.clear();
        const box = t.store.add();
        await t.r.pass();
        expect(t.store.get(box.id).state).toBe('running');
        t.docker.others.add(EDGE);
        await t.r.pass();
        expect(Object.values(t.docker.networks.get(names(box.id).n)!.Containers).map(e => e.Name)).toContain(EDGE);
    });

    it('retries another /28 when Docker reports an overlap it could not see in the list', async () => {
        const box = t.store.add();
        t.docker.failNext.set('createNetwork', Object.assign(new Error('Pool overlaps with other one on this address space'), { statusCode: 403 }));
        await t.r.pass();
        expect(t.store.get(box.id).subnet).toBe('10.213.0.16/28');
        expect(t.store.get(box.id).state).toBe('running');
    });

    it('gives two boxes different subnets', async () => {
        const a = t.store.add();
        const b = t.store.add();
        await t.r.pass();
        expect(t.store.get(a.id).subnet).toBe('10.213.0.0/28');
        expect(t.store.get(b.id).subnet).toBe('10.213.0.16/28');
    });

    it('refuses to start a container that drifted, says so once, and waits for a rebuild', async () => {
        const box = t.store.add();
        await t.r.pass();
        const n = names(box.id);
        const c = t.docker.containers.get(n.c);
        c.HostConfig.Privileged = true;
        await t.docker.stopContainer(n.c);
        await t.r.pass();
        await t.r.pass();
        expect(t.docker.containers.get(n.c).State.Running).toBe(false);
        expect(t.store.get(box.id).state).toBe('failed');
        expect(t.store.get(box.id).lastError).toContain('privileged');
        expect(t.store.notices.filter(x => x.kind === 'drift')).toHaveLength(1);

        t.store.request(box.id, 'rebuild');
        await t.r.pass();
        const row = t.store.get(box.id);
        expect(row.state).toBe('running');
        expect(row.pendingAction).toBeNull();
        expect(row.generation).toBe(2);
        expect(t.docker.containers.get(n.c).HostConfig.Privileged).toBe(false);
    });

    it('stops a running container that drifted', async () => {
        const box = t.store.add();
        await t.r.pass();
        const n = names(box.id);
        t.docker.containers.get(n.c).Mounts.push({ Type: 'bind', Name: '', Destination: '/host' });
        await t.r.pass();
        expect(t.docker.containers.get(n.c).State.Running).toBe(false);
        expect(t.store.get(box.id).state).toBe('failed');
    });

    // Security review #5: a pre-created volume with copied labels and bind options is a host bind mount
    it('refuses a home volume with driver options or another driver, even with the right labels', async () => {
        for (const vol of [{ Driver: 'local', Options: { type: 'none', o: 'bind', device: '/etc' } }, { Driver: 'nfs', Options: null }]) {
            const box = t.store.add();
            const n = names(box.id);
            t.docker.volumes.set(n.v, { Name: n.v, ...vol, Labels: { 'org.agora.instance': 'agora', 'org.agora.box': box.id } });
            await t.r.pass();
            expect(t.store.get(box.id).lastError).toContain('not a plain local volume');
            expect(t.docker.containers.has(n.c)).toBe(false);
        }
    });

    it('refuses when its home volume is mounted by another container', async () => {
        const box = t.store.add();
        await t.r.pass();
        const n = names(box.id);
        t.docker.containers.set('intruder', { ...t.docker.containers.get(n.c), Name: '/intruder', Config: { Labels: {} } });
        await t.r.pass();
        expect(t.store.get(box.id).lastError).toContain('volume shared');
    });

    it('restart keeps the container and the tokens', async () => {
        const box = t.store.add();
        await t.r.pass();
        const before = t.docker.containers.get(names(box.id).c).Id;
        t.store.request(box.id, 'restart');
        await t.r.pass();
        expect(t.docker.count('restartContainer')).toBe(1);
        expect(t.docker.containers.get(names(box.id).c).Id).toBe(before);
        expect(t.store.minted).toHaveLength(1);
        expect(t.store.get(box.id).pendingAction).toBeNull();
    });

    it('rebuild replaces the container with a new generation and keeps the volume', async () => {
        const box = t.store.add();
        await t.r.pass();
        const n = names(box.id);
        const before = t.docker.containers.get(n.c).Id;
        t.store.request(box.id, 'rebuild');
        await t.r.pass();
        const after = t.docker.containers.get(n.c);
        expect(after.Id).not.toBe(before);
        expect(envOf(after).AGORA_BOX_GENERATION).toBe('2');
        expect(after.Config.Labels['org.agora.box.generation']).toBe('2');
        expect(t.docker.count(`removeVolume ${n.v}`)).toBe(0);
        expect(t.store.minted.map(m => m.generation)).toEqual([1, 2]);
    });

    it('reset replaces the volume too', async () => {
        const box = t.store.add();
        await t.r.pass();
        const n = names(box.id);
        t.store.request(box.id, 'reset');
        await t.r.pass();
        expect(t.docker.count(`removeVolume ${n.v}`)).toBe(1);
        expect(t.docker.count(`createVolume ${n.v}`)).toBe(2);
        expect(t.store.get(box.id).generation).toBe(2);
        expect(t.store.get(box.id).state).toBe('running');
    });

    it('does not lose an action requested while the previous one ran', async () => {
        const box = t.store.add();
        await t.r.pass();
        t.store.request(box.id, 'restart');
        const list = t.store.listBoxes.bind(t.store);
        t.store.listBoxes = async () => {
            const rows = await list();
            // The owner asks again (a rebuild) after boxd read the row
            t.store.request(box.id, 'rebuild');
            return rows;
        };
        await t.r.pass();
        expect(t.store.get(box.id).pendingAction).toBe('rebuild');
    });

    it('recreates when the row generation moved (restore) or the limits changed', async () => {
        const box = t.store.add();
        await t.r.pass();
        t.store.get(box.id).generation = 5; // box-restore-prep bumped it
        await t.r.pass();
        expect(t.store.get(box.id).generation).toBe(6);
        expect(envOf(t.docker.containers.get(names(box.id).c)).AGORA_BOX_GENERATION).toBe('6');
        t.store.get(box.id).cpus = 4;
        await t.r.pass();
        expect(t.docker.containers.get(names(box.id).c).HostConfig.NanoCpus).toBe(4e9);
        expect(t.store.get(box.id).generation).toBe(7);
    });

    it('stops and starts with desired_state', async () => {
        const box = t.store.add();
        await t.r.pass();
        t.store.get(box.id).desiredState = 'stopped';
        await t.r.pass();
        expect(t.docker.containers.get(names(box.id).c).State.Running).toBe(false);
        expect(t.store.get(box.id).state).toBe('stopped');
        t.store.get(box.id).desiredState = 'running';
        await t.r.pass();
        expect(t.docker.containers.get(names(box.id).c).State.Running).toBe(true);
        expect(t.store.minted).toHaveLength(1);
    });

    it('delete removes container and network, keeps the volume until purge, frees the subnet', async () => {
        const box = t.store.add();
        await t.r.pass();
        const n = names(box.id);
        Object.assign(t.store.get(box.id), { desiredState: 'deleted', volumePurgeAfter: new Date(1_000_000 + 7 * 86400_000) });
        await t.r.pass();
        expect(t.docker.containers.has(n.c)).toBe(false);
        expect(t.docker.networks.has(n.n)).toBe(false);
        expect(t.docker.volumes.has(n.v)).toBe(true);
        expect(t.store.get(box.id).state).toBe('deleted');
        expect(t.store.get(box.id).subnet).toBeNull();
        const calls = t.docker.calls.length;
        await t.r.pass();
        expect(t.docker.calls.length).toBe(calls);
        t.tick(7 * 86400_000 + 1);
        await t.r.pass();
        expect(t.docker.volumes.has(n.v)).toBe(false);
    });

    it('backs off 15 s doubling, notices once, and fails the box after 5 failed starts in 10 minutes', async () => {
        const box = t.store.add();
        const boom = () => t.docker.failNext.set('startContainer', Object.assign(new Error('OCI runtime create failed'), { statusCode: 500 }));
        boom();
        await t.r.pass();
        expect(t.store.get(box.id).lastError).toContain('OCI runtime');
        expect(t.store.notices.filter(n => n.kind === 'error')).toHaveLength(1);

        // Within the backoff nothing happens
        const starts = t.docker.count('startContainer');
        t.tick(BACKOFF_START_MS - 1000);
        await t.r.pass();
        expect(t.docker.count('startContainer')).toBe(starts);

        let delay = BACKOFF_START_MS;
        for (let i = 2; i <= FAIL_LIMIT; i++) {
            t.tick(delay);
            boom();
            await t.r.pass();
            delay *= 2;
        }
        expect(t.store.get(box.id).state).toBe('failed');
        expect(t.store.notices.filter(n => n.kind === 'error')).toHaveLength(1);
        expect(t.store.notices.filter(n => n.kind === 'failed')).toHaveLength(1);

        // Left alone until the owner acts; a restart lifts it
        t.tick(60_000);
        await t.r.pass();
        expect(t.store.get(box.id).state).toBe('failed');
        t.store.request(box.id, 'restart');
        await t.r.pass();
        expect(t.store.get(box.id).state).toBe('running');
    });

    it('a box process that keeps exiting (Docker restarts it) is failed after 5 in 10 minutes', async () => {
        const box = t.store.add();
        await t.r.pass();
        t.docker.crash(names(box.id).c, 3);
        await t.r.pass();
        expect(t.store.get(box.id).state).toBe('running');
        t.tick(60_000);
        t.docker.crash(names(box.id).c, 2);
        await t.r.pass();
        expect(t.store.get(box.id).state).toBe('failed');
        expect(t.docker.containers.get(names(box.id).c).State.Running).toBe(false);
    });

    it('upgrades one box per pass, waiting up to 15 minutes for an active run', async () => {
        const a = t.store.add();
        const b = t.store.add();
        await t.r.pass();
        t.setConfig({ image: 'agora/box:2', imageVersion: 2 });
        t.store.activeRuns.add(a.id);

        await t.r.pass();
        // a is busy, so nothing upgrades yet (one at a time, oldest first)
        expect(t.store.get(a.id).imageVersion).toBe(1);
        expect(t.store.get(b.id).imageVersion).toBe(1);
        // the old image is still a box image: no drift while it waits
        expect(t.store.get(a.id).state).toBe('running');

        t.tick(UPGRADE_WAIT_MS + 1);
        await t.r.pass();
        expect(t.store.get(a.id).imageVersion).toBe(2);
        expect(t.store.get(b.id).imageVersion).toBe(1);
        expect(t.docker.containers.get(names(a.id).c).Config.Image).toBe('agora/box:2');
        expect(t.store.notices.find(n => n.boxId === a.id && n.kind === 'upgraded')?.content).toContain('v1 to v2');

        await t.r.pass();
        expect(t.store.get(b.id).imageVersion).toBe(2);
        expect(t.docker.count(`removeVolume`)).toBe(0);
    });

    describe('another build of the same box/VERSION (agora-host, agora-mcp or box/ changed)', () => {
        const buildOf = (id: string) => t.docker.containers.get(names(id).c).Config.Labels['org.agora.box.build'];

        it('rebuilds each box onto the current build, one per pass, after active runs, then leaves them alone', async () => {
            const a = t.store.add();
            const b = t.store.add();
            await t.r.pass();
            expect(buildOf(a.id)).toBe('build-1');
            const before = t.store.minted.length;
            // The stack rebuilt agora/box:1 with new agora-host: same tag and version, new build label
            t.docker.imageBuild = 'build-2';
            t.store.activeRuns.add(a.id);

            await t.r.pass();
            // a is busy, b waits its turn: both keep the old build, with no drift
            expect([buildOf(a.id), buildOf(b.id)]).toEqual(['build-1', 'build-1']);
            expect(t.store.get(a.id).state).toBe('running');

            t.tick(UPGRADE_WAIT_MS + 1);
            await t.r.pass();
            expect([buildOf(a.id), buildOf(b.id)]).toEqual(['build-2', 'build-1']);
            expect(t.store.get(a.id).imageVersion).toBe(1);
            expect(t.store.notices.find(n => n.boxId === a.id && n.kind === 'upgraded')?.content).toContain('current build of box image v1');

            await t.r.pass();
            expect(buildOf(b.id)).toBe('build-2');
            expect(t.store.minted.length).toBe(before + 2);
            await t.r.pass();
            await t.r.pass();
            expect(t.store.minted.length).toBe(before + 2);
            expect(t.docker.count('removeVolume')).toBe(0);
        });

        it('never rebuilds twice for the same image build, but does for the next one', async () => {
            const box = t.store.add();
            await t.r.pass();
            t.docker.imageBuild = 'build-2';
            await t.r.pass();
            const after = t.store.minted.length;
            // The rebuilt container still doesn't carry it (say, the tag moved under boxd): no loop
            t.docker.containers.get(names(box.id).c).Config.Labels['org.agora.box.build'] = 'build-1';
            await t.r.pass();
            await t.r.pass();
            expect(t.store.minted.length).toBe(after);
            t.docker.imageBuild = 'build-3';
            await t.r.pass();
            expect(t.store.minted.length).toBe(after + 1);
            expect(buildOf(box.id)).toBe('build-3');
        });

        it('rebuilds nothing when the build label is unknown on either side, or the image inspect fails', async () => {
            // A container from an image without the label (built before it existed)
            t.docker.imageBuild = null;
            const old = t.store.add();
            await t.r.pass();
            expect(buildOf(old.id)).toBeUndefined();
            t.docker.imageBuild = 'build-2';
            await t.r.pass();
            await t.r.pass();
            expect(t.store.minted).toHaveLength(1);
            // A labelled box, then the engine can't say what the image is
            const labelled = t.store.add();
            await t.r.pass();
            expect(buildOf(labelled.id)).toBe('build-2');
            t.docker.imageBuild = 'build-3';
            t.docker.imageInspectFails = true;
            await t.r.pass();
            await t.r.pass();
            expect(buildOf(labelled.id)).toBe('build-2');
            // And an image built without one (no AGORA_BOX_BUILD)
            t.docker.imageInspectFails = false;
            t.docker.imageBuild = null;
            await t.r.pass();
            expect(buildOf(labelled.id)).toBe('build-2');
            expect(t.store.minted).toHaveLength(2);
        });

        it('rebuilds a stopped box too, and leaves it stopped', async () => {
            const box = t.store.add();
            await t.r.pass();
            t.store.get(box.id).desiredState = 'stopped';
            await t.r.pass();
            expect(t.docker.containers.get(names(box.id).c).State.Running).toBe(false);
            t.docker.imageBuild = 'build-2';
            await t.r.pass();
            expect(buildOf(box.id)).toBe('build-2');
            expect(t.docker.containers.get(names(box.id).c).State.Running).toBe(false);
            expect(t.store.get(box.id).state).toBe('stopped');
        });
    });

    it('removes unclaimed resources of this instance only', async () => {
        const kept = t.store.add();
        await t.r.pass();
        const ghost = fakeBoxId();
        const g = names(ghost);
        const other = { c: boxContainerName('agora2', ghost), v: boxVolumeName('agora2', ghost) };
        t.docker.volumes.set(g.v, { Name: g.v, Labels: { 'org.agora.instance': 'agora', 'org.agora.box': ghost } });
        t.docker.volumes.set(other.v, { Name: other.v, Labels: { 'org.agora.instance': 'agora2', 'org.agora.box': ghost } });
        await t.docker.createNetwork({ Name: g.n, Internal: true, Options: { 'com.docker.network.bridge.inhibit_ipv4': 'true' }, Labels: { 'org.agora.instance': 'agora', 'org.agora.box': ghost }, IPAM: { Config: [{ Subnet: '10.213.0.128/28' }] } });
        t.docker.containers.set(g.c, { ...t.docker.containers.get(names(kept.id).c), Name: `/${g.c}`, Mounts: [], State: { Running: false }, Config: { Labels: { 'org.agora.instance': 'agora', 'org.agora.box': ghost } } });
        t.docker.containers.set(other.c, { Name: `/${other.c}`, Mounts: [], State: { Running: false }, Config: { Labels: { 'org.agora.instance': 'agora2', 'org.agora.box': ghost } } });
        // The stack's own edge carries the instance label too, but isn't a box
        t.docker.containers.set(EDGE, { Name: `/${EDGE}`, Mounts: [], State: { Running: true }, Config: { Labels: { 'org.agora.instance': 'agora' } } });

        await t.r.pass();
        expect(t.docker.containers.has(g.c)).toBe(false);
        expect(t.docker.networks.has(g.n)).toBe(false);
        expect(t.docker.volumes.has(g.v)).toBe(false);
        expect(t.docker.containers.has(other.c)).toBe(true);
        expect(t.docker.volumes.has(other.v)).toBe(true);
        expect(t.docker.containers.has(EDGE)).toBe(true);
        expect(t.docker.containers.has(names(kept.id).c)).toBe(true);
    });

    it('finishes the current box and stops when asked (SIGTERM)', async () => {
        const a = t.store.add();
        const b = t.store.add();
        const mint = t.store.mintTokens.bind(t.store);
        t.store.mintTokens = async (id: string) => { t.r.stop(); return mint(id); };
        await t.r.pass();
        expect(t.store.get(a.id).state).toBe('running');
        expect(t.store.get(b.id).state).toBe('creating');
    });

    it('a box deleted between read and mint is skipped quietly', async () => {
        const box = t.store.add();
        const list = t.store.listBoxes.bind(t.store);
        t.store.listBoxes = async () => { const rows = await list(); t.store.get(box.id).desiredState = 'deleted'; return rows; };
        await t.r.pass();
        expect(t.store.notices).toHaveLength(0);
        expect(t.store.get(box.id).lastError).toBeNull();
    });
});
