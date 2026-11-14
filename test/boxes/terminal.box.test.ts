import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API, OPERATOR, api, createBox, docker, inBox, inBoxInput, inspectBox, instance, nodeInBox, psql, until, waitRunning, type Box, type Instance } from './harness';

/**
 * The terminal in a real box (docs/box-terminal.md): the owner's browser socket, the gateway, the
 * edge, the box's own agora-host and a real pseudo-terminal in a real container. The Agora side's
 * refusals are in test/integration/box-terminal.integration.test.ts; this proves the parts a fake
 * can't: a shell really starts in the box as the OPERATOR (a user of its own, uid 1001, not the
 * agent's), with no token in its environment, behind the box's network allowlist, and goes away when
 * the terminal does; and that the agent (uid 1000) cannot reach the operator's processes, terminal or
 * credential, while `as-agent` runs things as the agent and never as the operator.
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
    // (ten ticket requests a minute is the server's limit; the suite asks for more than that)
    for (let attempt = 0; ; attempt++) {
        const res = await ticketOnce(takeover);
        if (res.status !== 429 || attempt >= 12) return res;
        await new Promise(r => setTimeout(r, 5000));
    }
}
async function ticketOnce(takeover: boolean) {
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
    const sides: string[] = [];
    socket.on('shell:output', (d: ArrayBuffer) => { out += Buffer.from(d).toString('utf8'); });
    socket.on('shell:exit', (m: { reason: string }) => { exit = m; });
    socket.on('shell:side', (m: { side: string }) => { sides.push(m.side); });
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
        sides,
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
        (await psql(`SELECT h.shell_protocol FROM agent_boxes b JOIN agent_hosts h ON h.id = b.host_id WHERE b.id = '${box.id}'`)) === '2', 120_000, 2000);
    await cookieLogin();
}, 900_000);
afterEach(async () => {
    // One test's terminal must not be the next one's "already open"
    for (const s of sockets.splice(0)) s.disconnect();
    await until('no terminal left open', async () => (await psql(`SELECT count(*) FROM box_shell_sessions WHERE box_id = '${box.id}' AND state <> 'closed'`)) === '0', 60_000, 500);
});
afterAll(() => { for (const s of sockets.splice(0)) s.disconnect(); });

describe('a terminal in a real box', () => {
    it('starts a shell as the operator (not the agent), in the operator\'s own home, with a fixed PATH and no token', async () => {
        const status = await api(`/boxes/${box.id}/terminal`, { headers: { Cookie: cookie } });
        expect(status.body).toMatchObject({ supported: true, hostConnected: true, running: true, open: null });

        const t = await openTerminal();
        const who = await t.run('echo "uid=$(id -u) cwd=$(pwd) term=$TERM"');
        expect(who).toContain('uid=1001');
        // The operator's own home (not the agent's), and the banner says what this account is and how to act as the agent
        expect(who).toContain('cwd=/home/operator ');
        expect(t.out()).toContain('your own account');
        expect(t.out()).toContain('as-agent <command>');
        expect(t.out()).toContain("on the agent's side of the wall");
        // A fixed PATH of root-owned directories: the image's CLI directory first, nothing under a home or /tmp, no `.`
        expect((await t.run('echo "path=$PATH"'))).toContain('path=/opt/agora/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
        // Only the terminal and bash's own descriptor 255: the resize pipe (fd 3) did not reach the shell
        await t.run('ls /proc/$$/fd > ~/.fds');
        expect(await t.run('echo fds=$(tr "\n" , < ~/.fds)')).toContain('fds=0,1,2,255,');
        expect(who).toContain('term=xterm-256color');
        // The agent's login is the agent's: the operator's shell has no state directory of the agent's
        expect(await t.run('echo "state=[$CLAUDE_CONFIG_DIR]"')).toContain('state=[]');
        // The image's commands are on the PATH by name
        expect(await t.run('command -v claude codex as-agent')).toMatch(/\/claude\s*\r?\n.*\/codex\s*\r?\n.*\/as-agent/s);
        // The environment is fixed values plus the proxy: no host token, no bot token, no relay credential, no instance URL, no AGORA_ at all
        const env = await t.run('env | sort');
        expect(env).toContain('HTTPS_PROXY=http://edge:3128');
        for (const token of [box.hostToken, box.botToken, box.relayToken]) expect(env).not.toContain(token.slice(token.indexOf('.') + 1));
        expect(env).not.toMatch(/AGORA_|_API_KEY|CLAUDE_CONFIG_DIR/);
        // git reads the image's root-owned file only: hooks and fsmonitor off, no safe.directory
        const gitconf = await t.run('git --no-pager config --global --list --show-origin');
        expect(gitconf).toContain('/opt/agora/operator.gitconfig');
        expect(gitconf).toContain('core.hookspath=/dev/null');
        expect(gitconf).toContain('core.fsmonitor=false');
        expect(gitconf).not.toContain('safe.directory');

        // Output and input are bytes: a resize reaches the terminal
        t.socket.emit('shell:resize', { cols: 132, rows: 43 });
        await new Promise(r => setTimeout(r, 300));
        expect(await t.run('stty size')).toContain('43 132');

        // Its home is its own and writable
        expect(await t.run('echo from-$((6*7)) > ~/terminal-was-here; cat ~/terminal-was-here')).toContain('from-42');

        const closed = new Promise<void>(resolve => t.socket.once('shell:exit', () => resolve()));
        t.socket.emit('shell:close');
        await closed;
        expect(t.exit()).toEqual({ reason: 'closed_by_owner' });
        await until('the shell to be gone from the box', async () => (await shellsInBox()) === '0', 20_000, 500);
        // (kept in the operator's home until the box restarts; the agent cannot read it)
        expect((await inBox(box.container, 'cat /home/operator/terminal-was-here', 60_000, OPERATOR)).stdout.trim()).toBe('from-42');
        expect((await inBox(box.container, 'cat /home/operator/terminal-was-here 2>&1')).stdout).toContain('Permission denied');
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

// ─── The operator is out of the agent's reach (docs/box-terminal.md, "Separate operator user") ───

/** [pid, uid, ppid, command line] of every process in the box, read as the operator. */
async function processes() {
    const r = await inBox(box.container, `for d in /proc/[0-9]*; do p=\${d#/proc/}; u=$(awk '/^Uid:/{print $2}' $d/status 2>/dev/null); pp=$(awk '/^PPid:/{print $2}' $d/status 2>/dev/null); echo "$p|$u|$pp|$(tr '\\0' ' ' < $d/cmdline 2>/dev/null)"; done`, 60_000, OPERATOR);
    return r.stdout.trim().split('\n').map(l => { const [pid, uid, ppid, ...rest] = l.split('|'); return { pid: Number(pid), uid: Number(uid), ppid: Number(ppid), cmd: rest.join('|').trim() }; });
}
const status = async (pid: number) => {
    const text = (await inBox(box.container, `cat /proc/${pid}/status`, 30_000, OPERATOR)).stdout;
    const hex = (k: string) => BigInt('0x' + (new RegExp(`^${k}:\\s*([0-9a-f]+)`, 'm').exec(text)?.[1] ?? 'ffffffffffffffff'));
    return { inh: hex('CapInh'), prm: hex('CapPrm'), eff: hex('CapEff'), bnd: hex('CapBnd'), amb: hex('CapAmb'), nnp: /^NoNewPrivs:\s*1/m.test(text) };
};

