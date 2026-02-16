import { create } from 'zustand';
import { api } from '../lib/api';
import type { Member } from '../lib/contracts/server';

// Track in-flight requests to prevent duplicate parallel fetches
const loading = new Set<string>();

interface MemberState {
  byServer: Map<string, Member[]>;
  loadMembers: (serverId: string) => Promise<void>;
  clear: () => void;
}

export const useMemberStore = create<MemberState>((set) => ({
  byServer: new Map(),
  loadMembers: async (serverId) => {
    if (loading.has(serverId)) return;
    loading.add(serverId);
    try {
      const members = await api.get<Member[]>(`/servers/${serverId}/members`);
      set((state) => {
        const next = new Map(state.byServer);
        next.set(serverId, members);
        return { byServer: next };
      });
    } finally {
      loading.delete(serverId);
    }
  },
  clear: () => set({ byServer: new Map() }),
}));
