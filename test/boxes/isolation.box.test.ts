import { describe, it, expect, beforeAll } from 'vitest';
import {
    api, boxAction, connectFromBox, createBox, docker, httpFromBox, inBox, inBoxInput, inspectBox, instance, INSTANCE, psql,
    RUNTIME, serviceAddress, tcpFromBox, waitRunning, type Box, type Instance,
} from './harness';

/**
 * Agent A can't read or use agent B's tokens through mounts, the environment, the network or
 * the Agora API, and that holds after a restart and after a rebuild (docs/agent-boxes.md §14,
 * B1–B7, B9, B10). This is what closes #39 for boxed agents.
 */

let inst: Instance;
let a: Box;
let b: Box;

beforeAll(async () => {
    inst = await instance();
    a = await createBox(inst, 'iso-a');
    b = await createBox(inst, 'iso-b');
}, 600_000);

/** Every isolation check, run against the boxes as they are now. */
async function checkIsolation(label: string) {
    a = await inspectBox(a.id);
    b = await inspectBox(b.id);

    // B1: mounts. A sees its own home only; no Docker socket; B's volume isn't there.
    const mounts = await inBox(a.container, 'cat /proc/mounts; echo ---; ls -a /home; echo ---; ls -la /var/run/docker.sock 2>&1 || true');
    expect(mounts.stdout, `${label}: mounts`).not.toContain(b.id.toLowerCase());
    // (`operator` is the owner's own empty home, a tmpfs mount point the agent cannot enter)
    expect(mounts.stdout.split('---')[1].trim().split(/\s+/).filter(n => n !== '.' && n !== '..'), `${label}: /home`).toEqual(['agent', 'operator']);
    expect(mounts.stdout, `${label}: docker socket`).toMatch(/No such file|cannot access/);

    // B1/B2: B's token strings appear nowhere A can read: files, any process environment.
    for (const secret of [b.botToken, b.hostToken, b.relayToken]) {
        // The secret goes in on stdin into grep's pattern file, never onto a command line
        const secretPart = secret.slice(secret.indexOf('.') + 1);
        const files = await inBoxInput(a.container,
            'grep -rIlF -f /dev/stdin --exclude-dir=proc --exclude-dir=sys / 2>/dev/null | head -5', `${secretPart}\n`);
        expect(files.stdout.trim(), `${label}: files holding B's token`).toBe('');
        const procs = await inBoxInput(a.container,
            'exec 3<&0; for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do tr "\\0" "\\n" < "$f" 2>/dev/null; done | grep -cF -f /dev/fd/3 || true', `${secretPart}\n`);
        expect(procs.stdout.trim(), `${label}: processes holding B's token`).toBe('0');
    }
    // A's own environment carries only A's tokens; PID 1 (root) and the operator's processes are not the agent's to read
    const env = await inBox(a.container, 'env');
    expect(env.stdout).toContain(`AGORA_BOX_ID=${a.id}`);
    expect((await inBox(a.container, 'cat /proc/1/environ 2>&1')).stdout, `${label}: PID 1`).toMatch(/Permission denied/);

    // B3: network. B, the database, Redis, the API and the Docker host are unreachable directly.
    const targets: [string, number][] = [
        [b.address, 8080], [b.address, 22], [b.address, 3000],
        [await serviceAddress('postgres'), 5432], [await serviceAddress('redis'), 6379], [await serviceAddress('api'), 3000],
        ['postgres', 5432], ['redis', 6379], ['api', 3000], ['host.docker.internal', 2375],
        [a.address.replace(/\.\d+$/, '.1'), 22], [a.address.replace(/\.\d+$/, '.1'), 2375],
    ];
    for (const [host, port] of targets) {
        expect([`${label}: ${host}:${port}`, await tcpFromBox(a.container, host, port)]).not.toEqual([`${label}: ${host}:${port}`, 'open']);
    }
    // ...and the edge doesn't take it there either
    for (const authority of [`${b.address}:443`, `${await serviceAddress('postgres')}:443`, 'postgres:443', 'api:443']) {
        // 403 (refused), or 400 for a name that isn't a public host name at all
        expect([400, 403], `${label}: CONNECT ${authority}`).toContain((await connectFromBox(a.container, authority)).status);
    }

    // B4: B's real token is useless from A (REST through the edge) and outside any box.
    const asB = await httpFromBox(a.container, 'http://edge:8080/bots/@me', { auth: `Bot ${b.botToken}` });
    expect([label, asB.status, asB.body]).toEqual([label, 403, expect.stringContaining('token_not_for_this_box')]);
    const hostAsB = await httpFromBox(a.container, 'http://edge:8080/agent-hosts/@me/box-login', { auth: `AgentHost ${b.hostToken}` });
    expect([label, hostAsB.status]).toEqual([label, 403]);
    const outside = await api('/bots/@me', { auth: `Bot ${b.botToken}` });
    expect([label, outside.status, outside.body?.error]).toEqual([label, 403, 'box_token_outside_box']);
    const hostOutside = await api('/agent-hosts/@me/box-login', { auth: `AgentHost ${b.hostToken}` });
    expect([label, hostOutside.status, hostOutside.body?.error]).toEqual([label, 403, 'box_token_outside_box']);
    // ...also on the WebSocket handshake, from A through the edge and from outside
    const ws = await inBox(a.container, `cd /opt/agora/agora-mcp && node -e "
        const { io } = require('socket.io-client');
        const s = io('http://edge:8080', { transports: ['websocket'], auth: { type: 'bot', token: process.argv[1] }, reconnection: false, timeout: 8000 });
        s.on('connect_error', e => { console.log('refused:' + e.message); process.exit(0); });
        s.on('Ready', () => { console.log('ready'); process.exit(0); });
        setTimeout(() => { console.log('timeout'); process.exit(0); }, 10000);" '${b.botToken}'`);
    expect(ws.stdout.trim(), `${label}: websocket as B from A`).toMatch(/^refused:/);
    // A's own token works through its edge (the control)
    const asA = await httpFromBox(a.container, 'http://edge:8080/bots/@me', { auth: `Bot ${a.botToken}` });
    expect([label, asA.status]).toEqual([label, 200]);

    // B5: through the API, A's token can't reach B's box, bot or host records, and nothing returns token material.
    for (const path of [`/servers/${inst.serverId}/boxes`, `/boxes/${b.id}/login`, `/servers/${inst.serverId}/agent-hosts`, `/servers/${inst.serverId}/github-credential`]) {
        const r = await httpFromBox(a.container, `http://edge:8080${path}`, { auth: `Bot ${a.botToken}` });
        expect([label, path, r.status]).toEqual([label, path, 403]);
        expect(r.body).not.toContain(b.botToken.slice(b.botToken.indexOf('.') + 1));
    }
    const me = await httpFromBox(a.container, 'http://edge:8080/bots/@me', { auth: `Bot ${a.botToken}` });
    expect(me.body).not.toMatch(/bot_[0-9A-Z]{26}\.|ah_[0-9A-Z]{26}\./);
}

