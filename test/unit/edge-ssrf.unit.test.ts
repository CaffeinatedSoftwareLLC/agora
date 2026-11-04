import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { isBlockedAddress, looksLikeIpLiteral, pinAddress } from '../../src/boxes/edge/ssrf';
import { createForwardProxy, normalizeHost } from '../../src/boxes/edge/forward-proxy';
import { silentLog, type EdgeDeps } from '../../src/boxes/edge/common';
import type { EdgeBox } from '../../src/boxes/edge/identity';

/** docs/agent-boxes.md §4.2: the pinned SSRF guard and the forward proxy's use of it. */

describe('isBlockedAddress', () => {
    const blocked: Record<string, string[]> = {
        private: ['10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1'],
        loopback: ['127.0.0.1', '127.255.255.254', '::1'],
        'link-local': ['169.254.169.254', 'fe80::1'],
        multicast: ['224.0.0.1', '239.255.255.250', 'ff02::1'],
        reserved: ['0.0.0.0', '240.0.0.1', '255.255.255.255', '192.0.2.1', '198.51.100.7', '203.0.113.9', '198.18.0.1', '192.0.0.8', '::', '100::1', '2001:db8::1', '4000::1', 'fec0::1'],
        cgnat: ['100.64.0.1', '100.127.255.254'],
        'ipv4-mapped': ['::ffff:127.0.0.1', '::ffff:8.8.8.8', '::ffff:7f00:1', '::ffff:0808:0808'],
        nat64: ['64:ff9b::7f00:1', '64:ff9b::808:808', '64:ff9b:1::1'],
        '6to4 and teredo': ['2002:7f00:1::', '2001:0:4136:e378::1'],
        'unique local': ['fc00::1', 'fd12:3456::1'],
    };
    for (const [klass, addrs] of Object.entries(blocked)) {
        it(`blocks ${klass}`, () => {
            for (const a of addrs) expect(isBlockedAddress(a), a).toBe(true);
        });
    }

    it('allows public addresses', () => {
        for (const a of ['8.8.8.8', '1.1.1.1', '140.82.112.3', '2606:4700::1111', '2a00:1450:4001::200e']) expect(isBlockedAddress(a), a).toBe(false);
    });

    it('blocks anything inside the edge\'s own interface subnets', () => {
        const subnets = [{ address: '44.0.0.0', prefix: 24, family: 'ipv4' as const }];
        expect(isBlockedAddress('44.0.0.9', subnets)).toBe(true);
        expect(isBlockedAddress('44.0.1.9', subnets)).toBe(false);
    });

    it('blocks a non-IP', () => {
        expect(isBlockedAddress('example.com')).toBe(true);
    });
});

describe('pinAddress', () => {
    const none = () => [];

    it('refuses if ANY answer is blocked', async () => {
        expect(await pinAddress('x.example.com', { resolve: async () => ['8.8.8.8', '10.0.0.1'], subnets: none })).toEqual({ ok: false, reason: 'blocked' });
    });

    it('returns the validated address, preferring IPv4', async () => {
        expect(await pinAddress('x.example.com', { resolve: async () => ['2606:4700::1111', '8.8.4.4'], subnets: none })).toEqual({ ok: true, address: '8.8.4.4' });
    });

    it('treats no answers and resolver errors as unresolvable', async () => {
        expect(await pinAddress('x.example.com', { resolve: async () => [], subnets: none })).toEqual({ ok: false, reason: 'unresolvable' });
        expect(await pinAddress('x.example.com', { resolve: async () => { throw new Error('nx'); }, subnets: none })).toEqual({ ok: false, reason: 'unresolvable' });
    });

    it('resolves again on every call (no caching across attempts)', async () => {
        const answers = [['8.8.8.8'], ['127.0.0.1']];
        const resolve = vi.fn(async () => answers.shift()!);
        expect((await pinAddress('rebind.example.com', { resolve, subnets: none })).ok).toBe(true);
        expect(await pinAddress('rebind.example.com', { resolve, subnets: none })).toEqual({ ok: false, reason: 'blocked' });
        expect(resolve).toHaveBeenCalledTimes(2);
    });
});

describe('IP literals', () => {
    it('recognises every spelling', () => {
        for (const h of ['127.0.0.1', '[::1]', '::1', '2130706433', '0x7f000001', '0177.0.0.1', '127.1', '10.1']) expect(looksLikeIpLiteral(h), h).toBe(true);
        for (const h of ['example.com', 'a1.example.com', '1password.com']) expect(looksLikeIpLiteral(h), h).toBe(false);
        expect(normalizeHost('127.0.0.1')).toEqual({ error: 'ip' });
        expect(normalizeHost('[::1]')).toEqual({ error: 'ip' });
        expect(normalizeHost('Example.COM.')).toEqual({ host: 'example.com' });
        expect(normalizeHost('*.example.com')).toEqual({ error: 'invalid' });
        expect(normalizeHost('postgres')).toEqual({ error: 'invalid' });
    });
});

