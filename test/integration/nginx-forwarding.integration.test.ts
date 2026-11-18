import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

/**
 * Runs the real agora-ui/nginx.conf (in the image agora-ui/Dockerfile pins) in front of a tiny
 * upstream that echoes the Host and X-Forwarded-Proto it receives, and checks what the API would
 * see. The box terminal refuses a page whose Origin does not match them (originSchemeMatches /
 * originAllowed), and nginx used to overwrite the scheme with its own plain-http $scheme and drop
 * the port from Host, so it never worked behind Caddy or `tailscale serve`.
 * Skipped when Docker is not available.
 */
const root = join(__dirname, '..', '..');
const image = /^FROM (nginx:\S+) AS runtime/m.exec(readFileSync(join(root, 'agora-ui', 'Dockerfile'), 'utf8'))?.[1];

function docker(...args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const dockerOk = (() => { try { docker('version', '--format', '{{.Server.Version}}'); return !!image; } catch { return false; } })();

const suffix = `${process.pid}-${Date.now()}`;
const net = `agora-nginxtest-${suffix}`;
const upstream = `agora-nginxtest-up-${suffix}`;
const proxy = `agora-nginxtest-proxy-${suffix}`;
let port = 0;
let tmp = '';

function get(path: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, headers, method: 'GET' }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => { let body: any = data; try { body = JSON.parse(data); } catch { /* keep text */ } resolve({ status: res.statusCode ?? 0, body }); });
        });
        req.on('error', reject);
        req.end();
    });
}

describe.skipIf(!dockerOk)('nginx forwards the scheme and host the browser used', () => {
    beforeAll(async () => {
        tmp = mkdtempSync(join(tmpdir(), 'agora-nginxtest-'));
        const upConf = join(tmp, 'up.conf');
        writeFileSync(upConf, `server {
    listen 3000;
    listen 3100;
    location / {
        default_type application/json;
        return 200 '{"proto":"$http_x_forwarded_proto","host":"$http_host","upgrade":"$http_upgrade"}';
    }
}
`);
        docker('network', 'create', net);
        docker('create', '--name', upstream, '--network', net, '--network-alias', 'api', '--network-alias', 'mcp', image!);
        docker('cp', upConf, `${upstream}:/etc/nginx/conf.d/default.conf`);
        docker('start', upstream);
        docker('create', '--name', proxy, '--network', net, '-p', '127.0.0.1::80', image!);
        docker('cp', join(root, 'agora-ui', 'nginx.conf'), `${proxy}:/etc/nginx/conf.d/default.conf`);
        docker('start', proxy);
        port = Number(/:(\d+)$/m.exec(docker('port', proxy, '80/tcp'))![1]);
        for (let i = 0; i < 50; i++) {
            try { const r = await get('/health', { host: 'x' }); if (r.status === 200) return; } catch { /* not up yet */ }
            await new Promise(r => setTimeout(r, 200));
        }
        throw new Error(`nginx test proxy did not come up: ${docker('logs', proxy)}`);
    }, 60000);

    afterAll(() => {
        for (const c of [proxy, upstream]) { try { docker('rm', '-f', c); } catch { /* already gone */ } }
        try { docker('network', 'rm', net); } catch { /* already gone */ }
        if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    // One path for each proxied location: the API regex, the admin regex, /mcp and /socket.io.
    const paths = ['/boxes/terminal-ticket', '/admin', '/mcp', '/socket.io/?EIO=4&transport=websocket'];

    it.each(paths)('passes X-Forwarded-Proto https from a proxy in front (%s)', async p => {
        const r = await get(p, { host: 'machine.tailnet.ts.net', 'x-forwarded-proto': 'https' });
        expect(r.body.proto).toBe('https');
        expect(r.body.host).toBe('machine.tailnet.ts.net');
    });

    it.each(paths)('falls back to the scheme nginx was reached on when no proxy set one (%s)', async p => {
        const r = await get(p, { host: 'localhost:8080' });
        expect(r.body.proto).toBe('http');
    });

    it('keeps a non-default port in Host (Caddy on 8443, the macOS install)', async () => {
        const r = await get('/boxes/terminal-ticket', { host: 'localhost:8443', 'x-forwarded-proto': 'https' });
        expect(r.body).toMatchObject({ proto: 'https', host: 'localhost:8443' });
    });

    it('ignores a forwarded scheme that is not http or https', async () => {
        const r = await get('/boxes/terminal-ticket', { host: 'localhost', 'x-forwarded-proto': 'javascript' });
        expect(r.body.proto).toBe('http');
    });

    it('still upgrades the Socket.IO WebSocket', async () => {
        const r = await get('/socket.io/?EIO=4', { host: 'localhost', connection: 'Upgrade', upgrade: 'websocket', 'x-forwarded-proto': 'https' });
        expect(r.body).toMatchObject({ proto: 'https', upgrade: 'websocket' });
    });
});