describe('box isolation (#39)', () => {
    it('B9: boxes run under gVisor, read-only, without capabilities', async () => {
        const kernel = await inBox(a.container, 'uname -r');
        if (RUNTIME === 'runsc') expect(kernel.stdout.trim()).toMatch(/gvisor/);
        const info = JSON.parse((await docker('inspect', a.container)).stdout)[0];
        expect(info.HostConfig.Runtime).toBe(RUNTIME);
        expect(info.HostConfig.ReadonlyRootfs).toBe(true);
        expect(info.HostConfig.CapDrop).toEqual(expect.arrayContaining(['ALL']));
        expect(info.HostConfig.Privileged).toBe(false);
        expect(info.HostConfig.Binds ?? []).toEqual([]);
        expect(info.Mounts.filter((m: any) => m.Type !== 'tmpfs').map((m: any) => m.Name)).toEqual([`${INSTANCE}-box-${a.id.toLowerCase()}-home`]);
        const id = await inBox(a.container, 'id -u; mount 2>&1 | head -1; mount -t tmpfs none /mnt 2>&1 || true');
        expect(id.stdout.split('\n')[0]).toBe('1000');
        expect(id.stdout).toMatch(/denied|not permitted|must be superuser/i);
    });

    it('B1–B5 hold for two fresh boxes', async () => { await checkIsolation('fresh'); }, 600_000);

    it('B1–B5 hold after both boxes restart', async () => {
        const before = [a.generation, b.generation];
        await docker('restart', a.container, b.container);
        await waitRunning(inst, a.id); await waitRunning(inst, b.id);
        await checkIsolation('restart');
        // A restart keeps the container, so the generation and tokens stay
        expect([a.generation, b.generation]).toEqual(before);
    }, 600_000);

    it('B6: a rebuild rotates both tokens; the old ones are dead everywhere', async () => {
        const old = { ...a };
        await boxAction(inst, a.id, 'rebuild');
        await waitRunning(inst, a.id, old.generation + 1);
        a = await inspectBox(a.id);
        expect(a.generation).toBeGreaterThan(old.generation);
        expect(a.botToken).not.toBe(old.botToken);
        expect(a.hostToken).not.toBe(old.hostToken);
        expect(a.relayToken).not.toBe(old.relayToken);
        // The old ones fail from inside the rebuilt box and from outside
        expect((await httpFromBox(a.container, 'http://edge:8080/bots/@me', { auth: `Bot ${old.botToken}` })).status).toBe(401);
        expect((await api('/bots/@me', { auth: `Bot ${old.botToken}` })).status).toBe(401);
        expect((await httpFromBox(a.container, 'http://edge:8080/agent-hosts/@me/box-login', { auth: `AgentHost ${old.hostToken}` })).status).toBe(401);
        await checkIsolation('rebuild');
    }, 600_000);

    it('B7: the edge allows only listed domains, refuses IPs and makes one card per domain', async () => {
        const unlisted = await connectFromBox(a.container, 'example.com:443');
        expect(unlisted.status).toBe(403);
        expect(unlisted.requestId).toMatch(/^[0-9A-Z]{26}$/);
        const again = await connectFromBox(a.container, 'example.com:443');
        expect(again.requestId).toBe(unlisted.requestId);
        expect(await psql(`SELECT kind || ':' || status || ':' || (subject->>'host') FROM box_edge_requests WHERE id = '${unlisted.requestId}'`)).toBe('domain:pending:example.com');
        expect((await connectFromBox(a.container, '1.1.1.1:443')).status).toBe(403);
        expect((await connectFromBox(a.container, '[2606:4700:4700::1111]:443')).status).toBe(403);
        expect((await connectFromBox(a.container, 'registry.npmjs.org:22')).status).toBe(403);
        // No route out without the edge
        expect(await tcpFromBox(a.container, '1.1.1.1', 443)).not.toBe('open');
        // After the owner allows it, the same CONNECT is let through (the dial itself may fail in CI; the edge mustn't refuse)
        const decided = await api(`/box-edge-requests/${unlisted.requestId}`, { method: 'POST', auth: inst.admin, body: { decision: 'allow' } });
        expect(decided.status).toBe(200);
        const allowed = await connectFromBox(a.container, 'example.com:443');
        expect(allowed.status).not.toBe(403);
    }, 300_000);

    it('B10: a boxd can only reach its own install\'s box names through its socket proxy', async () => {
        const probe = (path: string, method = 'GET') => docker('exec', `${INSTANCE}-boxd-1`, 'node', '-e',
            `fetch('http://box-socket-proxy:2375${path}', { method: '${method}' }).then(r => console.log(r.status)).catch(e => console.log('error'))`);
        const other = 'agora-other-box-01jabcdefghjkmnpqrstvwxyz0';
        expect((await probe(`/containers/${other}/json`)).stdout.trim()).toBe('403');
        expect((await probe(`/containers/${other}/start`, 'POST')).stdout.trim()).toBe('403');
        expect((await probe(`/containers/${INSTANCE}-postgres-1/json`)).stdout.trim()).toBe('403');
        expect((await probe(`/containers/${a.container}/exec`, 'POST')).stdout.trim()).toBe('403');
        expect((await probe(`/containers/${a.container}/json`)).stdout.trim()).toBe('200');
    });
});
