import { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePalette } from '../../theme';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useMemberStore } from '../../stores/memberStore';
import { useUIStore } from '../../stores/uiStore';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Deterministic color from server name (no color property on the Server contract). */
function serverColor(name: string): string {
  const colors = [
    '#0FA3B1', '#4ADE80', '#FBBF24', '#C77DFF', '#F97316',
    '#EF4444', '#3B82F6', '#EC4899', '#8B5CF6', '#10B981',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

/** Generate 1-2 character initials from a server name. */
function serverInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

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

/** Count online members for a server. */
function getOnlineCount(serverId: string): number {
  const members = useMemberStore.getState().byServer.get(serverId);
  if (!members) return 0;
  const statusMap = usePresenceStore.getState().status;
  let count = 0;
  for (const m of members) {
    const s = statusMap.get(m.id);
    if (s === 'online' || s === 'idle') count++;
  }
  return count;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ServerList() {
  const P = usePalette();
  const navigate = useNavigate();

  const servers = useServerStore(s => s.servers);
  const pinnedServerIds = useServerStore(s => s.pinnedServerIds);
  const setActiveServer = useServerStore(s => s.setActiveServer);
  const addServerTab = useUIStore(s => s.addServerTab);
  const byChannel = useUnreadStore(s => s.byChannel);

  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Split into pinned / unpinned
  const { pinned, unpinned } = useMemo(() => {
    const pinned: typeof allServers = [];
    const unpinned: typeof allServers = [];
    const allServers = Array.from(servers.values());
    for (const s of allServers) {
      if (pinnedServerIds.has(s.id)) pinned.push(s);
      else unpinned.push(s);
    }
    return { pinned, unpinned };
  }, [servers, pinnedServerIds]);

  const handleServerClick = useCallback((serverId: string) => {
    setActiveServer(serverId);
    addServerTab(serverId);
    navigate(`/app/${serverId}`);
  }, [setActiveServer, addServerTab, navigate]);

  // ── Shared server row renderer ─────────────────────────────────────────

  const renderServerRow = (server: { id: string; name: string; ownerId: string }) => {
    const color = serverColor(server.name);
    const initials = serverInitials(server.name);
    const unread = getServerUnread(server.id, byChannel);
    const hasUnread = unread > 0;
    const isPinned = pinnedServerIds.has(server.id);
    const isHovered = hoveredId === server.id;
    const online = getOnlineCount(server.id);

    return (
      <button
        key={server.id}
        onClick={() => handleServerClick(server.id)}
        className="w-full flex items-center gap-3.5 px-4 py-3 rounded-xl mb-1.5 transition-all duration-150 group text-left"
        style={{
          background: isHovered ? P.surfaceHover : P.surface,
          border: `1px solid ${isHovered ? P.border : 'transparent'}`,
        }}
        onMouseEnter={() => setHoveredId(server.id)}
        onMouseLeave={() => setHoveredId(null)}
      >
        {/* Color indicator bar + server icon */}
        <div className="flex items-center gap-3 shrink-0">
          <div
            className="w-1 h-8 rounded-full"
            style={{ background: color, boxShadow: `0 0 8px ${color}40` }}
          />
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold"
            style={{
              background: `linear-gradient(135deg, ${color}30, ${color}10)`,
              color: color,
            }}
          >
            {initials}
          </div>
        </div>

        {/* Server info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="text-[14px] font-semibold truncate"
              style={{ color: hasUnread ? P.text : P.muted }}
            >
              {server.name}
            </span>
            {isPinned && (
              <svg
                className="h-3 w-3 shrink-0"
                style={{ color: P.dim }}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <line x1="12" y1="17" x2="12" y2="22" />
                <path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.89A2 2 0 0115 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.89A2 2 0 005 15.24z" />
              </svg>
            )}
          </div>
        </div>

        {/* Right side: online count + unread badge */}
        <div className="flex items-center gap-3 shrink-0">
          {/* Online indicator */}
          {online > 0 && (
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full" style={{ background: P.online }} />
              <span className="text-[11px] font-medium" style={{ color: P.dim }}>{online}</span>
            </div>
          )}

          {/* Unread badge */}
          {hasUnread ? (
            <span
              className="text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[20px] text-center"
              style={{ background: P.accent, color: P.bg }}
            >
              {unread}
            </span>
          ) : (
            <span className="w-[20px]" />
          )}
        </div>
      </button>
    );
  };

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <>
      {/* Pinned servers section */}
      {pinned.length > 0 && (
        <div className="mb-5">
          <h3
            className="text-[10px] font-semibold uppercase tracking-widest px-1 mb-2 flex items-center gap-1.5"
            style={{ color: P.dim }}
          >
            <svg
              className="h-3 w-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <line x1="12" y1="17" x2="12" y2="22" />
              <path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.89A2 2 0 0115 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.89A2 2 0 005 15.24z" />
            </svg>
            Pinned
          </h3>
          {pinned.map(server => renderServerRow(server))}
        </div>
      )}

      {/* All Servers section */}
      <div>
        <h3
          className="text-[10px] font-semibold uppercase tracking-widest px-1 mb-2"
          style={{ color: P.dim }}
        >
          All Servers
        </h3>
        {unpinned.length === 0 && pinned.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-[13px]" style={{ color: P.dim }}>No servers yet</p>
            <p className="text-[12px] mt-1" style={{ color: P.dim }}>
              Join or create a server to get started
            </p>
          </div>
        )}
        {unpinned.map(server => renderServerRow(server))}
      </div>
    </>
  );
}
