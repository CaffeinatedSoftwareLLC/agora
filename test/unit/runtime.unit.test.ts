import { describe, it, expect } from 'vitest';
import { resolveLimits, timeProfileFor, DEFAULT_LIMITS, HARD_CEILINGS } from '../../src/runtime/limits';
import { buildContainerSpec, chunkCode, capHostPort, containerName, MAX_CODE_BYTES } from '../../src/runtime/container-spec';
import { demuxLogs } from '../../src/runtime/docker';
import { redact, statusFor, hashToken } from '../../src/runtime/runner';

describe('limits', () => {
    it('uses defaults and the standard profile', () => {
        const l = resolveLimits('standard');
        expect(l).toEqual({ ...DEFAULT_LIMITS, wallClockMs: 60_000 });
    });

    it('generation profile gets more wall clock', () => {
        expect(resolveLimits('generation').wallClockMs).toBe(180_000);
        expect(timeProfileFor(['search'])).toBe('standard');
        expect(timeProfileFor(['search', 'tts'])).toBe('generation');
        expect(timeProfileFor(['image'])).toBe('generation');
        expect(timeProfileFor([])).toBe('standard');
    });

    it('submitters can lower limits but never raise them', () => {
        const l = resolveLimits('standard', { memoryMb: 128, cpus: 4, wallClockMs: 999_999, capabilityCalls: 5 });
        expect(l.memoryMb).toBe(128);
        expect(l.cpus).toBe(1);
        expect(l.wallClockMs).toBe(60_000);
        expect(l.capabilityCalls).toBe(5);
    });

    it('ignores invalid requested values', () => {
        const l = resolveLimits('standard', { memoryMb: -5, pidsLimit: Number.NaN });
        expect(l.memoryMb).toBe(DEFAULT_LIMITS.memoryMb);
        expect(l.pidsLimit).toBe(DEFAULT_LIMITS.pidsLimit);
    });

    it('instance overrides are clamped to hard ceilings', () => {
        const l = resolveLimits('generation', {}, {
            defaults: { memoryMb: 99_999, cpus: 2 },
            profiles: { generation: { defaultMs: 900_000, ceilingMs: 900_000 } },
        });
        expect(l.memoryMb).toBe(HARD_CEILINGS.memoryMb);
        expect(l.cpus).toBe(2);
        expect(l.wallClockMs).toBe(600_000);
    });
});

