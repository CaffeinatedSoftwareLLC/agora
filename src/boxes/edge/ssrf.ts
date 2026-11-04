import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import os from 'node:os';
import { isPrivateAddress } from '../../lib/url-guard';

/**
 * The edge's pinned SSRF guard (docs/agent-boxes.md §4.2): resolve a name once, refuse it if
 * ANY answer is somewhere a box must not reach, and hand back the validated address so the
 * caller dials that address, never the name again.
 */

// Two lists: a BlockList also matches IPv4 addresses against IPv6 rules (as ::ffff:a.b.c.d)
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
// IPv4: url-guard's private ranges plus the special-purpose ones (RFC 6890 and successors)
for (const [net, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED_V4.addSubnet(net, bits, 'ipv4');
// IPv6: unspecified, loopback, IPv4-mapped and -compatible, NAT64 (both), discard, IETF/Teredo,
// documentation, 6to4 (can embed any IPv4), unique local, link-local, site-local, multicast
for (const [net, bits] of [
    ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
    ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
    ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) BLOCKED_V6.addSubnet(net, bits, 'ipv6');
// Only global unicast IPv6 (2000::/3) is reachable at all; everything else is reserved
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');

export interface Subnet { address: string; prefix: number; family: 'ipv4' | 'ipv6' }

/** The subnets of the edge's own interfaces: every Docker network it sits on (box networks, the default one). */
export function localSubnets(): Subnet[] {
    const out: Subnet[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list ?? []) {
            if (!ni.cidr) continue;
            const [address, prefix] = ni.cidr.split('/');
            out.push({ address, prefix: Number(prefix), family: ni.family === 'IPv6' ? 'ipv6' : 'ipv4' });
        }
    }
    return out;
}

/** True when a box must not reach this address. Anything that isn't an IP literal is blocked. */
export function isBlockedAddress(address: string, subnets: Subnet[] = []): boolean {
    const family = isIP(address);
    if (family === 0) return true;
    if (isPrivateAddress(address)) return true;
    if (family === 4) {
        if (BLOCKED_V4.check(address, 'ipv4')) return true;
    } else {
        if (BLOCKED_V6.check(address, 'ipv6') || !GLOBAL_V6.check(address, 'ipv6')) return true;
    }
    if (subnets.length > 0) {
        const own = new BlockList();
        const want = family === 4 ? 'ipv4' : 'ipv6';
        for (const s of subnets) {
            if (s.family !== want) continue;
            try { own.addSubnet(s.address, s.prefix, s.family); } catch { /* an odd interface entry: skip it */ }
        }
        if (own.check(address, want)) return true;
    }
    return false;
}

export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => {
    const results = await lookup(host, { all: true, verbatim: true });
    return results.map(r => r.address);
};

export type PinResult = { ok: true; address: string } | { ok: false; reason: 'unresolvable' | 'blocked' };

/**
 * Resolve `host` once and validate every answer. Called for every connection attempt (a retry
 * calls it again), so nothing is cached between check and dial.
 */
export async function pinAddress(host: string, opts: { resolve?: Resolver; subnets?: () => Subnet[] } = {}): Promise<PinResult> {
    let answers: string[];
    try {
        answers = await (opts.resolve ?? systemResolver)(host);
    } catch {
        return { ok: false, reason: 'unresolvable' };
    }
    if (!Array.isArray(answers) || answers.length === 0) return { ok: false, reason: 'unresolvable' };
    const subnets = (opts.subnets ?? localSubnets)();
    if (answers.some(a => isBlockedAddress(a, subnets))) return { ok: false, reason: 'blocked' };
    // Prefer IPv4: Docker networks are usually v4-only, so a v6 answer may have no route out
    const v4 = answers.find(a => isIP(a) === 4);
    return { ok: true, address: v4 ?? answers[0] };
}

/** An IP literal in any spelling a resolver or socket might accept (dotted, bracketed, numeric). */
export function looksLikeIpLiteral(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, '');
    if (isIP(h)) return true;
    // inet_aton forms: 2130706433, 0x7f000001, 0177.0.0.1, 127.1
    return /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/i.test(h);
}
