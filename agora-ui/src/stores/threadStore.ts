import { create } from 'zustand';
import { api } from '../lib/api';
import { findOptimistic, tempMessageId, type Message } from './messageStore';
import { fileMetadata, useFileMetadataStore } from './fileMetadataStore';
import type { FileAttachmentUpdatePayload } from '../lib/contracts/ws-events';
import type { MessagePayload, MessageUpdatePayload, MessageDeletePayload, ThreadMetadataUpdatePayload, ProtocolInfo } from '../lib/contracts/ws-events';

export interface ThreadSummary {
  latestProtocol?: ProtocolInfo & { messageId: string; authorUsername: string | null } | null;
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
  loadingReplies: Map<string, boolean>;
  replyLoadErrors: Map<string, string>;
  activeThreads: Map<string, ThreadSummary[]>;
  hasMoreThreads: Map<string, boolean>;

  openThread: (channelId: string, messageId: string) => void;
  closeThread: () => void;
  loadReplies: (channelId: string, messageId: string) => Promise<void>;
  loadOlder: (channelId: string, messageId: string) => Promise<void>;
  sendReply: (channelId: string, messageId: string, content: string, authorId: string, authorUsername: string, attachmentIds?: string[]) => Promise<boolean>;
  editReply: (channelId: string, threadId: string, replyId: string, content: string) => Promise<void>;
  deleteReply: (channelId: string, threadId: string, replyId: string) => Promise<void>;
  addReply: (msg: MessagePayload) => void;
  updateReply: (payload: MessageUpdatePayload) => void;
  updateFileAttachment: (payload: FileAttachmentUpdatePayload) => void;
  removeReply: (payload: MessageDeletePayload) => void;
  streamUpdate: (threadId: string, messageId: string, content: string, streaming: boolean, attachments?: Message['attachments']) => void;
  loadActiveThreads: (channelId: string) => Promise<void>;
  loadMoreThreads: (channelId: string) => Promise<void>;
  closeThreadRemote: (channelId: string, messageId: string) => Promise<void>;
  reopenThread: (channelId: string, messageId: string) => Promise<void>;
  updateParentMetadata: (data: ThreadMetadataUpdatePayload) => void;
  clear: () => void;
}

const REPLY_PAGE_SIZE = 50;
const replyLoads = new Map<string, symbol>();
const olderReplyLoads = new Map<string, Promise<void>>();

function mapReply(m: MessagePayload): Message {
  return { ...m, authorUsername: m.authorUsername ?? '' };
}

// Active-thread list requests, one per channel at a time. A load or a metadata event
// that arrives while one is in flight marks the channel dirty, and the request loop
// fetches once more after it resolves, so nothing that happened meanwhile is lost.
const listLoads = new Map<string, Promise<void>>();
const listDirty = new Set<string>();
// Metadata events seen while a list request was in flight, by `${channelId}:${threadId}`.
// A snapshot requested before such an event keeps the event's counts and closure.
let eventSeq = 0;
const eventSeqByThread = new Map<string, number>();
// Bumped by clear(); a list request from before it is dropped when it resolves.
let listGeneration = 0;

