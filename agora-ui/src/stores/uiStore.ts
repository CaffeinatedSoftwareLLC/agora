import { create } from 'zustand';
import type { PaletteKey } from '../theme/palettes';

type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

interface UIState {
  // Arc V2: palette
  paletteKey: PaletteKey;
  setPalette: (key: PaletteKey) => void;
  togglePalette: () => void;

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

  membersOpen: false,
  toggleMembers: () => set((s) => ({ membersOpen: !s.membersOpen })),

  activeModal: null,
  setModal: (modal) => set({ activeModal: modal }),

  connectionStatus: 'disconnected',
  setConnectionStatus: (status) => set({ connectionStatus: status }),
}));
