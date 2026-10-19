import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStartupConfig, parseInvite } from '../src/invites.js';

let directory: string;
const code = 'a'.repeat(64);
const args = ['--instance', 'https://agora.example', '--channel', 'general', '--invite', code];
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'agora-invites-'));
    vi.stubEnv('AGORA_INVITE', '');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe('invite startup', () => {
    it('redeems privately, persists credentials, and restarts without another exchange', async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: 'bot_test.secret' })));
        const config = await loadStartupConfig(args, { credentialDir: directory, fetch: fetcher });
        expect(config).toEqual({ instance: 'https://agora.example', token: 'bot_test.secret', defaultChannel: 'general' });
        expect(fetcher).toHaveBeenCalledWith('https://agora.example/agent-invites/redeem', expect.objectContaining({ method: 'POST', body: JSON.stringify({ code }), redirect: 'error' }));
        expect(await loadStartupConfig(args, { credentialDir: directory, fetch: fetcher })).toEqual(config);
        expect(fetcher).toHaveBeenCalledTimes(1);
        const files = await readdir(directory);
        expect(files).toHaveLength(1);
        const path = join(directory, files[0]);
        expect(await readFile(path, 'utf8')).not.toContain(code);
        if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    it('serializes concurrent local starts before redeeming', async () => {
        const fetcher = vi.fn().mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 30));
            return new Response(JSON.stringify({ token: 'bot_test.secret' }));
        });
        const configs = await Promise.all(Array.from({ length: 4 }, () => loadStartupConfig(args, { credentialDir: directory, fetch: fetcher })));
        expect(configs.every(c => c.token === 'bot_test.secret')).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it.each([410, 429, 500])('does not persist failures or disclose the response body (%s)', async status => {
        const fetcher = vi.fn().mockResolvedValue(new Response('sensitive server details', { status }));
        await expect(loadStartupConfig(args, { credentialDir: directory, fetch: fetcher })).rejects.toThrow(`(${status})`);
        expect(await readdir(directory)).toEqual([]);
    });

    it('keeps identities and instances separate', async () => {
        const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ token: `bot_${fetcher.mock.calls.length}.secret` })));
        const first = await loadStartupConfig(args, { credentialDir: directory, fetch: fetcher });
        const second = await loadStartupConfig([...args.slice(0, -1), 'b'.repeat(64)], { credentialDir: directory, fetch: fetcher });
        expect(first.token).not.toBe(second.token);
        expect(await readdir(directory)).toHaveLength(2);
    });

    it('accepts a full invite link and preserves legacy token configuration', async () => {
        expect(parseInvite(`https://agora.example/#agora-invite=${code}`)).toBe(code);
        expect(await loadStartupConfig(['--instance', 'http://localhost:3000', '--token', 'legacy'])).toEqual({ instance: 'http://localhost:3000', token: 'legacy', defaultChannel: undefined });
        expect(() => parseInvite('bad')).toThrow('Invalid Agora invite');
    });

    it.each(['http://remote.example', 'https://user:password@agora.example', 'https://agora.example/path', 'file:///tmp'])('rejects unsafe instance %s before sending a secret', async instance => {
        const fetcher = vi.fn();
        await expect(loadStartupConfig(['--instance', instance, '--invite', code], { credentialDir: directory, fetch: fetcher })).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('rejects malformed successful responses and cleans up locks', async () => {
        await expect(loadStartupConfig(args, { credentialDir: directory, fetch: vi.fn().mockResolvedValue(new Response('{}')) })).rejects.toThrow('invalid credentials');
        expect(await readdir(directory)).toEqual([]);
    });

    it('never echoes corrupt token-bearing JSON in startup errors', async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: 'bot_test.secret' })));
        await loadStartupConfig(args, { credentialDir: directory, fetch: fetcher });
        const [file] = await readdir(directory);
        await writeFile(join(directory, file), '{"token":"bot_private.secret"');
        await expect(loadStartupConfig(args, { credentialDir: directory, fetch: fetcher })).rejects.toThrow('Invalid saved Agora credentials. Request a fresh invite.');
        const malformed = vi.fn().mockResolvedValue(new Response('bot_private.secret invalid json'));
        await expect(loadStartupConfig([...args.slice(0, -1), 'c'.repeat(64)], { credentialDir: directory, fetch: malformed })).rejects.toThrow('Agora returned invalid credentials.');
    });

    it('supports invite environment configuration and CLI overrides', async () => {
        vi.stubEnv('AGORA_INVITE', code);
        vi.stubEnv('AGORA_INSTANCE', 'https://environment.example');
        vi.stubEnv('AGORA_DEFAULT_CHANNEL', 'env-channel');
        const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ token: 'bot_test.secret' })));
        expect(await loadStartupConfig([], { credentialDir: directory, fetch: fetcher })).toEqual({ instance: 'https://environment.example', token: 'bot_test.secret', defaultChannel: 'env-channel' });
        expect(await loadStartupConfig(args, { credentialDir: directory, fetch: fetcher })).toEqual({ instance: 'https://agora.example', token: 'bot_test.secret', defaultChannel: 'general' });
    });
});
