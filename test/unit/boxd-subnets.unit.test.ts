import { describe, expect, it } from 'vitest';
import { boxAddress, edgeAddress, gatewayAddress, isOverlapError, overlaps, parseCidr, parsePools, pickSubnet } from '../../src/boxes/boxd/subnets';

describe('boxd subnets', () => {
    it('parses IPv4 CIDRs and ignores IPv6', () => {
        expect(parseCidr('10.213.0.0/16')).toEqual({ base: (10 << 24 >>> 0) + (213 << 16), prefix: 16 });
        expect(parseCidr('10.213.0.5/28')!.base).toBe(parseCidr('10.213.0.0/28')!.base);
        expect(parseCidr('fd00::/64')).toBeNull();
        expect(parseCidr('300.1.1.1/8')).toBeNull();
        expect(parseCidr('10.0.0.0/33')).toBeNull();
    });

    it('takes the first /28 of the pool when nothing is used', () => {
        expect(pickSubnet(parsePools('10.213.0.0/16'), [])).toBe('10.213.0.0/28');
    });

    it('skips every subnet any engine network or other box uses, whatever its size', () => {
        const taken = ['10.213.0.0/28', '10.213.0.16/28', '172.17.0.0/16', '10.213.0.32/27', 'fd00::/64'];
        expect(pickSubnet(parsePools('10.213.0.0/16'), taken)).toBe('10.213.0.64/28');
        // A wider network covering the whole pool leaves nothing
        expect(pickSubnet(parsePools('10.213.0.0/16'), ['10.0.0.0/8'])).toBeNull();
    });

    it('moves to the next pool when the first is full', () => {
        expect(pickSubnet(parsePools('10.213.0.0/28, 10.214.0.0/24'), ['10.213.0.0/28'])).toBe('10.214.0.0/28');
    });

    it('rejects pools smaller than a /28 and empty specs', () => {
        expect(() => parsePools('10.0.0.0/29')).toThrow();
        expect(() => parsePools('nonsense')).toThrow();
        expect(() => parsePools(' , ')).toThrow();
    });

    it('detects overlap both ways', () => {
        expect(overlaps(parseCidr('10.0.0.0/8')!, parseCidr('10.213.0.16/28')!)).toBe(true);
        expect(overlaps(parseCidr('10.213.0.16/28')!, parseCidr('10.213.0.0/28')!)).toBe(false);
    });

    it('puts the bridge at .1, the edge at .2 and the box at .3', () => {
        expect(gatewayAddress('10.213.0.48/28')).toBe('10.213.0.49');
        expect(edgeAddress('10.213.0.48/28')).toBe('10.213.0.50');
        expect(boxAddress('10.213.0.48/28')).toBe('10.213.0.51');
        expect(() => boxAddress('10.213.0.0/24')).toThrow();
    });

    it("recognizes Docker's overlap error", () => {
        expect(isOverlapError({ statusCode: 403, json: { message: 'Pool overlaps with other one on this address space' } })).toBe(true);
        expect(isOverlapError(new Error('invalid pool request: Pool overlaps with other one on this address space'))).toBe(true);
        expect(isOverlapError(new Error('network with name x already exists'))).toBe(false);
    });
});