describe('the operator is out of the agent\'s reach', () => {
    it('no process of either user holds a capability, can gain one, or is without no-new-privileges; the init keeps CAP_KILL alone', async () => {
        const t = await openTerminal();
        const procs = await processes();
        // The init (root) is PID 1 and holds only CAP_KILL (bit 5)
        const init = await status(1);
        expect({ prm: init.prm, eff: init.eff, bnd: init.bnd, inh: init.inh, amb: init.amb, nnp: init.nnp }).toEqual({ prm: 1n << 5n, eff: 1n << 5n, bnd: 1n << 5n, inh: 0n, amb: 0n, nnp: true });
        // The processes the init started and their descendants (not a `docker exec`, which is the harness's own)
        const kids = new Set<number>([1]);
        for (let grew = true; grew;) { grew = false; for (const p of procs) if (!kids.has(p.pid) && kids.has(p.ppid)) { kids.add(p.pid); grew = true; } }
        const mine = procs.filter(p => (p.uid === 1000 || p.uid === 1001) && kids.has(p.pid) && !/\/proc\/\[0-9\]/.test(p.cmd));
        // The agent's tree (agora-box-start, agora-host, as-agent-server) and the operator's (relay, agora-pty, bash) are all there
        for (const needle of ['agora-host/dist/index.js --config', 'box-relay', 'as-agent-server', 'agora-pty', 'rcfile']) expect(mine.some(p => new RegExp(needle).test(p.cmd)), needle).toBe(true);
        for (const p of mine) {
            const s = await status(p.pid).catch(() => null);
            if (!s) continue;   // gone since the listing
            expect({ pid: p.pid, cmd: p.cmd.slice(0, 60), eff: s.eff, prm: s.prm, inh: s.inh, amb: s.amb, nnp: s.nnp, bnd: s.bnd })
                .toEqual({ pid: p.pid, cmd: p.cmd.slice(0, 60), eff: 0n, prm: 0n, inh: 0n, amb: 0n, nnp: true, bnd: 0n });
        }
        // Each daemon is the user it should be
        const uidOf = (re: RegExp) => mine.find(p => re.test(p.cmd))?.uid;
        expect(uidOf(/agora-host\/dist\/index\.js --config/)).toBe(1000);
        expect(uidOf(/as-agent-server/)).toBe(1000);
        expect(uidOf(/box-relay/)).toBe(1001);
        expect(uidOf(/rcfile/)).toBe(1001);
        t.socket.emit('shell:close');
    }, 300_000);

    it('the agent cannot read, trace, signal or type into the operator\'s relay and shell, read its terminal or home, or find the relay credential', async () => {
        const t = await openTerminal();
        const procs = await processes();
        const relay = procs.find(p => p.uid === 1001 && /box-relay/.test(p.cmd))!;
        const shell = procs.find(p => p.uid === 1001 && /^\/bin\/bash .*--rcfile/.test(p.cmd))!;
        expect(relay && shell).toBeTruthy();
        const pty = (await inBox(box.container, `readlink /proc/${shell.pid}/fd/0`, 30_000, OPERATOR)).stdout.trim();
        expect(pty).toMatch(/^\/dev\/pts\/\d+$/);
        const secret = box.relayToken.slice(box.relayToken.indexOf('.') + 1);
        const probe = readFileSync(join(__dirname, 'operator-probe.py'), 'utf8');
        // As the agent
        // (the secret goes in on stdin with the program, never onto a command line the probe would then find)
        const res = await inBoxInput(box.container, `python3 - ${relay.pid} ${shell.pid} ${pty}`, `import os
os.environ['SECRET'] = '${secret}'
${probe}`, 180_000);
        expect(res.code, res.stderr).toBe(0);
        const results = JSON.parse(res.stdout.trim().split('\n').pop()!) as Record<string, string>;
        const entries = Object.entries(results);
        expect(entries.length).toBeGreaterThan(40);
        // Every attempt is refused, except the two command lines (readable by design: no secret in them)
        const allowed = entries.filter(([k, v]) => !k.startsWith('(readable by design)') && !v.startsWith('denied'));
        expect(allowed, JSON.stringify(allowed)).toEqual([]);
        for (const [k, v] of entries) if (k.startsWith('(readable by design)')) {
            expect(v).not.toContain(secret);
            expect(v).not.toMatch(/ar_|ah_|bot_/);
        }
        // Nothing the agent did disturbed the shell or the relay
        expect(await t.run('echo still-$((6*7))')).toContain('still-42');
        t.socket.emit('shell:close');
    }, 300_000);

    it('the host token cannot register as a terminal endpoint: refused by the real server, through the box\'s own edge', async () => {
        const js = (auth: object) => `
            const { io } = require('/opt/agora/agora-host/node_modules/socket.io-client');
            const s = io('http://edge:8080', { transports: ['websocket'], reconnection: false, auth: ${JSON.stringify(auth)} });
            s.on('connect', () => { console.log('connected'); process.exit(0); });
            s.on('connect_error', e => { console.log('refused:' + e.message); process.exit(0); });
            setTimeout(() => { console.log('timeout'); process.exit(0); }, 15000);`;
        const as = async (auth: object) => (await nodeInBox(box.container, js(auth), 60_000)).stdout.trim();
        // The host token as a relay credential, and the old host handshake: neither registers
        expect(await as({ type: 'relay', token: box.hostToken, shellProtocol: 2 })).toBe('refused:Malformed relay token');
        expect(await as({ type: 'host', token: box.hostToken, shellProtocol: 2 })).toMatch(/^refused:/);
        expect(await as({ type: 'relay', token: box.hostToken.replace(/^ah_/, 'ar_'), shellProtocol: 2 })).toBe('refused:Invalid relay token');
        // And the real relay is still the box's terminal endpoint
        expect(await psql(`SELECT count(*) FROM audit_log WHERE action = 'box_host_conflict' AND target_id = '${box.id}'`)).toBe('0');
        const t = await openTerminal();
        expect(await t.run('echo registered-$((6*7))')).toContain('registered-42');
        t.socket.emit('shell:close');
    }, 300_000);

    it('the operator cannot read the agent\'s files or the host token either', async () => {
        const t = await openTerminal();
        const out = await t.run('ls /home/agent 2>&1; cat /run/agora/host.json 2>&1; cat /proc/1/environ 2>&1 | head -c 50; ls /home/agent/.agora 2>&1');
        expect((out.match(/Permission denied/g) ?? []).length).toBeGreaterThanOrEqual(3);
        expect(out).not.toContain(box.hostToken.slice(box.hostToken.indexOf('.') + 1));
        t.socket.emit('shell:close');
    }, 300_000);

    it('as-agent runs as the agent: uid 1000, the agent\'s login and workspace; interactive, with the terminal\'s size and Ctrl-C', async () => {
        const t = await openTerminal();
        const out = await t.run('as-agent id -u; as-agent pwd; as-agent sh -c "echo \\$CLAUDE_CONFIG_DIR; stty size; exit 7"; echo "status=$?"');
        expect(out).toMatch(/\r?\n1000\r?\n/);
        expect(out).toContain('/home/agent/scratch');
        expect(out).toContain('/home/agent/.agora/state/term-a');
        expect(out).toContain('30 100');
        expect(out).toContain('status=7');
        // Said once, where it matters: this is the agent's side
        expect(out).toContain('AGENT SIDE');
        expect(out).toContain('~ and .');
        // Ctrl-C reaches the job on the agent's side
        t.socket.emit('shell:input', 'as-agent sleep 600\n');
        await until('the job to run as the agent', async () => (await inBoxCount('[s]leep 600')) !== '0', 30_000, 300);
        t.socket.emit('shell:input', Buffer.from([3]));
        await until('the job to stop', async () => (await inBoxCount('[s]leep 600')) === '0', 30_000, 300);
        expect(await t.run('echo back-$((6*7))')).toContain('back-42');
        // No terminal at all: stdin, stdout, stderr and the exit status pass through
        const piped = await t.run('echo piped | as-agent sh -c "cat; printf err-%s \$((6*7)) >&2; exit 3" 2>/dev/null; echo "status=$?"');
        expect(piped).toContain('piped');
        expect(piped).not.toContain('err-42');
        expect(piped).toContain('status=3');
        t.socket.emit('shell:close');
    }, 300_000);

    it('a hook the agent planted runs only as the agent: git refuses the repository for the operator, and as-agent runs it as uid 1000', async () => {
        // The agent plants a repository with a hook and an fsmonitor command (somewhere the operator can look)
        // (/tmp does not run programs: the hooks live in the agent's home, where the agent's own scripts do)
        const plant = await inBox(box.container, `set -e; rm -rf /tmp/planted /tmp/planted-marker ~/planted-hooks; git init -q /tmp/planted; mkdir -p ~/planted-hooks; cd /tmp/planted
            printf '#!/bin/sh\\necho "hook uid=$(id -u)" >> /tmp/planted-marker\\n' > ~/planted-hooks/pre-commit; chmod +x ~/planted-hooks/pre-commit
            printf '#!/bin/sh\\necho "fsmonitor uid=$(id -u)" >> /tmp/planted-marker\\n' > ~/planted-hooks/fsm.sh; chmod +x ~/planted-hooks/fsm.sh
            git config core.hooksPath ~/planted-hooks; git config core.fsmonitor ~/planted-hooks/fsm.sh; chmod -R a+rX /tmp/planted; echo planted`);
        expect(plant.stdout).toContain('planted');
        const marker = async () => (await inBox(box.container, 'cat /tmp/planted-marker 2>/dev/null || true')).stdout;
        const t = await openTerminal();
        // The operator's plain git: refused (dubious ownership), nothing runs
        const refused = await t.run('git -C /tmp/planted status 2>&1; git -C /tmp/planted -c user.name=x -c user.email=x@x commit --allow-empty -m m 2>&1; echo "end"');
        expect(refused).toContain('dubious ownership');
        expect(await marker()).toBe('');
        // The same commands as the agent: its own hook and fsmonitor run, as uid 1000
        const asAgent = await t.run('as-agent git -C /tmp/planted -c user.name=x -c user.email=x@x commit --allow-empty -m m 2>&1; as-agent git -C /tmp/planted status >/dev/null 2>&1; echo "end"');
        expect(asAgent).not.toContain('dubious ownership');
        const ran = await marker();
        expect(ran).toContain('hook uid=1000');
        expect(ran).toContain('fsmonitor uid=1000');
        expect(ran).not.toContain('uid=1001');
        t.socket.emit('shell:close');
    }, 300_000);

    it('as-agent refuses anyone but the operator: the agent asking for itself is turned away by the kernel\'s peer credentials', async () => {
        const res = await inBoxInput(box.container, 'python3 -', `
import socket, struct, json
s = socket.socket(socket.AF_UNIX); s.connect('/run/as-agent/server.sock')
r = json.dumps({'argv': ['id', '-u'], 'tty': False}).encode()
s.sendall(b'Q' + struct.pack('>I', len(r)) + r)
print(s.recv(100))`, 60_000);
        expect(res.stdout).toContain('forbidden');
    }, 120_000);
});

