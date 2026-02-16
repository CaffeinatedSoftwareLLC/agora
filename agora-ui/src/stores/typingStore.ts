import { create } from 'zustand';

interface TypingEntry {
  username: string;
  timeout: ReturnType<typeof setTimeout>;
}

interface TypingState {
  byChannel: Map<string, Map<string, TypingEntry>>;
  addTyping: (channelId: string, userId: string, username: string) => void;
  removeTyping: (channelId: string, userId: string) => void;
  getTypingUsers: (channelId: string) => string[];
  clear: () => void;
}

export const useTypingStore = create<TypingState>((set, get) => ({
  byChannel: new Map(),

  addTyping: (channelId, userId, username) => {
    const state = get();
    const channelMap = state.byChannel.get(channelId);
    const existing = channelMap?.get(userId);
    if (existing) clearTimeout(existing.timeout);

    const timeout = setTimeout(() => {
      get().removeTyping(channelId, userId);
    }, 3000);

    set((s) => {
      const next = new Map(s.byChannel);
      const channel = new Map(next.get(channelId) ?? []);
      channel.set(userId, { username, timeout });
      next.set(channelId, channel);
      return { byChannel: next };
    });
  },

  removeTyping: (channelId, userId) => {
    set((s) => {
      const existing = s.byChannel.get(channelId);
      if (!existing || !existing.has(userId)) return s;

      const entry = existing.get(userId);
      if (entry) clearTimeout(entry.timeout);

      const next = new Map(s.byChannel);
      const channel = new Map(existing);
      channel.delete(userId);
      if (channel.size === 0) {
        next.delete(channelId);
      } else {
        next.set(channelId, channel);
      }
      return { byChannel: next };
    });
  },

  getTypingUsers: (channelId) => {
    const channel = get().byChannel.get(channelId);
    if (!channel) return [];
    return Array.from(channel.values()).map((e) => e.username);
  },

  clear: () => {
    const state = get();
    for (const channel of state.byChannel.values()) {
      for (const entry of channel.values()) {
        clearTimeout(entry.timeout);
      }
    }
    set({ byChannel: new Map() });
  },
}));
