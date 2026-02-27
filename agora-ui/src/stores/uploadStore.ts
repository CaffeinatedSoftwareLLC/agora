import { create } from 'zustand';
import { uploadFile } from '../lib/api';

export interface PendingUpload {
  id: string;          // temporary client ID
  file: File;
  channelId: string;
  progress: number;    // 0-100
  status: 'uploading' | 'done' | 'error';
  result?: { id: string; name: string; mime: string; size: number; width: number | null; height: number | null; url: string };
  error?: string;
}

interface UploadState {
  uploads: Map<string, PendingUpload>;
  addUpload: (channelId: string, file: File) => string;
  removeUpload: (id: string) => void;
  clearCompleted: (channelId: string) => void;
  getChannelUploads: (channelId: string) => PendingUpload[];
  getCompletedIds: (channelId: string) => string[];
}

export const useUploadStore = create<UploadState>((set, get) => ({
  uploads: new Map(),

  addUpload: (channelId, file) => {
    const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const upload: PendingUpload = { id, file, channelId, progress: 0, status: 'uploading' };

    set(state => {
      const next = new Map(state.uploads);
      next.set(id, upload);
      return { uploads: next };
    });

    // Start upload
    uploadFile(channelId, file)
      .then(result => {
        set(state => {
          const next = new Map(state.uploads);
          const u = next.get(id);
          if (u) next.set(id, { ...u, status: 'done', progress: 100, result });
          return { uploads: next };
        });
      })
      .catch(err => {
        set(state => {
          const next = new Map(state.uploads);
          const u = next.get(id);
          if (u) next.set(id, { ...u, status: 'error', error: err.message });
          return { uploads: next };
        });
      });

    return id;
  },

  removeUpload: (id) => {
    set(state => {
      const next = new Map(state.uploads);
      next.delete(id);
      return { uploads: next };
    });
  },

  clearCompleted: (channelId) => {
    set(state => {
      const next = new Map(state.uploads);
      for (const [id, u] of next) {
        if (u.channelId === channelId && (u.status === 'done' || u.status === 'error')) {
          next.delete(id);
        }
      }
      return { uploads: next };
    });
  },

  getChannelUploads: (channelId) => {
    return Array.from(get().uploads.values()).filter(u => u.channelId === channelId);
  },

  getCompletedIds: (channelId) => {
    return Array.from(get().uploads.values())
      .filter(u => u.channelId === channelId && u.status === 'done' && u.result)
      .map(u => u.result!.id);
  },
}));
