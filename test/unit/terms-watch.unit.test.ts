import { describe, expect, it, vi } from 'vitest';
import { extractTermsText, fetchTerms, publicTermsAddress, termsDiff, termsHash, termsUrl, type TermsTransport } from '../../src/lib/terms-fetch';
import { parseTermsAnalysis } from '../../src/terms/analysis';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import context from '../../src/terms/context.json';

const response = (body = 'Terms', status = 200, location?: string, contentType = 'text/plain') => ({ status, location, contentType,
    body: (async function* () { yield Buffer.from(body); })(), close: vi.fn() });
const publicDns = async () => ['93.184.216.34'];

describe('terms text and diff', () => {
    it('deterministically extracts main content and discards navigation, scripts and hidden text', () => {
        const one = '<html><head>ignored</head><nav>Menu A</nav><main><h1> Terms &amp; conditions </h1><p>A\n  B&nbsp;C</p><nav><div>nested menu</div></nav><script>attack()</script><aside>Aside</aside><p hidden>hidden</p><p aria-hidden="true">hidden2</p><p>Use &#x1f600; &#169;</p></main><footer>Footer</footer></html>';
        const two = one.replace('Menu A', 'Changing navigation').replace('A\n  B', 'A B').replace('attack()', 'newScript()');
        expect(extractTermsText(one)).toBe('Terms & conditions\nA B C\nUse 😀 ©');
        expect(termsHash(extractTermsText(one))).toBe(termsHash(extractTermsText(two)));
        expect(extractTermsText('x\r\n \r\ny  z\u200b', false)).toBe('x\ny z');
    });
    it('drops announcement banners, live regions, dialogs and buttons so page chrome cannot fake a change', () => {
        const page = (banner: string) => `<main><div class="devsite-banner devsite-banner-announcement nocontent"\n data-x>${banner}</div><div role="status">Saved 3s ago</div><div aria-live="polite">${banner}</div><dialog>Sign up</dialog><button>Copy page</button><h1>Terms</h1><p class="cookie-policy-text">Cookies are described here.</p></main>`;
        expect(extractTermsText(page('Model A launched'))).toBe('Terms\nCookies are described here.');
        expect(termsHash(extractTermsText(page('Model A launched')))).toBe(termsHash(extractTermsText(page('Model B launched'))));
    });
    it('preserves text in raw markdown and normalizes unicode', () => {
        expect(extractTermsText(' # T\n\nCafe\u0301 <literal> ', false)).toBe('# T\nCafé <literal>');
    });
    it('rejects pathological nesting before it can consume unbounded parser work', () => {
        expect(() => extractTermsText('<div>'.repeat(257) + 'Terms')).toThrow('nesting');
    });
    it('makes a deterministic unified diff with context and caps rewrites', () => {
        expect(termsDiff('one\ntwo\nthree', 'one\nnew\nthree')).toBe('--- previous\n+++ current\n@@ -1,3 +1,3 @@\n one\n-two\n+new\n three\n');
        expect(termsDiff('same', 'same')).toBe('');
        const diff = termsDiff('a'.repeat(50_000), 'b'.repeat(50_000));
        expect(diff.length).toBeLessThanOrEqual(24_000); expect(diff).toContain('[diff truncated]');
    });
    it('validates model impact and three bounded summary lines', () => {
        expect(parseTermsAnalysis('{"impact":"low","summary":["a","b","c"]}')).toMatchObject({impact:'low',summary:'a\nb\nc'});
        for (const raw of ['{}','{"impact":"execute","summary":["a","b","c"]}','{"impact":"high","summary":["a"]}']) expect(() => parseTermsAnalysis(raw)).toThrow();
    });
    it('bundles the actual policy documents into the server', () => {
        const read = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
        expect(context.policy).toBe(read('docs/provider-terms.md'));
        expect(context.subscription).toBe(read('docs/subscription-use.md'));
    });
});

