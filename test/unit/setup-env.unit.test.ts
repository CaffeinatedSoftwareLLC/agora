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

    it('keeps volumes from before a failed start', () => {
        fakeDocker(['agora'], true);
        const r = run([...PORTS, '--start', '--instance', 'agora']);
        expect(r.status).toBe(1);
        expect(calls()).toMatch(/down --remove-orphans\n/);
    });
});
