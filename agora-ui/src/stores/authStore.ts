import { useDraftStore } from './draftStore';
import { create } from 'zustand';
import { api, ApiError } from '../lib/api';
import type { AuthResponse, RegisterRequest, User } from '../lib/contracts/auth';
import { useServerStore } from './serverStore';
import { useChannelStore } from './channelStore';
import { useMemberStore } from './memberStore';
import { useMessageStore } from './messageStore';
import { useUIStore } from './uiStore';
import { useTypingStore } from './typingStore';
import { usePresenceStore } from './presenceStore';
import { useUnreadStore } from './unreadStore';
import { useThreadStore } from './threadStore';
import { passkeyApi } from '../lib/passkeys';

/** `checking`: no user remembered in this browser, asking the server whether the cookie is good. */
type AuthStatus = 'idle' | 'checking' | 'loading' | 'authenticated' | 'pending';

interface AuthState {
  user: User | null;
  status: AuthStatus;
  /** `login` is a username or an email. */
  login: (login: string, password: string) => Promise<void>;
  /** Sign in with a passkey; `login` narrows it to one account's passkeys. */
  loginWithPasskey: (login?: string) => Promise<void>;
  register: (data: RegisterRequest) => Promise<void>;
  /** Signed in by another flow (the setup wizard): the server has already set the session cookie. */
  setAuthenticated: (user: User) => void;
  /** Ask the server whether the session cookie is still good; signs out locally if not. */
  verifySession: () => Promise<void>;
  /** On load with no remembered user: the cookie may still be valid (other origin, cleared storage). */
  restoreSession: () => Promise<void>;
  logout: () => void;
  logoutAll: () => Promise<void>;
  clearSession: () => void;
}

// The session itself is an httpOnly cookie this code can't read. Only the user's
// id/name is kept here, so a reload can render at once; verifySession() and the
// socket handshake find out if the cookie has expired or been revoked.
const USER_KEY = 'agora_user';
/** Where the login token was kept before sessions moved to a cookie (#77). */
const LEGACY_TOKEN_KEY = 'agora_token';

/**
 * One-time migration: a token left in localStorage by an older build is revoked
 * and deleted, and that user signs in again. It is not exchanged for a cookie,
 * because the point of the change is that a token page scripts could read may
 * already have been copied; revoking it ends that copy too.
 */
function retireLegacyToken(): boolean {
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
    if (legacy) {
      localStorage.removeItem(LEGACY_TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
  } catch { /* storage unavailable */ }
  if (legacy) {
    fetch('/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${legacy}` } }).catch(() => {});
  }
  return legacy !== null;
}

function loadPersistedUser(legacyRetired: boolean): { user: User | null; status: AuthStatus } {
  try {
    const userJson = localStorage.getItem(USER_KEY);
    if (userJson) return { user: JSON.parse(userJson), status: 'authenticated' };
  } catch { /* corrupted storage — start fresh */ }
  // The remembered user is only a cache: the httpOnly cookie may still be valid
  // when it is missing, so ask the server before showing the login page. A user
  // whose legacy token was just revoked signs in again, as that migration intends.
  return { user: null, status: legacyRetired ? 'idle' : 'checking' };
}

function persistUser(user: User) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* not fatal */ }
}

function clearPersistedUser() {
  try { localStorage.removeItem(USER_KEY); } catch { /* not fatal */ }
}

const initialAuth = loadPersistedUser(retireLegacyToken());
/** The server has confirmed the cookie since this page loaded. */
let sessionVerified = false;

export const useAuthStore = create<AuthState>((set, get) => ({
  user: initialAuth.user,
  status: initialAuth.status,

  login: async (login, password) => {
    set({ status: 'loading' });
    try {
      const res = await api.post<AuthResponse>('/auth/login', { login, password });
      get().setAuthenticated(res.user);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'account_pending') {
          set({ status: 'pending', user: null });
          return;
        }
      }
      set({ status: 'idle' });
      throw err;
    }
  },

  loginWithPasskey: async (login) => {
    set({ status: 'loading' });
    try {
      const res = await passkeyApi.signIn(login);
      get().setAuthenticated(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'account_pending') {
        set({ status: 'pending', user: null });
        return;
      }
      set({ status: 'idle' });
      throw err;
    }
  },

  register: async (data) => {
    set({ status: 'loading' });
    try {
      const res = await api.post<AuthResponse & { status?: string }>('/auth/register', data);
      if (res.status === 'pending') {
        set({ status: 'pending', user: null });
      } else {
        get().setAuthenticated(res.user);
      }
    } catch (err) {
      set({ status: 'idle' });
      throw err;
    }
  },

  setAuthenticated: (user) => {
    persistUser(user);
    set({ user, status: 'authenticated' });
  },

  verifySession: async () => {
    if (get().status !== 'authenticated' || sessionVerified) return;
    try {
      const res = await api.get<{ user: User }>('/auth/session');
      sessionVerified = true;
      if (get().status === 'authenticated' && res.user) get().setAuthenticated(res.user);
    } catch (err) {
      // Only a definite answer signs out; a network blip leaves the session alone
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) get().clearSession();
    }
  },

  restoreSession: async () => {
    if (get().status !== 'checking') return;
    try {
      const res = await api.get<{ user: User }>('/auth/session');
      if (get().status !== 'checking') return;
      if (res.user) {
        sessionVerified = true;
        get().setAuthenticated(res.user);
      } else {
        set({ status: 'idle' });
      }
    } catch {
      // 401/403 means no session. Anything else can't be retried from here, and
      // the login page is the one place the user can act, so show it.
      if (get().status === 'checking') set({ status: 'idle' });
    }
  },

  logout: () => {
    // Revoke token server-side (best-effort — don't block on failure)
    api.post('/auth/logout', undefined).catch(() => {});
    get().clearSession();
  },

  logoutAll: async () => {
    // Preserve the session on failure so the user can retry revoking other devices.
    await api.post('/auth/logout-all');
    get().clearSession();
  },

  clearSession: () => {
    sessionVerified = false;
    clearPersistedUser();
    useDraftStore.getState().clearAllDrafts();
    useUIStore.getState().onChannelSelect(null);
    set({ user: null, status: 'idle' });
    useServerStore.getState().clear();
    useChannelStore.getState().clear();
    useMemberStore.getState().clear();
    useMessageStore.getState().clear();
    useThreadStore.getState().clear();
    useTypingStore.getState().clear();
    usePresenceStore.getState().clear();
    useUnreadStore.getState().clear();
    useUIStore.getState().setConnectionStatus('disconnected');
  },
}));

if (initialAuth.status === 'checking') void useAuthStore.getState().restoreSession();
