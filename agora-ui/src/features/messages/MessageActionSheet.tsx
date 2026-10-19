import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useUIStore } from '../../stores/uiStore';
import { useOverlayFocus } from '../shell/useOverlayFocus';
import { SpeakerIcon } from './MessageActions';

interface MessageActionSheetProps {
  isOpen: boolean;
  onClose: () => void;
  isOwn: boolean;
  onReply?: () => void;
  onCopy?: () => void;
  onReadAloud?: () => void;
  readingAloud?: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export function MessageActionSheet({
  isOpen,
  onClose,
  isOwn,
  onReply,
  onCopy,
  onReadAloud,
  readingAloud,
  onEdit,
  onDelete,
}: MessageActionSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    useUIStore.getState().openOverlay({
      kind: 'message-actions',
      id,
      onClose: () => closeRef.current(),
    });
    return () => {
      useUIStore.getState().releaseOverlay(id);
    };
  }, [isOpen, id]);

  useOverlayFocus(sheetRef, isOpen);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        useUIStore.getState().closeOverlay();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  if (!isOpen) return null;

  const dismissAndRun = (action?: () => void) => {
    useUIStore.getState().closeOverlay();
    action?.();
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-end md:items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          useUIStore.getState().closeOverlay();
        }
      }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Message actions"
        tabIndex={-1}
        className="bg-surface border-t md:border border-border rounded-t-2xl md:rounded-2xl w-full max-w-md pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] px-2 shadow-xl outline-none"
      >
        <div className="w-10 h-1 rounded-full bg-border mx-auto mb-2 md:hidden" />

        <div className="flex flex-col gap-0.5">
          {onReply && (
            <button
              type="button"
              onClick={() => dismissAndRun(onReply)}
              className="w-full min-h-12 px-4 py-2.5 rounded-xl flex items-center gap-3 text-[15px] font-medium text-text hover:bg-surface-hover transition-colors text-left"
            >
              <svg className="w-5 h-5 text-text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
              <span>Reply in thread</span>
            </button>
          )}

          {onCopy && (
            <button
              type="button"
              onClick={() => dismissAndRun(onCopy)}
              className="w-full min-h-12 px-4 py-2.5 rounded-xl flex items-center gap-3 text-[15px] font-medium text-text hover:bg-surface-hover transition-colors text-left"
            >
              <svg className="w-5 h-5 text-text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" strokeWidth={2} />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
              <span>Copy text</span>
            </button>
          )}

          {onReadAloud && (
            <button
              type="button"
              onClick={() => dismissAndRun(onReadAloud)}
              className="w-full min-h-12 px-4 py-2.5 rounded-xl flex items-center gap-3 text-[15px] font-medium text-text hover:bg-surface-hover transition-colors text-left"
            >
              <SpeakerIcon className="w-5 h-5 text-text-muted shrink-0" reading={readingAloud} />
              <span>{readingAloud ? 'Stop reading' : 'Read aloud'}</span>
            </button>
          )}

          {isOwn && (
            <>
              <button
                type="button"
                onClick={() => dismissAndRun(onEdit)}
                className="w-full min-h-12 px-4 py-2.5 rounded-xl flex items-center gap-3 text-[15px] font-medium text-text hover:bg-surface-hover transition-colors text-left"
              >
                <svg className="w-5 h-5 text-text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
                <span>Edit message</span>
              </button>

              <button
                type="button"
                onClick={() => dismissAndRun(onDelete)}
                className="w-full min-h-12 px-4 py-2.5 rounded-xl flex items-center gap-3 text-[15px] font-medium text-danger hover:bg-danger/15 transition-colors text-left"
              >
                <svg className="w-5 h-5 text-danger shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                <span>Delete message</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
