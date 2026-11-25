import { describe, expect, it } from 'vitest';
import { boxPeerOf } from '../../src/boxes/edge/announce';

describe('edge announce', () => {
    it('names the box (.3) only on the edge\'s own address (.2) of a box network', () => {
        expect(boxPeerOf('10.214.0.18', '255.255.255.240')).toBe('10.214.0.19');
        expect(boxPeerOf('10.214.0.2', '255.255.255.240')).toBe('10.214.0.3');
        // the box's own address, another host in the network, and the default network
        expect(boxPeerOf('10.214.0.19', '255.255.255.240')).toBeNull();
        expect(boxPeerOf('10.214.0.17', '255.255.255.240')).toBeNull();
        expect(boxPeerOf('172.18.0.2', '255.255.0.0')).toBeNull();
    });
});
