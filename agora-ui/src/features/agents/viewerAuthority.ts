import { useEffect, useState } from 'react';
import { api, inBackground } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';

/**
 * Whether the viewer may direct agents in a channel: 'owner', 'director' or null (a plain
 * member). From GET /channels/:id/directors (src/routes/directors.ts), the same rule the
 * server applies to decisions (src/lib/direct-agents.ts). 'loading' until it is known;
 * 'unknown' if the lookup failed, and then the server's refusal is the guard.
 */
export type ViewerAuthority = 'owner' | 'director' | null | 'loading' | 'unknown';

interface Director { userId: string; authority: 'owner' | 'director' }

// One lookup per channel serves every card on screen; refreshed after a short while so a
// role change shows up without a reload
const TTL_MS = 30_000;
const lookups = new Map<string, { at: number; directors: Promise<Director[]> }>();

function directorsOf(channelId: string): Promise<Director[]> {
  const hit = lookups.get(channelId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.directors;
  const directors = inBackground(() => api.get<{ directors: Director[] }>(`/channels/${channelId}/directors`))
    .then(r => r.directors ?? []);
  lookups.set(channelId, { at: Date.now(), directors });
  directors.catch(() => { if (lookups.get(channelId)?.directors === directors) lookups.delete(channelId); });
  return directors;
}

/** For tests. */
export function clearViewerAuthority(): void {
  lookups.clear();
}

export function useViewerAuthority(channelId: string | undefined, enabled = true): ViewerAuthority {
  const userId = useAuthStore(s => s.user?.id);
  const [found, setFound] = useState<{ key: string; authority: ViewerAuthority } | null>(null);
  const key = `${channelId ?? ''}:${userId ?? ''}`;

  useEffect(() => {
    if (!enabled || !channelId || !userId) return;
    let live = true;
    directorsOf(channelId).then(
      list => {
        const me = list.find(d => d.userId.trim() === userId.trim());
        if (live) setFound({ key, authority: me ? me.authority : null });
      },
      () => { if (live) setFound({ key, authority: 'unknown' }); },
    );
    return () => { live = false; };
  }, [enabled, channelId, userId, key]);

  if (!channelId || !userId) return null;
  return found?.key === key ? found.authority : 'loading';
}
