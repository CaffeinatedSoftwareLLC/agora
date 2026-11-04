import { boxAddresses, matchBox, plainAddress, type EdgeBox } from '../../src/boxes/edge/identity';
import { apiRequestHeaders } from '../../src/boxes/edge/reverse-proxy';
import { verifyEdge } from '../../src/lib/boxes/contract';
import { refLockKey } from '../../src/boxes/edge/locks';

/** docs/agent-boxes.md §3.3: a connection's box is the network it arrived on, checked by the source address. */

const box = (id: string, subnet: string): EdgeBox => ({ id, serverId: 'S', generation: 3, subnet, allowedDomains: [], homeChannelId: null });
const A = box('01J00000000000000000000AAA', '10.213.0.0/28');
const B = box('01J00000000000000000000BBB', '10.213.0.16/28');

describe('box identity', () => {
    it('computes the edge (.2) and box (.3) addresses of a /28', () => {
        expect(boxAddresses('10.213.0.16/28')).toEqual({ edge: '10.213.0.18', box: '10.213.0.19' });
        expect(boxAddresses('10.213.0.0/28')).toEqual({ edge: '10.213.0.2', box: '10.213.0.3' });
        expect(boxAddresses('nonsense')).toBeNull();
    });

    it('maps the local address to the box and requires its .3 as the source', () => {
        expect(matchBox([A, B], '10.213.0.18', '10.213.0.19')).toBe(B);
        expect(matchBox([A, B], '::ffff:10.213.0.2', '::ffff:10.213.0.3')).toBe(A);
    });

    it('refuses a source that is not the box', () => {
        expect(matchBox([A, B], '10.213.0.18', '10.213.0.20')).toBeNull();
        // B's address arriving on A's network
        expect(matchBox([A, B], '10.213.0.2', '10.213.0.19')).toBeNull();
    });

    it('refuses connections on networks that are no box\'s', () => {
        expect(matchBox([A, B], '172.18.0.5', '172.18.0.3')).toBeNull();
        expect(matchBox([A, B], '127.0.0.1', '127.0.0.1')).toBeNull();
        expect(matchBox([A, B], '10.213.0.34', '10.213.0.35')).toBeNull();
    });

    it('plainAddress unwraps IPv4-mapped addresses', () => {
        expect(plainAddress('::ffff:10.0.0.1')).toBe('10.0.0.1');
        expect(plainAddress('fe80::1')).toBe('fe80::1');
    });
});

describe('API request headers', () => {
    const secret = 'ab'.repeat(32);
    it('strips spoofed provenance and hop-by-hop headers, then signs', () => {
        const out = apiRequestHeaders({
            host: 'edge:8080', authorization: 'Bot x', 'x-agora-edge-box': 'SPOOF', 'x-agora-edge-sig': 'f'.repeat(64),
            'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https', forwarded: 'for=1.2.3.4', 'x-real-ip': '1.2.3.4',
            connection: 'keep-alive, x-secret', 'x-secret': 'drop', 'transfer-encoding': 'chunked', 'proxy-authorization': 'x',
        }, A, '10.213.0.3', secret);
        expect(out.authorization).toBe('Bot x');
        expect(out['x-forwarded-for']).toBe('10.213.0.3');
        for (const n of ['x-forwarded-proto', 'forwarded', 'x-real-ip', 'x-secret', 'transfer-encoding', 'proxy-authorization', 'connection']) expect(out[n]).toBeUndefined();
        expect(verifyEdge(out as any, secret)).toEqual({ boxId: A.id, generation: 3 });
    });

    it('lock keys are the same for any spelling of the repo', () => {
        expect(refLockKey('Acme', 'Widget', 'refs/heads/x')).toBe(refLockKey('acme', 'widget', 'refs/heads/x'));
        expect(refLockKey('acme', 'widget', 'refs/heads/x')).not.toBe(refLockKey('acme', 'widget', 'refs/heads/y'));
    });
});
