import { useCallback, useState } from 'react';
import { loadExpandedRuns, saveExpandedRuns, toggleRunKey } from './systemNotices';

function expanded(held: readonly string[], key: string, aliases: readonly string[], defaultExpanded: boolean) {
  const allKeys = [key, ...aliases];
  if (allKeys.some(alias => held.includes(`collapsed:${alias}`))) return false;
  return allKeys.some(alias => held.includes(alias)) || defaultExpanded;
}

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

  const isExpanded = (key: string, aliases: readonly string[] = [], defaultExpanded = false) => expanded(keys, key, aliases, defaultExpanded);
  const toggle = useCallback((key: string, aliases: readonly string[] = [], defaultExpanded = false) => {
    setState(prev => {
      const allKeys = new Set([key, ...aliases].flatMap(alias => [alias, `collapsed:${alias}`]));
      const next = toggleRunKey(prev.keys.filter(held => !allKeys.has(held)),
        expanded(prev.keys, key, aliases, defaultExpanded) ? `collapsed:${key}` : key);
      saveExpandedRuns(prev.userId, next);
      return { userId: prev.userId, keys: next };
    });
  }, []);
  return { isExpanded, toggle, keys };
}