describe('terms SSRF and bounded fetching (no internet)', () => {
    it.each(['127.0.0.1','10.0.0.1','172.16.0.1','192.168.0.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','::','fc00::1','fe80::1','::ffff:127.0.0.1','::ffff:7f00:1','2002:7f00:1::','2001:db8::1'])('blocks private/reserved address %s', ip => expect(publicTermsAddress(ip)).toBe(false));
    it('accepts public IPv4/IPv6 and rejects unsafe URL forms', () => {
        expect(publicTermsAddress('8.8.8.8')).toBe(true); expect(publicTermsAddress('2606:4700:4700::1111')).toBe(true);
        for (const url of ['http://example.com','https://u:p@example.com','https://example.com:8443','file:///etc/passwd','https://localhost','https://127.1','https://[::1]']) expect(() => termsUrl(url,[new URL(url).hostname])).toThrow();
        expect(() => termsUrl('https://evil.example',['example.com'])).toThrow();
    });
    it('pins the public DNS result passed to the transport, strips HTML and closes the body', async () => {
        const res = response('<main><p>Read me</p></main>',200,undefined,'text/html'); const transport = vi.fn<TermsTransport>(async () => res);
        expect(await fetchTerms('https://example.com',['example.com'],{resolve:publicDns,transport})).toBe('Read me');
        expect(transport.mock.calls[0][1]).toBe('93.184.216.34'); expect(res.close).toHaveBeenCalledOnce();
    });
    it('rejects mixed public/private DNS before making any request', async () => {
        const transport = vi.fn();
        await expect(fetchTerms('https://example.com',['example.com'],{resolve:async()=>['8.8.8.8','10.1.2.3'],transport})).rejects.toThrow('blocked');
        expect(transport).not.toHaveBeenCalled();
    });
    it('blocks redirects to private IPs even when explicitly allowlisted', async () => {
        const transport = vi.fn(async () => response('',302,'https://127.0.0.1/secret'));
        await expect(fetchTerms('https://example.com',['example.com','127.0.0.1'],{resolve:publicDns,transport})).rejects.toThrow('blocked');
        expect(transport).toHaveBeenCalledOnce();
    });
    it('rechecks DNS for an allowlisted redirect hostname and for same-host rebinding', async () => {
        for (const location of ['https://next.example/secret','/next']) {
            const resolve = vi.fn().mockResolvedValueOnce(['8.8.8.8']).mockResolvedValueOnce(['169.254.169.254']);
            const transport = vi.fn(async () => response('',302,location));
            await expect(fetchTerms('https://example.com',['example.com','next.example'],{resolve,transport})).rejects.toThrow('blocked');
            expect(transport).toHaveBeenCalledOnce(); expect(resolve).toHaveBeenCalledTimes(2);
        }
    });
    it('blocks unlisted redirect hosts and stops after three redirects', async () => {
        const redirect: TermsTransport = async () => response('',302,'https://other.example/');
        await expect(fetchTerms('https://example.com',['example.com'],{resolve:publicDns,transport:redirect})).rejects.toThrow('allowlisted');
        const transport = vi.fn(async () => response('',302,'/again'));
        await expect(fetchTerms('https://example.com',['example.com'],{resolve:publicDns,transport})).rejects.toThrow('Too many redirects');
        expect(transport).toHaveBeenCalledTimes(4);
    });
    it('decodes gzip bodies and counts the decoded size against the cap', async () => {
        const gz = (text: string) => ({ status: 200, contentType: 'text/plain', contentEncoding: 'gzip', body: (async function* () { yield gzipSync(text); })(), close: vi.fn() });
        expect(await fetchTerms('https://example.com',['example.com'],{resolve:publicDns,transport:async()=>gz('Terms text')})).toBe('Terms text');
        await expect(fetchTerms('https://example.com',['example.com'],{resolve:publicDns,transport:async()=>gz('x'.repeat(100_000)),maxBytes:1000})).rejects.toThrow('size cap');
    });
    it('allows exactly three safe redirects', async () => {
        let count=0; const transport: TermsTransport = async () => ++count<=3 ? response('',302,'/next') : response('ok');
        expect(await fetchTerms('https://example.com',['example.com'],{resolve:publicDns,transport})).toBe('ok');
    });
    it('bounds bytes, DNS time, HTTP failures, unsupported types and empty documents', async () => {
        for (const res of [response('12345'),response('',403),response('',200,undefined,'application/pdf'),response(''),{...response('zstd bytes'),contentEncoding:'zstd'}]) {
            await expect(fetchTerms('https://example.com',['example.com'],{resolve:publicDns,transport:async()=>res,maxBytes:4})).rejects.toThrow();
            expect(res.close).toHaveBeenCalledOnce();
        }
        await expect(fetchTerms('https://example.com',['example.com'],{resolve:()=>new Promise(()=>{}),timeoutMs:5})).rejects.toThrow('timed out');
    });
});
