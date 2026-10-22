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

  const isExpanded = (key: string, aliases: readonly string[] = []) => keys.includes(key) || aliases.some(alias => keys.includes(alias));
  const toggle = useCallback((key: string, aliases: readonly string[] = []) => {
    setState(prev => {
      const allKeys = new Set([key, ...aliases]);
      const next = prev.keys.some(held => allKeys.has(held))
        ? prev.keys.filter(held => !allKeys.has(held)) : toggleRunKey(prev.keys, key);
      saveExpandedRuns(prev.userId, next);
      return { userId: prev.userId, keys: next };
    });
  }, []);
  return { isExpanded, toggle, keys };
}
