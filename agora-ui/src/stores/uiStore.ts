import { create } from 'zustand';
import type { PaletteKey } from '../theme/palettes';

type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

interface UIState {
  // Arc V2: palette
  paletteKey: PaletteKey;
  setPalette: (key: PaletteKey) => void;
  togglePalette: () => void;

  // Arc V2: tab bar tracks which server tabs are open
  openServerTabs: string[];
  addServerTab: (serverId: string) => void;
  removeServerTab: (serverId: string) => void;

  // Members sidebar
  membersOpen: boolean;
  toggleMembers: () => void;

  // Modals
  activeModal: string | null;
  setModal: (modal: string | null) => void;

  // Connection
  connectionStatus: ConnectionStatus;
  setConnectionStatus: (status: ConnectionStatus) => void;
}

// Persist palette to localStorage
const storedPalette = (typeof window !== 'undefined'
  ? localStorage.getItem('agora:palette') as PaletteKey | null
  : null) || 'aegean';

const storedTabs = (typeof window !== 'undefined'
  ? JSON.parse(localStorage.getItem('agora:openTabs') || '[]') as string[]
  : []);

export const useUIStore = create<UIState>((set) => ({
  paletteKey: storedPalette,
  setPalette: (key) => {
    localStorage.setItem('agora:palette', key);
    set({ paletteKey: key });
  },
  togglePalette: () => set((s) => {
    const next = s.paletteKey === 'aegean' ? 'terracotta' : 'aegean';
    localStorage.setItem('agora:palette', next);
    return { paletteKey: next as PaletteKey };
  }),

  openServerTabs: storedTabs,
  addServerTab: (serverId) => set((s) => {
    if (s.openServerTabs.includes(serverId)) return s;
    const next = [...s.openServerTabs, serverId];
    localStorage.setItem('agora:openTabs', JSON.stringify(next));
    return { openServerTabs: next };
  }),
  removeServerTab: (serverId) => set((s) => {
    const next = s.openServerTabs.filter(id => id !== serverId);
    localStorage.setItem('agora:openTabs', JSON.stringify(next));
    return { openServerTabs: next };
  }),

  membersOpen: false,
  toggleMembers: () => set((s) => ({ membersOpen: !s.membersOpen })),

  activeModal: null,
  setModal: (modal) => set({ activeModal: modal }),

  connectionStatus: 'disconnected',
  setConnectionStatus: (status) => set({ connectionStatus: status }),
}));
