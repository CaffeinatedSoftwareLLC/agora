import { create } from 'zustand';
import { api, ApiError, setTokenGetter } from '../lib/api';
import type { AuthResponse, RegisterRequest, User } from '../lib/contracts/auth';
import { useServerStore } from './serverStore';
import { useChannelStore } from './channelStore';
import { useMemberStore } from './memberStore';
import { useUIStore } from './uiStore';

type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'pending';

interface AuthState {
  token: string | null;
  user: User | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<void>;
  register: (data: RegisterRequest) => Promise<void>;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  user: null,
  status: 'idle',

  login: async (email, password) => {
    set({ status: 'loading' });
    try {
      const res = await api.post<AuthResponse>('/auth/login', { email, password });
      set({ token: res.accessToken, user: res.user, status: 'authenticated' });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'account_pending') {
          set({ status: 'pending', token: null, user: null });
          return;
        }
      }
      set({ status: 'idle' });
      throw err;
    }
  },

  register: async (data) => {
    set({ status: 'loading' });
    try {
      const res = await api.post<AuthResponse & { status?: string }>('/auth/register', data);
      if (res.accessToken) {
        set({ token: res.accessToken, user: res.user, status: 'authenticated' });
      } else {
        set({ status: 'pending', token: null, user: null });
      }
    } catch (err) {
      set({ status: 'idle' });
      throw err;
    }
  },

  logout: () => {
    set({ token: null, user: null, status: 'idle' });
    useServerStore.getState().clear();
    useChannelStore.getState().clear();
    useMemberStore.getState().clear();
    useUIStore.getState().setConnectionStatus('disconnected');
  },
}));

// Wire up the API client to read the token from the store
setTokenGetter(() => useAuthStore.getState().token);
