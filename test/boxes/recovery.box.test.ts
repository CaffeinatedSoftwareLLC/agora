import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    api, boxAction, compose, createBox, docker, inBox, inspectBox, instance, OPERATOR, psql, sh, shEnv, until, waitRunning,
    type Box, type Instance,
} from './harness';

/**
 * Recovery and reboot (docs/agent-boxes.md §9.3, §14): boxes come back by themselves after
 * their own process dies, after the edge is recreated, after boxd restarts and after the
 * Docker daemon restarts, with their home folder (logins, repos) intact.
 */

let inst: Instance;
let box: Box;

/** The box's agora-host reached Agora after `since` (it polls through the edge). */
async function hostCheckedInSince(since: string) {
    await until('the box host to check in', async () =>
        (await psql(`SELECT h.last_seen_at > '${since}'::timestamptz FROM agent_boxes b JOIN agent_hosts h ON h.id = b.host_id WHERE b.id = '${box.id}'`)) === 't');
}
const now = async () => psql('SELECT NOW()');
/** A shell loop that kills processes by command line (the image has no pkill); the bracket keeps it from matching itself. */
const killMatching = (pattern: string) => `for f in /proc/[0-9]*/cmdline; do p=\${f#/proc/}; p=\${p%/cmdline}; if tr '\\0' ' ' < $f 2>/dev/null | grep -q '${pattern.replace(/^(.)/, '[$1]')}'; then kill -9 $p; fi; done`;
const startedAt = async () => JSON.parse((await docker('inspect', box.container)).stdout)[0].State.StartedAt as string;

beforeAll(async () => {
    inst = await instance();
    box = await createBox(inst, 'recover');
    // Something in the home folder that must survive everything below except a reset
    await inBox(box.container, 'echo keep-me > ~/marker && mkdir -p ~/.agora/state/recover && echo fake-login > ~/.agora/state/recover/login.json');
}, 600_000);

