import { describe, it, expect } from 'vitest';
import { checkBaseUrl, isPrivateAddress } from '../../src/lib/url-guard';

const resolveTo = (...addrs: string[]) => async () => addrs;

describe('isPrivateAddress', () => {
    it.each([
        '127.0.0.1', '10.1.2.3', '172.16.0.5', '172.31.255.255', '192.168.1.10',
        '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1',
    ])('%s is private', (addr) => {
        expect(isPrivateAddress(addr)).toBe(true);
    });

    it.each(['8.8.8.8', '142.250.72.14', '172.32.0.1', '2607:f8b0:4005:80a::200e'])('%s is public', (addr) => {
        expect(isPrivateAddress(addr)).toBe(false);
    });
});

describe('checkBaseUrl', () => {
    it('accepts a public https host', async () => {
        const res = await checkBaseUrl('https://openrouter.ai/api/v1', { allowPrivate: false, resolve: resolveTo('104.18.2.3') });
        expect(res.ok).toBe(true);
    });

    it('rejects hosts that resolve to private addresses (e.g. docker service names)', async () => {
        const res = await checkBaseUrl('http://postgres:5432', { allowPrivate: false, resolve: resolveTo('172.19.0.2') });
        expect(res).toMatchObject({ ok: false });
        expect((res as any).error).toContain('private');
    });

    it('rejects if any resolved address is private', async () => {
        const res = await checkBaseUrl('https://mixed.example', { allowPrivate: false, resolve: resolveTo('8.8.8.8', '10.0.0.1') });
        expect(res.ok).toBe(false);
    });

    it('rejects literal private IPs, including IPv6', async () => {
        expect((await checkBaseUrl('http://127.0.0.1:11434/v1', { allowPrivate: false })).ok).toBe(false);
        expect((await checkBaseUrl('http://[::1]:11434/v1', { allowPrivate: false })).ok).toBe(false);
        expect((await checkBaseUrl('http://169.254.169.254/latest', { allowPrivate: false })).ok).toBe(false);
    });

    it('allows private targets when the instance setting is on', async () => {
        const res = await checkBaseUrl('http://localhost:11434/v1', { allowPrivate: true });
        expect(res.ok).toBe(true);
    });

    it('rejects non-http schemes, credentials, and garbage', async () => {
        expect((await checkBaseUrl('file:///etc/passwd', { allowPrivate: true })).ok).toBe(false);
        expect((await checkBaseUrl('https://user:pw@example.com', { allowPrivate: true })).ok).toBe(false);
        expect((await checkBaseUrl('not a url', { allowPrivate: true })).ok).toBe(false);
    });

    it('rejects unresolvable hosts', async () => {
        const res = await checkBaseUrl('https://nope.invalid', {
            allowPrivate: false,
            resolve: async () => { throw new Error('ENOTFOUND'); },
        });
        expect(res.ok).toBe(false);
    });
});
