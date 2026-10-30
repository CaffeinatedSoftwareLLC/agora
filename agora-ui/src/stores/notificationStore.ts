import { create } from 'zustand';
import { api, inBackground } from '../lib/api';
import type { AppNotification, NotificationPage, NotificationReadPayload } from '../lib/contracts/notifications';

const PAGE = 30;

interface NotificationState {
  items: AppNotification[];
  unread: number;
  hasMore: boolean;
  loaded: boolean;
  /** First page and the unread count (on connect and when the list opens). */
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** A NotificationCreate from the socket. */
  add: (n: AppNotification) => void;
  /** A NotificationRead from the socket (another tab or device). */
  applyRead: (e: NotificationReadPayload) => void;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  clear: () => void;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  items: [],
  unread: 0,
  hasMore: false,
  loaded: false,

  load: async () => {
    const page = await inBackground(() => api.get<NotificationPage>(`/me/notifications?limit=${PAGE}`));
    set({ items: page.notifications, unread: page.unread, hasMore: page.hasMore, loaded: true });
  },

  loadMore: async () => {
    const last = get().items.at(-1);
    if (!last || !get().hasMore) return;
    const page = await api.get<NotificationPage>(`/me/notifications?limit=${PAGE}&before=${last.id}`);
    set(s => ({ items: [...s.items, ...page.notifications.filter(n => !s.items.some(i => i.id === n.id))], unread: page.unread, hasMore: page.hasMore }));
  },

  add: (n) => set(s => {
    if (s.items.some(i => i.id === n.id)) return s;
    return { items: [n, ...s.items], unread: s.unread + (n.readAt ? 0 : 1) };
  }),

  applyRead: (e) => set(s => {
    const now = new Date().toISOString();
    const ids = new Set(e.ids ?? []);
    return {
      unread: e.unread,
      items: s.items.map(i => (!i.readAt && (e.all || ids.has(i.id)) ? { ...i, readAt: now } : i)),
    };
  }),

  markRead: async (id) => {
    const item = get().items.find(i => i.id === id);
    if (item?.readAt) return;
    // Show it read at once; the server's count wins when it answers
    set(s => ({
      items: s.items.map(i => (i.id === id ? { ...i, readAt: new Date().toISOString() } : i)),
      unread: Math.max(0, s.unread - (item ? 1 : 0)),
    }));
    const res = await api.post<{ unread: number }>(`/me/notifications/${id}/read`);
    set({ unread: res.unread });
  },

  markAllRead: async () => {
    const now = new Date().toISOString();
    set(s => ({ items: s.items.map(i => (i.readAt ? i : { ...i, readAt: now })), unread: 0 }));
    await api.post('/me/notifications/read-all');
  },

  clear: () => set({ items: [], unread: 0, hasMore: false, loaded: false }),
}));
