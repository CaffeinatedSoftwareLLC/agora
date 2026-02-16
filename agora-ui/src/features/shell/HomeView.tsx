import { useState, useMemo } from 'react';
import { usePalette } from '../../theme';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { DMSidebar } from './DMSidebar';
import { ServerList } from './ServerList';
import { ExploreView } from './ExploreView';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Sum unread + mention counts for every channel belonging to `serverId`. */
function getServerUnread(
  serverId: string,
  byChannel: Map<string, { unreadCount: number; mentionCount: number }>,
): number {
  const channels = useChannelStore.getState().byServer(serverId);
  let total = 0;
  for (const ch of channels) {
    const entry = byChannel.get(ch.id);
    if (entry) total += entry.unreadCount + entry.mentionCount;
  }
  return total;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function HomeView() {
  const P = usePalette();

  const user = useAuthStore(s => s.user);
  const servers = useServerStore(s => s.servers);
  const byChannel = useUnreadStore(s => s.byChannel);

  const [subTab, setSubTab] = useState<'servers' | 'explore'>('servers');

  // Compute total unreads across all servers
  const { totalUnread, serversWithUnread } = useMemo(() => {
    let totalUnread = 0;
    let serversWithUnread = 0;
    for (const [sid] of servers) {
      const u = getServerUnread(sid, byChannel);
      totalUnread += u;
      if (u > 0) serversWithUnread++;
    }
    return { totalUnread, serversWithUnread };
  }, [servers, byChannel]);

  const username = user?.username ?? 'there';

  return (
    <div className="flex flex-1 min-h-0">
      {/* ── Left: DM sidebar ──────────────────────────────────────────────── */}
      <DMSidebar />

      {/* ── Main area ─────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0" style={{ background: P.bg }}>
        {/* Sub-tab header area */}
        <div className="shrink-0 px-6 pt-5 pb-0">
          {/* Welcome + quick switch */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-bold" style={{ color: P.text }}>
                Welcome back, {username}
              </h1>
              <p className="text-[13px] mt-0.5" style={{ color: P.muted }}>
                {totalUnread > 0
                  ? `${totalUnread} unread message${totalUnread !== 1 ? 's' : ''} across ${serversWithUnread} server${serversWithUnread !== 1 ? 's' : ''}`
                  : 'You\u2019re all caught up'}
              </p>
            </div>

            {/* Quick switch button */}
            <button
              className="flex items-center gap-2.5 px-4 py-2 rounded-xl transition-all"
              style={{ background: P.surface, border: `1px solid ${P.border}` }}
            >
              <svg
                className="h-4 w-4"
                style={{ color: P.muted }}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <span className="text-[13px]" style={{ color: P.dim }}>Quick switch...</span>
              <kbd
                className="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ml-3"
                style={{ background: P.bg, color: P.muted, border: `1px solid ${P.border}` }}
              >
                Ctrl+K
              </kbd>
            </button>
          </div>

          {/* Sub-tabs: Servers | Explore */}
          <div className="flex gap-1" style={{ borderBottom: `1px solid ${P.border}` }}>
            {/* Servers tab */}
            <button
              onClick={() => setSubTab('servers')}
              className="relative px-4 py-2.5 text-[13px] font-semibold transition-all"
              style={{ color: subTab === 'servers' ? P.text : P.dim }}
            >
              <span className="flex items-center gap-2">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
                Servers
              </span>
              {subTab === 'servers' && (
                <span
                  className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full"
                  style={{ background: `linear-gradient(90deg, ${P.accent}, ${P.primary})` }}
                />
              )}
            </button>

            {/* Explore tab */}
            <button
              onClick={() => setSubTab('explore')}
              className="relative px-4 py-2.5 text-[13px] font-semibold transition-all"
              style={{ color: subTab === 'explore' ? P.text : P.dim }}
            >
              <span className="flex items-center gap-2">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
                </svg>
                Explore
              </span>
              {subTab === 'explore' && (
                <span
                  className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full"
                  style={{ background: `linear-gradient(90deg, ${P.accent}, ${P.primary})` }}
                />
              )}
            </button>
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {subTab === 'servers' ? <ServerList /> : <ExploreView />}
        </div>
      </div>
    </div>
  );
}
