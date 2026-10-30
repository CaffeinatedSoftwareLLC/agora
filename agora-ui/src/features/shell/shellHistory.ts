import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';

function layers() {
  const s = useUIStore.getState();
  return [
    // Track logical selection even while docked, so resizing an already-open
    // inspector to phone preserves Back behavior without writing history on resize.
    ...(s.navOpen ? ['nav'] : s.aux ? [`aux:${s.aux}`] : []),
    ...(s.activeOverlay ? [`${s.activeOverlay.kind}:${s.activeOverlay.id}`] : []),
  ];
}

let settled: Promise<void> = Promise.resolve();
export function shellHistorySettled() { return settled; }

/** Only shell state changes write history. Media changes never do. */
export function installShellHistory() {
  // A remount (e.g. back from /settings) lands on the entry we pushed for a layer
  // that is still open in the store; adopt it so the next Back closes that layer
  // instead of being swallowed by a stale same-URL entry.
  const current = layers();
  let stack: string[] = current.length && window.history.state?.agoraLayer === current.at(-1) ? current : [];
  let popping = false;
  let pending = false;
  let resolvePending: (() => void) | undefined;
  let pathname = window.location.pathname;
  const write = (push: boolean) => {
    const state = { ...window.history.state, agoraLayer: stack.at(-1) ?? null };
    if (push) window.history.pushState(state, '');
    else window.history.replaceState(state, '');
  };
  const sync = () => {
    if (popping || pending) return;
    // Signing out closes every layer on the way to /login. Going back over their
    // entries would land after that navigation and return the page to /app, where
    // AuthGuard has already spent its redirect: a blank page. Leave them in place.
    if (!useAuthStore.getState().user) {
      stack = [];
      return;
    }
    if (pathname !== window.location.pathname) {
      pathname = window.location.pathname;
      stack = [];
    }
    const next = layers();
    if (next.length < stack.length) {
      const delta = next.length - stack.length;
      stack = next;
      pending = true;
      settled = new Promise(resolve => { resolvePending = resolve; });
      window.history.go(delta);
    } else {
      while (stack.length < next.length) {
        stack = next.slice(0, stack.length + 1);
        write(true);
      }
      stack = next;
      write(false);
    }
  };
  const onPop = () => {
    if (pending) {
      pending = false;
      write(false);
      resolvePending?.();
      sync();
      return;
    }
    if (!stack.length) return;
    stack.pop();
    popping = true;
    useUIStore.getState().dismissTop();
    popping = false;
    write(false);
  };
  const unsubscribe = useUIStore.subscribe((state, previous) => {
    if (state.navOpen !== previous.navOpen || state.aux !== previous.aux || state.activeOverlay !== previous.activeOverlay) sync();
  });
  window.addEventListener('popstate', onPop);
  return () => {
    unsubscribe();
    window.removeEventListener('popstate', onPop);
    resolvePending?.();
    settled = Promise.resolve();
  };
}
