import { create } from 'zustand';
import type { Channel } from '../lib/contracts/server';

interface ChannelState {
  channels: Map<string, Channel>;
  activeChannelId: string | null;
  setChannels: (channels: Channel[]) => void;
  setActiveChannel: (id: string | null) => void;
  addChannel: (channel: Channel) => void;
  byServer: (serverId: string) => Channel[];
  dmChannels: () => Channel[];
  clear: () => void;
}

export const useChannelStore = create<ChannelState>((set, get) => ({
  channels: new Map(),
  activeChannelId: null,
  setChannels: (channels) => set({ channels: new Map(channels.map(c => [c.id, c])) }),
  setActiveChannel: (id) => set({ activeChannelId: id }),
  addChannel: (channel) => set((state) => {
    const next = new Map(state.channels);
    next.set(channel.id, channel);
    return { channels: next };
  }),
  byServer: (serverId) => {
    return Array.from(get().channels.values()).filter(c => c.serverId === serverId);
  },
  dmChannels: () => {
    return Array.from(get().channels.values()).filter(c => c.serverId === null);
  },
  clear: () => set({ channels: new Map(), activeChannelId: null }),
}));
