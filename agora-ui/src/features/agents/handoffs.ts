import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

/** Ownership handoffs (#84, docs/agent-sessions.md "Handoffs"): card data and the thread's owner. */

export interface HandoffData {
  kind?: string; offerId?: string; status?: string; from?: string; to?: string;
  branch?: string | null; headSha?: string | null; senderRunning?: boolean; paths?: string[];
  expiresAt?: string; reason?: string | null;
}

export const HANDOFF_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'PENDING', tone: 'bg-warn/20 text-warn' },
  accepted: { label: 'ACCEPTED', tone: 'bg-online/20 text-online' },
  declined: { label: 'DECLINED', tone: 'bg-danger/20 text-danger' },
  expired: { label: 'EXPIRED', tone: 'bg-surface text-text-muted' },
  cancelled: { label: 'CANCELLED', tone: 'bg-surface text-text-muted' },
};

/** The status to show: a pending offer past its expiry reads as expired before the server marks it. */
export function handoffStatus(data: HandoffData, now = Date.now()): string {
  if (data.status === 'pending' && data.expiresAt && Date.parse(data.expiresAt) <= now) return 'expired';
  return data.status ?? 'pending';
}

export interface ThreadOwnerInfo { username: string; sessionState: string; from: string | null; branch: string | null; headSha: string | null }

/** The thread's task owner, for the thread header. Refetches when an offer's state changes. */
export function useThreadOwner(channelId: string | null, threadId: string | null, version: string): ThreadOwnerInfo | null {
  const key = channelId && threadId ? `${channelId}/${threadId}` : null;
  const [loaded, setLoaded] = useState<{ key: string; owner: ThreadOwnerInfo | null } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    api.get<{ owner: ThreadOwnerInfo | null }>(`/channels/${key.replace('/', '/threads/')}/handoffs`)
      .then(r => { if (live) setLoaded({ key, owner: r.owner }); })
      .catch(() => { if (live) setLoaded({ key, owner: null }); });
    return () => { live = false; };
  }, [key, version]);
  // Only the open thread's answer; another thread's stays hidden until its own arrives
  return loaded && loaded.key === key ? loaded.owner : null;
}

