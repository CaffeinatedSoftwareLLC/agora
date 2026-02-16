import { create } from 'zustand';

type PresenceStatus = 'online' | 'idle' | 'offline';

interface PresenceState {
  status: Map<string, PresenceStatus>;
  setPresence: (userId: string, status: PresenceStatus) => void;
  setOnlineUsers: (userIds: string[]) => void;
  getStatus: (userId: string) => PresenceStatus;
  clear: () => void;
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  status: new Map(),

  setPresence: (userId, status) => {
    set((s) => {
      const next = new Map(s.status);
      next.set(userId, status);
      return { status: next };
    });
  },

  setOnlineUsers: (userIds) => {
    set(() => {
      const next = new Map<string, PresenceStatus>();
      for (const id of userIds) {
        next.set(id, 'online');
      }
      return { status: next };
    });
  },

  getStatus: (userId) => {
    return get().status.get(userId) ?? 'offline';
  },

  clear: () => set({ status: new Map() }),
}));
