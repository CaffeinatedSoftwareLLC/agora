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
    /** Killed because `shouldStop` returned true (e.g. the submitting bot was paused). */
    stopped: boolean;
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

/** `name` is the gateway container `wanted`, or it with a Compose replica suffix (`-1`). */
export function isGatewayName(name: string, wanted: string): boolean {
    const n = name.replace(/^\//, '');
    return n === wanted || (n.startsWith(`${wanted}-`) && /^\d+$/.test(n.slice(wanted.length + 1)));
}

/** The parts of a network inspect the preflight checks. */
export interface SandboxNetworkInfo {
    Internal?: boolean;
    Driver?: string;
    EnableIPv6?: boolean;
    Options?: Record<string, string> | null;
}

/** Docker's bridge option that leaves the host without an address on the network. */
export const INHIBIT_IPV4 = 'com.docker.network.bridge.inhibit_ipv4';

/**
 * Why a network can't carry sandbox runs, or null when it can.
 *
 * Internal keeps traffic off the outside world, but the host itself still answers on the
 * bridge's own address (its gateway): an sshd, a Docker API on 2375, anything listening on
 * 0.0.0.0. With inhibit_ipv4 the bridge has no IPv4 address, so the host isn't on the sandbox
 * network at all. Agent boxes found and closed the same gap (src/boxes/boxd/spec.ts networkSpec).
 */
export function sandboxNetworkProblem(info: SandboxNetworkInfo): string | null {
    if (!info.Internal) return 'must be internal (no external route)';
    // inhibit_ipv4 covers IPv4 only; with IPv6 on, the host could hold an address on the bridge again
    if (info.EnableIPv6) return 'must not have IPv6 enabled (enable_ipv6: false)';
    if ((info.Driver ?? 'bridge') === 'bridge' && info.Options?.[INHIBIT_IPV4] !== 'true') {
        return `lets runs reach the host on its gateway address (created without ${INHIBIT_IPV4}=true; `
            + 'recreate it with install/sandbox-network.sh, see docs/planning/sandbox-isolation-spec.md §6.1)';
    }
    return null;
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

        const network = await this.docker.getNetwork(opts.network).inspect().catch(() => null) as SandboxNetworkInfo | null;
        if (!network) throw new Error(`Sandbox network "${opts.network}" does not exist`);
        const problem = sandboxNetworkProblem(network);
        if (problem) throw new Error(`Sandbox network "${opts.network}" ${problem}; refusing to run`);

        const image = await this.docker.getImage(opts.image).inspect().catch(() => null);
        if (!image) throw new Error(`Sandbox image "${opts.image}" is not present on this host`);

        return { runtime: hasGvisor ? 'runsc' : 'runc' };
    }

    /**
     * IPv4 of the capability gateway on the sandbox network, found by container name: exactly
     * `containerName`, or that name with Compose's replica suffix (`agora-cap-gateway` matches
     * `agora-cap-gateway-1`). Not a substring: another container on the network (another
     * install's, attached by a compromised runner of its own, §6.2) must not be taken for the
     * gateway and be handed this install's run tokens. Uses the network inspect endpoint the
     * socket proxy already allows; it never inspects other containers. Looked up per run, so a
     * restarted gateway with a new IP is picked up.
     */
    async gatewayAddress(network: string, containerName: string): Promise<string | null> {
        const info = await this.docker.getNetwork(network).inspect() as { Containers?: Record<string, { Name?: string; IPv4Address?: string }> };
        for (const c of Object.values(info.Containers ?? {})) {
            if (c.Name && isGatewayName(c.Name, containerName) && c.IPv4Address) return c.IPv4Address.split('/')[0];
        }
        return null;
    }

    /**
     * Create, start, wait (with deadline), collect logs, remove. Always removes the container.
     * Every call after create addresses the container by name: the socket proxy only
     * allows container operations on this install's `<instance>-run-*` names, so the runner
     * can't inspect or touch other containers (e.g. read the database container's env) or
     * another install's runs.
     */
    async run(spec: ContainerCreateOptions, opts: {
        timeoutMs: number;
        outputBytes: number;
        onStarted?: (containerId: string) => Promise<void>;
        /** Polled every `stopPollMs` while the container runs; true kills it. */
        shouldStop?: () => Promise<boolean>;
        stopPollMs?: number;
    }): Promise<RunOutcome> {
        if (!spec.name) throw new Error('Sandbox containers must be named');
        const created = await this.docker.createContainer(spec);
        const container = this.docker.getContainer(spec.name);
        try {
            await container.start();
            await opts.onStarted?.(created.id);

            let timer: NodeJS.Timeout | undefined;
            let poll: NodeJS.Timeout | undefined;
            const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), opts.timeoutMs); });
            const stop = new Promise<'stopped'>(resolve => {
                const shouldStop = opts.shouldStop;
                if (!shouldStop) return;
                poll = setInterval(() => {
                    shouldStop().then(s => { if (s) resolve('stopped'); }, () => { /* keep running; retry next tick */ });
                }, opts.stopPollMs ?? 1000);
            });
            const waited = container.wait().then(() => 'exited' as const);
            const result = await Promise.race([waited, deadline, stop]);
            clearTimeout(timer);
            clearInterval(poll);

            const timedOut = result === 'timeout';
            const stopped = result === 'stopped';
            if (timedOut || stopped) {
                await container.kill({ signal: 'SIGKILL' }).catch(() => { /* already exited */ });
                await waited.catch(() => { /* ignore */ });
            }

            const state = (await container.inspect()).State;
            const logs = await container.logs({ stdout: true, stderr: true, follow: false }) as unknown as Buffer;
            const output = demuxLogs(Buffer.isBuffer(logs) ? logs : Buffer.from(logs as unknown as string), opts.outputBytes);

            return {
                exitCode: timedOut || stopped ? null : state.ExitCode,
                timedOut,
                stopped,
                oomKilled: !!state.OOMKilled,
                ...output,
                containerId: created.id,
            };
        } finally {
            // One retry; a container still left is removed at the runner's next start (removeRunContainers)
            await container.remove({ force: true })
                .catch(() => new Promise(r => setTimeout(r, 500)).then(() => container.remove({ force: true })))
                .catch(() => { /* best effort */ });
        }
    }

    /**
     * Remove this install's run containers left behind (the runner crashed mid-run, or a removal
     * failed), by name. The runner can't list containers: the socket proxy refuses the list call,
     * because it can't hold a list to one install's label (it filters paths, not query strings),
     * and allows deletes only on this install's `<instance>-run-` names (#126). The names come
     * from this install's own database (runner.ts runContainerCandidates). A name that is
     * already gone is skipped; one that can't be removed is reported in `failed`.
     */
    async removeRunContainers(names: readonly string[]): Promise<{ removed: number; failed: { name: string; error: string }[] }> {
        let removed = 0;
        const failed: { name: string; error: string }[] = [];
        for (const name of names) {
            try {
                await this.docker.getContainer(name).remove({ force: true });
                removed++;
            } catch (err) {
                if ((err as { statusCode?: number }).statusCode === 404) continue;
                failed.push({ name, error: err instanceof Error ? err.message : String(err) });
            }
        }
        return { removed, failed };
    }
}
