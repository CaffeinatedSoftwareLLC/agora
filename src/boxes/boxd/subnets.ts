import { BOX_HOST_OFFSET, DEFAULT_BOX_SUBNETS, EDGE_HOST_OFFSET } from '../../lib/boxes/contract';

/**
 * Box subnets (docs/agent-boxes.md §3.3): each box network is a /28 taken from
 * AGORA_BOX_SUBNETS, skipping every subnet any network on the engine already uses, so a
 * second install on the same engine (#209) or an unrelated network never overlaps.
 */

export const BOX_PREFIX = 28;
const BLOCK = 2 ** (32 - BOX_PREFIX);

export interface Cidr { base: number; prefix: number }

function ipToInt(ip: string): number {
    const parts = ip.split('.');
    if (parts.length !== 4) throw new Error(`Invalid IPv4 address "${ip}"`);
    let n = 0;
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p) || Number(p) > 255) throw new Error(`Invalid IPv4 address "${ip}"`);
        n = n * 256 + Number(p);
    }
    return n;
}

export function intToIp(n: number): string {
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Parses an IPv4 CIDR; null for IPv6 or anything else (other networks' v6 ranges can't overlap ours). */
export function parseCidr(cidr: string): Cidr | null {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr.trim());
    if (!m) return null;
    const prefix = Number(m[2]);
    if (prefix > 32) return null;
    let ip: number;
    try { ip = ipToInt(m[1]); } catch { return null; }
    const size = 2 ** (32 - prefix);
    return { base: ip - (ip % size), prefix };
}

function range(c: Cidr): [number, number] {
    return [c.base, c.base + 2 ** (32 - c.prefix) - 1];
}

export function overlaps(a: Cidr, b: Cidr): boolean {
    const [a0, a1] = range(a);
    const [b0, b1] = range(b);
    return a0 <= b1 && b0 <= a1;
}

/** The pools in AGORA_BOX_SUBNETS (comma-separated IPv4 CIDRs, each /28 or larger). */
export function parsePools(spec = DEFAULT_BOX_SUBNETS): Cidr[] {
    const pools = spec.split(',').map(s => s.trim()).filter(Boolean).map(s => {
        const c = parseCidr(s);
        if (!c || c.prefix > BOX_PREFIX) throw new Error(`AGORA_BOX_SUBNETS entry "${s}" must be an IPv4 CIDR of /${BOX_PREFIX} or larger`);
        return c;
    });
    if (pools.length === 0) throw new Error('AGORA_BOX_SUBNETS is empty');
    return pools;
}

/**
 * The first /28 in the pools that overlaps none of `taken` (subnets of every engine network,
 * subnets other boxes hold in the DB, and ones that just failed with an overlap). Null when full.
 */
export function pickSubnet(pools: Cidr[], taken: string[]): string | null {
    const used = taken.map(parseCidr).filter((c): c is Cidr => c !== null);
    for (const pool of pools) {
        const [start, end] = range(pool);
        for (let base = start; base + BLOCK - 1 <= end; base += BLOCK) {
            const candidate: Cidr = { base, prefix: BOX_PREFIX };
            if (!used.some(u => overlaps(candidate, u))) return `${intToIp(base)}/${BOX_PREFIX}`;
        }
    }
    return null;
}

/** The address at `offset` in a box's /28: .1 the bridge, .2 the edge, .3 the box. */
export function hostAddress(subnet: string, offset: number): string {
    const c = parseCidr(subnet);
    if (!c || c.prefix !== BOX_PREFIX) throw new Error(`Invalid box subnet "${subnet}"`);
    return intToIp(c.base + offset);
}
export const gatewayAddress = (subnet: string) => hostAddress(subnet, 1);
export const edgeAddress = (subnet: string) => hostAddress(subnet, EDGE_HOST_OFFSET);
export const boxAddress = (subnet: string) => hostAddress(subnet, BOX_HOST_OFFSET);

/** Docker's reply when a requested subnet overlaps an existing network. */
export function isOverlapError(err: unknown): boolean {
    const msg = String((err as any)?.json?.message ?? (err as any)?.message ?? err);
    return /overlap/i.test(msg);
}
