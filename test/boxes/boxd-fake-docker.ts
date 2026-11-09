import type { ContainerCreateOptions } from 'dockerode';
import type { BoxDockerApi, NetworkInfo } from '../../src/boxes/boxd/docker';
import { overlaps, parseCidr } from '../../src/boxes/boxd/subnets';

/** A fake Docker engine for the reconcile unit tests: names, networks, IPAM overlap, endpoints, volumes in use. */

const dockerError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode, json: { message } });

/** What `docker inspect` shows for a container created from `spec` (the fields boxd checks). */
export function inspectFrom(spec: ContainerCreateOptions, id = 'c'.repeat(64)): any {
    const hc: any = spec.HostConfig ?? {};
    const eps = spec.NetworkingConfig?.EndpointsConfig ?? {};
    return {
        Id: id,
        Name: `/${spec.name}`,
        RestartCount: 0,
        State: { Running: false, Restarting: false, Status: 'created' },
        Config: { Image: spec.Image, User: spec.User, Env: spec.Env, Labels: { ...(spec.Labels ?? {}) } },
        HostConfig: JSON.parse(JSON.stringify({ ...hc, Mounts: undefined })),
        Mounts: (hc.Mounts ?? []).map((m: any) => ({ Type: m.Type, Name: m.Source, Destination: m.Target, RW: !m.ReadOnly })),
        NetworkSettings: {
            Networks: Object.fromEntries(Object.entries(eps).map(([k, v]: [string, any]) => [k, { IPAMConfig: v.IPAMConfig ?? null, IPAddress: '' }])),
        },
    };
}

interface FakeNetwork extends NetworkInfo { Containers: Record<string, { Name: string; IPv4Address: string }> }

const matches = (labels: Record<string, string>, filter: string[] = []) => filter.every(l => {
    const [k, v] = l.split('=');
    return v === undefined ? k in labels : labels[k] === v;
});

export class FakeDocker implements BoxDockerApi {
    containers = new Map<string, any>();
    networks = new Map<string, FakeNetwork>();
    volumes = new Map<string, { Name: string; Labels: Record<string, string> }>();
    /** Containers that exist outside boxd (the edge, a stranger). */
    others = new Set<string>(['agora-box-edge-1']);
    calls: string[] = [];
    /** Throw this from the next call to the named method, once. */
    failNext = new Map<string, Error>();
    private ids = 0;
    /** The ID of the image the box tag names now; a rebuild of the stack gives it a new one. */
    imageId = 'sha256:' + '1'.repeat(64);

    private hit(call: string) {
        this.calls.push(call);
        const method = call.split(' ')[0];
        const err = this.failNext.get(method);
        if (err) { this.failNext.delete(method); throw err; }
    }
    count(prefix: string) { return this.calls.filter(c => c.startsWith(prefix)).length; }

