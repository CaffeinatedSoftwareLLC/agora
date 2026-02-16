import { create } from 'zustand';
import { api } from '../lib/api';
import { useReactionStore } from './reactionStore';
import type { MessagePayload, MessageUpdatePayload, MessageDeletePayload } from '../lib/contracts/ws-events';

export interface Message {
  id: string;
  content: string | null;
  authorId: string;
  authorUsername: string;
  channelId: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  pending?: boolean;
  failed?: boolean;
}

interface MessageState {
  byChannel: Map<string, Message[]>;
  hasMore: Map<string, boolean>;

  loadMessages: (channelId: string) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  sendMessage: (channelId: string, content: string, authorId: string, authorUsername: string) => Promise<void>;
  editMessage: (channelId: string, msgId: string, content: string) => Promise<void>;
  deleteMessage: (channelId: string, msgId: string) => Promise<void>;

  addMessage: (msg: MessagePayload) => void;
  updateMessage: (payload: MessageUpdatePayload) => void;
  removeMessage: (payload: MessageDeletePayload) => void;

  clearChannel: (channelId: string) => void;
  clear: () => void;
}

const PAGE_SIZE = 50;

export const useMessageStore = create<MessageState>((set, get) => ({
  byChannel: new Map(),
  hasMore: new Map(),

  loadMessages: async (channelId) => {
    const data = await api.get<MessagePayload[]>(`/channels/${channelId}/messages?limit=${PAGE_SIZE}`);
    // API returns newest-first; reverse for chronological (oldest-first) order
    const reversed = data.reverse();
    const messages: Message[] = reversed.map((m) => ({
      id: m.id,
      content: m.content,
      authorId: m.authorId,
      authorUsername: m.authorUsername ?? '',
      channelId: m.channelId,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      deletedAt: m.deletedAt,
    }));
    // Hydrate reaction store — always write so stale entries get cleared
    const reactionStore = useReactionStore.getState();
    for (const m of reversed) {
      reactionStore.setReactions(m.id, (m.reactions ?? []).map((r) => ({
        emoji: r.emoji,
        count: r.count,
        me: r.me,
        userIds: [],
      })));
    }
    set((state) => {
      const nextByChannel = new Map(state.byChannel);
      const nextHasMore = new Map(state.hasMore);
      nextByChannel.set(channelId, messages);
      nextHasMore.set(channelId, data.length === PAGE_SIZE);
      return { byChannel: nextByChannel, hasMore: nextHasMore };
    });
  },

  loadOlder: async (channelId) => {
    const existing = get().byChannel.get(channelId);
    if (!existing || existing.length === 0) return;
    if (!get().hasMore.get(channelId)) return;

    const oldestId = existing[0].id;
    const data = await api.get<MessagePayload[]>(
      `/channels/${channelId}/messages?limit=${PAGE_SIZE}&before=${oldestId}`
    );
    // API returns newest-first; reverse to chronological order then prepend
    const reversed = data.reverse();
    const older: Message[] = reversed.map((m) => ({
      id: m.id,
      content: m.content,
      authorId: m.authorId,
      authorUsername: m.authorUsername ?? '',
      channelId: m.channelId,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      deletedAt: m.deletedAt,
    }));
    // Hydrate reaction store — always write so stale entries get cleared
    const reactionStore = useReactionStore.getState();
    for (const m of reversed) {
      reactionStore.setReactions(m.id, (m.reactions ?? []).map((r) => ({
        emoji: r.emoji,
        count: r.count,
        me: r.me,
        userIds: [],
      })));
    }
    set((state) => {
      const nextByChannel = new Map(state.byChannel);
      const nextHasMore = new Map(state.hasMore);
      const current = nextByChannel.get(channelId) ?? [];
      nextByChannel.set(channelId, [...older, ...current]);
      nextHasMore.set(channelId, data.length === PAGE_SIZE);
      return { byChannel: nextByChannel, hasMore: nextHasMore };
    });
  },

  sendMessage: async (channelId, content, authorId, authorUsername) => {
    // Create optimistic message
    const tempId = `pending-${Date.now()}`;
    const optimistic: Message = {
      id: tempId,
      content,
      authorId,
      authorUsername,
      channelId,
      createdAt: new Date().toISOString(),
      pending: true,
    };

    set((state) => {
      const nextByChannel = new Map(state.byChannel);
      const current = nextByChannel.get(channelId) ?? [];
      nextByChannel.set(channelId, [...current, optimistic]);
      return { byChannel: nextByChannel };
    });

    try {
      const res = await api.post<{ id: string }>(`/channels/${channelId}/messages`, { content });
      // Reconcile: if WS already delivered the real message, drop the optimistic row.
      // Otherwise remap tempId → real ID so addMessage can match when WS arrives.
      set((state) => {
        const nextByChannel = new Map(state.byChannel);
        const current = nextByChannel.get(channelId) ?? [];
        const wsAlreadyDelivered = current.some((m) => !m.pending && m.id === res.id);
        if (wsAlreadyDelivered) {
          // WS won the race — remove the optimistic row
          nextByChannel.set(channelId, current.filter((m) => m.id !== tempId));
        } else {
          // POST won the race — remap so addMessage can match by real ID
          nextByChannel.set(channelId, current.map((m) =>
            m.id === tempId ? { ...m, id: res.id, pending: true } : m
          ));
        }
        return { byChannel: nextByChannel };
      });
    } catch {
      // Mark as failed
      set((state) => {
        const nextByChannel = new Map(state.byChannel);
        const current = nextByChannel.get(channelId) ?? [];
        nextByChannel.set(channelId, current.map((m) =>
          m.id === tempId ? { ...m, pending: false, failed: true } : m
        ));
        return { byChannel: nextByChannel };
      });
    }
  },

  editMessage: async (channelId, msgId, content) => {
    // Optimistic update
    let originalContent: string | null = null;
    set((state) => {
      const nextByChannel = new Map(state.byChannel);
      const current = nextByChannel.get(channelId) ?? [];
      nextByChannel.set(channelId, current.map((m) => {
        if (m.id === msgId) {
          originalContent = m.content;
          return { ...m, content, editedAt: new Date().toISOString() };
        }
        return m;
      }));
      return { byChannel: nextByChannel };
    });

    try {
      await api.patch(`/channels/${channelId}/messages/${msgId}`, { content });
      // WS 'MessageUpdate' event will arrive with server timestamp
    } catch {
      // Revert on failure
      if (originalContent !== null) {
        set((state) => {
          const nextByChannel = new Map(state.byChannel);
          const current = nextByChannel.get(channelId) ?? [];
          nextByChannel.set(channelId, current.map((m) =>
            m.id === msgId ? { ...m, content: originalContent, editedAt: undefined } : m
          ));
          return { byChannel: nextByChannel };
        });
      }
    }
  },

  deleteMessage: async (channelId, msgId) => {
    // Optimistic delete (soft-delete: set content to null)
    let originalMessage: Message | undefined;
    set((state) => {
      const nextByChannel = new Map(state.byChannel);
      const current = nextByChannel.get(channelId) ?? [];
      nextByChannel.set(channelId, current.map((m) => {
        if (m.id === msgId) {
          originalMessage = m;
          return { ...m, content: null, deletedAt: new Date().toISOString() };
        }
        return m;
      }));
      return { byChannel: nextByChannel };
    });

    try {
      await api.delete(`/channels/${channelId}/messages/${msgId}`);
      // WS 'MessageDelete' event will arrive with server timestamp
    } catch {
      // Revert on failure
      if (originalMessage) {
        const orig = originalMessage;
        set((state) => {
          const nextByChannel = new Map(state.byChannel);
          const current = nextByChannel.get(channelId) ?? [];
          nextByChannel.set(channelId, current.map((m) =>
            m.id === msgId ? orig : m
          ));
          return { byChannel: nextByChannel };
        });
      }
    }
  },

  addMessage: (msg) => {
    set((state) => {
      const nextByChannel = new Map(state.byChannel);
      const current = nextByChannel.get(msg.channelId) ?? [];

      // Check if this is confirming an optimistic (pending) message by real ID
      const pendingIdx = current.findIndex(
        (m) => m.pending && m.id === msg.id
      );

      if (pendingIdx !== -1) {
        // Replace the optimistic message with the confirmed server version
        const updated = [...current];
        updated[pendingIdx] = {
          id: msg.id,
          content: msg.content,
          authorId: msg.authorId,
          authorUsername: msg.authorUsername,
          channelId: msg.channelId,
          createdAt: msg.createdAt,
        };
        nextByChannel.set(msg.channelId, updated);
      } else {
        // Ignore duplicate (WS arrived before POST response updated the ID)
        if (current.some((m) => m.id === msg.id)) {
          return state;
        }
        // New message from another user (or no pending match)
        const newMsg: Message = {
          id: msg.id,
          content: msg.content,
          authorId: msg.authorId,
          authorUsername: msg.authorUsername,
          channelId: msg.channelId,
          createdAt: msg.createdAt,
        };
        nextByChannel.set(msg.channelId, [...current, newMsg]);
      }

      return { byChannel: nextByChannel };
    });
  },

  updateMessage: (payload) => {
    set((state) => {
      const nextByChannel = new Map(state.byChannel);
      const current = nextByChannel.get(payload.channelId);
      if (!current) return state;

      nextByChannel.set(payload.channelId, current.map((m) =>
        m.id === payload.id
          ? { ...m, content: payload.content, editedAt: payload.editedAt }
          : m
      ));
      return { byChannel: nextByChannel };
    });
  },

  removeMessage: (payload) => {
    set((state) => {
      const nextByChannel = new Map(state.byChannel);
      const current = nextByChannel.get(payload.channelId);
      if (!current) return state;

      nextByChannel.set(payload.channelId, current.map((m) =>
        m.id === payload.id
          ? { ...m, content: null, deletedAt: payload.deletedAt }
          : m
      ));
      return { byChannel: nextByChannel };
    });
  },

  clearChannel: (channelId) => {
    set((state) => {
      const nextByChannel = new Map(state.byChannel);
      const nextHasMore = new Map(state.hasMore);
      nextByChannel.delete(channelId);
      nextHasMore.delete(channelId);
      return { byChannel: nextByChannel, hasMore: nextHasMore };
    });
  },

  clear: () => set({ byChannel: new Map(), hasMore: new Map() }),
}));