export const useThreadStore = create<ThreadState>((set, get) => ({
  openThreadId: null,
  openThreadChannelId: null,
  repliesByThread: new Map(),
  hasMore: new Map(),
  loadingReplies: new Map(),
  replyLoadErrors: new Map(),
  activeThreads: new Map(),
  hasMoreThreads: new Map(),

  openThread: (channelId, messageId) => {
    set({ openThreadId: messageId, openThreadChannelId: channelId });
    void get().loadReplies(channelId, messageId).catch(() => {});
  },

  closeThread: () => {
    set({ openThreadId: null, openThreadChannelId: null });
  },

  loadReplies: async (channelId, messageId) => {
    const token = Symbol();
    replyLoads.set(messageId, token);
    const before = new Map((get().repliesByThread.get(messageId) ?? []).map(m => [m.id, m]));
    set(state => ({ loadingReplies: new Map(state.loadingReplies).set(messageId, true),
      replyLoadErrors: new Map(state.replyLoadErrors).set(messageId, '') }));
    try {
      const data = await api.get<MessagePayload[]>(
        `/channels/${channelId}/messages/${messageId}/replies?limit=${REPLY_PAGE_SIZE}&order=desc`
      );
      if (replyLoads.get(messageId) !== token) return;
      const replies = [...data].reverse().map(mapReply);
      set(state => {
        const held = state.repliesByThread.get(messageId) ?? [];
        const merged = new Map(replies.map(m => [m.id, m]));
        const latest = replies.at(-1)?.id ?? '';
        // Retain socket changes/new arrivals and optimistic sends made during this GET.
        // Older cached pages are intentionally dropped when reopening at the newest page.
        for (const m of held) {
          if (m.pending || m.failed || (before.get(m.id) !== m && (merged.has(m.id) || m.id > latest))) merged.set(m.id, m);
        }
        const sorted = [...merged.values()].sort((a, b) => {
          if (!!a.pending !== !!b.pending) return a.pending ? 1 : -1;
          return a.id.localeCompare(b.id);
        });
        return { repliesByThread: new Map(state.repliesByThread).set(messageId, sorted),
          hasMore: new Map(state.hasMore).set(messageId, data.length === REPLY_PAGE_SIZE) };
      });
    } catch (error) {
      if (replyLoads.get(messageId) === token) set(state => ({ replyLoadErrors: new Map(state.replyLoadErrors).set(messageId, 'Could not load replies. Try again.') }));
      throw error;
    } finally {
      if (replyLoads.get(messageId) === token) set(state => ({ loadingReplies: new Map(state.loadingReplies).set(messageId, false) }));
    }
  },

  loadOlder: (channelId, messageId) => {
    const inFlight = olderReplyLoads.get(messageId);
    if (inFlight) return inFlight;
    const existing = get().repliesByThread.get(messageId);
    const first = existing?.find(m => !m.pending && !m.failed);
    if (!first || !get().hasMore.get(messageId) || get().loadingReplies.get(messageId)) return Promise.resolve();
    const token = replyLoads.get(messageId);
    const generation = listGeneration;
    const run: Promise<void> = (async () => {
      const data = await api.get<MessagePayload[]>(
        `/channels/${channelId}/messages/${messageId}/replies?limit=${REPLY_PAGE_SIZE}&order=desc&before=${first.id}`
      );
      if (generation !== listGeneration || replyLoads.get(messageId) !== token) return;
      const older = [...data].reverse().map(mapReply);
      set(state => {
        const current = state.repliesByThread.get(messageId) ?? [];
        const currentIds = new Set(current.map(m => m.id));
        return { repliesByThread: new Map(state.repliesByThread).set(messageId, [...older.filter(m => !currentIds.has(m.id)), ...current]),
          hasMore: new Map(state.hasMore).set(messageId, data.length === REPLY_PAGE_SIZE) };
      });
    })().finally(() => {
      if (olderReplyLoads.get(messageId) === run) olderReplyLoads.delete(messageId);
    });
    olderReplyLoads.set(messageId, run);
    return run;
  },

  sendReply: async (channelId, messageId, content, authorId, authorUsername, attachmentIds) => {
    const tempId = tempMessageId();
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
      const body: { content?: string; attachments?: string[] } = {};
      if (content) body.content = content;
      if (attachmentIds?.length) body.attachments = attachmentIds;
      const res = await api.post<{ id: string; attachments?: Message['attachments'] }>(
        `/channels/${channelId}/messages/${messageId}/replies`,
        body
      );
      set((state) => {
        const nextReplies = new Map(state.repliesByThread);
        const current = nextReplies.get(messageId) ?? [];
        const wsAlreadyDelivered = current.some((m) => !m.pending && m.id === res.id);
        if (wsAlreadyDelivered) {
          nextReplies.set(messageId, current.filter((m) => m.id !== tempId));
        } else {
          nextReplies.set(messageId, current.map((m) =>
            m.id === tempId ? { ...m, id: res.id, pending: true, attachments: res.attachments } : m
          ));
        }
        return { repliesByThread: nextReplies };
      });
      return true;
    } catch {
      set((state) => {
        const nextReplies = new Map(state.repliesByThread);
        const current = nextReplies.get(messageId) ?? [];
        nextReplies.set(messageId, current.map((m) =>
          m.id === tempId ? { ...m, pending: false, failed: true } : m
        ));
        return { repliesByThread: nextReplies };
      });
      return false;
    }
  },

  editReply: async (channelId, threadId, replyId, content) => {
    const original = get().repliesByThread.get(threadId)?.find(m => m.id === replyId);
    const optimistic = original ? { ...original, content, editedAt: new Date().toISOString() } : undefined;
    if (optimistic) {
      set(state => {
        const next = new Map(state.repliesByThread);
        next.set(threadId, (next.get(threadId) ?? []).map(m => m.id === replyId ? optimistic : m));
        return { repliesByThread: next };
      });
    }
    try {
      await api.patch(`/channels/${channelId}/messages/${replyId}`, { content });
      // MessageUpdate supplies the authoritative timestamp and parsed protocol.
    } catch {
      if (original && optimistic) {
        set(state => {
          const current = state.repliesByThread.get(threadId);
          // Don't restore a stale value over a socket event, later edit, or clear().
          if (!current?.includes(optimistic)) return state;
          const next = new Map(state.repliesByThread);
          next.set(threadId, current.map(m => m === optimistic ? original : m));
          return { repliesByThread: next };
        });
      }
    }
  },

  deleteReply: async (channelId, threadId, replyId) => {
    const original = get().repliesByThread.get(threadId)?.find(m => m.id === replyId);
    const optimistic = original ? { ...original, content: null, deletedAt: new Date().toISOString(), protocol: undefined } : undefined;
    if (optimistic) {
      set(state => {
        const next = new Map(state.repliesByThread);
        next.set(threadId, (next.get(threadId) ?? []).map(m => m.id === replyId ? optimistic : m));
        return { repliesByThread: next };
      });
    }
    try {
      await api.delete(`/channels/${channelId}/messages/${replyId}`);
      // MessageDelete supplies the authoritative tombstone.
    } catch {
      if (original && optimistic) {
        set(state => {
          const current = state.repliesByThread.get(threadId);
          if (!current?.includes(optimistic)) return state;
          const next = new Map(state.repliesByThread);
          next.set(threadId, current.map(m => m === optimistic ? original : m));
          return { repliesByThread: next };
        });
      }
    }
  },

  addReply: (msg) => {
    const threadId = msg.threadId;
    if (!threadId) return;

    set((state) => {
      const nextReplies = new Map(state.repliesByThread);
      const current = nextReplies.get(threadId) ?? [];

      // Reconcile optimistic send: by real ID, or by author and text if the echo beat the POST response
      const pendingIdx = current.some((m) => !m.pending && m.id === msg.id) ? -1 : findOptimistic(current, msg);
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
          artifact: msg.artifact,
          systemEvent: msg.systemEvent,
          systemData: msg.systemData,
          protocol: msg.protocol,
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
          artifact: msg.artifact,
          systemEvent: msg.systemEvent,
          systemData: msg.systemData,
          protocol: msg.protocol,
        };
        nextReplies.set(threadId, [...current, newReply]);
      }

      return { repliesByThread: nextReplies };
    });
  },

  updateFileAttachment: payload => {
    useFileMetadataStore.getState().update(payload);
    set(state => {
      if (!payload.threadId) return state;
      const current = state.repliesByThread.get(payload.threadId);
      if (!current) return state;
      const next = new Map(state.repliesByThread);
      next.set(payload.threadId, current.map(message => message.id === payload.messageId && message.channelId === payload.channelId && !message.deletedAt
        ? { ...message, attachments: message.attachments?.map(file => file.id === payload.fileId && !file.deletedAt ? { ...file, ...fileMetadata(payload) } : file) } : message));
      return { repliesByThread: next };
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
          ? { ...m, content: payload.content, editedAt: payload.editedAt, protocol: payload.protocol ?? undefined, ...(payload.systemData ? { systemData: payload.systemData } : {}), ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}) }
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
          ? { ...m, content: null, deletedAt: payload.deletedAt, protocol: undefined }
          : m
      ));
      return { repliesByThread: nextReplies };
    });
  },

  streamUpdate: (threadId, messageId, content, streaming, attachments) => {
    set((state) => {
      const current = state.repliesByThread.get(threadId);
      if (!current) return state;

      const nextReplies = new Map(state.repliesByThread);
      nextReplies.set(threadId, current.map((m) => {
        if (m.id !== messageId) return m;
        // Ignore updates after stream has been finalized
        if (m.streaming === false) return m;
        return { ...m, content, streaming, ...(attachments ? { attachments } : {}) };
      }));
      return { repliesByThread: nextReplies };
    });
  },

  loadActiveThreads: (channelId) => {
    const inFlight = listLoads.get(channelId);
    if (inFlight) {
      listDirty.add(channelId);
      return inFlight;
    }
    const generation = listGeneration;
    // Assigned before the body's first await, which is the only way to reach finally
    let run: Promise<void> | undefined = undefined;
    run = (async () => {
      try {
        do {
          listDirty.delete(channelId);
          const requestedAt = eventSeq;
          const data = await api.get<ThreadSummary[]>(`/channels/${channelId}/threads?limit=5`);
          if (generation !== listGeneration) return;
          set((state) => {
            const held = new Map((state.activeThreads.get(channelId) ?? []).map((t) => [t.id, t]));
            const merged = data.map((t) => {
              const newer = held.get(t.id);
              if (!newer || (eventSeqByThread.get(`${channelId}:${t.id}`) ?? 0) <= requestedAt) return t;
              return { ...t, replyCount: newer.replyCount, lastReplyAt: newer.lastReplyAt, threadClosedAt: newer.threadClosedAt };
            });
            const next = new Map(state.activeThreads);
            const nextHasMore = new Map(state.hasMoreThreads);
            next.set(channelId, merged);
            nextHasMore.set(channelId, data.length === 5);
            return { activeThreads: next, hasMoreThreads: nextHasMore };
          });
        } while (listDirty.has(channelId));
      } finally {
        if (listLoads.get(channelId) === run) {
          listLoads.delete(channelId);
          listDirty.delete(channelId);
          for (const key of eventSeqByThread.keys()) {
            if (key.startsWith(`${channelId}:`)) eventSeqByThread.delete(key);
          }
        }
      }
    })();
    listLoads.set(channelId, run);
    return run;
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
    if (listLoads.has(data.channelId)) {
      // The in-flight request may have been answered before this event: fetch again after it
      listDirty.add(data.channelId);
      eventSeqByThread.set(`${data.channelId}:${data.messageId}`, ++eventSeq);
    }
    const loaded = get().activeThreads.get(data.channelId);
    // A first reply starts a thread the bar has never seen; the event carries only counts,
    // so fetch the list again to get the new thread's summary.
    if (loaded && data.replyCount > 0 && !data.threadClosedAt && !loaded.some((t) => t.id === data.messageId)) {
      void get().loadActiveThreads(data.channelId).catch(() => {});
      return;
    }
    set((state) => {
      const next = new Map(state.activeThreads);
      const threads = next.get(data.channelId);
      if (threads) {
        next.set(data.channelId, threads.map((t) =>
          t.id === data.messageId
            ? {
                ...t,
                replyCount: data.replyCount,
                lastReplyAt: data.lastReplyAt ?? t.lastReplyAt,
                ...(data.threadClosedAt !== undefined ? { threadClosedAt: data.threadClosedAt } : {}),
              }
            : t
        ));
      }
      return { activeThreads: next };
    });
  },

  clear: () => {
    replyLoads.clear();
    olderReplyLoads.clear();
    listGeneration++;
    listLoads.clear();
    listDirty.clear();
    eventSeqByThread.clear();
    set({
      openThreadId: null,
      openThreadChannelId: null,
      repliesByThread: new Map(),
      hasMore: new Map(),
      loadingReplies: new Map(),
      replyLoadErrors: new Map(),
      activeThreads: new Map(),
      hasMoreThreads: new Map(),
    });
  },
}));
