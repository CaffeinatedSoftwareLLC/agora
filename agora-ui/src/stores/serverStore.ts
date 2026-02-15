import { create } from 'zustand';
import type { Server } from '../lib/contracts/server';

interface ServerState {
  servers: Map<string, Server>;
  activeServerId: string | null;
  setServers: (servers: Server[]) => void;
  setActiveServer: (id: string | null) => void;
  addServer: (server: Server) => void;
  clear: () => void;
}

export const useServerStore = create<ServerState>((set) => ({
  servers: new Map(),
  activeServerId: null,
  setServers: (servers) => set({ servers: new Map(servers.map(s => [s.id, s])) }),
  setActiveServer: (id) => set({ activeServerId: id }),
  addServer: (server) => set((state) => {
    const next = new Map(state.servers);
    next.set(server.id, server);
    return { servers: next };
  }),
  clear: () => set({ servers: new Map(), activeServerId: null }),
}));