describe('container spec', () => {
    const base = {
        runId: '01JABCDEFGHJKMNPQRSTVWXYZ0',
        serverId: '01SERVERAAAAAAAAAAAAAAAAAA',
        image: 'agora/sandbox-deno:dev',
        network: 'agora_sandbox',
        runtime: 'runsc' as const,
        code: 'console.log("hi")',
        runToken: 'art_secret',
        capUrl: 'http://cap-gateway:8080',
        limits: resolveLimits('standard'),
    };
    const spec = buildContainerSpec(base);
    const hc = spec.HostConfig!;

    it('applies every hardening setting from the spec', () => {
        expect(hc.Runtime).toBe('runsc');
        expect(hc.NetworkMode).toBe('agora_sandbox');
        expect(hc.Privileged).toBe(false);
        expect(hc.ReadonlyRootfs).toBe(true);
        expect(hc.CapDrop).toEqual(['ALL']);
        expect(hc.CapAdd).toEqual([]);
        expect(hc.SecurityOpt).toEqual(['no-new-privileges']);
        expect(hc.Binds).toEqual([]);
        expect(hc.Mounts).toEqual([]);
        expect(hc.Devices).toEqual([]);
        expect(hc.PortBindings).toEqual({});
        expect(hc.PublishAllPorts).toBe(false);
        expect(hc.PidsLimit).toBe(128);
        expect(hc.Memory).toBe(512 * 1024 * 1024);
        expect(hc.MemorySwap).toBe(hc.Memory);
        expect(hc.NanoCpus).toBe(1e9);
        expect(hc.Tmpfs!['/scratch']).toContain('size=64m');
        expect(hc.Tmpfs!['/scratch']).toContain('noexec');
        expect(hc.LogConfig).toEqual({ Type: 'local', Config: { 'max-size': '1m', 'max-file': '1', compress: 'false' } });
        expect(spec.User).toBe('65532:65532');
        expect(spec.OpenStdin).toBe(false);
    });

    it('names and labels the container for the socket proxy allowlist', () => {
        expect(spec.name).toBe('agora-run-01jabcdefghjkmnpqrstvwxyz0');
        expect(spec.name).toMatch(/^agora-run-[0-9a-z]{26}$/);
        expect(spec.Labels).toMatchObject({ 'agora.managed': 'runtime', 'agora.run': base.runId });
        expect(containerName(' 01JABCDEFGHJKMNPQRSTVWXYZ0 ')).toBe(spec.name);
    });

    it('passes only allowlisted env vars', () => {
        const names = spec.Env!.map(e => e.split('=')[0]);
        expect(names).toEqual(['AGORA_CAP_URL', 'AGORA_RUN_TOKEN', 'AGORA_CODE_0', 'DENO_DIR', 'NO_COLOR']);
    });

    it('Deno may only reach the gateway and never import remote code', () => {
        const cmd = spec.Cmd as string[];
        expect(cmd).toContain('--allow-net=cap-gateway:8080');
        expect(cmd).toContain('--deny-import');
        expect(cmd).toContain('--cached-only');
        expect(cmd).toContain('--no-prompt');
        expect(cmd.some(a => a.startsWith('--allow-run') || a.startsWith('--allow-ffi') || a.startsWith('--allow-sys') || a === '-A' || a === '--allow-all')).toBe(false);
        expect(cmd).toContain('--allow-write=/scratch');
        expect(cmd).toContain('--v8-flags=--max-old-space-size=384');
    });

    it('uses runc only when told to (insecure dev)', () => {
        expect(buildContainerSpec({ ...base, runtime: 'runc' }).HostConfig!.Runtime).toBe('runc');
    });

    it('chunks code into base64 env values and enforces the size cap', () => {
        const big = 'x'.repeat(200_000);
        const chunks = chunkCode(big);
        expect(chunks).toHaveLength(3);
        expect(Buffer.concat(chunks.map(c => Buffer.from(c, 'base64'))).toString()).toBe(big);
        expect(chunks.every(c => c.length < 128 * 1024)).toBe(true);
        expect(() => chunkCode('x'.repeat(MAX_CODE_BYTES + 1))).toThrow('exceeds');
        expect(() => chunkCode('')).toThrow('empty');
    });

    it('derives the gateway host:port', () => {
        expect(capHostPort('http://cap-gateway:8080')).toBe('cap-gateway:8080');
        expect(capHostPort('https://gw.internal')).toBe('gw.internal:443');
    });
});

describe('demuxLogs', () => {
    const frame = (stream: 1 | 2, text: string) => {
        const payload = Buffer.from(text);
        const header = Buffer.alloc(8);
        header[0] = stream;
        header.writeUInt32BE(payload.length, 4);
        return Buffer.concat([header, payload]);
    };

    it('splits stdout and stderr frames', () => {
        const out = demuxLogs(Buffer.concat([frame(1, 'hello '), frame(2, 'oops'), frame(1, 'world')]), 1024);
        expect(out).toEqual({ stdout: 'hello world', stderr: 'oops', stdoutTruncated: false, stderrTruncated: false });
    });

    it('caps each stream independently', () => {
        const out = demuxLogs(Buffer.concat([frame(1, 'a'.repeat(10)), frame(1, 'b'.repeat(10)), frame(2, 'c'.repeat(3))]), 15);
        expect(out.stdout).toBe('a'.repeat(10) + 'b'.repeat(5));
        expect(out.stdoutTruncated).toBe(true);
        expect(out.stderr).toBe('ccc');
        expect(out.stderrTruncated).toBe(false);
    });
});

describe('runner helpers', () => {
    it('redacts secrets everywhere they appear', () => {
        expect(redact('token=art_x and again art_x', ['art_x'])).toBe('token=[REDACTED] and again [REDACTED]');
    });

    it('maps outcomes to statuses', () => {
        const o = { exitCode: 0, timedOut: false, oomKilled: false, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, containerId: 'c' };
        expect(statusFor(o).status).toBe('succeeded');
        expect(statusFor({ ...o, exitCode: 1 }).status).toBe('failed');
        expect(statusFor({ ...o, exitCode: null, timedOut: true }).status).toBe('timeout');
        expect(statusFor({ ...o, exitCode: 137, oomKilled: true }).status).toBe('killed');
    });

    it('hashes tokens with sha256', () => {
        expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    });
});
