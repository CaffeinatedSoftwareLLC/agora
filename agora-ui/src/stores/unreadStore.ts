import { create } from 'zustand';

export interface UnreadEntry {
  lastReadId: string | null;
  mentionCount: number;
  unreadCount: number;
}

interface UnreadState {
  byChannel: Map<string, UnreadEntry>;
  setUnreads: (unreads: { channelId: string; lastReadId: string | null; mentionCount: number }[]) => void;
  markRead: (channelId: string, messageId: string) => void;
  incrementUnread: (channelId: string) => void;
  incrementMention: (channelId: string) => void;
  getUnread: (channelId: string) => UnreadEntry | null;
  clear: () => void;
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  byChannel: new Map(),

  setUnreads: (unreads) => {
    set(() => {
      const next = new Map<string, UnreadEntry>();
      for (const u of unreads) {
        next.set(u.channelId, {
          lastReadId: u.lastReadId,
          mentionCount: u.mentionCount,
          unreadCount: 0,
        });
      }
      return { byChannel: next };
    });
  },

  markRead: (channelId, messageId) => {
    set((s) => {
      const next = new Map(s.byChannel);
      next.set(channelId, {
        lastReadId: messageId,
        mentionCount: 0,
        unreadCount: 0,
      });
      return { byChannel: next };
    });
  },

  incrementUnread: (channelId) => {
    set((s) => {
      const next = new Map(s.byChannel);
      const existing = next.get(channelId) ?? { lastReadId: null, mentionCount: 0, unreadCount: 0 };
      next.set(channelId, { ...existing, unreadCount: existing.unreadCount + 1 });
      return { byChannel: next };
    });
  },

  incrementMention: (channelId) => {
    set((s) => {
      const next = new Map(s.byChannel);
      const existing = next.get(channelId) ?? { lastReadId: null, mentionCount: 0, unreadCount: 0 };
      next.set(channelId, { ...existing, mentionCount: existing.mentionCount + 1 });
      return { byChannel: next };
    });
  },

  getUnread: (channelId) => {
    return get().byChannel.get(channelId) ?? null;
  },

  clear: () => set({ byChannel: new Map() }),
}));
