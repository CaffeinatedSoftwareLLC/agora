import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCallStore } from './callStore';
import { useVoiceStore } from './voiceStore';

// Mock the API module
vi.mock('../lib/api', () => ({
  callApi: {
    initiate: vi.fn(),
    accept: vi.fn(),
    decline: vi.fn(),
    cancel: vi.fn(),
    end: vi.fn(),
  },
}));

import { callApi } from '../lib/api';

const mockedCallApi = callApi as {
  initiate: ReturnType<typeof vi.fn>;
  accept: ReturnType<typeof vi.fn>;
  decline: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

function resetStore() {
  useCallStore.getState().reset();
}

describe('callStore', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  describe('handleIncoming', () => {
    it('sets incoming call data when idle', () => {
      const payload = {
        callId: 'call-1',
        channelId: 'ch-1',
        callerId: 'user-1',
        callerUsername: 'alice',
        callType: 'voice' as const,
      };
      useCallStore.getState().handleIncoming(payload);

      const state = useCallStore.getState();
      expect(state.status).toBe('ringing');
      expect(state.direction).toBe('incoming');
      expect(state.callId).toBe('call-1');
      expect(state.channelId).toBe('ch-1');
      expect(state.callType).toBe('voice');
      expect(state.remoteUsername).toBe('alice');
      expect(state.incomingCall).toEqual(payload);
    });

    it('ignores incoming call when not idle', () => {
      // Set status to ringing first
      useCallStore.getState().handleIncoming({
        callId: 'call-1',
        channelId: 'ch-1',
        callerId: 'user-1',
        callerUsername: 'alice',
        callType: 'voice',
      });

      // Try another incoming — should be ignored
      useCallStore.getState().handleIncoming({
        callId: 'call-2',
        channelId: 'ch-2',
        callerId: 'user-2',
        callerUsername: 'bob',
        callType: 'video',
      });

      expect(useCallStore.getState().callId).toBe('call-1');
    });
  });

  describe('handleAccepted', () => {
    it('transitions ringing to connected', () => {
      useCallStore.getState().handleIncoming({
        callId: 'call-1',
        channelId: 'ch-1',
        callerId: 'user-1',
        callerUsername: 'alice',
        callType: 'voice',
      });

      useCallStore.getState().handleAccepted({ callId: 'call-1' });

      expect(useCallStore.getState().status).toBe('connected');
      expect(useCallStore.getState().incomingCall).toBeNull();
    });

    it('ignores if callId does not match', () => {
      useCallStore.getState().handleIncoming({
        callId: 'call-1',
        channelId: 'ch-1',
        callerId: 'user-1',
        callerUsername: 'alice',
        callType: 'voice',
      });

      useCallStore.getState().handleAccepted({ callId: 'call-999' });

      expect(useCallStore.getState().status).toBe('ringing');
    });
  });

  describe('handleDeclined', () => {
    it('resets state', () => {
      useCallStore.getState().handleIncoming({
        callId: 'call-1',
        channelId: 'ch-1',
        callerId: 'user-1',
        callerUsername: 'alice',
        callType: 'voice',
      });

      useCallStore.getState().handleDeclined({ callId: 'call-1' });

      expect(useCallStore.getState().status).toBe('idle');
      expect(useCallStore.getState().callId).toBeNull();
    });
  });

  describe('handleCancelled', () => {
    it('resets state', () => {
      useCallStore.getState().handleIncoming({
        callId: 'call-1',
        channelId: 'ch-1',
        callerId: 'user-1',
        callerUsername: 'alice',
        callType: 'voice',
      });

      useCallStore.getState().handleCancelled({ callId: 'call-1' });

      expect(useCallStore.getState().status).toBe('idle');
    });
  });

  describe('handleTimeout', () => {
    it('resets state', () => {
      useCallStore.getState().handleIncoming({
        callId: 'call-1',
        channelId: 'ch-1',
        callerId: 'user-1',
        callerUsername: 'alice',
        callType: 'voice',
      });

      useCallStore.getState().handleTimeout({ callId: 'call-1' });

      expect(useCallStore.getState().status).toBe('idle');
    });
  });

  describe('handleEnded', () => {
    it('resets state and leaves voice channel', () => {
      const leaveSpy = vi.spyOn(useVoiceStore.getState(), 'leaveChannel');

      useCallStore.getState().handleIncoming({
        callId: 'call-1',
        channelId: 'ch-1',
        callerId: 'user-1',
        callerUsername: 'alice',
        callType: 'voice',
      });

      useCallStore.getState().handleEnded({ callId: 'call-1' });

      expect(useCallStore.getState().status).toBe('idle');
      expect(leaveSpy).toHaveBeenCalled();
      leaveSpy.mockRestore();
    });
  });

  describe('initiateCall', () => {
    it('calls API and sets ringing + outgoing state', async () => {
      mockedCallApi.initiate.mockResolvedValue({
        callId: 'call-1',
        token: 'tok',
        url: 'wss://lk',
        callType: 'voice',
      });
      const connectSpy = vi.spyOn(useVoiceStore.getState(), 'connectWithToken');

      await useCallStore.getState().initiateCall('ch-1', 'voice', 'alice');

      const state = useCallStore.getState();
      expect(state.status).toBe('ringing');
      expect(state.direction).toBe('outgoing');
      expect(state.callId).toBe('call-1');
      expect(state.remoteUsername).toBe('alice');
      expect(connectSpy).toHaveBeenCalledWith('tok', 'wss://lk', 'ch-1', 'alice', '__dm_call__');
      connectSpy.mockRestore();
    });

    it('resets on API error', async () => {
      mockedCallApi.initiate.mockRejectedValue(new Error('fail'));

      await useCallStore.getState().initiateCall('ch-1', 'voice', 'alice');

      expect(useCallStore.getState().status).toBe('idle');
    });
  });

  describe('acceptCall', () => {
    it('calls API and transitions to connected', async () => {
      // Set up incoming call state first
      useCallStore.getState().handleIncoming({
        callId: 'call-1',
        channelId: 'ch-1',
        callerId: 'user-1',
        callerUsername: 'alice',
        callType: 'voice',
      });

      mockedCallApi.accept.mockResolvedValue({
        callId: 'call-1',
        token: 'tok',
        url: 'wss://lk',
      });
      const connectSpy = vi.spyOn(useVoiceStore.getState(), 'connectWithToken');

      await useCallStore.getState().acceptCall('call-1');

      expect(useCallStore.getState().status).toBe('connected');
      expect(connectSpy).toHaveBeenCalledWith('tok', 'wss://lk', 'ch-1', 'alice', '__dm_call__');
      connectSpy.mockRestore();
    });
  });

  describe('declineCall', () => {
    it('calls API and resets state', async () => {
      useCallStore.getState().handleIncoming({
        callId: 'call-1',
        channelId: 'ch-1',
        callerId: 'user-1',
        callerUsername: 'alice',
        callType: 'voice',
      });

      mockedCallApi.decline.mockResolvedValue({ success: true });

      await useCallStore.getState().declineCall('call-1');

      expect(useCallStore.getState().status).toBe('idle');
      expect(mockedCallApi.decline).toHaveBeenCalledWith('call-1');
    });
  });

  describe('cancelCall', () => {
    it('calls API, leaves voice, and resets', async () => {
      mockedCallApi.initiate.mockResolvedValue({
        callId: 'call-1',
        token: 'tok',
        url: 'wss://lk',
        callType: 'voice',
      });

      await useCallStore.getState().initiateCall('ch-1', 'voice', 'alice');

      mockedCallApi.cancel.mockResolvedValue({ success: true });
      const leaveSpy = vi.spyOn(useVoiceStore.getState(), 'leaveChannel');

      await useCallStore.getState().cancelCall();

      expect(useCallStore.getState().status).toBe('idle');
      expect(mockedCallApi.cancel).toHaveBeenCalledWith('call-1');
      expect(leaveSpy).toHaveBeenCalled();
      leaveSpy.mockRestore();
    });
  });

  describe('endCall', () => {
    it('calls API, leaves voice, and resets', async () => {
      // Simulate a connected call
      useCallStore.getState().handleIncoming({
        callId: 'call-1',
        channelId: 'ch-1',
        callerId: 'user-1',
        callerUsername: 'alice',
        callType: 'voice',
      });

      mockedCallApi.accept.mockResolvedValue({
        callId: 'call-1',
        token: 'tok',
        url: 'wss://lk',
      });
      await useCallStore.getState().acceptCall('call-1');

      mockedCallApi.end.mockResolvedValue({ success: true, duration: 120 });
      const leaveSpy = vi.spyOn(useVoiceStore.getState(), 'leaveChannel');

      await useCallStore.getState().endCall();

      expect(useCallStore.getState().status).toBe('idle');
      expect(mockedCallApi.end).toHaveBeenCalledWith('call-1');
      expect(leaveSpy).toHaveBeenCalled();
      leaveSpy.mockRestore();
    });
  });

  describe('reset', () => {
    it('returns to initial state', () => {
      useCallStore.getState().handleIncoming({
        callId: 'call-1',
        channelId: 'ch-1',
        callerId: 'user-1',
        callerUsername: 'alice',
        callType: 'voice',
      });

      useCallStore.getState().reset();

      const state = useCallStore.getState();
      expect(state.status).toBe('idle');
      expect(state.callId).toBeNull();
      expect(state.incomingCall).toBeNull();
    });
  });
});