    async info() { return { Runtimes: { runc: {} } }; }
    async imageInspect(_name: string) { return { Id: this.imageId, Config: { Labels: { 'org.agora.box.version': '1' } } }; }
    async listNetworks() { return [...this.networks.values()].map(n => JSON.parse(JSON.stringify(n))); }
    async listContainers(filters: Record<string, string[]>) {
        const out: any[] = [];
        for (const [name, c] of this.containers) {
            if (filters.volume && !c.Mounts.some((m: any) => filters.volume.includes(m.Name))) continue;
            if (!matches(c.Config.Labels, filters.label)) continue;
            out.push({ Names: [`/${name}`], Labels: c.Config.Labels, State: c.State.Running ? 'running' : 'exited' });
        }
        return out;
    }
    async listVolumes(filters: Record<string, string[]>) {
        return [...this.volumes.values()].filter(v => matches(v.Labels, filters.label));
    }
    async inspectNetwork(name: string) {
        const n = this.networks.get(name);
        return n ? JSON.parse(JSON.stringify(n)) : null;
    }
    /** A network made by something else on the engine. */
    addForeignNetwork(name: string, subnet: string) {
        this.networks.set(name, { Name: name, Internal: false, Labels: {}, IPAM: { Config: [{ Subnet: subnet }] }, Containers: {} });
    }
    async createNetwork(body: any) {
        this.hit(`createNetwork ${body.Name} ${body.IPAM.Config[0].Subnet}`);
        if (this.networks.has(body.Name)) throw dockerError(409, `network with name ${body.Name} already exists`);
        const want = parseCidr(body.IPAM.Config[0].Subnet)!;
        for (const n of this.networks.values()) {
            for (const c of n.IPAM?.Config ?? []) {
                const have = parseCidr(c.Subnet ?? '');
                if (have && overlaps(want, have)) throw dockerError(403, 'invalid pool request: Pool overlaps with other one on this address space');
            }
        }
        this.networks.set(body.Name, { Name: body.Name, Internal: body.Internal, Options: { ...(body.Options ?? {}) }, Labels: { ...body.Labels }, IPAM: { Config: body.IPAM.Config }, Containers: {} });
    }
    async connectNetwork(network: string, container: string, ipv4: string) {
        this.hit(`connectNetwork ${network} ${container} ${ipv4}`);
        const n = this.networks.get(network);
        if (!n) throw dockerError(404, 'network not found');
        if (!this.others.has(container) && !this.containers.has(container)) throw dockerError(404, `No such container: ${container}`);
        if (Object.values(n.Containers).some(e => e.Name === container)) throw dockerError(403, `endpoint with name ${container} already exists in network ${network}`);
        const prefix = n.IPAM!.Config![0].Subnet!.split('/')[1];
        n.Containers[`id-${container}`] = { Name: container, IPv4Address: `${ipv4}/${prefix}` };
    }
    async disconnectNetwork(network: string, container: string) {
        this.hit(`disconnectNetwork ${network} ${container}`);
        const n = this.networks.get(network);
        if (!n) return;
        for (const [k, e] of Object.entries(n.Containers)) if (e.Name === container) delete n.Containers[k];
    }
    async removeNetwork(name: string) {
        this.hit(`removeNetwork ${name}`);
        const n = this.networks.get(name);
        if (n && Object.keys(n.Containers).length) throw dockerError(403, `network ${name} has active endpoints`);
        this.networks.delete(name);
    }
    async inspectVolume(name: string) { return this.volumes.get(name) ?? null; }
    async createVolume(body: any) { this.hit(`createVolume ${body.Name}`); this.volumes.set(body.Name, { Name: body.Name, Driver: body.Driver ?? 'local', Options: body.DriverOpts ?? null, Labels: { ...body.Labels } }); }
    async removeVolume(name: string) {
        this.hit(`removeVolume ${name}`);
        for (const c of this.containers.values()) {
            if (c.Mounts.some((m: any) => m.Name === name)) throw dockerError(409, 'volume is in use');
        }
        this.volumes.delete(name);
    }
    async inspectContainer(name: string) {
        const c = this.containers.get(name);
        return c ? JSON.parse(JSON.stringify(c)) : null;
    }
    async createContainer(body: ContainerCreateOptions) {
        this.hit(`createContainer ${body.name}`);
        if (this.containers.has(body.name!)) throw dockerError(409, 'Conflict. The container name is already in use');
        for (const m of (body.HostConfig as any)?.Mounts ?? []) {
            if (!this.volumes.has(m.Source)) this.volumes.set(m.Source, { Name: m.Source, Labels: {} });
        }
        const id = String(++this.ids).padStart(64, 'a');
        // A container keeps the image ID it was created from, whatever the tag names later
        this.containers.set(body.name!, { ...inspectFrom(body, id), Image: this.imageId });
        return id;
    }
    private attach(name: string, running: boolean) {
        const c = this.containers.get(name);
        for (const [net, ep] of Object.entries(c.NetworkSettings.Networks) as [string, any][]) {
            const n = this.networks.get(net);
            if (!n) throw dockerError(404, `network ${net} not found`);
            if (running) {
                const prefix = n.IPAM!.Config![0].Subnet!.split('/')[1];
                n.Containers[c.Id] = { Name: name, IPv4Address: `${ep.IPAMConfig.IPv4Address}/${prefix}` };
            } else delete n.Containers[c.Id];
        }
    }
    async startContainer(name: string) {
        this.hit(`startContainer ${name}`);
        const c = this.containers.get(name);
        if (!c) throw dockerError(404, 'no such container');
        if (!c.State.Running) this.attach(name, true);
        c.State = { Running: true, Restarting: false, Status: 'running' };
        c.RestartCount = 0;
    }
    async stopContainer(name: string) {
        this.hit(`stopContainer ${name}`);
        const c = this.containers.get(name);
        if (!c) throw dockerError(404, 'no such container');
        if (c.State.Running) this.attach(name, false);
        c.State = { Running: false, Restarting: false, Status: 'exited' };
    }
    async restartContainer(name: string) {
        this.hit(`restartContainer ${name}`);
        const c = this.containers.get(name);
        if (!c) throw dockerError(404, 'no such container');
        if (!c.State.Running) this.attach(name, true);
        c.State = { Running: true, Restarting: false, Status: 'running' };
    }
    async killContainer(name: string) { await this.stopContainer(name); }
    async removeContainer(name: string) {
        this.hit(`removeContainer ${name}`);
        const c = this.containers.get(name);
        if (c) {
            if (c.State.Running) this.attach(name, false);
            this.containers.delete(name);
        }
    }
    /** Docker restarted the box process `n` times (unless-stopped). */
    crash(name: string, n = 1) { this.containers.get(name).RestartCount += n; }
}
