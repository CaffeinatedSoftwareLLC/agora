import { describe, it, expect, vi } from 'vitest';

// The header shapes each proxy path really produces for the box terminal's Origin checks.
async function load(env: { trustProxy: boolean; corsOrigin?: string }) {
    vi.resetModules();
    vi.doMock('../../src/config', () => ({ config: { trustProxy: env.trustProxy, corsOrigin: env.corsOrigin, cookieSecure: true, jwtSecret: 's' } }));
    return import('../../src/auth/session-cookie');
}

// nginx (agora-ui/nginx.conf) passes the browser's Host and the scheme a proxy in front reported.
const caddy443 = { origin: 'https://agora.example.com', host: 'agora.example.com', 'x-forwarded-proto': 'https' };
const caddy8443 = { origin: 'https://localhost:8443', host: 'localhost:8443', 'x-forwarded-proto': 'https' };
const tailscale443 = { origin: 'https://box.tail1234.ts.net', host: 'box.tail1234.ts.net', 'x-forwarded-proto': 'https' };
const noProxyHeader = { origin: 'https://box.tail1234.ts.net', host: 'box.tail1234.ts.net' };

describe('originAllowed + originSchemeMatches', () => {
    it.each([['Caddy on 443', caddy443], ['Caddy on 8443', caddy8443], ['tailscale serve on 443', tailscale443]])('%s is accepted', async (_n, h) => {
        const m = await load({ trustProxy: true });
        expect(m.originAllowed(h as any)).toBe(true);
        expect(m.originSchemeMatches(h as any, false)).toBe(true);
    });

    it('a Host without the port (what nginx $host sent) fails the host check, which is why nginx forwards $http_host', async () => {
        const m = await load({ trustProxy: true });
        expect(m.originAllowed({ ...caddy8443, host: 'localhost' } as any)).toBe(false);
    });

    it('an http page on an https site is refused', async () => {
        const m = await load({ trustProxy: true });
        expect(m.originSchemeMatches({ ...tailscale443, origin: 'http://box.tail1234.ts.net' } as any, false)).toBe(false);
    });

    it('without the header, the connection decides (the old behaviour behind plain nginx)', async () => {
        const m = await load({ trustProxy: true });
        expect(m.originSchemeMatches(noProxyHeader as any, false)).toBe(false);
        expect(m.originSchemeMatches(noProxyHeader as any, true)).toBe(true);
    });

    it('uses the first value of a list and ignores junk', async () => {
        const m = await load({ trustProxy: true });
        expect(m.originSchemeMatches({ ...tailscale443, 'x-forwarded-proto': 'https, http' } as any, false)).toBe(true);
        expect(m.originSchemeMatches({ ...tailscale443, 'x-forwarded-proto': 'ftp' } as any, false)).toBe(false);
    });

    it('ignores the header when TRUST_PROXY is off', async () => {
        const m = await load({ trustProxy: false });
        expect(m.originSchemeMatches(tailscale443 as any, false)).toBe(false);
    });

    it('a request with no Origin is never a match', async () => {
        const m = await load({ trustProxy: true });
        expect(m.originSchemeMatches({ host: 'x', 'x-forwarded-proto': 'https' } as any, true)).toBe(false);
    });
});
