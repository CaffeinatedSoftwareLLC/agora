import { create } from 'zustand';
import { api } from '../lib/api';
import type { Message } from './messageStore';
import type { MessagePayload, MessageUpdatePayload, MessageDeletePayload, ThreadMetadataUpdatePayload } from '../lib/contracts/ws-events';

export interface ThreadSummary {
  id: string;
  content: string | null;
  authorId: string | null;
  authorUsername: string | null;
  authorBot?: boolean;
  authorAvatarUrl?: string | null;
  channelId: string;
  createdAt: string;
  editedAt?: string;
  replyCount: number;
  lastReplyAt: string;
  threadClosedAt?: string | null;
  canClose?: boolean;
  previewReplies: {
    id: string;
    content: string | null;
    authorId: string | null;
    authorUsername: string | null;
    authorAvatarUrl?: string | null;
  }[];
}

interface ThreadState {
  openThreadId: string | null;
  openThreadChannelId: string | null;
  repliesByThread: Map<string, Message[]>;
  hasMore: Map<string, boolean>;
  activeThreads: Map<string, ThreadSummary[]>;
  hasMoreThreads: Map<string, boolean>;

  openThread: (channelId: string, messageId: string) => void;
  closeThread: () => void;
  loadReplies: (channelId: string, messageId: string) => Promise<void>;
  loadNewer: (channelId: string, messageId: string) => Promise<void>;
  sendReply: (channelId: string, messageId: string, content: string, authorId: string, authorUsername: string) => Promise<void>;
  addReply: (msg: MessagePayload) => void;
  updateReply: (payload: MessageUpdatePayload) => void;
  removeReply: (payload: MessageDeletePayload) => void;
  loadActiveThreads: (channelId: string) => Promise<void>;
  loadMoreThreads: (channelId: string) => Promise<void>;
  closeThreadRemote: (channelId: string, messageId: string) => Promise<void>;
  reopenThread: (channelId: string, messageId: string) => Promise<void>;
  updateParentMetadata: (data: ThreadMetadataUpdatePayload) => void;
  clear: () => void;
}

const REPLY_PAGE_SIZE = 50;

