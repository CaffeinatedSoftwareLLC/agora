import { create } from 'zustand';

export interface Reaction {
  emoji: string;
  count: number;
  userIds: string[];
  me: boolean;
}

interface ReactionState {
  byMessage: Map<string, Reaction[]>;
  setReactions: (messageId: string, reactions: Reaction[]) => void;
  addReaction: (messageId: string, emoji: string, userId: string, me: boolean) => void;
  removeReaction: (messageId: string, emoji: string, userId: string, me: boolean) => void;
  getReactions: (messageId: string) => Reaction[];
  clear: () => void;
}

export const useReactionStore = create<ReactionState>((set, get) => ({
  byMessage: new Map(),

  setReactions: (messageId, reactions) => {
    set((s) => {
      const next = new Map(s.byMessage);
      next.set(messageId, reactions);
      return { byMessage: next };
    });
  },

  addReaction: (messageId, emoji, userId, me) => {
    set((s) => {
      const next = new Map(s.byMessage);
      const reactions = [...(next.get(messageId) ?? [])];
      const idx = reactions.findIndex((r) => r.emoji === emoji);

      if (idx !== -1) {
        const existing = reactions[idx];
        if (existing.userIds.includes(userId)) return s;
        reactions[idx] = {
          ...existing,
          count: existing.count + 1,
          userIds: [...existing.userIds, userId],
          me: existing.me || me,
        };
      } else {
        reactions.push({ emoji, count: 1, userIds: [userId], me });
      }

      next.set(messageId, reactions);
      return { byMessage: next };
    });
  },

  removeReaction: (messageId, emoji, userId, me) => {
    set((s) => {
      const next = new Map(s.byMessage);
      const reactions = [...(next.get(messageId) ?? [])];
      const idx = reactions.findIndex((r) => r.emoji === emoji);

      if (idx === -1) return s;

      const existing = reactions[idx];
      if (existing.count <= 1) {
        reactions.splice(idx, 1);
      } else {
        reactions[idx] = {
          ...existing,
          count: existing.count - 1,
          userIds: existing.userIds.filter((id) => id !== userId),
          me: me ? false : existing.me,
        };
      }

      next.set(messageId, reactions);
      return { byMessage: next };
    });
  },

  getReactions: (messageId) => {
    return get().byMessage.get(messageId) ?? [];
  },

  clear: () => set({ byMessage: new Map() }),
}));
