import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * setup-env.js --prod against a fake `docker` on PATH (#209): it never starts the stack
 * unless asked, and a second install on the same engine gets its own name.
 */
const ROOT = resolve(__dirname, '../..');

let dir: string;
let bin: string;

/** A fake docker CLI: reports containers for the projects in FAKE_PROJECTS and logs every call. */
function fakeDocker(projects: string[], upFails = false) {
    writeFileSync(join(bin, 'docker'), `#!/bin/sh
echo "$@" >> "${join(dir, 'docker.log')}"
case "$*" in
  *"up -d"*) ${upFails ? 'exit 1' : 'exit 0'} ;;
  *"down"*) exit 0 ;;
  *"logs api"*) printf 'api-1  | AGORA SETUP TOKEN\\napi-1  |   ${'a'.repeat(64)}\\n'; exit 0 ;;
esac
for p in ${projects.join(' ')}; do
  case "$*" in *"project=$p "*|*"project=$p") echo deadbeef ;; esac
  case "$*" in *"name=^\${p}_sandbox\\$"*) echo net1 ;; esac
done
exit 0
`);
    chmodSync(join(bin, 'docker'), 0o755);
}

function run(args: string[]) {
    return spawnSync(process.execPath, [join(dir, 'scripts', 'setup-env.js'), '--prod', '--non-interactive', ...args], {
        cwd: dir, encoding: 'utf8', input: '',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
}
const env = () => Object.fromEntries(readFileSync(join(dir, '.env.prod'), 'utf8').split('\n')
    .filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const calls = () => existsSync(join(dir, 'docker.log')) ? readFileSync(join(dir, 'docker.log'), 'utf8') : '';
const PORTS = ['--http-port', '18080', '--https-port', '18443', '--api-port', '13000'];

describe.skipIf(process.platform === 'win32')('setup-env --prod (#209)', () => {
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'agora-setup-'));
        bin = join(dir, 'bin');
        mkdirSync(join(dir, 'scripts'));
        mkdirSync(bin);
        copyFileSync(join(ROOT, 'scripts', 'setup-env.js'), join(dir, 'scripts', 'setup-env.js'));
        copyFileSync(join(ROOT, '.env.prod.example'), join(dir, '.env.prod.example'));
    });

    it('writes .env.prod and does not start Docker unless asked', () => {
        fakeDocker([]);
        const r = run(PORTS);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('Not starting Docker');
        expect(calls()).not.toMatch(/up -d/);
        const e = env();
        expect(e.AGORA_INSTANCE).toBe('agora');
        expect(e.COMPOSE_PROJECT_NAME).toBe('agora');
        expect(e.AGORA_HTTPS_PORT).toBe('18443');
        expect(e.AGORA_API_PORT).toBe('13000');
        expect(e.CORS_ORIGIN).toBe('https://localhost:18443');
        expect(e.AGORA_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    });

    it('generates the box edge secret, keeps telemetry off and follows box/VERSION', () => {
        fakeDocker([]);
        mkdirSync(join(dir, 'box'));
        writeFileSync(join(dir, 'box', 'VERSION'), '7\n');
        expect(run(PORTS).status).toBe(0);
        const e = env();
        expect(e.AGORA_EDGE_SECRET).toMatch(/^[0-9a-f]{64}$/);
        expect(e.AGORA_EDGE_SECRET).not.toBe(e.AGORA_ENCRYPTION_KEY);
        expect(e.AGORA_TELEMETRY).toBe('off');
        expect(e.AGORA_BOX_VERSION).toBe('7');
        expect(e.AGORA_BOX_TARGET).toBeUndefined();
    });

    it('records the telemetry answer and the test box image when asked', () => {
        fakeDocker([]);
        expect(run([...PORTS, '--telemetry', 'on', '--box-target', 'test']).status).toBe(0);
        const e = env();
        expect(e.AGORA_TELEMETRY).toBe('on');
        expect(e.AGORA_BOX_TARGET).toBe('test');
        expect(e.AGORA_BOX_TAG_SUFFIX).toBe('-test');
        expect(e.AGORA_BOX_VERSION).toBe('1');
    });

    it('takes the docker group id from the installer', () => {
        fakeDocker([]);
        expect(run([...PORTS, '--docker-gid', '4242']).status).toBe(0);
        expect(env().DOCKER_GID).toBe('4242');
        expect(run([...PORTS, '--docker-gid', 'docker', '--force']).status).toBe(1);
    });

    it('rejects an unknown telemetry answer', () => {
        fakeDocker([]);
        expect(run([...PORTS, '--telemetry', 'maybe']).status).toBe(1);
        expect(existsSync(join(dir, '.env.prod'))).toBe(false);
    });

    it('names a second install on the same engine agora2', () => {
        fakeDocker(['agora']);
        const r = run(PORTS);
        expect(r.status).toBe(0);
        expect(env().AGORA_INSTANCE).toBe('agora2');
        expect(env().COMPOSE_PROJECT_NAME).toBe('agora2');
    });

    it('keeps the default origin on port 443', () => {
        fakeDocker([]);
        expect(run(['--http-port', '18080', '--https-port', '443', '--api-port', '13000']).status).toBe(0);
        expect(env().CORS_ORIGIN).toBeUndefined();
    });

    it('rejects an invalid instance name', () => {
        fakeDocker([]);
        const r = run([...PORTS, '--instance', 'Bad_Name']);
        expect(r.status).toBe(1);
        expect(existsSync(join(dir, '.env.prod'))).toBe(false);
    });

    it('starts with --start and reads the setup token through compose', () => {
        fakeDocker([]);
        const r = run([...PORTS, '--start']);
        expect(r.status).toBe(0);
        expect(calls()).toMatch(/compose -f docker-compose.prod.yml --env-file .env.prod up -d --build/);
        expect(r.stdout).toContain('a'.repeat(64));
    });

    it('cleans up what a failed start created, volumes included when there were none before', () => {
        fakeDocker([], true);
        const r = run([...PORTS, '--start']);
        expect(r.status).toBe(1);
        expect(calls()).toMatch(/down --remove-orphans -v/);
    });

    // Codex review #8: new secrets over an existing install would lock it out of its own data
    it('refuses an --instance name this engine already has, and writes nothing', () => {
        fakeDocker(['agora']);
        const r = run([...PORTS, '--instance', 'agora']);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/already has containers, volumes or networks/);
        expect(existsSync(join(dir, '.env.prod'))).toBe(false);
        expect(calls()).not.toMatch(/up -d|down/);
    });

    // Codex review #9: an unknown inventory is never "free", and cleanup never reaches older resources
    it('starts nothing when Docker cannot be asked what exists', () => {
        fakeDocker([]);
        writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$@" >> "${join(dir, 'docker.log')}"\ncase "$*" in *"volume ls"*) exit 1 ;; esac\nexit 0\n`);
        chmodSync(join(bin, 'docker'), 0o755);
        const r = run([...PORTS, '--start', '--instance', 'agora']);
        expect(r.status).toBe(1);
        expect(calls()).not.toMatch(/up -d|down/);
    });

    it('starts nothing, and removes nothing, when resources appear between the check and the start', () => {
        // The first inventory sees an empty engine, the second (right before `up`) a volume
        const marker = join(dir, 'seen');
        writeFileSync(join(bin, 'docker'), `#!/bin/sh
echo "$@" >> "${join(dir, 'docker.log')}"
case "$*" in
  *"volume ls"*) if [ -f "${marker}" ]; then echo vol1; else touch "${marker}"; fi ;;
esac
exit 0
`);
        chmodSync(join(bin, 'docker'), 0o755);
        const r = run([...PORTS, '--start', '--instance', 'agora']);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/appeared meanwhile/);
        expect(calls()).not.toMatch(/up -d|down/);
    });
});
