import { create } from 'zustand';
import { api, inBackground } from '../../lib/api';
import type { Receipt, ReceiptUpdatePayload, VerdictResult, VerdictValue } from '../../lib/contracts/receipts';
import { attentionCount } from './receiptText';

/**
 * Receipts by thread, oldest first. A thread is loaded when its panel opens or when a
 * ReceiptUpdate arrives for it; after that updates patch it in place. Server: src/routes/receipts.ts.
 */

interface ReceiptState {
  byThread: Map<string, Receipt[]>;
  /** Threads whose list failed to load, with a sentence for the panel. */
  errors: Map<string, string>;
  loading: Set<string>;

  load: (channelId: string, threadId: string) => Promise<void>;
  /** A ReceiptUpdate: patch the thread's list, or fetch it when it was never loaded. */
  applyUpdate: (payload: ReceiptUpdatePayload) => void;
  /** After a socket reconnect: events may have been missed. */
  reloadLoaded: () => void;
  giveVerdict: (channelId: string, receiptId: string, verdict: VerdictValue, note?: string) => Promise<VerdictResult>;
  reset: () => void;
}

/** Receipt IDs are ULIDs: creation order is list order. */
function upsert(list: readonly Receipt[], receipt: Receipt): Receipt[] {
  const at = list.findIndex(r => r.id === receipt.id);
  if (at >= 0) {
    // An older copy of the same receipt (a slow response) never replaces a newer one
    if (Date.parse(list[at].updatedAt) > Date.parse(receipt.updatedAt)) return list.slice();
    const next = list.slice();
    next[at] = receipt;
    return next;
  }
  return [...list, receipt].sort((a, b) => a.id.localeCompare(b.id));
}

/** Which load answers which thread's latest request: a late answer for an older request is dropped. */
const requests = new Map<string, symbol>();

export const useReceiptStore = create<ReceiptState>((set, get) => ({
  byThread: new Map(),
  errors: new Map(),
  loading: new Set(),

  load: async (channelId, threadId) => {
    const token = Symbol();
    requests.set(threadId, token);
    set(s => ({ loading: new Set(s.loading).add(threadId) }));
    try {
      const { receipts } = await inBackground(() => api.get<{ receipts: Receipt[] }>(`/channels/${channelId}/threads/${threadId}/receipts`));
      if (requests.get(threadId) !== token) return;
      set(s => {
        const byThread = new Map(s.byThread);
        // Keep anything newer that an event delivered while the request was in flight
        let merged = receipts;
        for (const held of s.byThread.get(threadId) ?? []) {
          const fresh = merged.find(r => r.id === held.id);
          if (!fresh || Date.parse(held.updatedAt) > Date.parse(fresh.updatedAt)) merged = upsert(merged, held);
        }
        byThread.set(threadId, merged);
        const errors = new Map(s.errors);
        errors.delete(threadId);
        return { byThread, errors };
      });
    } catch {
      if (requests.get(threadId) !== token) return;
      set(s => ({ errors: new Map(s.errors).set(threadId, 'Could not load the receipts. Try again.') }));
    } finally {
      if (requests.get(threadId) === token) set(s => { const loading = new Set(s.loading); loading.delete(threadId); return { loading }; });
    }
  },

  applyUpdate: ({ channelId, threadId, receipt }) => {
    if (!get().byThread.has(threadId)) {
      // Never loaded: a count or a later open needs the whole list, not one receipt of it
      void get().load(channelId, threadId);
      return;
    }
    set(s => ({ byThread: new Map(s.byThread).set(threadId, upsert(s.byThread.get(threadId) ?? [], receipt)) }));
  },

  reloadLoaded: () => {
    for (const [threadId, list] of get().byThread) {
      const channelId = list[0]?.channelId;
      if (channelId) void get().load(channelId, threadId);
    }
  },

  giveVerdict: async (channelId, receiptId, verdict, note) => {
    const body = verdict === 'disputed' ? { verdict, note } : { verdict };
    const result = await api.post<VerdictResult>(`/channels/${channelId}/receipts/${receiptId}/verdict`, body);
    // The event does the same, but the person who pressed the button should not wait for it
    get().applyUpdate({ channelId, threadId: result.receipt.threadId, receipt: result.receipt });
    return result;
  },

  reset: () => { requests.clear(); set({ byThread: new Map(), errors: new Map(), loading: new Set() }); },
}));

/**
 * How many receipts of a thread need a person (contradicted claims nobody accepted, disputed
 * receipts). Counted from the loaded receipts when there are any, so it follows ReceiptUpdate
 * events and clears on an accept; else from the thread list's `receiptAttention`.
 */
export function useReceiptAttention(threadId: string, fromList?: number | null): number {
  const loaded = useReceiptStore(s => s.byThread.get(threadId));
  return loaded ? attentionCount(loaded) : fromList ?? 0;
}
