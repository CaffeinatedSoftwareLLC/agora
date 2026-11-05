import { useEffect, useState } from 'react';
import { serverApi } from '../lib/api';

const Administrator = 1n << 0n;
const ManageBots = 1n << 27n;
/** How long one /access answer is reused; the server checks every change anyway. */
const TTL_MS = 60_000;

const cache = new Map<string, { at: number; answer: Promise<boolean> }>();

function lookup(serverId: string): Promise<boolean> {
  const hit = cache.get(serverId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.answer;
  const answer = serverApi.getAccess(serverId)
    .then(data => {
      try { return (BigInt(data.permissions) & (ManageBots | Administrator)) !== 0n; } catch { return false; }
    })
    .catch(() => { cache.delete(serverId); return false; });
  cache.set(serverId, { at: Date.now(), answer });
  return answer;
}

/**
 * Whether the current user holds ManageBots on a server: the permission that may change
 * the loop guard (PATCH /channels/:id/bot-config). Many notices share one request.
 */
export function useCanManageBots(serverId: string | null | undefined): boolean {
  const [answer, setAnswer] = useState<{ serverId: string; can: boolean } | null>(null);
  useEffect(() => {
    if (!serverId) return;
    let live = true;
    void lookup(serverId).then(can => { if (live) setAnswer({ serverId, can }); });
    return () => { live = false; };
  }, [serverId]);
  return !!serverId && answer?.serverId === serverId && answer.can;
}

/** Tests only. */
export function clearCanManageBotsCache() { cache.clear(); }
