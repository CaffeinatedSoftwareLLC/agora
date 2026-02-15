import { create } from 'zustand';
import { api } from '../lib/api';
import type { Member } from '../lib/contracts/server';

interface MemberState {
  byServer: Map<string, Member[]>;
  loadMembers: (serverId: string) => Promise<void>;
  clear: () => void;
}

export const useMemberStore = create<MemberState>((set) => ({
  byServer: new Map(),
  loadMembers: async (serverId) => {
    const members = await api.get<Member[]>(`/servers/${serverId}/members`);
    set((state) => {
      const next = new Map(state.byServer);
      next.set(serverId, members);
      return { byServer: next };
    });
  },
  clear: () => set({ byServer: new Map() }),
}));
