import { create } from 'zustand';
import { api } from '../lib/api';

interface VoiceChannel {
  channelId: string;
  serverId: string;
  channelName: string;
}

interface VoiceParticipant {
  userId: string;
  name: string;
}

type VoiceConnectionState = 'disconnected' | 'connecting' | 'connected';

interface VoiceState {
  currentChannel: VoiceChannel | null;
  /** Participants keyed by channelId → userId → participant info */
  participantsByChannel: Map<string, Map<string, VoiceParticipant>>;
  connectionState: VoiceConnectionState;
  token: string | null;
  livekitUrl: string | null;
  isMuted: boolean;
  isDeafened: boolean;

  joinChannel: (channelId: string, serverId: string, channelName: string) => Promise<void>;
  leaveChannel: () => void;
  setConnectionState: (state: VoiceConnectionState) => void;
  addParticipant: (channelId: string, userId: string, name: string) => void;
  removeParticipant: (channelId: string, userId: string) => void;
  clearChannelParticipants: (channelId: string) => void;
  getChannelParticipants: (channelId: string) => VoiceParticipant[];
  setMuted: (muted: boolean) => void;
  setDeafened: (deafened: boolean) => void;
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  currentChannel: null,
  participantsByChannel: new Map(),
  connectionState: 'disconnected',
  token: null,
  livekitUrl: null,
  isMuted: false,
  isDeafened: false,

  joinChannel: async (channelId, serverId, channelName) => {
    // If already in this channel, do nothing
    if (get().currentChannel?.channelId === channelId) return;

    // If in a different channel, leave first
    if (get().currentChannel) {
      get().leaveChannel();
    }

    set({
      connectionState: 'connecting',
      currentChannel: { channelId, serverId, channelName },
    });

    try {
      const res = await api.post<{ token: string; url: string }>('/voice/token', { channelId });
      set({
        token: res.token,
        livekitUrl: res.url,
      });
    } catch {
      set({
        connectionState: 'disconnected',
        currentChannel: null,
        token: null,
        livekitUrl: null,
      });
    }
  },

  leaveChannel: () => {
    set({
      currentChannel: null,
      connectionState: 'disconnected',
      token: null,
      livekitUrl: null,
      isMuted: false,
      isDeafened: false,
    });
  },

  setConnectionState: (state) => set({ connectionState: state }),

  addParticipant: (channelId, userId, name) => set((s) => {
    const next = new Map(s.participantsByChannel);
    const channelMap = new Map(next.get(channelId) ?? []);
    channelMap.set(userId, { userId, name });
    next.set(channelId, channelMap);
    return { participantsByChannel: next };
  }),

  removeParticipant: (channelId, userId) => set((s) => {
    const next = new Map(s.participantsByChannel);
    const channelMap = next.get(channelId);
    if (channelMap) {
      const updated = new Map(channelMap);
      updated.delete(userId);
      if (updated.size === 0) {
        next.delete(channelId);
      } else {
        next.set(channelId, updated);
      }
    }
    return { participantsByChannel: next };
  }),

  clearChannelParticipants: (channelId) => set((s) => {
    const next = new Map(s.participantsByChannel);
    next.delete(channelId);
    return { participantsByChannel: next };
  }),

  getChannelParticipants: (channelId) => {
    const channelMap = get().participantsByChannel.get(channelId);
    return channelMap ? Array.from(channelMap.values()) : [];
  },

  setMuted: (muted) => set({ isMuted: muted }),
  setDeafened: (deafened) => set({ isDeafened: deafened }),
}));
