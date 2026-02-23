import { describe, test, expect } from 'vitest';
import { mapParticipant } from '../../src/routes/voice';

describe('mapParticipant – permission field mapping', () => {
    test('includes canPublish and canSubscribe when permission is present', () => {
        const mapped = mapParticipant({
            identity: 'user-1',
            name: 'Alice',
            joinedAt: BigInt(1700000000),
            tracks: [],
            permission: { canPublish: true, canSubscribe: false },
        });

        expect(mapped.permission).toEqual({ canPublish: true, canSubscribe: false });
    });

    test('permission is undefined when source has no permission', () => {
        const mapped = mapParticipant({
            identity: 'user-2',
            name: 'Bob',
            joinedAt: BigInt(1700000000),
            tracks: [],
            permission: undefined,
        });

        expect(mapped.permission).toBeUndefined();
    });

    test('maps tracks and server-muted permission correctly', () => {
        const mapped = mapParticipant({
            identity: 'user-3',
            name: 'Charlie',
            joinedAt: BigInt(1700000000),
            tracks: [{ sid: 'TR_123', source: 1, muted: true }],
            permission: { canPublish: false, canSubscribe: true },
        });

        expect(mapped.permission).toEqual({ canPublish: false, canSubscribe: true });
        expect(mapped.tracks).toHaveLength(1);
        expect(mapped.tracks[0].muted).toBe(true);
    });

    test('converts bigint joinedAt to number', () => {
        const mapped = mapParticipant({
            identity: 'user-4',
            name: 'Diana',
            joinedAt: BigInt(1700000000),
            tracks: [],
        });

        expect(mapped.joinedAt).toBe(1700000000);
    });
});
