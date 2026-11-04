import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Harness for the box suites (test/boxes, docs/agent-boxes.md §14). They run against a real
 * stack started by scripts/test-boxes.sh: the prod compose file under its own instance name,
 * with the box test image (fake CLIs). The harness is trusted: it uses the Docker CLI to look
 * inside boxes, which no box component can.
 */

const run = promisify(execFile);

export const API = process.env.BOXTEST_API ?? 'http://127.0.0.1:13000';
export const INSTANCE = process.env.BOXTEST_INSTANCE ?? 'agora-boxtest';
export const COMPOSE = (process.env.BOXTEST_COMPOSE ?? `docker compose -p ${INSTANCE} -f docker-compose.prod.yml --env-file .env.boxtest`).split(' ');
/** 'runsc' when the engine has gVisor; the suite still runs under runc, minus the kernel check. */
export const RUNTIME = process.env.BOXTEST_RUNTIME ?? 'runsc';

export interface Exec { code: number; stdout: string; stderr: string }

export async function sh(cmd: string, args: string[], timeout = 120_000): Promise<Exec> {
    try {
        const { stdout, stderr } = await run(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
        return { code: 0, stdout, stderr };
    } catch (err: any) {
        return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err) };
    }
}
export const docker = (...args: string[]) => sh('docker', args);
export const compose = (...args: string[]) => sh(COMPOSE[0], [...COMPOSE.slice(1), ...args], 300_000);
/** Run a command inside a container as its own user. */
export const inBox = (container: string, script: string, timeout = 60_000) => sh('docker', ['exec', container, 'sh', '-c', script], timeout);
/** Node one-liner inside a box (the image has Node); prints what the script prints. */
export const nodeInBox = (container: string, js: string, timeout = 60_000) => sh('docker', ['exec', container, 'node', '-e', js], timeout);

export async function psql(sql: string): Promise<string> {
    const r = await docker('exec', `${INSTANCE}-postgres-1`, 'psql', '-U', 'accord', '-d', 'agora', '-tAc', sql);
    if (r.code !== 0) throw new Error(`psql failed: ${r.stderr}`);
    return r.stdout.trim();
}

export async function api(path: string, init: { method?: string; body?: unknown; auth?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.auth) headers.Authorization = init.auth;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body };
}

export async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 180_000, everyMs = 2000): Promise<T> {
    const end = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < end) {
        try { const v = await fn(); if (v) return v; } catch (err) { last = err; }
        await new Promise(r => setTimeout(r, everyMs));
    }
    throw new Error(`Timed out waiting for ${what}${last ? `: ${last instanceof Error ? last.message : last}` : ''}`);
}

export interface Instance { admin: string; serverId: string; channelId: string }

/** First-run setup of the test instance (idempotent across suites in one stack). */
export async function instance(): Promise<Instance> {
    const status = await api('/instance/status');
    if (!status.body?.initialized) {
        const logs = await compose('logs', 'api');
        const token = /AGORA SETUP TOKEN[^]*?([a-f0-9]{64})/.exec(logs.stdout)?.[1];
        if (!token) throw new Error('no setup token in the api log');
        const setup = await api('/instance/setup', { method: 'POST', body: {
            setupToken: token, username: 'boxadmin', email: 'boxadmin@example.test', password: 'box-admin-password-1',
            instanceName: 'Box tests', registrationPolicy: 'open',
        } });
        if (setup.status !== 200 && setup.status !== 201) throw new Error(`setup: ${setup.status} ${JSON.stringify(setup.body)}`);
    }
    const login = await api('/auth/login', { method: 'POST', body: { login: 'boxadmin', password: 'box-admin-password-1' } });
    if (!login.body?.accessToken) throw new Error(`login: ${login.status}`);
    const admin = `Bearer ${login.body.accessToken}`;
    const serverId = (await api('/instance/status')).body.instanceServerId as string;
    const channels = await api(`/servers/${serverId}/channels`, { auth: admin });
    const general = (channels.body as any[]).find(c => c.name === 'general');
    return { admin, serverId, channelId: general.id };
}

export interface Box { id: string; name: string; container: string; botToken: string; hostToken: string; generation: number; address: string }

export const containerOf = (boxId: string) => `${INSTANCE}-box-${boxId.toLowerCase()}`;

