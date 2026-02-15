import { create } from 'zustand';

type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

interface UIState {
  sidebarOpen: boolean;
  membersOpen: boolean;
  activeModal: string | null;
  connectionStatus: ConnectionStatus;
  toggleSidebar: () => void;
  toggleMembers: () => void;
  setModal: (modal: string | null) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  membersOpen: false,
  activeModal: null,
  connectionStatus: 'disconnected',
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleMembers: () => set((s) => ({ membersOpen: !s.membersOpen })),
  setModal: (modal) => set({ activeModal: modal }),
  setConnectionStatus: (status) => set({ connectionStatus: status }),
}));
