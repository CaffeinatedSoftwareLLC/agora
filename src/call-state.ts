/**
 * In-memory call state for DM voice/video calls.
 *
 * Three maps maintain the call state:
 * - activeCalls: channelId → ActiveCall (one call per DM channel)
 * - callIdToChannel: callId → channelId (reverse lookup)
 * - userInCall: userId → callId (prevents users from being in multiple calls)
 */

export interface ActiveCall {
    callId: string;
    channelId: string;
    callerId: string;
    callerUsername: string;
    recipientId: string;
    callType: 'voice' | 'video';
    status: 'ringing' | 'connected';
    startedAt: number;
    connectedAt?: number;
}

const activeCalls = new Map<string, ActiveCall>();
const callIdToChannel = new Map<string, string>();
const userInCall = new Map<string, string>();
const callTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

// ─── Query helpers ───────────────────────────────────────────────────────

export function getCallByChannel(channelId: string): ActiveCall | undefined {
    return activeCalls.get(channelId);
}

export function getCallById(callId: string): ActiveCall | undefined {
    const channelId = callIdToChannel.get(callId);
    if (!channelId) return undefined;
    return activeCalls.get(channelId);
}

export function isUserInCall(userId: string): string | undefined {
    return userInCall.get(userId);
}

// ─── Mutations ───────────────────────────────────────────────────────────

export type AddCallError = 'channel_already_active' | 'caller_in_call' | 'recipient_in_call';

export function addCall(call: ActiveCall): AddCallError | null {
    if (activeCalls.has(call.channelId)) return 'channel_already_active';
    if (userInCall.has(call.callerId)) return 'caller_in_call';
    if (userInCall.has(call.recipientId)) return 'recipient_in_call';

    activeCalls.set(call.channelId, call);
    callIdToChannel.set(call.callId, call.channelId);
    userInCall.set(call.callerId, call.callId);
    // Recipient is NOT added to userInCall until they accept (setCallConnected)

    return null;
}

export function setCallConnected(callId: string): boolean {
    const call = getCallById(callId);
    if (!call) return false;

    call.status = 'connected';
    call.connectedAt = Date.now();
    userInCall.set(call.recipientId, call.callId);
    return true;
}

export function removeCall(callId: string): ActiveCall | undefined {
    const channelId = callIdToChannel.get(callId);
    if (!channelId) return undefined;

    const call = activeCalls.get(channelId);
    if (!call) return undefined;

    activeCalls.delete(channelId);
    callIdToChannel.delete(callId);
    userInCall.delete(call.callerId);
    userInCall.delete(call.recipientId);
    clearCallTimeout(callId);

    return call;
}

// ─── Timeout management ─────────────────────────────────────────────────

export function startCallTimeout(
    call: ActiveCall,
    timeoutMs: number,
    callback: (callSnapshot: ActiveCall) => void,
): void {
    // Capture a snapshot so callback has all data even if call was removed
    const snapshot = { ...call };
    const timer = setTimeout(() => {
        callTimeouts.delete(call.callId);
        callback(snapshot);
    }, timeoutMs);
    callTimeouts.set(call.callId, timer);
}

export function clearCallTimeout(callId: string): void {
    const timer = callTimeouts.get(callId);
    if (timer) {
        clearTimeout(timer);
        callTimeouts.delete(callId);
    }
}

// ─── Test utility ────────────────────────────────────────────────────────

export function clearAllCalls(): void {
    activeCalls.clear();
    callIdToChannel.clear();
    userInCall.clear();
    for (const timer of callTimeouts.values()) {
        clearTimeout(timer);
    }
    callTimeouts.clear();
}
