import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import {
    addCall,
    removeCall,
    getCallByChannel,
    getCallById,
    isUserInCall,
    setCallConnected,
    clearAllCalls,
    startCallTimeout,
    clearCallTimeout,
    type ActiveCall,
} from '../../src/call-state';

function makeCall(overrides?: Partial<ActiveCall>): ActiveCall {
    return {
        callId: 'call-1',
        channelId: 'ch-1',
        callerId: 'user-a',
        callerUsername: 'alice',
        recipientId: 'user-b',
        callType: 'voice',
        status: 'ringing',
        startedAt: Date.now(),
        ...overrides,
    };
}

beforeEach(() => {
    clearAllCalls();
});

describe('clearAllCalls', () => {
    test('empties all maps', () => {
        addCall(makeCall());
        clearAllCalls();

        expect(getCallByChannel('ch-1')).toBeUndefined();
        expect(getCallById('call-1')).toBeUndefined();
        expect(isUserInCall('user-a')).toBeUndefined();
        expect(isUserInCall('user-b')).toBeUndefined();
    });
});

describe('addCall', () => {
    test('populates all three maps correctly', () => {
        const call = makeCall();
        const err = addCall(call);
        expect(err).toBeNull();

        expect(getCallByChannel('ch-1')).toBe(call);
        expect(getCallById('call-1')).toBe(call);
        expect(isUserInCall('user-a')).toBe('call-1');
        // Recipient is NOT in userInCall until they accept
        expect(isUserInCall('user-b')).toBeUndefined();
    });

    test('returns channel_already_active for duplicate channel', () => {
        addCall(makeCall());
        const err = addCall(makeCall({ callId: 'call-2', callerId: 'user-c', recipientId: 'user-d' }));
        expect(err).toBe('channel_already_active');
    });

    test('returns caller_in_call for duplicate caller', () => {
        addCall(makeCall());
        const err = addCall(makeCall({ callId: 'call-2', channelId: 'ch-2', recipientId: 'user-d' }));
        expect(err).toBe('caller_in_call');
    });

    test('returns recipient_in_call for duplicate recipient', () => {
        addCall(makeCall());
        // user-a is the caller in call-1, so if another call has user-a as recipient,
        // user-a is in userInCall as caller → recipient_in_call won't fire.
        // Instead test: user-b accepted (connected), then a new call targets user-b.
        // Actually, user-b is NOT in userInCall until accept. But addCall checks
        // userInCall.has(recipientId). So we need user-b to be in another call.
        // Let's have user-b be caller of a second call, then a third call targets user-b.
        addCall(makeCall({ callId: 'call-2', channelId: 'ch-2', callerId: 'user-b', recipientId: 'user-c' }));
        const err = addCall(makeCall({ callId: 'call-3', channelId: 'ch-3', callerId: 'user-d', recipientId: 'user-b' }));
        expect(err).toBe('recipient_in_call');
    });
});

describe('removeCall', () => {
    test('clears all maps for both users', () => {
        addCall(makeCall());
        const removed = removeCall('call-1');

        expect(removed).toBeDefined();
        expect(removed!.callId).toBe('call-1');
        expect(getCallByChannel('ch-1')).toBeUndefined();
        expect(getCallById('call-1')).toBeUndefined();
        expect(isUserInCall('user-a')).toBeUndefined();
        expect(isUserInCall('user-b')).toBeUndefined();
    });

    test('returns undefined for non-existent callId', () => {
        expect(removeCall('nonexistent')).toBeUndefined();
    });
});

describe('getCallByChannel / getCallById', () => {
    test('return correct calls', () => {
        const call = makeCall();
        addCall(call);

        expect(getCallByChannel('ch-1')).toBe(call);
        expect(getCallById('call-1')).toBe(call);
    });

    test('return undefined for unknown keys', () => {
        expect(getCallByChannel('unknown')).toBeUndefined();
        expect(getCallById('unknown')).toBeUndefined();
    });
});

describe('isUserInCall', () => {
    test('returns callId for caller after addCall', () => {
        addCall(makeCall());
        expect(isUserInCall('user-a')).toBe('call-1');
    });

    test('returns undefined for recipient before accept', () => {
        addCall(makeCall());
        expect(isUserInCall('user-b')).toBeUndefined();
    });

    test('returns callId for recipient after setCallConnected', () => {
        addCall(makeCall());
        setCallConnected('call-1');
        expect(isUserInCall('user-b')).toBe('call-1');
    });
});

describe('setCallConnected', () => {
    test('marks call as connected and records connectedAt', () => {
        addCall(makeCall());
        const result = setCallConnected('call-1');

        expect(result).toBe(true);
        const call = getCallById('call-1')!;
        expect(call.status).toBe('connected');
        expect(call.connectedAt).toBeDefined();
        expect(typeof call.connectedAt).toBe('number');
    });

    test('returns false for non-existent call', () => {
        expect(setCallConnected('nonexistent')).toBe(false);
    });
});

describe('lifecycle sequences', () => {
    test('addCall → removeCall → all empty', () => {
        addCall(makeCall());
        removeCall('call-1');

        expect(getCallByChannel('ch-1')).toBeUndefined();
        expect(getCallById('call-1')).toBeUndefined();
        expect(isUserInCall('user-a')).toBeUndefined();
        expect(isUserInCall('user-b')).toBeUndefined();
    });

    test('addCall → setCallConnected → removeCall → all empty', () => {
        addCall(makeCall());
        setCallConnected('call-1');

        // Verify recipient is now tracked
        expect(isUserInCall('user-b')).toBe('call-1');

        removeCall('call-1');

        expect(getCallByChannel('ch-1')).toBeUndefined();
        expect(getCallById('call-1')).toBeUndefined();
        expect(isUserInCall('user-a')).toBeUndefined();
        expect(isUserInCall('user-b')).toBeUndefined();
    });
});

describe('timeout management', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('startCallTimeout fires callback after timeout', () => {
        const call = makeCall();
        addCall(call);

        const cb = vi.fn();
        startCallTimeout(call, 5000, cb);

        vi.advanceTimersByTime(4999);
        expect(cb).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(cb).toHaveBeenCalledOnce();
    });

    test('clearCallTimeout prevents callback from firing', () => {
        const call = makeCall();
        addCall(call);

        const cb = vi.fn();
        startCallTimeout(call, 5000, cb);
        clearCallTimeout('call-1');

        vi.advanceTimersByTime(10000);
        expect(cb).not.toHaveBeenCalled();
    });

    test('callback receives snapshot preserving original call data', () => {
        const call = makeCall();
        addCall(call);

        let snapshot: ActiveCall | undefined;
        startCallTimeout(call, 100, (s) => { snapshot = s; });

        // Mutate the original call object — snapshot should still have original data
        call.status = 'connected';
        call.callType = 'video';

        vi.advanceTimersByTime(100);

        expect(snapshot).toBeDefined();
        expect(snapshot!.callId).toBe('call-1');
        expect(snapshot!.channelId).toBe('ch-1');
        expect(snapshot!.callerId).toBe('user-a');
        expect(snapshot!.recipientId).toBe('user-b');
        // Snapshot was taken at startCallTimeout time, not when callback fires
        expect(snapshot!.status).toBe('ringing');
        expect(snapshot!.callType).toBe('voice');
    });

    test('removeCall clears pending timeout', () => {
        const call = makeCall();
        addCall(call);

        const cb = vi.fn();
        startCallTimeout(call, 5000, cb);

        removeCall('call-1');
        vi.advanceTimersByTime(10000);
        expect(cb).not.toHaveBeenCalled();
    });
});