// ─── Second security review (docs/box-terminal.md): the root init, the side indicator, a hostile agent side ───

/** Kill processes by command line, as the user given (the image has no pkill). */
const killMatching = (pattern: string) => `for f in /proc/[0-9]*/cmdline; do p=\${f#/proc/}; p=\${p%/cmdline}; if tr '\\0' ' ' < $f 2>/dev/null | grep -q '${pattern.replace(/^(.)/, '[$1]')}'; then kill -9 $p; fi; done`;
const startedAt = async () => JSON.parse((await docker('inspect', box.container)).stdout)[0].State.StartedAt as string;
const asRoot = (script: string, timeout = 60_000) => inBox(box.container, script, timeout, '0');

/** Every process with its ids, capability sets and no-new-privileges, read as root: `pid|uid|ppid|inh|prm|eff|bnd|amb|nnp|cmd`. */
async function table() {
    const r = await asRoot(`for d in /proc/[0-9]*; do p=\${d#/proc/}; awk -v p=$p 'BEGIN{OFS="|"} /^Uid:/{u=$2} /^PPid:/{pp=$2} /^CapInh:/{i=$2} /^CapPrm:/{pr=$2} /^CapEff:/{e=$2} /^CapBnd:/{b=$2} /^CapAmb:/{a=$2} /^NoNewPrivs:/{n=$2} END{printf "%s|%s|%s|%s|%s|%s|%s|%s|%s|", p,u,pp,i,pr,e,b,a,n}' $d/status 2>/dev/null; tr '\\0' ' ' < $d/cmdline 2>/dev/null; echo; done`);
    return r.stdout.trim().split('\n').filter(Boolean).map(l => {
        const [pid, uid, ppid, inh, prm, eff, bnd, amb, nnp, ...cmd] = l.split('|');
        return { pid: Number(pid), uid: Number(uid), ppid: Number(ppid), inh, prm, eff, bnd, amb, nnp, cmd: cmd.join('|').trim() };
    });
}
const ZERO = '0000000000000000';

