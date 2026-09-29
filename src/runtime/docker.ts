import Docker from 'dockerode';
import type { ContainerCreateOptions } from 'dockerode';

/**
 * Thin wrapper over the Docker Engine API for sandbox runs. Talks to Docker only
 * through the socket proxy (AGORA_DOCKER_HOST=http://socket-proxy:2375; not DOCKER_HOST, so a sourced .env never redirects the docker CLI), which allows
 * just the endpoints used here. No attach/exec: code goes in via env, output comes
 * back via the logs API after exit.
 */

export interface RunOutcome {
    exitCode: number | null;
    timedOut: boolean;
    oomKilled: boolean;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    containerId: string;
}

export function dockerFromEnv(dockerHost = process.env.AGORA_DOCKER_HOST ?? 'http://127.0.0.1:2375'): Docker {
    const url = new URL(dockerHost.replace(/^tcp:/, 'http:'));
    return new Docker({ protocol: url.protocol === 'https:' ? 'https' : 'http', host: url.hostname, port: Number(url.port || 2375) });
}

/**
 * Split Docker's multiplexed log stream (8-byte frame headers when Tty=false) into
 * stdout and stderr, keeping at most `cap` bytes of each.
 */
export function demuxLogs(buf: Buffer, cap: number): Pick<RunOutcome, 'stdout' | 'stderr' | 'stdoutTruncated' | 'stderrTruncated'> {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let outTrunc = false;
    let errTrunc = false;

    let offset = 0;
    while (offset + 8 <= buf.length) {
        const stream = buf[offset];
        const size = buf.readUInt32BE(offset + 4);
        const start = offset + 8;
        const end = Math.min(start + size, buf.length);
        const frame = buf.subarray(start, end);
        offset = start + size;

        if (stream === 2) {
            const room = cap - errLen;
            if (room <= 0) { errTrunc = true; continue; }
            if (frame.length > room) errTrunc = true;
            const part = frame.subarray(0, room);
            err.push(part);
            errLen += part.length;
        } else {
            const room = cap - outLen;
            if (room <= 0) { outTrunc = true; continue; }
            if (frame.length > room) outTrunc = true;
            const part = frame.subarray(0, room);
            out.push(part);
            outLen += part.length;
        }
    }

    return {
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        stdoutTruncated: outTrunc,
        stderrTruncated: errTrunc,
    };
}

export class SandboxDocker {
    constructor(private docker: Docker) {}

    /** Throws with an operator-facing message if the environment can't run sandboxes safely. */
    async preflight(opts: { image: string; network: string; requireGvisor: boolean }): Promise<{ runtime: 'runsc' | 'runc' }> {
        const info = await this.docker.info() as { Runtimes?: Record<string, unknown> };
        const hasGvisor = !!info.Runtimes && 'runsc' in info.Runtimes;
        if (!hasGvisor && opts.requireGvisor) {
            throw new Error(
                'gVisor (runsc) is not registered with Docker. The sandbox runner refuses to execute code without it. '
                + 'Install it (see docs/planning/sandbox-isolation-spec.md §15) or, for local development only, '
                + 'set AGORA_SANDBOX_INSECURE_DEV=1.',
            );
        }

        const network = await this.docker.getNetwork(opts.network).inspect().catch(() => null) as { Internal?: boolean } | null;
        if (!network) throw new Error(`Sandbox network "${opts.network}" does not exist`);
        if (!network.Internal) {
            throw new Error(`Sandbox network "${opts.network}" must be internal (no external route); refusing to run`);
        }

        const image = await this.docker.getImage(opts.image).inspect().catch(() => null);
        if (!image) throw new Error(`Sandbox image "${opts.image}" is not present on this host`);

        return { runtime: hasGvisor ? 'runsc' : 'runc' };
    }

    /**
     * Create, start, wait (with deadline), collect logs, remove. Always removes the container.
     * Every call after create addresses the container by name: the socket proxy only
     * allows container operations on `agora-run-*` names, so the runner can't inspect
     * or touch other containers (e.g. read the database container's env).
     */
    async run(spec: ContainerCreateOptions, opts: { timeoutMs: number; outputBytes: number; onStarted?: (containerId: string) => Promise<void> }): Promise<RunOutcome> {
        if (!spec.name) throw new Error('Sandbox containers must be named');
        const created = await this.docker.createContainer(spec);
        const container = this.docker.getContainer(spec.name);
        try {
            await container.start();
            await opts.onStarted?.(created.id);

            let timer: NodeJS.Timeout | undefined;
            const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), opts.timeoutMs); });
            const waited = container.wait().then(() => 'exited' as const);
            const result = await Promise.race([waited, deadline]);
            clearTimeout(timer);

            const timedOut = result === 'timeout';
            if (timedOut) {
                await container.kill({ signal: 'SIGKILL' }).catch(() => { /* already exited */ });
                await waited.catch(() => { /* ignore */ });
            }

            const state = (await container.inspect()).State;
            const logs = await container.logs({ stdout: true, stderr: true, follow: false }) as unknown as Buffer;
            const output = demuxLogs(Buffer.isBuffer(logs) ? logs : Buffer.from(logs as unknown as string), opts.outputBytes);

            return {
                exitCode: timedOut ? null : state.ExitCode,
                timedOut,
                oomKilled: !!state.OOMKilled,
                ...output,
                containerId: created.id,
            };
        } finally {
            await container.remove({ force: true }).catch(() => { /* best effort */ });
        }
    }

    /** Remove any sandbox containers left behind (e.g. runner crashed mid-run). */
    async removeOrphans(): Promise<number> {
        const containers = await this.docker.listContainers({ all: true, filters: { label: ['agora.managed=runtime'] } });
        for (const c of containers) {
            const name = c.Names?.[0]?.replace(/^\//, '');
            if (!name?.startsWith('agora-run-')) continue;
            await this.docker.getContainer(name).remove({ force: true }).catch(() => { /* ignore */ });
        }
        return containers.length;
    }
}
