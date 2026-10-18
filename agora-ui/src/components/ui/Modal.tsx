import { useUIStore } from '../../stores/uiStore';
import { useOverlayFocus } from '../../features/shell/useOverlayFocus';
import { useEffect, useRef, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export function Modal({ isOpen, onClose, title, children }: ModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  const id = useId();
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!isOpen) return;
    useUIStore.getState().openOverlay({ kind: 'modal', id, onClose: () => closeRef.current() });
    return () => {
      useUIStore.getState().releaseOverlay(id);
    };
  }, [isOpen, id]);
  useOverlayFocus(contentRef, isOpen);
  useEffect(() => {
    if (!isOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        useUIStore.getState().closeOverlay();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={contentRef}
        role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        className="bg-surface rounded-lg border border-border p-6 max-w-md w-full mx-4"
      >
        <h2 className="text-lg font-bold text-text">{title}</h2>
        <div className="mt-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
