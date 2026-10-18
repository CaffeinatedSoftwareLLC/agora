import { useOverlayFocus } from './useOverlayFocus';
import { useEffect, useRef, type RefObject } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useShellViewport } from './viewport';
import { installShellHistory } from './shellHistory';

export function OverlayManager({ navRef, auxRef }: {
  navRef: RefObject<HTMLElement | null>;
  auxRef: RefObject<HTMLElement | null>;
}) {
  const { compact } = useShellViewport();
  const navOpen = useUIStore(s => s.navOpen);
  const aux = useUIStore(s => s.aux);
  const overlay = useUIStore(s => s.activeOverlay);
  const latestCompact = useRef(compact);
  useEffect(() => { latestCompact.current = compact; }, [compact]);
  useEffect(installShellHistory, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const s = useUIStore.getState();
      if (event.key === 'Escape' && !event.defaultPrevented && (s.activeOverlay || (latestCompact.current && (s.navOpen || s.aux)))) {
        event.preventDefault();
        useUIStore.getState().dismissTop();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useOverlayFocus(navRef, compact && navOpen, !overlay);
  useOverlayFocus(auxRef, compact && !!aux, !overlay && !navOpen);
  return null;
}
