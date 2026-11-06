import { useEffect, useState } from 'react';
import { serverApi } from '../lib/api';
import { useAuthStore } from '../stores/authStore';

const Administrator = 1n << 0n;
const ManageBots = 1n << 27n;
/** How long one /access answer is reused; the server checks every change anyway. */
const TTL_MS = 60_000;

const cache = new Map<string, { at: number; answer: Promise<boolean> }>();

// Keyed by user too: another account signing in on this tab never reuses an answer
function lookup(userId: string, serverId: string): Promise<boolean> {
  const key = `${userId}:${serverId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.answer;
  const answer = serverApi.getAccess(serverId)
    .then(data => {
      try { return (BigInt(data.permissions) & (ManageBots | Administrator)) !== 0n; } catch { return false; }
    })
    .catch(() => { cache.delete(key); return false; });
  cache.set(key, { at: Date.now(), answer });
  return answer;
}

/**
 * Whether the current user holds ManageBots on a server: the permission that may change
 * the loop guard (PATCH /channels/:id/bot-config). Many notices share one request.
 */
export function useCanManageBots(serverId: string | null | undefined): boolean {
  const userId = useAuthStore(s => s.user?.id ?? null);
  const want = userId && serverId ? `${userId}:${serverId}` : null;
  const [answer, setAnswer] = useState<{ key: string; can: boolean } | null>(null);
  useEffect(() => {
    if (!userId || !serverId) return;
    const key = `${userId}:${serverId}`;
    let live = true;
    void lookup(userId, serverId).then(can => { if (live) setAnswer({ key, can }); });
    return () => { live = false; };
  }, [userId, serverId]);
  return !!want && answer?.key === want && answer.can;
}

/** Tests only. */
export function clearCanManageBotsCache() { cache.clear(); }
