import { create } from 'zustand';
import type { PaletteKey } from '../theme/palettes';
import { api } from '../lib/api';

type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

interface UIState {
  // Arc V2: palette
  paletteKey: PaletteKey;
  setPalette: (key: PaletteKey) => void;
  togglePalette: () => void;
  /** Load the account's saved preferences (theme) after sign-in. */
  loadPreferences: () => Promise<void>;

  // Members sidebar
  membersOpen: boolean;
  toggleMembers: () => void;

  // Files panel (search the channel's files)
  filesOpen: boolean;
  toggleFiles: () => void;

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

const isPalette = (v: unknown): v is PaletteKey => v === 'aegean' || v === 'terracotta';

/** Save the choice to the account too, so the phone and the PC agree. Local storage stays the fallback. */
function savePalette(key: PaletteKey) {
  try { localStorage.setItem('agora:palette', key); } catch { /* private mode */ }
  api.patch('/users/@me/preferences', { palette: key }).catch(() => { /* offline or older server */ });
}

export const useUIStore = create<UIState>((set, get) => ({
  paletteKey: storedPalette,
  setPalette: (key) => {
    savePalette(key);
    set({ paletteKey: key });
  },
  togglePalette: () => {
    const next: PaletteKey = get().paletteKey === 'aegean' ? 'terracotta' : 'aegean';
    savePalette(next);
    set({ paletteKey: next });
  },
  loadPreferences: async () => {
    try {
      const prefs = await api.get<{ palette?: unknown }>('/users/@me/preferences');
      if (isPalette(prefs.palette) && prefs.palette !== get().paletteKey) {
        try { localStorage.setItem('agora:palette', prefs.palette); } catch { /* private mode */ }
        set({ paletteKey: prefs.palette });
      }
    } catch { /* older server or offline: keep the local choice */ }
  },

  membersOpen: false,
  toggleMembers: () => set((s) => ({ membersOpen: !s.membersOpen })),

  filesOpen: false,
  toggleFiles: () => set((s) => ({ filesOpen: !s.filesOpen })),

  activeModal: null,
  setModal: (modal) => set({ activeModal: modal }),

  connectionStatus: 'disconnected',
  setConnectionStatus: (status) => set({ connectionStatus: status }),
}));
