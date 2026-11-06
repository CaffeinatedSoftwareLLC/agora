import { BlockList, isIPv4 } from 'node:net';
import { BOX_HOST_OFFSET, EDGE_HOST_OFFSET } from '../../lib/boxes/contract';

/**
 * Which box a connection comes from (docs/agent-boxes.md §3.3): the network it arrived on.
 * The edge's own address on that network (the connection's local address, `.2`) names the
 * box whose /28 contains it; the remote address must be that box's `.3`.
 */

export interface EdgeBox {
    id: string;
    serverId: string;
    generation: number;
    subnet: string | null;
    allowedDomains: string[];
    homeChannelId: string | null;
    /** The box's CLI (agent_profiles.adapter): which provider domains a login may wait on. */
    adapter?: string | null;
}

export type Identify = (localAddress: string, remoteAddress: string) => Promise<EdgeBox | null>;

/** `::ffff:10.0.0.2` → `10.0.0.2`; anything not IPv4 stays as it is (box networks are IPv4). */
export function plainAddress(address: string | undefined): string {
    if (!address) return '';
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    return m ? m[1] : address;
}

function ipv4ToInt(ip: string): number {
    return ip.split('.').reduce((acc, part) => (acc * 256) + Number(part), 0);
}
function intToIpv4(n: number): string {
    return [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');
}

/** The edge's and the box's addresses in a box subnet (`10.213.0.16/28` → `.18`, `.19`). */
export function boxAddresses(subnet: string): { edge: string; box: string } | null {
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(subnet);
    if (!m || !isIPv4(m[1])) return null;
    const prefix = Number(m[2]);
    if (prefix < 8 || prefix > 29) return null;
    const size = 2 ** (32 - prefix);
    const base = ipv4ToInt(m[1]) - (ipv4ToInt(m[1]) % size);
    return { edge: intToIpv4(base + EDGE_HOST_OFFSET), box: intToIpv4(base + BOX_HOST_OFFSET) };
}

/** The address rule itself, over a list of box rows. */
export function matchBox(boxes: EdgeBox[], localAddress: string, remoteAddress: string): EdgeBox | null {
    const local = plainAddress(localAddress);
    const remote = plainAddress(remoteAddress);
    if (!isIPv4(local) || !isIPv4(remote)) return null;
    for (const box of boxes) {
        if (!box.subnet) continue;
        const addrs = boxAddresses(box.subnet);
        if (!addrs) continue;
        const [net, bits] = box.subnet.split('/');
        const list = new BlockList();
        try { list.addSubnet(net, Number(bits), 'ipv4'); } catch { continue; }
        if (!list.check(local, 'ipv4')) continue;
        // The network matched: it is this box or nobody
        return local === addrs.edge && remote === addrs.box ? box : null;
    }
    return null;
}

/** Box rows, cached for a few seconds so every connection doesn't cost a query. */
export class BoxDirectory {
    private rows: EdgeBox[] = [];
    private loadedAt = 0;
    private loading: Promise<EdgeBox[]> | null = null;

    constructor(private db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, private ttlMs = 3000) {}

    async all(): Promise<EdgeBox[]> {
        if (Date.now() - this.loadedAt < this.ttlMs) return this.rows;
        if (!this.loading) {
            this.loading = this.load().finally(() => { this.loading = null; });
        }
        return this.loading;
    }

    private async load(): Promise<EdgeBox[]> {
        const res = await this.db.query(
            `SELECT b.id, b.server_id, b.generation, b.subnet, b.allowed_domains, b.home_channel_id, p.adapter
             FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id
             WHERE b.deleted_at IS NULL AND b.desired_state <> 'deleted'`
        );
        this.rows = res.rows.map(r => ({
            id: r.id.trim(), serverId: r.server_id.trim(), generation: Number(r.generation), subnet: r.subnet,
            allowedDomains: r.allowed_domains ?? [], homeChannelId: r.home_channel_id?.trim() ?? null,
            adapter: r.adapter ?? null,
        }));
        this.loadedAt = Date.now();
        return this.rows;
    }

    async byId(id: string): Promise<EdgeBox | null> {
        return (await this.all()).find(b => b.id === id) ?? null;
    }

    readonly identify: Identify = async (localAddress, remoteAddress) => matchBox(await this.all(), localAddress, remoteAddress);

    invalidate() { this.loadedAt = 0; }
}
