import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { Readable, pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

export const MAX_TERMS_BYTES = 2 * 1024 * 1024;
export const TERMS_TIMEOUT_MS = 20_000;
const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blocked.addSubnet(ip, bits, 'ipv4');
// Permit only global IPv6 unicast, excluding special-purpose ranges inside it.
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6'); blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('3fff::', 20, 'ipv6');
export function publicTermsAddress(ip: string): boolean {
    if (isIP(ip) === 4) return !blocked.check(ip, 'ipv4');
    return isIP(ip) === 6 && global6.check(ip, 'ipv6') && !blocked.check(ip, 'ipv6');
}

export function termsUrl(raw: string, hosts: string[]): URL {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Only HTTPS on port 443 without credentials is allowed');
    if (!hosts.includes(url.hostname.toLowerCase())) throw new Error('Redirect host is not allowlisted');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !publicTermsAddress(host)) throw new Error('Private or reserved address blocked');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Local host blocked');
    url.hash = '';
    return url;
}
export type TermsResolver = (host: string) => Promise<string[]>;
export type TermsResponse = { status: number; location?: string; contentType?: string; contentEncoding?: string; body: AsyncIterable<Uint8Array>; close(): void };
export type TermsTransport = (url: URL, address: string, signal: AbortSignal) => Promise<TermsResponse>;
const resolve: TermsResolver = async host => (await lookup(host, { all: true, verbatim: true })).map(r => r.address);

// The validated address is pinned at connection time. TLS and Host still use the original hostname.
const transport: TermsTransport = (url, address, signal) => new Promise((accept, reject) => {
    const req = request(url, {
        agent: false, signal,
        lookup: ((_host: string, opts: { all?: boolean }, cb: Function) => opts.all
            ? cb(null, [{ address, family: isIP(address) }]) : cb(null, address, isIP(address))) as any,
        headers: { 'User-Agent': 'Agora-Terms-Watcher/1.0 (daily provider compliance monitoring)', Accept: 'text/html,text/plain,text/markdown', 'Accept-Encoding': 'identity' },
    }, res => accept({ status: res.statusCode ?? 0, location: res.headers.location,
        contentType: res.headers['content-type'], contentEncoding: res.headers['content-encoding'], body: res, close: () => res.destroy() }));
    req.on('error', reject); req.end();
});

export async function fetchTerms(raw: string, hosts: string[], deps: { resolve?: TermsResolver; transport?: TermsTransport; timeoutMs?: number; maxBytes?: number } = {}): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Fetch timed out')); }, deps.timeoutMs ?? TERMS_TIMEOUT_MS); });
    const work = async () => {
        let url = termsUrl(raw, hosts);
        for (let redirects = 0; ; redirects++) {
            const host = url.hostname.replace(/^\[|\]$/g, '');
            const addresses = isIP(host) ? [host] : await (deps.resolve ?? resolve)(host);
            if (!addresses.length || addresses.some(ip => !publicTermsAddress(ip))) throw new Error('Private or reserved address blocked');
            controller.signal.throwIfAborted();
            const res = await (deps.transport ?? transport)(url, addresses[0], controller.signal);
            try {
                if ([301, 302, 303, 307, 308].includes(res.status)) {
                    if (redirects >= 3 || !res.location) throw new Error('Too many redirects or missing Location');
                    url = termsUrl(new URL(res.location, url).href, hosts);
                    continue;
                }
                if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
                const type = (res.contentType ?? '').split(';')[0].trim().toLowerCase();
                if (!['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown'].includes(type)) throw new Error('Unsupported document content type');
                const chunks: Buffer[] = []; let size = 0;
                // Some hosts send gzip even when asked for identity. The byte cap counts
                // decoded bytes, so a compression bomb stops at the cap.
                for await (const chunk of decodedBody(res.body, res.contentEncoding)) {
                    controller.signal.throwIfAborted(); size += chunk.byteLength;
                    if (size > (deps.maxBytes ?? MAX_TERMS_BYTES)) throw new Error('Document exceeds size cap');
                    chunks.push(Buffer.from(chunk));
                }
                const text = extractTermsText(Buffer.concat(chunks).toString('utf8'), type.includes('html'));
                if (!text) throw new Error('Document has no readable text');
                return text;
            } finally { res.close(); }
        }
    };
    try { return await Promise.race([work(), timeout]); }
    finally { clearTimeout(timer!); controller.abort(); }
}

