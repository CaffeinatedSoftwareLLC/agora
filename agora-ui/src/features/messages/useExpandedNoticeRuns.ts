import { useCallback, useState } from 'react';
import { loadExpandedRuns, saveExpandedRuns, toggleRunKey } from './systemNotices';

/** Which notice runs this user has expanded, remembered in localStorage per user (#118). */
export function useExpandedNoticeRuns(userId: string | undefined) {
  const [state, setState] = useState(() => ({ userId, keys: loadExpandedRuns(userId) }));
  // Reload when the signed-in user changes (render-time state adjustment, no effect needed)
  let current = state;
  if (state.userId !== userId) {
    current = { userId, keys: loadExpandedRuns(userId) };
    setState(current);
  }
  const { keys } = current;

  const isExpanded = (key: string) => keys.includes(key);
  const toggle = useCallback((key: string) => {
    setState(prev => {
      const next = toggleRunKey(prev.keys, key);
      saveExpandedRuns(prev.userId, next);
      return { userId: prev.userId, keys: next };
    });
  }, []);
  return { isExpanded, toggle, keys };
}