describe('the root init trusts nothing the agent can write', () => {
    beforeAll(async () => { box = await inspectBox(box.id); await cookieLogin(); }, 120_000);

    it('planted interpreters, python startup files and shadowed commands never run as root or the operator, across a forced restart; PID 1 keeps CAP_KILL only, the children none, the credential stays out of reach, the terminal works', async () => {
        const secret = box.relayToken.slice(box.relayToken.indexOf('.') + 1);
        // As the agent: everything the agent can plant, world-readable, with its home made traversable
        const plant = await inBoxInput(box.container, 'python3 -', `
import os, sys
home = os.path.expanduser('~')
def w(path, text, mode=0o755):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'w').write(text)
    os.chmod(path, mode)
for d, tag in (('.local/bin', 'local'), ('.npm-global/bin', 'npm')):
    for name, real in (('python3', '/usr/bin/python3'), ('python', '/usr/bin/python3'), ('node', '/usr/local/bin/node'), ('env', '/usr/bin/env')):
        w('%s/%s/%s' % (home, d, name), '#!/bin/sh\\n/usr/bin/id -u >> /tmp/m-%s-%s 2>/dev/null\\nexec %s "$@"\\n' % (name, tag, real))
mark = lambda tag: "import os; open('/tmp/m-%s', 'a').write(str(os.getuid()) + chr(10))\\n" % tag
for minor in range(8, 16):
    sp = '%s/.local/lib/python3.%d/site-packages' % (home, minor)
    w(sp + '/usercustomize.py', mark('usercustomize'), 0o644)
    w(sp + '/evil.pth', mark('pth').replace('import os; ', 'import os; ', 1), 0o644)
for d in (home, home + '/scratch', home + '/work', home + '/.agora'):
    w(d + '/sitecustomize.py', mark('sitecustomize'), 0o644)
w(home + '/usercustomize.py', mark('homeusercustomize'), 0o644)
os.chmod(home, 0o711)
# the dirs agora-box-start made are 0700 (umask 077): the agent opens up every directory it planted in
for base, dirs, _files in os.walk(home):
    dirs[:] = [d for d in dirs if d in ('.local', '.npm-global', 'bin', 'lib', 'site-packages', 'scratch', 'work', '.agora') or d.startswith('python3')]
    for d in dirs:
        try: os.chmod(os.path.join(base, d), 0o755)
        except OSError: pass
print('planted')`, 60_000);
        expect(plant.stdout).toContain('planted');
        // Sanity: the plants do work for the agent's own python, so absence below means something
        expect((await inBox(box.container, 'rm -f /tmp/m-usercustomize; python3 -c pass; cat /tmp/m-usercustomize')).stdout.trim()).toBe('1000');
        await inBox(box.container, 'rm -f /tmp/m-*');

        // The agent forces a restart the way it can: it ends its own agora-host; Docker restarts the box on the same volume
        const started = await startedAt();
        await inBox(box.container, killMatching('agora-host/dist/index.js --config'));
        await until('the container to restart', async () => (await startedAt()) !== started, 120_000, 1000);
        await waitRunning(inst, box.id);
        await until('the terminal relay to reconnect', async () => (await api(`/boxes/${box.id}/terminal`, { headers: { Cookie: cookie } })).body.hostConnected === true, 120_000, 2000);
        // The home was made traversable before the restart; the init ran with it that way (agora-box-start resets it only later)

        // Whatever ran, ran as the agent. Nothing ran as root (0) or as the operator (1001)
        // (the markers are mode 0600 files of whoever ran the plant; root holds no capability, so it is the agent who reads them: a file it cannot read
        // is a file someone else made, and is reported as such)
        const markers = (await inBox(box.container, 'for f in /tmp/m-*; do [ -e "$f" ] && echo "$f $(cat $f 2>/dev/null | sort -u | tr "\n" " ")"; done; true')).stdout.trim().split('\n').filter(Boolean);
        for (const line of markers) expect(line, line).toMatch(/ 1000 ?$/);
        expect(markers.some(l => l.startsWith('/tmp/m-usercustomize') || l.includes('-npm') || l.includes('-local')), 'the agent\'s own processes still use its plants (it is the agent\'s PATH)').toBe(true);

        // PID 1: the init, started as the absolute interpreter in isolated mode, holding CAP_KILL alone
        const procs = await table();
        const init = procs.find(p => p.pid === 1)!;
        expect(init.cmd).toMatch(/^\/usr\/bin\/python3 -I \/opt\/agora\/agora-box-init --stage2 \d+$/);
        expect({ uid: init.uid, inh: init.inh, prm: init.prm, eff: init.eff, bnd: init.bnd, amb: init.amb, nnp: init.nnp })
            .toEqual({ uid: 0, inh: ZERO, prm: '0000000000000020', eff: '0000000000000020', bnd: '0000000000000020', amb: ZERO, nnp: '1' });
        // Its children: no capability at all
        for (const p of procs.filter(q => (q.uid === 1000 || q.uid === 1001) && /agora-box-start|agora-host|agora-relay-supervisor|box-relay|as-agent-server/.test(q.cmd))) {
            expect({ cmd: p.cmd.slice(0, 50), inh: p.inh, prm: p.prm, eff: p.eff, bnd: p.bnd, amb: p.amb, nnp: p.nnp }).toEqual({ cmd: p.cmd.slice(0, 50), inh: ZERO, prm: ZERO, eff: ZERO, bnd: ZERO, amb: ZERO, nnp: '1' });
        }
        expect(procs.some(p => p.uid === 1001 && /agora-relay-supervisor/.test(p.cmd))).toBe(true);
        expect(procs.some(p => p.uid === 1001 && /box-relay --token-fd/.test(p.cmd))).toBe(true);

        // The credential: gone from PID 1's environment (root can read that file), and from the supervisor's and relay's
        // (PID 1 is root's own process: root can read its environment; every other process's environment is read by its own user)
        const environ = (await asRoot('cat /proc/1/environ > /tmp/.pid1env && echo readable; tr "\\0" "\\n" < /tmp/.pid1env; rm -f /tmp/.pid1env')).stdout;
        expect(environ.trim()).toBe('readable');
        for (const p of procs.filter(q => q.pid !== 1 && (q.uid === 1000 || q.uid === 1001))) {
            const read = await inBox(box.container, `cat /proc/${p.pid}/environ > /dev/null 2>&1 && tr "\\0" "\\n" < /proc/${p.pid}/environ | sed 's/^/E /'; true`, 60_000, String(p.uid));
            expect(read.stdout, p.cmd.slice(0, 40)).not.toContain('AGORA_RELAY_TOKEN');
            expect(read.stdout, p.cmd.slice(0, 40)).not.toContain(secret);
        }
        // The supervisor's and the relay's environments were readable (it is the operator's own) and fixed
        const relayProc = procs.find(q => q.uid === 1001 && /box-relay --token-fd/.test(q.cmd))!;
        const relayEnv = (await inBox(box.container, `tr "\\0" "\\n" < /proc/${relayProc.pid}/environ`, 60_000, OPERATOR)).stdout;
        expect(relayEnv).toContain('PATH=/opt/agora/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
        expect(relayEnv).not.toMatch(/^(NODE_OPTIONS|NODE_PATH|PYTHON\w*|LD_\w+|AGORA_HOST_TOKEN|AGORA_BOT_TOKEN)=/m);
        // As the agent: nothing readable in /proc, in its home, its run directory or /tmp holds it
        const hunt = await inBoxInput(box.container, 'python3 -', `
import os
secret = '${secret}'.encode()
found = []
def look(path):
    try:
        if secret in open(path, 'rb').read(1 << 22): found.append(path)
    except OSError:
        pass
# (this probe was itself started by the harness's docker exec, which gives its processes the container's configured environment: it and
# its parents are not the agent's, and are left out)
mine = set()
pid = os.getpid()
while pid > 1:
    mine.add(str(pid))
    try:
        pid = int(open('/proc/%d/stat' % pid).read().rsplit(')', 1)[1].split()[1])
    except (OSError, ValueError, IndexError):
        break
for pid in filter(str.isdigit, os.listdir('/proc')):
    if pid in mine: continue
    for f in ('environ', 'cmdline', 'maps'):
        look('/proc/%s/%s' % (pid, f))
for root in ('/home/agent', '/run', '/tmp', '/etc', '/opt'):
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d != 'node_modules']
        for f in files: look(os.path.join(dirpath, f))
print('found=%s' % found)`, 180_000);
        expect(hunt.stdout.trim()).toBe('found=[]');

        // And the terminal works after all of it
        const t = await openTerminal();
        await until('the side to be reported', async () => t.sides.length > 0, 15_000, 200);
        expect(t.sides[0]).toBe('operator');
        expect(await t.run('echo id=$(id -u)')).toContain('id=1001');
        t.socket.emit('shell:close');
        await inBox(box.container, 'chmod 700 ~');
    }, 900_000);

    it('/tmp does not run programs (noexec), as the spec says, and is the agent\'s scratch otherwise', async () => {
        const r = await inBox(box.container, `grep ' /tmp ' /proc/mounts; printf '#!/bin/sh\\necho ran\\n' > /tmp/x.sh; chmod +x /tmp/x.sh; /tmp/x.sh 2>&1; sh /tmp/x.sh; mkdir -p ~/tmpexec && cp /tmp/x.sh ~/tmpexec/ && ~/tmpexec/x.sh`);
        expect(r.stdout).toMatch(/\/tmp tmpfs rw,[^ ]*noexec/);
        expect(r.stdout).toMatch(/Permission denied/);
        // A script is still run by naming its interpreter; a program under the home volume runs
        expect(r.stdout.match(/ran/g)?.length).toBe(2);
    }, 120_000);

    it('a process with empty capability sets under no-new-privileges gets nothing from a setuid binary, as the agent and as the operator', async () => {
        // The probe runs inside the box's own process trees: the operator's shell, and (through as-agent) the agent's side
        const probe = `
import os, pty, select, time, json
found = []
for path in ('/bin/su', '/usr/bin/su', '/usr/bin/passwd', '/usr/bin/mount', '/usr/bin/newgrp', '/usr/bin/chsh', '/usr/bin/gpasswd'):
    if os.path.exists(path) and os.stat(path).st_mode & 0o4000: found.append(path)
res = {'setuid': found, 'me': os.getuid()}
# su asks for a password on the terminal and waits: look at the process while it waits
pid, fd = pty.fork()
if pid == 0:
    os.execv('/bin/su', ['su', 'root'])
out = b''
end = time.time() + 6
while time.time() < end and b'assword' not in out:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try: out += os.read(fd, 4096)
        except OSError: break
st = open('/proc/%d/status' % pid).read()
res['su'] = {k: v for k, v in (l.split(':\\t', 1) for l in st.splitlines() if l.split(':', 1)[0] in ('Uid', 'Gid', 'CapEff', 'CapPrm', 'CapBnd', 'NoNewPrivs'))}
os.kill(pid, 9)
print('RESULT ' + json.dumps(res))
`;
        const t = await openTerminal();
        await t.run(`cat > /tmp/suprobe.py <<'PROBEEOF'\n${probe}\nPROBEEOF\nchmod 644 /tmp/suprobe.py`);
        const parse = (text: string) => JSON.parse(/RESULT (\{.*\})/.exec(text)![1]);
        for (const [who, cmd, uid] of [['operator', '/usr/bin/python3 -I /tmp/suprobe.py', 1001], ['agent', 'as-agent /usr/bin/python3 -I /tmp/suprobe.py', 1000]] as const) {
            const res = parse(await t.run(cmd, 60_000));
            expect(res.setuid.length, `${who}: the image has setuid binaries to try`).toBeGreaterThan(0);
            expect(res.me).toBe(uid);
            // Without no-new-privileges `su` would be running with an effective user id of 0
            expect(res.su.Uid.trim().split(/\s+/).slice(0, 2), who).toEqual([String(uid), String(uid)]);
            expect(res.su.NoNewPrivs.trim()).toBe('1');
            expect(res.su.CapEff.trim()).toBe(ZERO);
            expect(res.su.CapBnd.trim()).toBe(ZERO);
        }
        t.socket.emit('shell:close');
    }, 300_000);
});

describe('which side the owner is typing on, and a hostile agent side', () => {
    beforeAll(async () => {
        await inBoxInput(box.container, 'cat > /tmp/hostile.py', readFileSync(join(__dirname, 'as-agent-hostile.py'), 'utf8'), 60_000);
        await inBoxInput(box.container, 'cat > /tmp/drive.py', readFileSync(join(__dirname, 'as-agent-drive.py'), 'utf8'), 60_000);
        await inBox(box.container, 'chmod 644 /tmp/hostile.py /tmp/drive.py');
    }, 120_000);

    const REAL = '/run/as-agent/server.sock';
    /** Start the hostile server as the agent on a socket and drive as-agent against it as the operator. */
    async function hostile(mode: string, action: string, sock = `/tmp/hostile-${mode}.sock`) {
        await inBox(box.container, `rm -f ${sock}; (setsid python3 /tmp/hostile.py ${mode} ${sock} </dev/null >/dev/null 2>&1 &) ; for i in 1 2 3 4 5 6 7 8 9 10; do [ -S ${sock} ] && break; sleep 0.3; done; echo up`);
        // (the driver is the harness's own: one retry covers a docker exec that dies on a loaded engine)
        let r = await inBox(box.container, `python3 /tmp/drive.py ${action} ${sock}`, 90_000, OPERATOR);
        if (r.code !== 0) {
            await inBox(box.container, `rm -f ${sock}; (setsid python3 /tmp/hostile.py ${mode} ${sock} </dev/null >/dev/null 2>&1 &) ; sleep 1`);
            r = await inBox(box.container, `python3 /tmp/drive.py ${action} ${sock}`, 90_000, OPERATOR);
        }
        expect(r.code, `${r.stderr} ${r.stdout}`).toBe(0);
        return JSON.parse(r.stdout.trim().split('\n').pop()!) as { exited: boolean; status: number | null; seconds: number; output: string };
    }

    it('the side event: operator in the own shell, agent for as-agent even while the agent side draws the operator\'s prompt and stays open, operator again when the session ends; the agent replaced the server socket', async () => {
        const t = await openTerminal();
        await until('operator to be reported', async () => t.sides.at(-1) === 'operator', 15_000, 200);
        // The agent replaces the real server's socket with its own (it owns the directory)
        await inBox(box.container, `rm -f ${REAL}; (setsid python3 /tmp/hostile.py prompt ${REAL} </dev/null >/dev/null 2>&1 &); for i in 1 2 3 4 5 6 7 8 9 10; do [ -S ${REAL} ] && break; sleep 0.3; done`);
        t.socket.emit('shell:input', 'as-agent echo hi\n');
        await until('the agent side to be reported', async () => t.sides.at(-1) === 'agent', 15_000, 100);
        // It has drawn a byte-exact copy of the operator's prompt, and the session stays open: still the agent's side, on every report
        await until('the fake prompt to be drawn', async () => t.out().includes('\x1b[2J\x1b[Hoperator@box:~$ '), 15_000, 100);
        const n = t.sides.length;
        await new Promise(r => setTimeout(r, 3500));
        expect(t.sides.length).toBeGreaterThan(n + 1);
        expect(t.sides.slice(n - 1).every(s => s === 'agent')).toBe(true);
        // Typing into it goes nowhere the owner sees; the local escape works although the server ignores input
        t.socket.emit('shell:input', '\r~.');
        await until('the session to end', async () => t.out().includes('left the agent'), 15_000, 100);
        await until('operator to be reported again', async () => t.sides.at(-1) === 'operator', 15_000, 100);
        expect(await t.run('echo back-$((6*7))')).toContain('back-42');
        t.socket.emit('shell:close');
        // The real server again: ending it makes agora-host start it afresh on the same path
        await inBox(box.container, killMatching('hostile.py'));
        await inBox(box.container, killMatching('as-agent-server'));
        await until('the real as-agent server to be back', async () => (await inBoxInput(box.container, 'python3 -', 'import socket\ns = socket.socket(socket.AF_UNIX)\ns.connect("/run/as-agent/server.sock")\nprint("up")', 20_000)).stdout.includes('up'), 120_000, 3000);
    }, 600_000);

    it('a hostile agent side cannot hold the owner: the escape works with the server silent or flooding; oversize frames, hostile exit frames and refusals end the session with a short fixed message', async () => {
        const escaped = await hostile('noread', 'escape');
        expect(escaped).toMatchObject({ exited: true, status: 130 });
        expect(escaped.output).toContain('left the agent');
        const flooded = await hostile('flood', 'escape');
        expect(flooded).toMatchObject({ exited: true, status: 130 });
        expect(flooded.seconds).toBeLessThan(20);

        const huge = await hostile('huge', 'wait');
        expect(huge).toMatchObject({ exited: true, status: 76 });
        expect(huge.output).toContain('too large');
        expect(huge.output).not.toContain('\xff');

        const badx = await hostile('badx', 'wait');
        expect(badx.exited).toBe(true);
        expect(badx.status).toBe(1);
        expect(badx.output).not.toMatch(/Traceback|Error/);

        const evil = await hostile('evilf', 'wait');
        expect(evil.status).toBe(77);
        expect(evil.output).toContain('refused');
        expect(evil.output).not.toContain('EVIL');
        expect(evil.output).not.toContain('\x07');
        expect(evil.output.length).toBeLessThan(600);

        const closed = await hostile('closed', 'wait');
        expect(closed.exited).toBe(true);
        expect(closed.output).toContain('connection to the agent side closed');

        // Unknown frame types are ignored, and a hostile exit code is clamped
        const odd = await hostile('badkind', 'wait');
        expect(odd.output).toContain('visible-output');
        expect(odd.status).toBe(1);

        // A server that never reads while the owner pastes: the client gives up instead of growing without bound
        const paste = await hostile('noread', 'paste');
        expect(paste.exited).toBe(true);
        expect(paste.status).toBe(76);
        expect(paste.output).toContain('stopped reading');
    }, 600_000);
});
