import { create } from 'zustand';
import { api, ApiError, setTokenGetter } from '../lib/api';
import type { AuthResponse, RegisterRequest, User } from '../lib/contracts/auth';
import { useServerStore } from './serverStore';
import { useChannelStore } from './channelStore';
import { useMemberStore } from './memberStore';
import { useMessageStore } from './messageStore';
import { useUIStore } from './uiStore';
import { useTypingStore } from './typingStore';
import { usePresenceStore } from './presenceStore';
import { useUnreadStore } from './unreadStore';
import { useReactionStore } from './reactionStore';

type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'pending';

interface AuthState {
  token: string | null;
  user: User | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<void>;
  register: (data: RegisterRequest) => Promise<void>;
  logout: () => void;
}

// Restore persisted session from localStorage
function loadPersistedAuth(): { token: string | null; user: User | null; status: AuthStatus } {
  try {
    const token = localStorage.getItem('agora_token');
    const userJson = localStorage.getItem('agora_user');
    if (token && userJson) {
      return { token, user: JSON.parse(userJson), status: 'authenticated' };
    }
  } catch { /* corrupted storage — start fresh */ }
  return { token: null, user: null, status: 'idle' };
}

function persistAuth(token: string, user: User) {
  localStorage.setItem('agora_token', token);
  localStorage.setItem('agora_user', JSON.stringify(user));
}

function clearPersistedAuth() {
  localStorage.removeItem('agora_token');
  localStorage.removeItem('agora_user');
}

const initialAuth = loadPersistedAuth();

export const useAuthStore = create<AuthState>((set) => ({
  token: initialAuth.token,
  user: initialAuth.user,
  status: initialAuth.status,

  login: async (email, password) => {
    set({ status: 'loading' });
    try {
      const res = await api.post<AuthResponse>('/auth/login', { email, password });
      persistAuth(res.accessToken, res.user);
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
        persistAuth(res.accessToken, res.user);
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
    // Revoke token server-side (best-effort — don't block on failure)
    api.post('/auth/logout', undefined).catch(() => {});
    clearPersistedAuth();
    set({ token: null, user: null, status: 'idle' });
    useServerStore.getState().clear();
    useChannelStore.getState().clear();
    useMemberStore.getState().clear();
    useMessageStore.getState().clear();
    useTypingStore.getState().clear();
    usePresenceStore.getState().clear();
    useUnreadStore.getState().clear();
    useReactionStore.getState().clear();
    useUIStore.getState().setConnectionStatus('disconnected');
  },
}));

// Wire up the API client to read the token from the store
setTokenGetter(() => useAuthStore.getState().token);
