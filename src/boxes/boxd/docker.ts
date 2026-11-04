import Docker from 'dockerode';
import type { ContainerCreateOptions } from 'dockerode';

/**
 * boxd's Docker access (docs/agent-boxes.md §7.2): only the endpoints its socket proxy allows,
 * and every container, network and volume addressed by NAME after create, never by ID, so the
 * proxy's name allowlist (`<instance>-box-<ulid>`, `<instance>_box_<ulid>`,
 * `<instance>-box-<ulid>-home`) covers each call. No exec, attach, pull, build or bind mount.
 *
 * The interface is what reconcile.ts uses; tests pass a fake.
 */

export interface NetworkEndpoint { Name?: string; IPv4Address?: string }
export interface NetworkInfo {
    Name: string;
    Internal?: boolean;
    Labels?: Record<string, string>;
    IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] | null };
    Containers?: Record<string, NetworkEndpoint>;
}
export interface ContainerSummary { Names?: string[]; Labels?: Record<string, string>; State?: string }
export interface VolumeSummary { Name: string; Labels?: Record<string, string> | null }

export interface BoxDockerApi {
    info(): Promise<{ Runtimes?: Record<string, unknown> }>;
    imageInspect(name: string): Promise<any | null>;
    /** Every network on the engine (subnet picking must see them all). */
    listNetworks(): Promise<NetworkInfo[]>;
    listContainers(filters: Record<string, string[]>): Promise<ContainerSummary[]>;
    listVolumes(filters: Record<string, string[]>): Promise<VolumeSummary[]>;
    inspectNetwork(name: string): Promise<NetworkInfo | null>;
    createNetwork(body: Record<string, unknown>): Promise<void>;
    connectNetwork(network: string, container: string, ipv4: string): Promise<void>;
    disconnectNetwork(network: string, container: string): Promise<void>;
    removeNetwork(name: string): Promise<void>;
    inspectVolume(name: string): Promise<any | null>;
    createVolume(body: Record<string, unknown>): Promise<void>;
    removeVolume(name: string): Promise<void>;
    inspectContainer(name: string): Promise<any | null>;
    createContainer(body: ContainerCreateOptions): Promise<string>;
    startContainer(name: string): Promise<void>;
    stopContainer(name: string, seconds: number): Promise<void>;
    restartContainer(name: string, seconds: number): Promise<void>;
    killContainer(name: string): Promise<void>;
    removeContainer(name: string): Promise<void>;
}

export function boxDockerFromEnv(dockerHost = process.env.AGORA_BOX_DOCKER_HOST ?? 'http://box-socket-proxy:2375'): Docker {
    const url = new URL(dockerHost.replace(/^tcp:/, 'http:'));
    return new Docker({ protocol: url.protocol === 'https:' ? 'https' : 'http', host: url.hostname, port: Number(url.port || 2375) });
}

export const statusOf = (err: unknown): number | undefined => (err as any)?.statusCode;
export const notFound = (err: unknown) => statusOf(err) === 404;
/** start of a running container, stop of a stopped one: Docker answers 304. */
const notModified = (err: unknown) => statusOf(err) === 304;

async function orNull<T>(p: Promise<T>): Promise<T | null> {
    try { return await p; } catch (err) { if (notFound(err)) return null; throw err; }
}
async function ignore404(p: Promise<unknown>): Promise<void> {
    try { await p; } catch (err) { if (!notFound(err)) throw err; }
}

export class BoxDocker implements BoxDockerApi {
    constructor(private docker: Docker) {}

    async info() { return this.docker.info(); }
    async imageInspect(name: string) { return orNull(this.docker.getImage(name).inspect()); }
    async listNetworks() { return await this.docker.listNetworks() as NetworkInfo[]; }
    async listContainers(filters: Record<string, string[]>) {
        return await this.docker.listContainers({ all: true, filters }) as ContainerSummary[];
    }
    async listVolumes(filters: Record<string, string[]>) {
        const r = await this.docker.listVolumes({ filters }) as { Volumes?: VolumeSummary[] | null };
        return r.Volumes ?? [];
    }
    async inspectNetwork(name: string) { return orNull(this.docker.getNetwork(name).inspect()) as Promise<NetworkInfo | null>; }
    async createNetwork(body: Record<string, unknown>) { await this.docker.createNetwork(body as any); }
    async connectNetwork(network: string, container: string, ipv4: string) {
        await this.docker.getNetwork(network).connect({ Container: container, EndpointConfig: { IPAMConfig: { IPv4Address: ipv4 } } });
    }
    async disconnectNetwork(network: string, container: string) {
        await ignore404(this.docker.getNetwork(network).disconnect({ Container: container, Force: true }));
    }
    async removeNetwork(name: string) { await ignore404(this.docker.getNetwork(name).remove()); }
    async inspectVolume(name: string) { return orNull(this.docker.getVolume(name).inspect()); }
    async createVolume(body: Record<string, unknown>) { await this.docker.createVolume(body as any); }
    async removeVolume(name: string) { await ignore404(this.docker.getVolume(name).remove()); }
    async inspectContainer(name: string) { return orNull(this.docker.getContainer(name).inspect()); }
    async createContainer(body: ContainerCreateOptions) {
        if (!body.name) throw new Error('Box containers must be named');
        const c = await this.docker.createContainer(body);
        return c.id;
    }
    async startContainer(name: string) {
        try { await this.docker.getContainer(name).start(); } catch (err) { if (!notModified(err)) throw err; }
    }
    async stopContainer(name: string, seconds: number) {
        try { await this.docker.getContainer(name).stop({ t: seconds }); } catch (err) { if (!notModified(err) && !notFound(err)) throw err; }
    }
    async restartContainer(name: string, seconds: number) { await this.docker.getContainer(name).restart({ t: seconds }); }
    async killContainer(name: string) {
        try { await this.docker.getContainer(name).kill(); } catch (err) { if (!notFound(err) && statusOf(err) !== 409) throw err; }
    }
    async removeContainer(name: string) { await ignore404(this.docker.getContainer(name).remove({ force: true })); }
}
