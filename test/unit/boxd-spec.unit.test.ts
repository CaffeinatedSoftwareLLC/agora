import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    BOX_PATH, LOADER_ENV, containerDrift, containerSpec, limitsDiffer, networkDrift, networkSpec, validApiKeyEnv, volumeSpec, type BoxSpecInput, type ExpectedBox,
} from '../../src/boxes/boxd/spec';
import { BOX_IMAGE_VERSION } from '../../src/boxes/boxd/version';
import { inspectFrom } from '../boxes/boxd-fake-docker';

const BOX = '01JBXA0000000000000000000Z';
const input = (over: Partial<BoxSpecInput> = {}): BoxSpecInput => ({
    instance: 'agora', boxId: BOX, generation: 3, image: 'agora/box:1', imageVersion: 1, runtime: 'runsc',
    subnet: '10.213.0.16/28', limits: { cpus: 2, memoryMb: 4096, pids: 1024 },
    hostToken: 'ah_H.secret', relayToken: 'ar_H.relay', botId: 'B'.repeat(26), botToken: 'bot_T.secret',
    profile: { name: 'claude-1', adapter: 'claude', auth: 'subscription', apiKeyEnv: null, workdirAlias: 'work', repos: ['acme/app'] },
    apiKey: null,
    ...over,
});
const expected = (over: Partial<ExpectedBox> = {}): ExpectedBox => ({
    instance: 'agora', boxId: BOX, generation: 3, image: 'agora/box:1', imageVersion: 1, runtime: 'runsc', subnet: '10.213.0.16/28', ...over,
});
const env = (spec: any) => Object.fromEntries((spec.Env as string[]).map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));

