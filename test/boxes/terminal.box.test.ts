import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { API, api, createBox, docker, inBox, instance, psql, until, waitRunning, type Box, type Instance } from './harness';

/**
 * The terminal in a real box (docs/box-terminal.md): the owner's browser socket, the gateway, the
 * edge, the box's own agora-host and a real pseudo-terminal in a real container. The Agora side's
 * refusals are in test/integration/box-terminal.integration.test.ts; this proves the parts a fake
 * can't: a shell really starts in the box as the box's user, with the CLI's environment and no
 * token in it, behind the box's network allowlist, and goes away when the terminal does.
 */

const PASSWORD = 'box-admin-password-1';
let inst: Instance;
let box: Box;
let cookie = '';
let csrf = '';
const sockets: Socket[] = [];

async function cookieLogin() {
    const res = await fetch(`${API}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agora-Session': 'cookie' },
        body: JSON.stringify({ login: 'boxadmin', password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie();
    const value = (n: string) => set.find(c => c.startsWith(`${n}=`))!.split(';')[0].slice(n.length + 1);
    cookie = `agora_session=${value('agora_session')}; agora_csrf=${value('agora_csrf')}`;
    csrf = value('agora_csrf');
}

async function ticket(takeover = false) {
    const res = await api(`/boxes/${box.id}/terminal/ticket`, {
        method: 'POST', body: takeover ? { password: PASSWORD, takeover } : { password: PASSWORD },
        headers: { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: API, 'X-Agora-Session': 'cookie' },
    });
    return res;
}

/** A terminal, as the page opens it: ticket, socket, size, and a reader of what the shell prints. */
async function openTerminal() {
    const t = await ticket();
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const socket = io(API, {
        transports: ['websocket'], reconnection: false, autoConnect: false,
        extraHeaders: { cookie, origin: API }, auth: { type: 'shell', ticket: t.body.ticket },
    });
    sockets.push(socket);
    let out = '';
    let exit: { reason: string } | null = null;
    socket.on('shell:output', (d: ArrayBuffer) => { out += Buffer.from(d).toString('utf8'); });
    socket.on('shell:exit', (m: { reason: string }) => { exit = m; });
    await new Promise<void>((resolve, reject) => {
        socket.once('connect_error', e => reject(new Error(e.message)));
        socket.once('connect', () => resolve());
        socket.connect();
    });
    const ready = new Promise<void>(resolve => socket.once('shell:ready', () => resolve()));
    socket.emit('shell:start', { cols: 100, rows: 30 });
    await ready;
    return {
        socket,
        out: () => out,
        exit: () => exit,
        /**
         * Type a line and wait for the shell to finish it. The end marker is computed by the shell
         * (`$((40+2))`), so it appears only in the output, never in the echo of what was typed;
         * returns everything printed since, the echo of the line included.
         */
        async run(line: string, ms = 20_000): Promise<string> {
            const before = out.length;
            socket.emit('shell:input', `${line}; echo "__end$((40+2))__"\n`);
            await until(`output of ${line}`, async () => out.slice(before).includes('__end42__'), ms, 100);
            return out.slice(before);
        },
    };
}

/** Processes in the box whose command line matches (the image has no pgrep: read /proc; the bracket keeps grep from matching itself) */
const inBoxCount = async (pattern: string) => (await inBox(box.container,
    `for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < "$f" 2>/dev/null; echo; done | grep -c '${pattern}' || true`)).stdout.trim();
const shellsInBox = () => inBoxCount('[a]gora-pty');

beforeAll(async () => {
    inst = await instance();
    box = await createBox(inst, 'term-a');
    // Its agora-host has connected its terminal socket through the edge
    await until('the box to report the terminal protocol', async () =>
        (await psql(`SELECT h.shell_protocol FROM agent_boxes b JOIN agent_hosts h ON h.id = b.host_id WHERE b.id = '${box.id}'`)) === '1', 120_000, 2000);
    await cookieLogin();
}, 900_000);
afterEach(async () => {
    // One test's terminal must not be the next one's "already open"
    for (const s of sockets.splice(0)) s.disconnect();
    await until('no terminal left open', async () => (await psql(`SELECT count(*) FROM box_shell_sessions WHERE box_id = '${box.id}' AND state <> 'closed'`)) === '0', 60_000, 500);
});
afterAll(() => { for (const s of sockets.splice(0)) s.disconnect(); });

describe('a terminal in a real box', () => {
    it('starts a shell as the box user, in its home folder (not the agent worktree), with the CLI environment and no token', async () => {
        const status = await api(`/boxes/${box.id}/terminal`, { headers: { Cookie: cookie } });
        expect(status.body).toMatchObject({ supported: true, hostConnected: true, running: true, open: null });

        const t = await openTerminal();
        const who = await t.run('echo "uid=$(id -u) cwd=$(pwd) term=$TERM"');
        expect(who).toContain('uid=1000');
        // Neutral ground: the home folder, with a line naming the agent's workspace; the image's CLI directory first on PATH; no resize pipe
        expect(who).toContain('cwd=/home/agent ');
        expect(t.out()).toContain('The agent workspace is /home/agent/');
        expect((await t.run('echo "path=${PATH%%:*}"'))).toContain('path=/opt/agora/bin');
        // Only the terminal and bash's own descriptor 255: the resize pipe (fd 3) did not reach the shell
        await t.run('ls /proc/$$/fd > ~/.fds');
        expect(await t.run('echo fds=$(tr "\n" , < ~/.fds)')).toContain('fds=0,1,2,255,');
        expect(who).toContain('term=xterm-256color');
        // The CLI's own state directory: the agent's login is the one `claude` finds here
        expect(await t.run('echo state=$CLAUDE_CONFIG_DIR')).toContain('state=/home/agent/.agora/state/term-a');
        // Its commands are on the PATH by name
        expect(await t.run('command -v claude codex')).toMatch(/\/claude\s*\r?\n.*\/codex/s);
        // The environment is the CLI's allowlist plus the proxy: no host token, no bot token, no instance URL
        const env = await t.run('env | sort');
        expect(env).toContain('HTTPS_PROXY=http://edge:3128');
        for (const secret of [box.hostToken.slice(box.hostToken.indexOf('.') + 1), box.botToken.slice(box.botToken.indexOf('.') + 1)]) expect(env).not.toContain(secret);
        expect(env).not.toMatch(/AGORA_(HOST|BOT)_TOKEN|AGORA_INSTANCE_URL/);

        // Output and input are bytes: a resize reaches the terminal
        t.socket.emit('shell:resize', { cols: 132, rows: 43 });
        await new Promise(r => setTimeout(r, 300));
        expect(await t.run('stty size')).toContain('43 132');

        // It is the same box: the repo-free home folder, writable, kept
        expect(await t.run('echo from-$((6*7)) > ~/terminal-was-here; cat ~/terminal-was-here')).toContain('from-42');

        const closed = new Promise<void>(resolve => t.socket.once('shell:exit', () => resolve()));
        t.socket.emit('shell:close');
        await closed;
        expect(t.exit()).toEqual({ reason: 'closed_by_owner' });
        await until('the shell to be gone from the box', async () => (await shellsInBox()) === '0', 20_000, 500);
        expect((await inBox(box.container, 'cat ~/terminal-was-here')).stdout.trim()).toBe('from-42');
    }, 300_000);

    it('the box\'s network allowlist applies to it: an unlisted domain is refused by the edge, and there is no way around', async () => {
        const t = await openTerminal();
        const viaProxy = await t.run('curl -sS -m 10 https://example.org/ 2>&1 | head -2', 30_000);
        expect(viaProxy).toMatch(/403|CONNECT tunnel failed/);
        const direct = await t.run('curl -sS -m 6 --noproxy "*" https://1.1.1.1/ 2>&1 | head -2', 30_000);
        expect(direct).toMatch(/Could not|Failed to connect|timed out|Network is unreachable|Connection refused|Couldn.t connect/i);
        // The edge recorded a pending domain request for the owner, as it does for the agent
        expect(await psql(`SELECT count(*) FROM box_edge_requests WHERE box_id = '${box.id}' AND subject->>'host' = 'example.org'`)).toBe('1');
        t.socket.emit('shell:close');
    }, 300_000);

    it('a flood of output is slowed to the owner\'s limit and Ctrl-C still reaches the shell', async () => {
        const patched = await api(`/boxes/${box.id}`, { method: 'PATCH', auth: inst.admin, body: { terminalRateKbps: 64 } });
        expect(patched.status).toBe(200);
        const t = await openTerminal();
        const start = Date.now();
        t.socket.emit('shell:input', 'yes flood-flood-flood-flood\n');
        await new Promise(r => setTimeout(r, 4000));
        const seconds = (Date.now() - start) / 1000;
        // 64 KiB/s with a one-second burst, and a little for chunking
        expect(t.out().length).toBeLessThan(64 * 1024 * (seconds + 2));
        expect(t.out().length).toBeGreaterThan(32 * 1024);
        expect(t.exit()).toBeNull();
        t.socket.emit('shell:input', Buffer.from([3]));
        const after = await t.run('echo interrupted-$((6*7))', 30_000);
        expect(after).toContain('interrupted-42');
        t.socket.emit('shell:close');
        await api(`/boxes/${box.id}`, { method: 'PATCH', auth: inst.admin, body: { terminalRateKbps: 512 } });
    }, 300_000);

    it('the browser disappearing ends the shell in the box and everything it started', async () => {
        const t = await openTerminal();
        await t.run('sleep 600 & true');
        expect(await shellsInBox()).not.toBe('0');
        t.socket.disconnect();
        await until('the shell and its job to be gone', async () => (await shellsInBox()) === '0' && (await inBoxCount('[s]leep 600')) === '0', 30_000, 500);
        expect(await psql(`SELECT close_reason FROM box_shell_sessions WHERE box_id = '${box.id}' ORDER BY opened_at DESC LIMIT 1`)).toBe('browser_gone');
    }, 300_000);

    it('a second terminal asks first and takes the first over', async () => {
        const first = await openTerminal();
        expect((await ticket()).body).toMatchObject({ error: 'terminal_in_use' });
        const taken = await ticket(true);
        expect(taken.status).toBe(200);
        await until('the first to be told', async () => first.exit(), 10_000, 200);
        expect(first.exit()).toEqual({ reason: 'taken_over' });
        await until('the first shell to be gone', async () => (await shellsInBox()) === '0', 20_000, 500);
    }, 300_000);

    it('the box restarting ends the terminal, and a terminal can be opened again once its host is back', async () => {
        const t = await openTerminal();
        await docker('restart', box.container);
        await until('the terminal to end', async () => t.exit(), 60_000, 500);
        expect(t.exit()).toEqual({ reason: 'box_disconnected' });
        await waitRunning(inst, box.id);
        await until('the host to reconnect', async () => (await api(`/boxes/${box.id}/terminal`, { headers: { Cookie: cookie } })).body.hostConnected === true, 120_000, 2000);
        const again = await openTerminal();
        expect(await again.run('echo back-$((6*7))')).toContain('back-42');
        again.socket.emit('shell:close');
    }, 600_000);

    it('a rebuild (new tokens) ends it and the new generation connects its own host', async () => {
        const t = await openTerminal();
        const old = box;
        await api(`/boxes/${box.id}/actions`, { method: 'POST', auth: inst.admin, body: { action: 'rebuild' } });
        await until('the terminal to end', async () => t.exit(), 120_000, 1000);
        expect(['box_disconnected', 'box_changed']).toContain(t.exit()!.reason);
        await waitRunning(inst, old.id, old.generation + 1);
        await until('the new host to connect', async () => (await api(`/boxes/${old.id}/terminal`, { headers: { Cookie: cookie } })).body.hostConnected === true, 120_000, 2000);
    }, 900_000);

    it('every terminal is on the owner\'s record, and none of what was typed is', async () => {
        const sessions = await api(`/boxes/${box.id}/terminal/sessions`, { headers: { Cookie: cookie } });
        expect(sessions.body.sessions.length).toBeGreaterThanOrEqual(5);
        expect(sessions.body.sessions.every((s: any) => s.state === 'closed')).toBe(true);
        expect(JSON.stringify(sessions.body)).not.toContain('terminal-was-here');
        expect(await psql(`SELECT count(*) FROM audit_log WHERE action = 'box_terminal_open' AND target_id = '${box.id}'`)).not.toBe('0');
        const dump = await psql(`SELECT count(*) FROM (SELECT row_to_json(a)::text AS t FROM audit_log a UNION ALL SELECT row_to_json(m)::text FROM messages m UNION ALL SELECT row_to_json(s)::text FROM box_shell_sessions s) x WHERE t LIKE '%flood-flood%' OR t LIKE '%terminal-was-here%' OR t LIKE '%back-42%'`);
        expect(dump).toBe('0');
    }, 120_000);
});