function decodedBody(body: AsyncIterable<Uint8Array>, encoding?: string): AsyncIterable<Uint8Array> {
    const enc = (encoding ?? '').trim().toLowerCase();
    if (!enc || enc === 'identity') return body;
    const z = enc === 'gzip' || enc === 'x-gzip' ? createGunzip() : enc === 'deflate' ? createInflate() : enc === 'br' ? createBrotliDecompress() : null;
    if (!z) throw new Error('Unsupported document content encoding');
    return pipeline(Readable.from(body), z, () => {});
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', copy: '©', reg: '®', bull: '•' };
function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, key: string) => {
        if (key[0] !== '#') return entities[key.toLowerCase()] ?? all;
        const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
    });
}
// Hidden elements and page chrome that changes without the document changing:
// announcement/cookie banners, toasts, live regions and dialogs.
const volatile = new RegExp([
    String.raw`\s(?:hidden(?:\s|=|/?>)|aria-hidden\s*=\s*["']?true)`,
    String.raw`\srole\s*=\s*["']?(?:banner|navigation|alert|status|dialog|alertdialog|log|marquee|timer)\b`,
    String.raw`\saria-live\s*=\s*["']?(?:polite|assertive)\b`,
    String.raw`\s(?:class|id)\s*=\s*["'](?:[^"']*[\s_-])?(?:announcement|toast|snackbar|cookie[_-]?(?:banner|consent|notice|bar)|consent[_-]?(?:banner|bar|manager))(?:[\s_-][^"']*)?["']`,
].join('|'), 'i');
export function extractTermsText(input: string, html = true): string {
    let text = input.replace(/\r\n?/g, '\n');
    if (html) {
        text = text.replace(/<!--[\s\S]*?-->/g, '');
        // Prefer the article/main landmark when present. A small token scanner keeps
        // nested navigation and hidden elements out without executing any page code.
        const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(text);
        if (main) text = main[2];
        const stack: { tag: string; skip: boolean }[] = []; const out: string[] = [];
        const ignored = /^(script|style|nav|header|footer|aside|noscript|svg|template|head|dialog|button)$/;
        for (const token of text.match(/<[^>]*>|[^<]+/g) ?? []) {
            if (!token.startsWith('<')) { if (!stack.some(s => s.skip)) out.push(token.replace(/\s+/g, ' ')); continue; }
            const tag = /^<\/?\s*([\w-]+)/.exec(token)?.[1]?.toLowerCase(); if (!tag) continue;
            if (/^<\//.test(token)) {
                const i = stack.map(s => s.tag).lastIndexOf(tag); if (i >= 0) stack.splice(i);
            } else if (!/\/$/.test(token.slice(0, -1)) && !/^(br|hr|img|input|meta|link|wbr|source)$/.test(tag)) {
                if (stack.length >= 256) throw new Error('Document nesting exceeds extraction cap');
                stack.push({ tag, skip: ignored.test(tag) || volatile.test(token) });
            }
            if (!stack.some(s => s.skip) && /^(p|div|h[1-6]|li|ul|ol|br|hr|tr|section|article|main|blockquote)$/.test(tag)) out.push('\n');
        }
        text = decodeEntities(out.join(''));
    }
    return text.normalize('NFC').split('\n').map(line => line.replace(/[\s\u200b\ufeff]+/g, ' ').trim()).filter(Boolean).join('\n');
}
export const termsHash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Linear-space, single-hunk unified diff; bounded output even for a complete rewrite. */
export function termsDiff(before: string, after: string, cap = 24_000): string {
    if (before === after) return '';
    const a = before.split('\n'), b = after.split('\n'); let start = 0, end = 0;
    while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
    while (end < Math.min(a.length, b.length) - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    const lo = Math.max(0, start - 3), ae = Math.min(a.length, a.length - end + 3), be = Math.min(b.length, b.length - end + 3);
    let result = `--- previous\n+++ current\n@@ -${lo + 1},${ae - lo} +${lo + 1},${be - lo} @@\n`;
    const add = (prefix: string, lines: string[]) => { for (const line of lines) { if (result.length > cap) break; result += prefix + line + '\n'; } };
    add(' ', a.slice(lo, start)); add('-', a.slice(start, a.length - end)); add('+', b.slice(start, b.length - end)); add(' ', a.slice(a.length - end, ae));
    return result.length > cap ? result.slice(0, Math.max(0, cap - 24)) + '\n[diff truncated]\n' : result;
}
