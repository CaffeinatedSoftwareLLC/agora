import { create } from 'zustand';
import { api } from '../lib/api';
import type { Member } from '../lib/contracts/server';

// Track in-flight requests to prevent duplicate parallel fetches
const loading = new Set<string>();

interface MemberState {
  byServer: Map<string, Member[]>;
  /** Explicit agent membership supplied by the existing ChannelAgents loader. */
  channelAgentIds: Map<string, string[]>;
  setChannelAgents: (channelId: string, ids: string[]) => void;
  loadMembers: (serverId: string) => Promise<void>;
  clear: () => void;
}

export const useMemberStore = create<MemberState>((set) => ({
  byServer: new Map(),
  channelAgentIds: new Map(),
  setChannelAgents: (channelId, ids) => set(state => {
    const nextIds = [...new Set(ids)].sort();
    if (JSON.stringify(state.channelAgentIds.get(channelId)) === JSON.stringify(nextIds)) return state;
    return { channelAgentIds: new Map(state.channelAgentIds).set(channelId, nextIds) };
  }),
  loadMembers: async (serverId) => {
    if (loading.has(serverId)) return;
    loading.add(serverId);
    try {
      const [members, bots] = await Promise.all([
        api.get<Member[]>(`/servers/${serverId}/members`),
        api.get<{ id: string; username: string }[]>(`/servers/${serverId}/bots`).catch(() => []),
      ]);
      // Merge bots into member list for mention autocomplete
      const botMembers: Member[] = bots.map((b) => ({
        id: b.id,
        username: b.username,
        joinedAt: '',
        roles: [],
      }));
      set((state) => {
        const next = new Map(state.byServer);
        next.set(serverId, [...members, ...botMembers]);
        return { byServer: next };
      });
    } finally {
      loading.delete(serverId);
    }
  },
  clear: () => set({ byServer: new Map(), channelAgentIds: new Map() }),
}));
