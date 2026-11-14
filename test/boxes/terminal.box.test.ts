import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API, OPERATOR, api, createBox, docker, inBox, inBoxInput, instance, nodeInBox, psql, until, waitRunning, type Box, type Instance } from './harness';

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
        expect(out).toContain("the agent can see what you type here");
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
