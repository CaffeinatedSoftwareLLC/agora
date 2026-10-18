import { useEffect, type RefObject } from 'react';

/** Shared by shell surfaces, Modal, and the sheets added in later phases. */
export function useOverlayFocus(ref: RefObject<HTMLElement | null>, active: boolean, trap = active) {
  // Capture the invoking control for the full surface lifetime, including when a
  // higher-priority dialog temporarily takes over its focus trap.
  useEffect(() => {
    if (!active) return;
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      queueMicrotask(() => { if (invoker?.isConnected && !invoker.closest('[inert]')) invoker.focus(); });
    };
  }, [active]);
  useEffect(() => {
    if (!active || !trap) return;
    const root = ref.current;
    if (!root) return;
    const focusable = () => Array.from(root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
    )).filter(el => !el.closest('[inert]') && el.getClientRects().length > 0);
    const frame = requestAnimationFrame(() => (focusable()[0] ?? root).focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0] ?? root;
      const last = items.at(-1) ?? root;
      if (!root.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, active, trap]);
}