export const useThreadStore = create<ThreadState>((set, get) => ({
  openThreadId: null,
  openThreadChannelId: null,
  repliesByThread: new Map(),
  hasMore: new Map(),
  activeThreads: new Map(),
  hasMoreThreads: new Map(),

  openThread: (channelId, messageId) => {
    set({ openThreadId: messageId, openThreadChannelId: channelId });
    get().loadReplies(channelId, messageId);
  },

  closeThread: () => {
    set({ openThreadId: null, openThreadChannelId: null });
  },

  loadReplies: async (channelId, messageId) => {
    const data = await api.get<MessagePayload[]>(
      `/channels/${channelId}/messages/${messageId}/replies?limit=${REPLY_PAGE_SIZE}`
    );
    const replies: Message[] = data.map((m) => ({
      id: m.id,
      content: m.content,
      authorId: m.authorId,
      authorUsername: m.authorUsername ?? '',
      authorBot: m.authorBot,
      authorAvatarUrl: m.authorAvatarUrl,
      channelId: m.channelId,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      deletedAt: m.deletedAt,
      attachments: m.attachments,
    }));
    set((state) => {
      const nextReplies = new Map(state.repliesByThread);
      const nextHasMore = new Map(state.hasMore);
      nextReplies.set(messageId, replies);
      nextHasMore.set(messageId, data.length === REPLY_PAGE_SIZE);
      return { repliesByThread: nextReplies, hasMore: nextHasMore };
    });
  },

  loadNewer: async (channelId, messageId) => {
    const existing = get().repliesByThread.get(messageId);
    if (!existing || existing.length === 0) return;
    if (!get().hasMore.get(messageId)) return;

    const lastId = existing[existing.length - 1].id;
    const data = await api.get<MessagePayload[]>(
      `/channels/${channelId}/messages/${messageId}/replies?limit=${REPLY_PAGE_SIZE}&after=${lastId}`
    );
    const newer: Message[] = data.map((m) => ({
      id: m.id,
      content: m.content,
      authorId: m.authorId,
      authorUsername: m.authorUsername ?? '',
      authorBot: m.authorBot,
      authorAvatarUrl: m.authorAvatarUrl,
      channelId: m.channelId,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      deletedAt: m.deletedAt,
      attachments: m.attachments,
    }));
    set((state) => {
      const nextReplies = new Map(state.repliesByThread);
      const nextHasMore = new Map(state.hasMore);
      const current = nextReplies.get(messageId) ?? [];
      nextReplies.set(messageId, [...current, ...newer]);
      nextHasMore.set(messageId, data.length === REPLY_PAGE_SIZE);
      return { repliesByThread: nextReplies, hasMore: nextHasMore };
    });
  },

  sendReply: async (channelId, messageId, content, authorId, authorUsername) => {
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
      const nextReplies = new Map(state.repliesByThread);
      const current = nextReplies.get(messageId) ?? [];
      nextReplies.set(messageId, [...current, optimistic]);
      return { repliesByThread: nextReplies };
    });

    try {
      const res = await api.post<{ id: string }>(
        `/channels/${channelId}/messages/${messageId}/replies`,
        { content }
      );
      set((state) => {
        const nextReplies = new Map(state.repliesByThread);
        const current = nextReplies.get(messageId) ?? [];
        const wsAlreadyDelivered = current.some((m) => !m.pending && m.id === res.id);
        if (wsAlreadyDelivered) {
          nextReplies.set(messageId, current.filter((m) => m.id !== tempId));
        } else {
          nextReplies.set(messageId, current.map((m) =>
            m.id === tempId ? { ...m, id: res.id, pending: true } : m
          ));
        }
        return { repliesByThread: nextReplies };
      });
    } catch {
      set((state) => {
        const nextReplies = new Map(state.repliesByThread);
        const current = nextReplies.get(messageId) ?? [];
        nextReplies.set(messageId, current.map((m) =>
          m.id === tempId ? { ...m, pending: false, failed: true } : m
        ));
        return { repliesByThread: nextReplies };
      });
    }
  },

  addReply: (msg) => {
    const threadId = msg.threadId;
    if (!threadId) return;

    set((state) => {
      const nextReplies = new Map(state.repliesByThread);
      const current = nextReplies.get(threadId) ?? [];

      // Reconcile optimistic send
      const pendingIdx = current.findIndex((m) => m.pending && m.id === msg.id);
      if (pendingIdx !== -1) {
        const updated = [...current];
        updated[pendingIdx] = {
          id: msg.id,
          content: msg.content,
          authorId: msg.authorId,
          authorUsername: msg.authorUsername,
          authorBot: msg.authorBot,
          authorAvatarUrl: msg.authorAvatarUrl,
          channelId: msg.channelId,
          createdAt: msg.createdAt,
          attachments: msg.attachments,
        };
        nextReplies.set(threadId, updated);
      } else {
        if (current.some((m) => m.id === msg.id)) return state;
        const newReply: Message = {
          id: msg.id,
          content: msg.content,
          authorId: msg.authorId,
          authorUsername: msg.authorUsername,
          authorBot: msg.authorBot,
          authorAvatarUrl: msg.authorAvatarUrl,
          channelId: msg.channelId,
          createdAt: msg.createdAt,
          attachments: msg.attachments,
        };
        nextReplies.set(threadId, [...current, newReply]);
      }

      return { repliesByThread: nextReplies };
    });
  },

  updateReply: (payload) => {
    if (!payload.threadId) return;
    set((state) => {
      const nextReplies = new Map(state.repliesByThread);
      const current = nextReplies.get(payload.threadId!);
      if (!current) return state;

      nextReplies.set(payload.threadId!, current.map((m) =>
        m.id === payload.id
          ? { ...m, content: payload.content, editedAt: payload.editedAt }
          : m
      ));
      return { repliesByThread: nextReplies };
    });
  },

  removeReply: (payload) => {
    if (!payload.threadId) return;
    set((state) => {
      const nextReplies = new Map(state.repliesByThread);
      const current = nextReplies.get(payload.threadId!);
      if (!current) return state;

      nextReplies.set(payload.threadId!, current.map((m) =>
        m.id === payload.id
          ? { ...m, content: null, deletedAt: payload.deletedAt }
          : m
      ));
      return { repliesByThread: nextReplies };
    });
  },

  loadActiveThreads: async (channelId) => {
    const data = await api.get<ThreadSummary[]>(`/channels/${channelId}/threads?limit=5`);
    set((state) => {
      const next = new Map(state.activeThreads);
      const nextHasMore = new Map(state.hasMoreThreads);
      next.set(channelId, data);
      nextHasMore.set(channelId, data.length === 5);
      return { activeThreads: next, hasMoreThreads: nextHasMore };
    });
  },

  loadMoreThreads: async (channelId) => {
    const existing = get().activeThreads.get(channelId);
    if (!existing || existing.length === 0) return;
    if (!get().hasMoreThreads.get(channelId)) return;

    const lastReplyAt = existing[existing.length - 1].lastReplyAt;
    const data = await api.get<ThreadSummary[]>(
      `/channels/${channelId}/threads?limit=5&before=${lastReplyAt}`
    );
    set((state) => {
      const next = new Map(state.activeThreads);
      const nextHasMore = new Map(state.hasMoreThreads);
      const current = next.get(channelId) ?? [];
      next.set(channelId, [...current, ...data]);
      nextHasMore.set(channelId, data.length === 5);
      return { activeThreads: next, hasMoreThreads: nextHasMore };
    });
  },

  closeThreadRemote: async (channelId, messageId) => {
    await api.patch(`/channels/${channelId}/messages/${messageId}/thread`, { closed: true });
  },

  reopenThread: async (channelId, messageId) => {
    await api.patch(`/channels/${channelId}/messages/${messageId}/thread`, { closed: false });
    get().loadActiveThreads(channelId);
  },

  updateParentMetadata: (data) => {
    set((state) => {
      const next = new Map(state.activeThreads);
      const threads = next.get(data.channelId);
      if (threads) {
        if (data.threadClosedAt) {
          // Remove closed thread from active list
          next.set(data.channelId, threads.filter((t) => t.id !== data.messageId));
        } else {
          next.set(data.channelId, threads.map((t) =>
            t.id === data.messageId
              ? { ...t, replyCount: data.replyCount, lastReplyAt: data.lastReplyAt ?? t.lastReplyAt }
              : t
          ));
        }
      }
      return { activeThreads: next };
    });
  },

  clear: () => set({
    openThreadId: null,
    openThreadChannelId: null,
    repliesByThread: new Map(),
    hasMore: new Map(),
    activeThreads: new Map(),
    hasMoreThreads: new Map(),
  }),
}));
