import { create } from 'zustand';
import type { AgentPresencePayload } from '../lib/contracts/ws-events';

/**
 * Bring-your-own-session agents per channel (docs/claude-channel.md): the user's own CLI
 * session connected through agora-mcp, as opposed to a session agora-host runs. Ready
 * replaces the lot; AgentPresence events update one agent in one channel. An agent that goes
 * offline stays listed as offline until the next Ready, so the strip can say it left.
 */

export type AgentPresenceEntry = Omit<AgentPresencePayload, 'channelId'>;

interface AgentPresenceState {
  byChannel: Map<string, Map<string, AgentPresenceEntry>>;
  setAll: (list: AgentPresencePayload[]) => void;
  update: (event: AgentPresencePayload) => void;
  clear: () => void;
}

function entry(e: AgentPresencePayload): AgentPresenceEntry {
  return { userId: e.userId, username: e.username, status: e.status, mode: e.mode };
}

export const useAgentPresenceStore = create<AgentPresenceState>((set) => ({
  byChannel: new Map(),

  setAll: (list) => {
    const next = new Map<string, Map<string, AgentPresenceEntry>>();
    for (const e of list) {
      const channel = next.get(e.channelId) ?? new Map<string, AgentPresenceEntry>();
      channel.set(e.userId, entry(e));
      next.set(e.channelId, channel);
    }
    set({ byChannel: next });
  },

  update: (event) => {
    set((s) => {
      const next = new Map(s.byChannel);
      const channel = new Map(next.get(event.channelId) ?? []);
      channel.set(event.userId, entry(event));
      next.set(event.channelId, channel);
      return { byChannel: next };
    });
  },

  clear: () => set({ byChannel: new Map() }),
}));
