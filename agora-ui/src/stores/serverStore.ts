import { create } from 'zustand';
import type { Server } from '../lib/contracts/server';

interface ServerState {
  servers: Map<string, Server>;
  activeServerId: string | null;
  pinnedServerIds: Set<string>;
  setServers: (servers: Server[]) => void;
  setActiveServer: (id: string | null) => void;
  addServer: (server: Server) => void;
  removeServer: (id: string) => void;
  pinServer: (id: string) => void;
  unpinServer: (id: string) => void;
  clear: () => void;
}

// Persist pinned servers to localStorage
const storedPins = (typeof window !== 'undefined'
  ? new Set(JSON.parse(localStorage.getItem('agora:pinnedServers') || '[]') as string[])
  : new Set<string>());

export const useServerStore = create<ServerState>((set, get) => ({
  servers: new Map(),
  activeServerId: null,
  pinnedServerIds: storedPins,

  setServers: (servers) => set({ servers: new Map(servers.map(s => [s.id, s])) }),
  setActiveServer: (id) => {
    if (get().activeServerId !== id) set({ activeServerId: id });
  },
  addServer: (server) => set((state) => {
    const next = new Map(state.servers);
    next.set(server.id, server);
    return { servers: next };
  }),
  removeServer: (id) => set((state) => {
    const next = new Map(state.servers);
    next.delete(id);
    const activeServerId = state.activeServerId === id ? null : state.activeServerId;
    return { servers: next, activeServerId };
  }),
  pinServer: (id) => set((state) => {
    const next = new Set(state.pinnedServerIds);
    next.add(id);
    localStorage.setItem('agora:pinnedServers', JSON.stringify([...next]));
    return { pinnedServerIds: next };
  }),
  unpinServer: (id) => set((state) => {
    const next = new Set(state.pinnedServerIds);
    next.delete(id);
    localStorage.setItem('agora:pinnedServers', JSON.stringify([...next]));
    return { pinnedServerIds: next };
  }),
  clear: () => set({ servers: new Map(), activeServerId: null }),
}));