/** What boxd put in the container (the harness may look; a box can't look at another's). */
export async function inspectBox(boxId: string): Promise<Box> {
    const container = containerOf(boxId);
    const r = await docker('inspect', container);
    if (r.code !== 0) throw new Error(`no container ${container}`);
    const info = JSON.parse(r.stdout)[0];
    const env = Object.fromEntries((info.Config.Env as string[]).map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
    const nets = Object.values(info.NetworkSettings.Networks) as any[];
    return {
        id: boxId, name: env.AGORA_BOX_PROFILE ? JSON.parse(env.AGORA_BOX_PROFILE).name : '', container,
        botToken: env.AGORA_BOT_TOKEN, hostToken: env.AGORA_HOST_TOKEN, generation: Number(env.AGORA_BOX_GENERATION),
        address: nets[0]?.IPAddress ?? '',
    };
}

/** Create a box through the owner API and wait until boxd runs it and its agora-host has checked in. */
export async function createBox(inst: Instance, name: string, adapter: 'claude' | 'codex' = 'claude'): Promise<Box> {
    const created = await api(`/servers/${inst.serverId}/boxes`, { method: 'POST', auth: inst.admin, body: { name, adapter, homeChannelId: inst.channelId } });
    if (created.status !== 201) throw new Error(`create box: ${created.status} ${JSON.stringify(created.body)}`);
    const id = created.body.box.id as string;
    await waitRunning(inst, id);
    return inspectBox(id);
}

export async function waitRunning(inst: Instance, boxId: string, minGeneration = 1): Promise<void> {
    await until(`box ${boxId} running`, async () => {
        const list = await api(`/servers/${inst.serverId}/boxes`, { auth: inst.admin });
        const box = list.body.boxes?.find((b: any) => b.id === boxId);
        if (box?.state === 'failed') throw new Error(`box failed: ${box.lastError}`);
        if (box?.state !== 'running' || box.generation < minGeneration) return false;
        // Its agora-host has reached Agora through the edge
        const seen = await psql(`SELECT h.last_seen_at > NOW() - INTERVAL '2 minutes' FROM agent_boxes b JOIN agent_hosts h ON h.id = b.host_id WHERE b.id = '${boxId}'`);
        return seen === 't';
    });
}

export async function boxAction(inst: Instance, boxId: string, action: string, confirm?: string) {
    const r = await api(`/boxes/${boxId}/actions`, { method: 'POST', auth: inst.admin, body: { action, ...(confirm ? { confirm } : {}) } });
    if (r.status !== 200 && r.status !== 202) throw new Error(`${action}: ${r.status} ${JSON.stringify(r.body)}`);
}

/** The IP of a compose service's container on the stack's default network. */
export async function serviceAddress(service: string): Promise<string> {
    const r = await docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', `${INSTANCE}-${service}-1`);
    return r.stdout.trim().split(/\s+/)[0];
}

/** Try a TCP connection from inside a box: 'open', 'refused', 'timeout' or 'error:<code>'. */
export async function tcpFromBox(container: string, host: string, port: number): Promise<string> {
    const r = await nodeInBox(container, `
        const s = require('net').connect({ host: ${JSON.stringify(host)}, port: ${port} });
        const done = v => { console.log(v); s.destroy(); process.exit(0); };
        s.setTimeout(3000, () => done('timeout'));
        s.on('connect', () => done('open'));
        s.on('error', e => done(e.code === 'ECONNREFUSED' ? 'refused' : 'error:' + e.code));`);
    return r.stdout.trim();
}

/** An HTTP request from inside a box (Node's http, optionally through the edge's forward proxy). */
export async function httpFromBox(container: string, url: string, opts: { auth?: string; proxy?: boolean } = {}): Promise<{ status: number; body: string }> {
    const r = await nodeInBox(container, `
        const u = new URL(${JSON.stringify(url)});
        const headers = ${JSON.stringify(opts.auth ? { Authorization: opts.auth } : {})};
        const req = ${opts.proxy ? `require('http').request({ host: 'edge', port: 3128, method: 'GET', path: u.href, headers: { ...headers, Host: u.host } }` : `require('http').request(u, { headers }`},
          res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { console.log(JSON.stringify({ status: res.statusCode, body: b.slice(0, 2000) })); }); });
        req.setTimeout(8000, () => { console.log(JSON.stringify({ status: 0, body: 'timeout' })); process.exit(0); });
        req.on('error', e => { console.log(JSON.stringify({ status: 0, body: e.code || String(e) })); });
        req.end();`);
    try { return JSON.parse(r.stdout.trim().split('\n').pop()!); } catch { return { status: -1, body: r.stdout + r.stderr }; }
}

/** CONNECT through the edge's forward proxy from inside a box; returns the proxy's status line. */
export async function connectFromBox(container: string, authority: string): Promise<{ status: number; requestId: string | null }> {
    const r = await nodeInBox(container, `
        const req = require('http').request({ host: 'edge', port: 3128, method: 'CONNECT', path: ${JSON.stringify(authority)} });
        req.setTimeout(8000, () => { console.log(JSON.stringify({ status: 0, requestId: null })); process.exit(0); });
        req.on('connect', (res, socket) => { console.log(JSON.stringify({ status: res.statusCode, requestId: res.headers['x-agora-edge-request'] || null })); socket.destroy(); process.exit(0); });
        req.on('response', res => { console.log(JSON.stringify({ status: res.statusCode, requestId: res.headers['x-agora-edge-request'] || null })); process.exit(0); });
        req.on('error', e => { console.log(JSON.stringify({ status: 0, requestId: null })); });
        req.end();`);
    try { return JSON.parse(r.stdout.trim().split('\n').pop()!); } catch { return { status: -1, requestId: null }; }
}
