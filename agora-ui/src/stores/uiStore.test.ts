import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useUIStore } from './uiStore';
import { useThreadStore } from './threadStore';

vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});
beforeEach(() => {
  useUIStore.setState({ navOpen: false, aux: null, activeOverlay: null, activeModal: null });
  useThreadStore.getState().clear();
  vi.spyOn(api, 'get').mockResolvedValue([]);
});

describe('shared shell actions', () => {
  it('mutually excludes navigation and every inspector', () => {
    const ui = useUIStore.getState();
    for (const kind of ['thread', 'files', 'members'] as const) {
      ui.openNav();
      ui.openAux(kind);
      expect(useUIStore.getState()).toMatchObject({ navOpen: false, aux: kind });
      ui.openNav();
      expect(useUIStore.getState()).toMatchObject({ navOpen: true, aux: null });
    }
    ui.toggleAux('files');
    ui.toggleAux('files');
    expect(useUIStore.getState().aux).toBeNull();
  });
  it('opens thread data, caches identity on local close, clears mismatched channel identity', () => {
    const ui = useUIStore.getState();
    const lock = vi.spyOn(api, 'patch');
    ui.openThreadView('channel-a', 'parent');
    expect(api.get).toHaveBeenCalledWith('/channels/channel-a/messages/parent/replies?limit=50&order=desc');
    ui.closeAux();
    expect(useThreadStore.getState().openThreadId).toBe('parent');
    expect(lock).not.toHaveBeenCalled();
    ui.openAux('members');
    ui.onChannelSelect('channel-b');
    expect(useUIStore.getState()).toMatchObject({ navOpen: false, aux: null });
    expect(useThreadStore.getState().openThreadId).toBeNull();
  });
  it('dismisses an overlay before the underlying aux, without locking the thread', () => {
    const close = vi.fn();
    const ui = useUIStore.getState();
    ui.openThreadView('channel', 'parent');
    ui.openOverlay({ kind: 'message-actions', id: 'actions', onClose: close });
    ui.dismissTop();
    expect(close).toHaveBeenCalledOnce();
    expect(useUIStore.getState().aux).toBe('thread');
    ui.dismissTop();
    expect(useUIStore.getState().aux).toBeNull();
    expect(useThreadStore.getState().openThreadId).toBe('parent');
  });
  it('gives modals precedence and closes replaced sheets', () => {
    const ui = useUIStore.getState();
    const close = vi.fn();
    ui.openOverlay({ kind: 'session-sheet', id: 'agent', onClose: close });
    ui.openOverlay({ kind: 'modal', id: 'invite', onClose: vi.fn() });
    expect(close).toHaveBeenCalledOnce();
    ui.openOverlay({ kind: 'message-actions', id: 'message', onClose: vi.fn() });
    expect(useUIStore.getState().activeOverlay?.id).toBe('invite');
  });
});
