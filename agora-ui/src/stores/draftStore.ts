import { create } from 'zustand';

export type DraftKey = `channel:${string}` | `thread:${string}`;

interface DraftState {
  drafts: Partial<Record<DraftKey, string>>;
  getDraft: (key: DraftKey) => string;
  setDraft: (key: DraftKey, text: string) => void;
  clearDraft: (key: DraftKey) => void;
  clearAllDrafts: () => void;
}

export const useDraftStore = create<DraftState>((set, get) => ({
  drafts: {},
  getDraft: key => get().drafts[key] ?? '',
  setDraft: (key, text) => set(s => ({ drafts: { ...s.drafts, [key]: text } })),
  clearDraft: key => set(s => {
    const drafts = { ...s.drafts };
    delete drafts[key];
    return { drafts };
  }),
  clearAllDrafts: () => set({ drafts: {} }),
}));

/** Clear only the submitted version; edits made during a request survive. */
export async function sendDraft(key: DraftKey, send: () => Promise<boolean>): Promise<boolean> {
  const text = useDraftStore.getState().getDraft(key);
  try {
    if (!await send()) return false;
    if (useDraftStore.getState().getDraft(key) === text) useDraftStore.getState().clearDraft(key);
    return true;
  } catch {
    return false;
  }
}
