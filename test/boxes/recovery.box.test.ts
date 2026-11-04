import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    api, boxAction, compose, createBox, docker, inBox, inspectBox, instance, psql, sh, shEnv, until, waitRunning,
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
        // tini is PID 1; killing agora-host ends tini, Docker restarts the container
        await inBox(box.container, 'pkill -f agora-host/dist/index.js || kill 1');
        await until('the container to be running again', async () => JSON.parse((await docker('inspect', box.container)).stdout)[0].State.Running);
        await hostCheckedInSince(t);
        expect((await inBox(box.container, 'cat ~/marker')).stdout.trim()).toBe('keep-me');
    }, 300_000);

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
