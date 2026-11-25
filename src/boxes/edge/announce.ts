import dgram from 'node:dgram';
import os from 'node:os';
import { BOX_HOST_OFFSET, EDGE_HOST_OFFSET } from '../../lib/boxes/contract';

/**
 * Tells a box that the edge's hardware address changed (docs/agent-boxes.md section 9.3).
 *
 * A recreated edge gets a new MAC on every box network. A gVisor box keeps its neighbour entry
 * for the edge's old MAC and answered nothing for 40 to 50 seconds (seen on CI, both architectures).
 * Resolving the box's address from the edge sends an ARP request that carries the edge's new MAC,
 * which makes the box's stack update its entry. So when the edge sees an interface on a box
 * network (its own address is the network's `.2`), it sends a few datagrams to that network's
 * `.3`. Nothing listens there; the ARP request is the point.
 */

const ipToInt = (ip: string) => ip.split('.').reduce((acc, part) => (acc * 256) + Number(part), 0);
const intToIp = (n: number) => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');

/** The box's address when `address/netmask` is the edge's own address on a box network, else null. */
export function boxPeerOf(address: string, netmask: string): string | null {
    const bits = netmask.split('.').reduce((n, o) => n + Number(o).toString(2).replace(/0/g, '').length, 0);
    if (bits < 24 || bits > 29) return null; // a box network is a /28; the default network is wider
    const size = 2 ** (32 - bits);
    const a = ipToInt(address);
    const base = a - (a % size);
    return a === base + EDGE_HOST_OFFSET ? intToIp(base + BOX_HOST_OFFSET) : null;
}

const SEND_AT_MS = [0, 500, 1500, 3500];

export function announceBoxNetworks(opts: { everyMs?: number } = {}): () => void {
    const seen = new Set<string>();
    const check = () => {
        for (const list of Object.values(os.networkInterfaces())) {
            for (const i of list ?? []) {
                if (i.family !== 'IPv4' || i.internal) continue;
                const peer = boxPeerOf(i.address, i.netmask);
                const key = `${i.address} ${i.mac}`;
                if (!peer || seen.has(key)) continue;
                seen.add(key);
                const socket = dgram.createSocket('udp4');
                socket.on('error', () => { try { socket.close(); } catch { /* closed */ } });
                socket.bind(0, i.address, () => {
                    for (const at of SEND_AT_MS) setTimeout(() => { try { socket.send('x', 9, peer); } catch { /* closed */ } }, at);
                    setTimeout(() => { try { socket.close(); } catch { /* closed */ } }, SEND_AT_MS[SEND_AT_MS.length - 1] + 1000).unref();
                });
            }
        }
    };
    check();
    const timer = setInterval(check, opts.everyMs ?? 1000);
    timer.unref();
    return () => clearInterval(timer);
}