describe('forward proxy dials the validated address', () => {
    const box: EdgeBox = { id: '01J0000000000000000000BOX1', serverId: 'S', generation: 1, subnet: null, allowedDomains: ['allowed.example.com', '*.cdn.example.net'], homeChannelId: null };
    const deps: EdgeDeps = { db: {} as any, encryptionKey: Buffer.alloc(32), publish: async () => undefined, githubBase: '', githubApiBase: '', log: silentLog };
    let target: net.Server; let targetPort: number;
    let web: http.Server; let webPort: number; let webHost: string | undefined;
    let proxy: http.Server; let proxyPort: number;
    let answers: string[][];
    const resolve = vi.fn(async () => answers.shift() ?? []);
    const dialed: [string, number][] = [];

    beforeAll(async () => {
        target = net.createServer(s => s.on('data', d => s.write(d)));
        await new Promise<void>(r => target.listen(0, '127.0.0.1', r));
        targetPort = (target.address() as AddressInfo).port;
        web = http.createServer((req, res) => { webHost = req.headers.host; res.end(`path=${req.url}`); });
        await new Promise<void>(r => web.listen(0, '127.0.0.1', r));
        webPort = (web.address() as AddressInfo).port;
        proxy = createForwardProxy({
            deps, identify: async () => box, resolve, subnets: () => [], track: () => undefined,
            dial: (address, port) => { dialed.push([address, port]); return net.connect({ host: '127.0.0.1', port: port === 443 ? targetPort : webPort }); },
        });
        await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
        proxyPort = (proxy.address() as AddressInfo).port;
    });
    afterAll(async () => {
        for (const s of [target, web, proxy]) await new Promise<void>(r => s.close(() => r()));
    });

    function connect(authority: string): Promise<string> {
        return new Promise((resolveP, reject) => {
            const s = net.connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
            let buf = '';
            s.on('data', d => {
                buf += d.toString();
                if (buf.startsWith('HTTP/1.1 200') && buf.includes('\r\n\r\n') && !buf.includes('ping')) s.write('ping');
                if (buf.includes('ping')) { s.destroy(); resolveP(buf); }
            });
            s.on('end', () => resolveP(buf));
            s.on('close', () => resolveP(buf));
            s.on('error', reject);
        });
    }

    it('public answer → tunnel to that address; the rebound private answer next time → refused', async () => {
        answers = [['93.184.216.34'], ['10.0.0.5']];
        resolve.mockClear(); dialed.length = 0;
        const first = await connect('allowed.example.com:443');
        expect(first).toMatch(/^HTTP\/1.1 200/);
        expect(first).toContain('ping');
        expect(dialed).toEqual([['93.184.216.34', 443]]);
        expect(resolve).toHaveBeenCalledTimes(1);

        const second = await connect('allowed.example.com:443');
        expect(second).toMatch(/^HTTP\/1.1 403/);
        expect(second).toContain('can\'t reach');
        expect(dialed).toHaveLength(1);
    });

    it('a mixed answer is refused outright', async () => {
        answers = [['93.184.216.34', '169.254.169.254']];
        dialed.length = 0;
        expect(await connect('x.cdn.example.net:443')).toMatch(/^HTTP\/1.1 403/);
        expect(dialed).toHaveLength(0);
    });

    it('IP literals and other ports are refused without resolving', async () => {
        resolve.mockClear();
        expect(await connect('127.0.0.1:443')).toMatch(/^HTTP\/1.1 403/);
        expect(await connect('[::1]:443')).toMatch(/^HTTP\/1.1 403/);
        expect(await connect('2130706433:443')).toMatch(/^HTTP\/1.1 403/);
        expect(await connect('allowed.example.com:22')).toMatch(/^HTTP\/1.1 403/);
        expect(resolve).not.toHaveBeenCalled();
    });

    it('plain HTTP goes to the validated address with the original Host', async () => {
        answers = [['93.184.216.34']];
        dialed.length = 0;
        const res = await new Promise<{ status: number; body: string }>((resolveP, reject) => {
            const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: 'http://allowed.example.com/a?b=1' }, r => {
                let body = ''; r.on('data', d => { body += d; }); r.on('end', () => resolveP({ status: r.statusCode!, body }));
            });
            req.on('error', reject); req.end();
        });
        expect(res).toEqual({ status: 200, body: 'path=/a?b=1' });
        expect(dialed).toEqual([['93.184.216.34', 80]]);
        expect(webHost).toBe('allowed.example.com');
    });

    it('plain HTTP to an IP literal is refused', async () => {
        const status = await new Promise<number>((resolveP, reject) => {
            const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: 'http://169.254.169.254/latest' }, r => { r.resume(); resolveP(r.statusCode!); });
            req.on('error', reject); req.end();
        });
        expect(status).toBe(403);
    });
});
