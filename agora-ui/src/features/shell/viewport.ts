import { useSyncExternalStore } from 'react';

const queries = { phone: '(max-width: 767px)', compact: '(max-width: 1279px)' };
const listeners = new Set<() => void>();
let media: MediaQueryList[] = [];
function subscribe(listener: () => void) {
  if (!listeners.size) {
    media = Object.values(queries).map(q => window.matchMedia(q));
    media.forEach(q => q.addEventListener('change', notify));
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) media.forEach(q => q.removeEventListener('change', notify));
  };
}
function notify() { listeners.forEach(listener => listener()); }
export function isPhone() { return window.matchMedia(queries.phone).matches; }
export function isCompact() { return window.matchMedia(queries.compact).matches; }
export function useShellViewport() {
  const phone = useSyncExternalStore(subscribe, isPhone, () => false);
  const compact = useSyncExternalStore(subscribe, isCompact, () => false);
  return { phone, compact };
}
