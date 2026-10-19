import { create } from 'zustand';
import { useThreadStore } from './threadStore';
import type { PaletteKey } from '../theme/palettes';
import { api } from '../lib/api';

type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

export type AuxView = 'thread' | 'files' | 'members' | 'project';
export interface Overlay {
  kind: 'session-sheet' | 'message-actions' | 'modal';
  id: string;
  onClose: () => void;
}

interface UIState {
  // Arc V2: palette
  paletteKey: PaletteKey;
  setPalette: (key: PaletteKey) => void;
  togglePalette: () => void;
  /** Load the account's saved preferences (theme) after sign-in. */
  loadPreferences: () => Promise<void>;

  navOpen: boolean;
  aux: AuxView | null;
  activeOverlay: Overlay | null;
  openNav: () => void;
  closeNav: () => void;
  openAux: (kind: AuxView) => void;
  toggleAux: (kind: AuxView) => void;
  closeAux: () => void;
  openThreadView: (channelId: string, threadId: string) => void;
  onChannelSelect: (channelId: string | null) => void;
  openOverlay: (overlay: Overlay) => void;
  closeOverlay: () => void;
  releaseOverlay: (id: string) => void;
  dismissTop: () => void;

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

  navOpen: false,
  aux: null,
  activeOverlay: null,
  openNav: () => set({ navOpen: true, aux: null }),
  closeNav: () => set({ navOpen: false }),
  openAux: (kind) => set({ aux: kind, navOpen: false }),
  toggleAux: (kind) => set(s => ({ aux: s.aux === kind ? null : kind, navOpen: false })),
  closeAux: () => set({ aux: null }),
  openThreadView: (channelId, threadId) => {
    useThreadStore.getState().openThread(channelId, threadId);
    set({ aux: 'thread', navOpen: false });
  },
  onChannelSelect: (channelId) => {
    if (useThreadStore.getState().openThreadChannelId !== channelId) {
      useThreadStore.getState().closeThread();
    }
    const overlay = get().activeOverlay;
    set({ navOpen: false, aux: null, activeOverlay: null, activeModal: null });
    overlay?.onClose();
  },
  openOverlay: (overlay) => {
    const previous = get().activeOverlay;
    // Modal dialogs take precedence over popover/bottom sheets.
    if (previous?.kind === 'modal' && overlay.kind !== 'modal') return;
    if (previous && previous.id !== overlay.id) previous.onClose();
    set({ activeOverlay: overlay });
  },
  releaseOverlay: (id) => {
    if (get().activeOverlay?.id === id) set({ activeOverlay: null });
  },
  closeOverlay: () => {
    const overlay = get().activeOverlay;
    set({ activeOverlay: null, activeModal: null });
    overlay?.onClose();
  },
  dismissTop: () => {
    if (get().activeOverlay) get().closeOverlay();
    else if (get().navOpen) get().closeNav();
    else get().closeAux();
  },
  activeModal: null,
  setModal: (modal) => {
    if (modal) get().openOverlay({ kind: 'modal', id: modal, onClose: () => set({ activeModal: null }) });
    else get().closeOverlay();
    set({ activeModal: modal });
  },

  connectionStatus: 'disconnected',
  setConnectionStatus: (status) => set({ connectionStatus: status }),
}));
