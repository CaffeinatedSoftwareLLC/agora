import { create } from 'zustand';
import { callApi } from '../lib/api';
import { useVoiceStore } from './voiceStore';
import type { CallIncomingPayload } from '../lib/contracts/ws-events';

interface IncomingCallData {
  callId: string;
  channelId: string;
  callerId: string;
  callerUsername: string;
  callType: 'voice' | 'video';
}

interface CallState {
  status: 'idle' | 'ringing' | 'connected';
  direction: 'incoming' | 'outgoing' | null;
  callId: string | null;
  channelId: string | null;
  callType: 'voice' | 'video' | null;
  remoteUsername: string | null;

  incomingCall: IncomingCallData | null;

  handleIncoming: (data: CallIncomingPayload) => void;
  handleAccepted: (data: { callId: string }) => void;
  handleDeclined: (data: { callId: string }) => void;
  handleCancelled: (data: { callId: string }) => void;
  handleTimeout: (data: { callId: string }) => void;
  handleEnded: (data: { callId: string }) => void;

  initiateCall: (channelId: string, callType: 'voice' | 'video', recipientUsername: string) => Promise<void>;
  acceptCall: (callId: string) => Promise<void>;
  declineCall: (callId: string) => Promise<void>;
  cancelCall: () => Promise<void>;
  endCall: () => Promise<void>;

  reset: () => void;
}

const initialState = {
  status: 'idle' as const,
  direction: null,
  callId: null,
  channelId: null,
  callType: null,
  remoteUsername: null,
  incomingCall: null,
};

export const useCallStore = create<CallState>((set, get) => ({
  ...initialState,

  handleIncoming: (data: CallIncomingPayload) => {
    if (get().status !== 'idle') return;
    set({
      status: 'ringing',
      direction: 'incoming',
      callId: data.callId,
      channelId: data.channelId,
      callType: data.callType,
      remoteUsername: data.callerUsername,
      incomingCall: {
        callId: data.callId,
        channelId: data.channelId,
        callerId: data.callerId,
        callerUsername: data.callerUsername,
        callType: data.callType,
      },
    });
  },

  handleAccepted: (data: { callId: string }) => {
    const state = get();
    if (state.callId !== data.callId || state.status !== 'ringing') return;
    set({ status: 'connected', incomingCall: null });
  },

  handleDeclined: (data: { callId: string }) => {
    if (get().callId !== data.callId) return;
    useVoiceStore.getState().leaveChannel();
    set(initialState);
  },

  handleCancelled: (data: { callId: string }) => {
    if (get().callId !== data.callId) return;
    set(initialState);
  },

  handleTimeout: (data: { callId: string }) => {
    if (get().callId !== data.callId) return;
    useVoiceStore.getState().leaveChannel();
    set(initialState);
  },

  handleEnded: (data: { callId: string }) => {
    if (get().callId !== data.callId) return;
    useVoiceStore.getState().leaveChannel();
    set(initialState);
  },

  initiateCall: async (channelId, callType, recipientUsername) => {
    try {
      const res = await callApi.initiate(channelId, callType);
      set({
        status: 'ringing',
        direction: 'outgoing',
        callId: res.callId,
        channelId,
        callType,
        remoteUsername: recipientUsername,
        incomingCall: null,
      });
      useVoiceStore.getState().connectWithToken(res.token, res.url, channelId, recipientUsername, '__dm_call__');
    } catch {
      set(initialState);
    }
  },

  acceptCall: async (callId) => {
    try {
      const res = await callApi.accept(callId);
      set({ status: 'connected', incomingCall: null });
      const state = get();
      useVoiceStore.getState().connectWithToken(
        res.token,
        res.url,
        state.channelId!,
        state.remoteUsername!,
        '__dm_call__',
      );
    } catch {
      set(initialState);
    }
  },

  declineCall: async (callId) => {
    try {
      await callApi.decline(callId);
    } catch {
      // best-effort
    }
    set(initialState);
  },

  cancelCall: async () => {
    const { callId } = get();
    if (callId) {
      try {
        await callApi.cancel(callId);
      } catch {
        // best-effort
      }
    }
    useVoiceStore.getState().leaveChannel();
    set(initialState);
  },

  endCall: async () => {
    const { callId } = get();
    if (callId) {
      try {
        await callApi.end(callId);
      } catch {
        // best-effort
      }
    }
    useVoiceStore.getState().leaveChannel();
    set(initialState);
  },

  reset: () => set(initialState),
}));
