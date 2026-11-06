import { execFileSync } from 'node:child_process';

/**
 * The host Docker CLI, for the test harness only: checks and probes the runner can't make
 * through its socket proxy (it has no container list, #126). Runs themselves always go
 * through the proxy.
 */

/** This suite's install name: run containers are <instance>-run-<id>, the network <instance>_sandbox. */
export const INSTANCE = process.env.AGORA_INSTANCE || 'agora';

export function hostDocker(args: string[], opts: { ignoreErrors?: boolean } = {}): string {
    try {
        return execFileSync('docker', args, { stdio: 'pipe', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).toString().trim();
    } catch (err: any) {
        if (!opts.ignoreErrors) throw new Error(`docker ${args.join(' ')} failed: ${err.stderr?.toString() || err.message}`);
        return (err.stdout?.toString() ?? '').trim();
    }
}

/** Containers of this run still on the engine, running or not. */
export function leftoverContainers(runId: string): string[] {
    return hostDocker(['ps', '-a', '--filter', `label=agora.run=${runId.trim()}`, '--format', '{{.Names}}']).split('\n').filter(Boolean);
}

export function containerExists(name: string): boolean {
    return hostDocker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']).split('\n').includes(name);
}

/** The gateway address Docker's IPAM gave a network (the bridge holds it unless inhibit_ipv4 is set). */
export function networkGateway(network: string): string {
    const gw = hostDocker(['network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Gateway}} {{end}}', network]).split(' ').find(Boolean);
    if (gw) return gw;
    // No gateway recorded: Docker gives the subnet's first address
    const subnet = hostDocker(['network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Subnet}} {{end}}', network]).split(' ').find(s => s.includes('.'));
    if (!subnet) throw new Error(`network ${network} has no IPv4 subnet`);
    const [a, b, c, d] = subnet.split('/')[0].split('.').map(Number);
    return [a, b, c, d + 1].join('.');
}