describe('boxd container spec', () => {
    it('PID 1 is the absolute interpreter in isolated mode on the absolute script, with a root-first PATH that box/Dockerfile shares', () => {
        const s: any = containerSpec(input());
        expect(s.Entrypoint).toEqual(['/usr/bin/python3', '-I', '/opt/agora/agora-box-init']);
        expect(s.Cmd).toEqual([]);
        expect(env(s).PATH).toBe(BOX_PATH);
        expect(BOX_PATH.split(':').slice(0, 6).every(p => !p.startsWith('/home/'))).toBe(true);
        const dockerfile = readFileSync(path.join(__dirname, '../../box/Dockerfile'), 'utf8');
        expect(dockerfile).toContain(`ENTRYPOINT ["/usr/bin/python3", "-I", "/opt/agora/agora-box-init"]`);
        expect(dockerfile).toContain(`PATH=${BOX_PATH} `);
        for (const f of ['agora-box-init', 'agora-relay-supervisor', 'as-agent', 'agora-pty', 'as-agent-server']) {
            expect(readFileSync(path.join(__dirname, '../../box', f), 'utf8').split(/\r?\n/)[0]).toBe('#!/usr/bin/python3 -I');
        }
    });

    it('/tmp is noexec, said in the spec, and no loader variable is set in the container', () => {
        const s: any = containerSpec(input());
        expect(s.HostConfig.Tmpfs['/tmp']).toBe('rw,noexec,nosuid,nodev,size=1g,mode=1777');
        expect(Object.keys(env(s)).filter(k => LOADER_ENV.test(k))).toEqual([]);
    });

    it('box/VERSION matches the constant boxd is built with', () => {
        const file = readFileSync(path.join(__dirname, '../../box/VERSION'), 'utf8').trim();
        expect(Number(file)).toBe(BOX_IMAGE_VERSION);
    });

    it('builds the §7.1 template from constants plus the row', () => {
        const s: any = containerSpec(input());
        expect(s.name).toBe('agora-box-01jbxa0000000000000000000z');
        expect(s.Image).toBe('agora/box:1');
        // Root, only so the init can start the agent (1000) and the owner's relay (1001) apart; it holds four capabilities and gives them up
        expect(s.User).toBe('0:0');
        expect(s.HostConfig.Runtime).toBe('runsc');
        expect(s.HostConfig.ReadonlyRootfs).toBe(true);
        expect(s.HostConfig.Privileged).toBe(false);
        expect(s.HostConfig.CapDrop).toEqual(['ALL']);
        expect(s.HostConfig.CapAdd).toEqual(['KILL', 'SETGID', 'SETPCAP', 'SETUID']);
        expect(s.HostConfig.SecurityOpt).toEqual(['no-new-privileges']);
        expect(s.HostConfig.Binds).toEqual([]);
        expect(s.HostConfig.Tmpfs['/tmp']).toContain('size=1g');
        expect(s.HostConfig.Tmpfs['/run/agora']).toBe('rw,noexec,nosuid,nodev,size=1m,mode=0700,uid=1000,gid=1000');
        // The owner's home: the operator's alone. The as-agent channel: the agent's, traversable by the operator's group only
        expect(s.HostConfig.Tmpfs['/home/operator']).toBe('rw,nosuid,nodev,size=256m,mode=0700,uid=1001,gid=1001');
        expect(s.HostConfig.Tmpfs['/run/as-agent']).toBe('rw,noexec,nosuid,nodev,size=1m,mode=0710,uid=1000,gid=1001');
        expect(s.HostConfig.Mounts).toEqual([{ Type: 'volume', Source: 'agora-box-01jbxa0000000000000000000z-home', Target: '/home/agent', ReadOnly: false }]);
        expect(s.HostConfig.RestartPolicy).toEqual({ Name: 'unless-stopped' });
        expect(s.HostConfig.NetworkMode).toBe('agora_box_01jbxa0000000000000000000z');
        expect(s.HostConfig.ExtraHosts).toEqual(['edge:10.213.0.18']);
        expect(s.NetworkingConfig.EndpointsConfig['agora_box_01jbxa0000000000000000000z'].IPAMConfig.IPv4Address).toBe('10.213.0.19');
        expect(s.HostConfig.Memory).toBe(4096 * 1024 * 1024);
        expect(s.HostConfig.MemorySwap).toBe(s.HostConfig.Memory);
        expect(s.HostConfig.NanoCpus).toBe(2e9);
        expect(s.HostConfig.PidsLimit).toBe(1024);
        expect(s.HostConfig.PortBindings).toEqual({});
        expect(s.Labels).toEqual({
            'org.agora.instance': 'agora', 'org.agora.box': BOX, 'org.agora.box.version': '1', 'org.agora.box.generation': '3',
        });
    });

    it('uses runc only when asked (AGORA_BOX_INSECURE_DEV)', () => {
        expect((containerSpec(input({ runtime: 'runc' })).HostConfig as any).Runtime).toBe('runc');
    });

    it('sets the box env from the contract', () => {
        const e = env(containerSpec(input()));
        expect(e).toMatchObject({
            AGORA_BOX_ID: BOX, AGORA_BOX_GENERATION: '3', AGORA_INSTANCE_URL: 'http://edge:8080',
            AGORA_HOST_TOKEN: 'ah_H.secret', AGORA_RELAY_TOKEN: 'ar_H.relay', AGORA_BOT_ID: 'B'.repeat(26), AGORA_BOT_TOKEN: 'bot_T.secret',
            HTTPS_PROXY: 'http://edge:3128', HTTP_PROXY: 'http://edge:3128', NO_PROXY: 'edge', HOME: '/home/agent',
        });
        expect(JSON.parse(e.AGORA_BOX_PROFILE)).toEqual({
            name: 'claude-1', adapter: 'claude', auth: 'subscription', apiKeyEnv: null, workdirAlias: 'work', repos: ['acme/app'],
        });
        expect(Object.keys(e).some(k => k.endsWith('_API_KEY'))).toBe(false);
    });

    it('adds an api_key profile key under its variable, and only a safe variable name', () => {
        const e = env(containerSpec(input({
            profile: { name: 'c', adapter: 'claude', auth: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY', workdirAlias: 'work', repos: [] },
            apiKey: 'sk-test',
        })));
        expect(e.ANTHROPIC_API_KEY).toBe('sk-test');
        for (const bad of ['PATH', 'AGORA_BOT_TOKEN', 'HTTPS_PROXY', 'LD_PRELOAD', 'AGORA_X_API_KEY', 'x_api_key', 'NODE_OPTIONS']) {
            expect(validApiKeyEnv(bad)).toBe(false);
            expect(() => containerSpec(input({
                profile: { name: 'c', adapter: 'claude', auth: 'api_key', apiKeyEnv: bad, workdirAlias: 'work', repos: [] }, apiKey: 'k',
            }))).toThrow();
        }
    });

    it('drops repo names that are not owner/repo', () => {
        const e = env(containerSpec(input({ profile: { ...input().profile, repos: ['acme/app', '../etc', 'a/..', 'x/y z'] } })));
        expect(JSON.parse(e.AGORA_BOX_PROFILE).repos).toEqual(['acme/app']);
    });

    it('clamps limits to the instance ceilings', () => {
        const s: any = containerSpec(input({ limits: { cpus: 99, memoryMb: 10, pids: 1e9 } }));
        expect(s.HostConfig.NanoCpus).toBe(16e9);
        expect(s.HostConfig.Memory).toBe(512 * 1024 * 1024);
        expect(s.HostConfig.PidsLimit).toBe(16384);
    });

    it('makes an internal /28 network with the bridge at .1, and a labelled volume', () => {
        expect(networkSpec('agora', BOX, '10.213.0.16/28')).toMatchObject({
            Name: 'agora_box_01jbxa0000000000000000000z', Internal: true, Driver: 'bridge',
            Options: { 'com.docker.network.bridge.inhibit_ipv4': 'true' },
            IPAM: { Config: [{ Subnet: '10.213.0.16/28', Gateway: '10.213.0.17' }] },
            Labels: { 'org.agora.instance': 'agora', 'org.agora.box': BOX },
        });
        expect(volumeSpec('agora', BOX)).toEqual({
            Name: 'agora-box-01jbxa0000000000000000000z-home', Driver: 'local', Labels: { 'org.agora.instance': 'agora', 'org.agora.box': BOX },
        });
    });
});

describe('boxd start check (drift)', () => {
    const good = () => inspectFrom(containerSpec(input()));

    it('passes a container exactly as created', () => {
        expect(containerDrift(good(), expected())).toEqual([]);
    });

    const cases: [string, (i: any) => void][] = [
        ['image', i => { i.Config.Image = 'evil/image:latest'; }],
        ['entrypoint', i => { i.Config.Entrypoint = ['/opt/agora/agora-box-init']; }],
        ['entrypoint', i => { i.Config.Entrypoint = ['/usr/bin/env', 'python3', '/opt/agora/agora-box-init']; }],
        ['entrypoint', i => { i.Config.Entrypoint = ['/usr/bin/python3', '/opt/agora/agora-box-init']; }],
        ['entrypoint', i => { i.Config.Entrypoint = ['/usr/bin/python3', '-I', '/home/agent/init']; }],
        ['entrypoint', i => { i.Config.Entrypoint = null; }],
        ['command', i => { i.Config.Cmd = ['--stage2', '3']; }],
        ['env-path', i => { i.Config.Env = i.Config.Env.map((e: string) => e.startsWith('PATH=') ? 'PATH=/home/agent/.local/bin:' + e.slice(5) : e); }],
        ['env-path', i => { i.Config.Env = i.Config.Env.filter((e: string) => !e.startsWith('PATH=')); }],
        ['env-home', i => { i.Config.Env = i.Config.Env.map((e: string) => e.startsWith('HOME=') ? 'HOME=/root' : e); }],
        ['env-loader', i => { i.Config.Env.push('LD_PRELOAD=/home/agent/evil.so'); }],
        ['env-loader', i => { i.Config.Env.push('PYTHONPATH=/home/agent/py'); }],
        ['env-loader', i => { i.Config.Env.push('PYTHONSTARTUP=/home/agent/s.py'); }],
        ['env-loader', i => { i.Config.Env.push('NODE_OPTIONS=--require /home/agent/x.js'); }],
        ['env-loader', i => { i.Config.Env.push('NODE_PATH=/home/agent/m'); }],
        ['env-loader', i => { i.Config.Env.push('BASH_ENV=/home/agent/rc'); }],
        ['working-dir', i => { i.Config.WorkingDir = '/'; }],
        ['tmpfs', i => { i.HostConfig.Tmpfs['/tmp'] = 'rw,exec,nosuid,nodev,size=1g,mode=1777'; }],
        ['user', i => { i.Config.User = '1000:1000'; }],
        ['user', i => { i.Config.User = '1001:1001'; }],
        ['runtime', i => { i.HostConfig.Runtime = 'runc'; }],
        ['privileged', i => { i.HostConfig.Privileged = true; }],
        ['read-only', i => { i.HostConfig.ReadonlyRootfs = false; }],
        ['cap-drop', i => { i.HostConfig.CapDrop = []; }],
        ['cap-add', i => { i.HostConfig.CapAdd = ['SYS_ADMIN']; }],
        ['cap-add', i => { i.HostConfig.CapAdd = ['KILL', 'SETGID', 'SETPCAP', 'SETUID', 'SYS_PTRACE']; }],
        ['cap-add', i => { i.HostConfig.CapAdd = ['KILL', 'SETGID', 'SETUID']; }],
        ['cap-add', i => { i.HostConfig.CapAdd = []; }],
        ['security-opt', i => { i.HostConfig.SecurityOpt = ['no-new-privileges', 'seccomp=unconfined']; }],
        ['tmpfs', i => { i.HostConfig.Tmpfs['/run/agora'] = 'rw,size=1g'; }],
        ['tmpfs', i => { i.HostConfig.Tmpfs['/home/operator'] = 'rw,mode=0755,uid=1001,gid=1001'; }],
        ['tmpfs', i => { i.HostConfig.Tmpfs['/run/as-agent'] = 'rw,mode=0777,uid=1000,gid=1000'; }],
        ['tmpfs', i => { delete i.HostConfig.Tmpfs['/home/operator']; }],
        ['binds', i => { i.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock']; }],
        ['mounts', i => { i.Mounts.push({ Type: 'volume', Name: 'agora-box-other-home', Destination: '/mnt' }); }],
        ['mounts', i => { i.Mounts[0].Name = 'agora-box-01jbxb0000000000000000000z-home'; }],
        ['devices', i => { i.HostConfig.Devices = [{ PathOnHost: '/dev/kvm' }]; }],
        ['ports', i => { i.HostConfig.PortBindings = { '22/tcp': [{ HostPort: '2222' }] }; }],
        ['namespaces', i => { i.HostConfig.PidMode = 'host'; }],
        ['network-mode', i => { i.HostConfig.NetworkMode = 'host'; }],
        ['networks', i => { i.NetworkSettings.Networks.agora_default = { IPAMConfig: null }; }],
        ['address', i => { i.NetworkSettings.Networks['agora_box_01jbxa0000000000000000000z'].IPAMConfig.IPv4Address = '10.213.0.20'; }],
        ['extra-hosts', i => { i.HostConfig.ExtraHosts = ['edge:10.0.0.1']; }],
        ['labels', i => { i.Config.Labels['org.agora.instance'] = 'agora2'; }],
        ['name', i => { i.Name = '/agora-box-01jbxb0000000000000000000z'; }],
    ];
    for (const [field, tamper] of cases) {
        it(`refuses a container whose ${field} changed`, () => {
            const info = good();
            tamper(info);
            expect(containerDrift(info, expected())).toContain(field);
        });
    }

    it('accepts the capability names however Docker spells them (SETUID or CAP_SETUID, any order)', () => {
        const info = good();
        info.HostConfig.CapAdd = ['CAP_SETUID', 'CAP_SETPCAP', 'CAP_KILL', 'CAP_SETGID'];
        expect(containerDrift(info, expected())).toEqual([]);
    });

    it('treats generation and limits as reasons to rebuild, not drift', () => {
        const info = good();
        expect(containerDrift(info, expected({ generation: 9 }))).toEqual([]);
        expect(limitsDiffer(info, { cpus: 2, memoryMb: 4096, pids: 1024 })).toBe(false);
        expect(limitsDiffer(info, { cpus: 4, memoryMb: 4096, pids: 1024 })).toBe(true);
    });

    it('checks the box network: internal, labelled, the row subnet', () => {
        const n = { Internal: true, Options: { 'com.docker.network.bridge.inhibit_ipv4': 'true' }, Labels: { 'org.agora.instance': 'agora', 'org.agora.box': BOX }, IPAM: { Config: [{ Subnet: '10.213.0.16/28' }] } };
        expect(networkDrift(n, 'agora', BOX, '10.213.0.16/28')).toEqual([]);
        // The host must not be on the box network (no bridge address)
        expect(networkDrift({ ...n, Options: {} }, 'agora', BOX, '10.213.0.16/28')).toContain('host reachable (no inhibit_ipv4)');
        expect(networkDrift({ ...n, Internal: false }, 'agora', BOX, '10.213.0.16/28')).toContain('not internal');
        expect(networkDrift(n, 'agora', BOX, '10.213.0.32/28')).toContain('subnet');
        expect(networkDrift({ ...n, Labels: {} }, 'agora', BOX, '10.213.0.16/28')).toContain('labels');
    });
});
