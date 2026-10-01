import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Test harness that makes a host-side HTTP server reachable from sandboxes as
 * `cap-gateway:8080`, mirroring production: a forwarder container sits on both the
 * internal sandbox network (alias cap-gateway) and a normal bridge network, and
 * relays to the host. Uses the host Docker CLI (not the restricted socket proxy).
 */

/** Container name of the forwarder. Under gVisor the runner pins its address (RunnerConfig.capContainer). */
export const FORWARDER = 'agora-test-cap-forwarder';

export interface RecordedRequest {
    method: string;
    path: string;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}

export type Handler = (req: RecordedRequest) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

export async function startGatewayHarness(network: string, handler: Handler | http.RequestListener, raw = false) {
    const requests: RecordedRequest[] = [];
    const server = http.createServer(raw ? handler as http.RequestListener : (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c));
        req.on('end', async () => {
            const recorded = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
            requests.push(recorded);
            const { status, body } = await (handler as Handler)(recorded);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        });
    });
    await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
    const port = (server.address() as AddressInfo).port;
    const forwarder = startForwarder(network, port);

    return {
        port,
        requests,
        async stop() {
            forwarder.stop();
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
}

/** Expose a host port to sandboxes as cap-gateway:8080 (dual-homed forwarder container). */
export function startForwarder(network: string, hostPort: number) {
    docker(['rm', '-f', FORWARDER], true);
    docker([
        'run', '-d', '--name', FORWARDER,
        '--add-host=host.docker.internal:host-gateway',
        'alpine/socat:latest',
        'TCP-LISTEN:8080,fork,reuseaddr', `TCP:host.docker.internal:${hostPort}`,
    ]);
    docker(['network', 'connect', '--alias', 'cap-gateway', network, FORWARDER]);
    return { stop: () => docker(['rm', '-f', FORWARDER], true) };
}

function docker(args: string[], ignoreErrors = false) {
    try {
        execFileSync('docker', args, { stdio: 'pipe', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    } catch (err) {
        if (!ignoreErrors) throw err;
    }
}