describe('box recovery', () => {
    it('the box restarts by itself when its agora-host dies', async () => {
        const t = await now();
        // agora-box-init is PID 1 (root): the agent can end its own agora-host, not the init. Init ends the
        // box when either of its two processes goes, and Docker restarts the container
        await inBox(box.container, killMatching('agora-host/dist/index.js --config'));
        await until('the container to be running again', async () => JSON.parse((await docker('inspect', box.container)).stdout)[0].State.Running);
        await hostCheckedInSince(t);
        expect((await inBox(box.container, 'cat ~/marker')).stdout.trim()).toBe('keep-me');
    }, 300_000);

    it('only the owner\'s terminal relay is restarted when it dies (the box and the agent are untouched), the agent cannot end it, and a relay that keeps dying is left down without taking the box with it', async () => {
        // The agent cannot signal the operator's relay (or the init): its attempt changes nothing
        const denied = await inBox(box.container, killMatching('box-relay --token-fd') + '; kill -9 1 2>&1; echo tried');
        expect(denied.stdout).toContain('tried');
        await new Promise(r => setTimeout(r, 3000));
        const started = await startedAt();
        const relayPids = async () => (await inBox(box.container, `for f in /proc/[0-9]*/cmdline; do p=\${f#/proc/}; p=\${p%/cmdline}; if tr '\\0' ' ' < $f 2>/dev/null | grep -q '[b]ox-relay --token-fd'; then echo $p; fi; done`)).stdout.trim().split('\n').filter(Boolean);
        const first = await relayPids();
        expect(first).toHaveLength(1);
        // The operator's own process may end it: the supervisor starts it again, the box stays up
        await inBox(box.container, killMatching('box-relay --token-fd'), 60_000, OPERATOR);
        await until('the relay to be started again', async () => { const p = await relayPids(); return p.length === 1 && p[0] !== first[0]; }, 60_000, 500);
        expect(await startedAt()).toBe(started);
        await until('the relay to reach Agora again', async () => (await api(`/boxes/${box.id}/terminal`, { auth: inst.admin })).body?.hostConnected !== false, 60_000, 1000).catch(() => {});
        // Killed whenever it is up: five starts a minute, then it is left down; the box and the agent's host carry on
        const gaveUp = async () => /leaving it down/.test((await docker('logs', '--tail', '80', box.container)).stderr);
        for (let i = 0; i < 90 && !(await gaveUp()); i++) {
            await inBox(box.container, killMatching('box-relay --token-fd'), 60_000, OPERATOR);
            await new Promise(r => setTimeout(r, 1000));
        }
        expect(await gaveUp()).toBe(true);
        await new Promise(r => setTimeout(r, 10_000));
        expect(await relayPids()).toEqual([]);
        expect(await startedAt()).toBe(started);
        const t = await now();
        await hostCheckedInSince(t);
        expect((await inBox(box.container, 'cat ~/marker')).stdout.trim()).toBe('keep-me');
        // The supervisor says why, in the box's own log
        expect((await docker('logs', '--tail', '50', box.container)).stderr).toMatch(/agora-relay-supervisor: the relay ended 5 times in a minute: leaving it down/);
        // Restarting the box brings the terminal side back
        await docker('restart', box.container);
        await waitRunning(inst, box.id);
        await until('the relay to run again', async () => (await relayPids()).length === 1, 60_000, 1000);
    }, 300_000);

    it('a relay that refuses its arguments or credential is not started again in a loop, and the box still runs', async () => {
        const version = readFileSync('box/VERSION', 'utf8').trim();
        const token = `ar_${'0'.repeat(26)}.${'a'.repeat(64)}`;
        // The supervisor alone, as the operator, with no instance address: the relay exits with status 2
        const script = `printf '%s' '${token}' | (exec 4<&0; python3 -I /opt/agora/agora-relay-supervisor 3<&4 4<&- & pid=$!; sleep 8; kill $pid; wait $pid) 2>&1`;
        const r = await sh('docker', ['run', '--rm', '--user', OPERATOR, '--entrypoint', 'sh', '-e', 'AGORA_HOST_IN_BOX=1', `agora/box:${version}-test`, '-c', script], 60_000);
        const out = r.stdout + r.stderr;
        expect(out.match(/not starting it again/g)).toHaveLength(1);
        expect(out).not.toMatch(/the relay ended \(status/);
    }, 120_000);

    it('an upgrade onto a volume laid out by the previous image (open home, old files, nothing of the new layout) comes up, closes the home again and keeps everything', async () => {
        // What an older box left on the volume: a world-readable home and state folder, an old npm prefix file, a login file, no new folders
        await inBox(box.container, 'chmod 755 ~ ~/.agora && chmod 644 ~/.agora/state/recover/login.json && rm -rf ~/.local ~/.venvs && printf "prefix=/home/agent/.npm-global\\n" > ~/.npmrc && echo old-layout > ~/old-file');
        const generation = box.generation;
        const t = await now();
        await boxAction(inst, box.id, 'rebuild');
        await waitRunning(inst, box.id, generation + 1);
        box = await inspectBox(box.id);
        await hostCheckedInSince(t);
        const look = async () => (await inBox(box.container, 'stat -c "%a" ~; stat -c "%a" ~/.agora; cat ~/marker ~/old-file ~/.agora/state/recover/login.json; ls -d ~/.local/bin ~/.npm-global ~/.venvs')).stdout;
        let out = await look();
        // (the start script closes the home before the host starts; give a slow engine a moment anyway)
        for (let i = 0; i < 10 && !out.startsWith('700\n700\n'); i++) { await new Promise(r => setTimeout(r, 2000)); out = await look(); }
        if (!out.startsWith('700\n700\n')) {
            const why = await inBox(box.container, 'id; ls -ld ~ ~/.agora; grep -E " /home/agent " /proc/mounts; chmod 700 ~; echo "chmod rc=$?"; stat -c "%a %U" ~');
            const logs = await docker('logs', '--tail', '30', box.container);
            throw new Error(`the home is still open after the upgrade: ${JSON.stringify(out.slice(0, 40))}\n${why.stdout}${why.stderr}\n${logs.stderr.slice(-1500)}`);
        }
        expect(out).toContain('700\n700\n');
        expect(out).toContain('keep-me\nold-layout\nfake-login\n');
        expect(out).toMatch(/\.local\/bin/);
        // The operator still cannot read the agent's home, and the relay is up under its supervisor
        expect((await inBox(box.container, 'ls /home/agent 2>&1', 60_000, OPERATOR)).stdout).toContain('Permission denied');
        expect((await inBox(box.container, `for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < $f 2>/dev/null; echo; done | grep -c '[b]ox-relay --token-fd'`)).stdout.trim()).toBe('1');
    }, 600_000);

    it('a recreated edge is re-attached and the box reaches Agora again without restarting', async () => {
        const started = await startedAt();
        const t = await now();
        expect((await compose('up', '-d', '--no-deps', '--force-recreate', 'box-edge')).code).toBe(0);
        await hostCheckedInSince(t);
        expect(await startedAt()).toBe(started);
        const r = await inBox(box.container, 'curl -s -o /dev/null -w "%{http_code}" http://edge:8080/health');
        expect(r.stdout).toBe('200');
    }, 300_000);

    it('a boxd restart leaves boxes running and picks up actions asked for meanwhile', async () => {
        expect((await compose('stop', 'boxd')).code).toBe(0);
        const started = await startedAt();
        const generation = box.generation;
        await boxAction(inst, box.id, 'rebuild');
        // Nothing happens while boxd is down
        await new Promise(r => setTimeout(r, 5000));
        expect(await startedAt()).toBe(started);
        expect((await compose('up', '-d', '--no-deps', '--no-build', 'boxd')).code).toBe(0);
        await waitRunning(inst, box.id, generation + 1);
        box = await inspectBox(box.id);
        expect(box.generation).toBe(generation + 1);
        expect((await inBox(box.container, 'cat ~/marker ~/.agora/state/recover/login.json')).stdout).toBe('keep-me\nfake-login\n');
    }, 300_000);

    it('a box on another build of its image (new agora-host code, same box/VERSION) is rebuilt onto the current one, home kept', async () => {
        const label = async () => JSON.parse((await docker('inspect', box.container)).stdout)[0].Config.Labels['org.agora.box.build'] ?? null;
        const before = await label();
        expect(before).toBeTruthy();
        const generation = box.generation;
        // What the stack does on an upgrade that changed agora-host: the same tag, another build label
        const version = readFileSync('box/VERSION', 'utf8').trim();
        const next = `${before}-next`;
        const built = await sh('docker', ['build', '-q', '-f', 'box/Dockerfile', '--target', 'test', '--build-arg', `BOX_VERSION=${version}`,
            '--build-arg', `BOX_BUILD=${next}`, '-t', `agora/box:${version}-test`, '.'], 900_000);
        expect(built.code, built.stderr).toBe(0);
        await waitRunning(inst, box.id, generation + 1);
        box = await inspectBox(box.id);
        expect(await label()).toBe(next);
        expect((await inBox(box.container, 'cat ~/marker ~/.agora/state/recover/login.json')).stdout).toBe('keep-me\nfake-login\n');
        // Once per build: it stays on this container
        await new Promise(r => setTimeout(r, 20_000));
        expect((await inspectBox(box.id)).generation).toBe(box.generation);
    }, 900_000);

    it.runIf(process.env.BOXTEST_ALLOW_DAEMON_RESTART === '1')('the reboot test: everything is back after the Docker daemon restarts', async () => {
        const t = await now().catch(() => new Date().toISOString());
        expect((await sh('sudo', ['systemctl', 'restart', 'docker'], 300_000)).code).toBe(0);
        await until('the API', async () => (await api('/health')).status === 200, 300_000);
        await hostCheckedInSince(t);
        box = await inspectBox(box.id);
        expect((await inBox(box.container, 'cat ~/marker ~/.agora/state/recover/login.json')).stdout).toBe('keep-me\nfake-login\n');
        // The token still works through the edge after the reboot, and still nowhere else
        const me = await inBox(box.container, `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bot ${box.botToken}" http://edge:8080/bots/@me`);
        expect(me.stdout).toBe('200');
        expect((await api('/bots/@me', { auth: `Bot ${box.botToken}` })).body?.error).toBe('box_token_outside_box');
    }, 900_000);

    // backup.sh and restore.sh run on the Linux side (in WSL on Windows), so not from Git Bash
    it.runIf(existsSync('install/backup.sh') && existsSync('install/restore.sh') && process.platform !== 'win32')('backup, reset, restore: the home folder comes back and old tokens are dead', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'agora-boxtest-backup-'));
        const pass = join(dir, 'passphrase');
        writeFileSync(pass, 'box-test-passphrase-1\n', { mode: 0o600 });
        const bundle = join(dir, 'bundle.agora-backup');
        const env = { AGORA_ENV_FILE_NAME: '.env.boxtest', NON_INTERACTIVE: '1' };
        const backup = await shEnv('bash', ['install/backup.sh', '--dir', '.', '--out', bundle, '--passphrase-file', pass], env, 900_000);
        expect(backup.code, backup.stderr).toBe(0);
        const before = await inspectBox(box.id);
        await boxAction(inst, box.id, 'reset', 'recover');
        await waitRunning(inst, box.id, before.generation + 1);
        expect((await inBox(containerFor(box), 'cat ~/marker 2>&1')).stdout).toMatch(/No such file/);
        const restore = await shEnv('bash', ['install/restore.sh', bundle, '--dir', '.', '--passphrase-file', pass, '--yes'], env, 900_000);
        expect(restore.code, restore.stderr).toBe(0);
        await until('the API', async () => (await api('/health')).status === 200, 300_000);
        inst = await instance();
        await waitRunning(inst, box.id, before.generation + 1);
        box = await inspectBox(box.id);
        expect((await inBox(box.container, 'cat ~/marker')).stdout.trim()).toBe('keep-me');
        // Tokens from before the restore are dead
        expect((await api('/bots/@me', { auth: `Bot ${before.botToken}` })).status).toBe(401);
        expect(await psql(`SELECT count(*) FROM box_edge_requests WHERE status IN ('pending', 'allowed', 'in_flight')`)).toBe('0');
    }, 1_800_000);
});

const containerFor = (b: Box) => b.container;
