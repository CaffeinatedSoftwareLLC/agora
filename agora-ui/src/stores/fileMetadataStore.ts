import { create } from 'zustand';
import type { FileAttachmentUpdatePayload } from '../lib/contracts/ws-events';

export function fileMetadata(data: FileAttachmentUpdatePayload) {
  return { tags: data.tags, tagging: data.tagging, partial: data.partial, injectionWarning: data.injectionWarning };
}

/** Retain live results that can beat the message event or an in-flight history GET. */
export const useFileMetadataStore = create<{
  byFile: Map<string, ReturnType<typeof fileMetadata>>;
  update: (data: FileAttachmentUpdatePayload) => void;
  clear: () => void;
}>((set) => ({
  byFile: new Map(),
  update: data => set(state => {
    const next = new Map(state.byFile);
    next.delete(data.fileId);
    next.set(data.fileId, fileMetadata(data));
    if (next.size > 500) next.delete(next.keys().next().value!);
    return { byFile: next };
  }),
  clear: () => set({ byFile: new Map() }),
}));
