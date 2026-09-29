import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * SSRF guard for admin-supplied provider base URLs. The server fetches these, so
 * without a check a server admin could point Agora at internal services
 * (Postgres, Redis, MinIO, cloud metadata). Private targets are allowed only when
 * the instance setting `ai.allow_private_base_urls` is on (e.g. local Ollama).
 *
 * Note: resolution happens before the request, so DNS rebinding between check and
 * fetch is not covered; the check runs on save and again before every call.
 */

const PRIVATE = new BlockList();
PRIVATE.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');   // CGNAT
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('169.254.0.0', 16, 'ipv4');  // link-local incl. cloud metadata
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('::', 128, 'ipv6');
PRIVATE.addSubnet('::1', 128, 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');        // unique local
PRIVATE.addSubnet('fe80::', 10, 'ipv6');       // link-local

export function isPrivateAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) return PRIVATE.check(address, 'ipv4');
    if (family === 6) {
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
        if (mapped) return PRIVATE.check(mapped[1], 'ipv4');
        return PRIVATE.check(address, 'ipv6');
    }
    return true; // not an IP: treat as unsafe
}

export type BaseUrlCheck = { ok: true; url: string } | { ok: false; error: string };

export async function checkBaseUrl(
    raw: string,
    opts: { allowPrivate: boolean; resolve?: (host: string) => Promise<string[]> },
): Promise<BaseUrlCheck> {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false, error: 'base_url is not a valid URL' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, error: 'base_url must use http or https' };
    }
    if (url.username || url.password) {
        return { ok: false, error: 'base_url must not contain credentials' };
    }
    if (opts.allowPrivate) return { ok: true, url: url.toString() };

    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    try {
        addresses = isIP(host)
            ? [host]
            : await (opts.resolve ?? defaultResolve)(host);
    } catch {
        return { ok: false, error: `base_url host "${host}" could not be resolved` };
    }
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
        return {
            ok: false,
            error: 'base_url points to a private or local network address. An instance admin can allow this '
                + '(Admin → AI: allow private base URLs), e.g. for a local Ollama server.',
        };
    }
    return { ok: true, url: url.toString() };
}

async function defaultResolve(host: string): Promise<string[]> {
    const results = await lookup(host, { all: true, verbatim: true });
    return results.map(r => r.address);
}
