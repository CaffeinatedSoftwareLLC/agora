import { useUIStore } from '../../stores/uiStore';
import { isPhone } from './viewport';
export function isFeedObscured() {
  const s = useUIStore.getState();
  return !!s.activeOverlay || (isPhone() && (s.navOpen || s.aux !== null));
}
