import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { useChannelStore } from '../../stores/channelStore';
import { usePalette, hexToRgb } from '../../theme';

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

/** Sum unread + mention counts for every channel belonging to `serverId`. */
function getServerUnread(serverId: string, byChannel: Map<string, { unreadCount: number; mentionCount: number }>): number {
  const channels = useChannelStore.getState().byServer(serverId);
  let total = 0;
  for (const ch of channels) {
    const entry = byChannel.get(ch.id);
    if (entry) total += entry.unreadCount + entry.mentionCount;
  }
  return total;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function TabBar() {
  const navigate = useNavigate();
  const P = usePalette();

  // UI store
  const paletteKey = useUIStore(s => s.paletteKey);
  const togglePalette = useUIStore(s => s.togglePalette);
  const openServerTabs = useUIStore(s => s.openServerTabs);

  // Server store
  const servers = useServerStore(s => s.servers);
  const activeServerId = useServerStore(s => s.activeServerId);

  // Unread store
  const byChannel = useUnreadStore(s => s.byChannel);

  // Derived: active server object (if any)
  const activeServer = activeServerId ? servers.get(activeServerId) ?? null : null;
  const isHome = activeServerId === null;

  // Derived: accent color for the active server tab
  const accentColor = activeServer ? serverColor(activeServer.name) : P.accent;
  const accentRgb = hexToRgb(accentColor);

  // Derived: total unread across ALL servers (shown on the Home badge)
  const totalUnread = useMemo(() => {
    let sum = 0;
    for (const [sid] of servers) {
      sum += getServerUnread(sid, byChannel);
    }
    return sum;
  }, [servers, byChannel]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleHomeClick = () => {
    useServerStore.getState().setActiveServer(null);
    navigate('/app');
  };

  const handleServerTabClick = (serverId: string) => {
    useServerStore.getState().setActiveServer(serverId);
    navigate(`/app/${serverId}`);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Tab bar container */}
      <div
        className="flex items-center gap-1 px-3 pt-2 pb-0 shrink-0"
        style={{
          background: isHome
            ? `linear-gradient(180deg, rgba(${hexToRgb(P.accent)}, 0.06) 0%, transparent 100%)`
            : `linear-gradient(180deg, rgba(${accentRgb}, 0.08) 0%, transparent 100%)`,
        }}
      >
        {/* ── Home tab ─────────────────────────────────────────────────────── */}
        <button
          onClick={handleHomeClick}
          className="relative flex items-center gap-2 px-4 py-2 text-[13px] font-medium transition-all duration-200 rounded-t-xl shrink-0"
          style={
            isHome
              ? {
                  background: `linear-gradient(180deg, rgba(${hexToRgb(P.accent)}, 0.15) 0%, rgba(${hexToRgb(P.accent)}, 0.04) 100%)`,
                  boxShadow: `0 1px 0 0 rgba(${hexToRgb(P.accent)}, 0.3), inset 0 1px 0 0 rgba(${hexToRgb(P.accent)}, 0.12)`,
                  color: P.text,
                }
              : { color: P.dim }
          }
        >
          {/* House icon */}
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
          Home

          {/* Total unread badge (visible only when Home is NOT active) */}
          {totalUnread > 0 && !isHome && (
            <span
              className="h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center"
              style={{ background: P.danger, color: P.text }}
            >
              {totalUnread}
            </span>
          )}

          {/* Active underline */}
          {isHome && (
            <span
              className="absolute bottom-0 left-3 right-3 h-0.5 rounded-full"
              style={{ background: `linear-gradient(90deg, transparent, ${P.accent}, transparent)` }}
            />
          )}
        </button>

        {/* Separator */}
        <div className="w-px h-5 mx-1" style={{ background: `${P.border}88` }} />

        {/* ── Server tabs ──────────────────────────────────────────────────── */}
        <div className="flex items-end gap-0.5 flex-1 min-w-0 overflow-x-auto">
          {openServerTabs.map(serverId => {
            const server = servers.get(serverId);
            if (!server) return null;

            const isActive = activeServerId === serverId;
            const color = serverColor(server.name);
            const sRgb = hexToRgb(color);
            const unread = getServerUnread(serverId, byChannel);

            return (
              <button
                key={serverId}
                onClick={() => handleServerTabClick(serverId)}
                className={`relative flex items-center gap-2 px-4 py-2 text-[13px] font-medium transition-all duration-200 rounded-t-xl shrink-0 ${
                  isActive ? '' : 'hover:text-[#A09AAB]'
                }`}
                style={
                  isActive
                    ? {
                        background: `linear-gradient(180deg, rgba(${sRgb}, 0.18) 0%, rgba(${sRgb}, 0.05) 100%)`,
                        boxShadow: `0 1px 0 0 rgba(${sRgb}, 0.3), inset 0 1px 0 0 rgba(${sRgb}, 0.12)`,
                        color: P.text,
                      }
                    : { color: P.dim }
                }
              >
                {/* Colored dot */}
                <span
                  className={`h-2.5 w-2.5 rounded-full shrink-0 transition-all ${isActive ? 'scale-100' : 'scale-75 opacity-50'}`}
                  style={{ background: color, boxShadow: isActive ? `0 0 8px ${color}60` : 'none' }}
                />

                {/* Server name (truncated) */}
                <span className="truncate max-w-[120px]">{server.name}</span>

                {/* Unread badge (visible only when NOT active) */}
                {unread > 0 && !isActive && (
                  <span
                    className="ml-0.5 h-4 min-w-[16px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center"
                    style={{ background: color, color: P.bg }}
                  >
                    {unread}
                  </span>
                )}

                {/* Active underline */}
                {isActive && (
                  <span
                    className="absolute bottom-0 left-3 right-3 h-0.5 rounded-full"
                    style={{ background: `linear-gradient(90deg, transparent, ${color}, transparent)` }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* ── Right controls ───────────────────────────────────────────────── */}
        <div className="flex items-center gap-1 ml-2 shrink-0">
          {/* Palette toggle */}
          <button
            onClick={togglePalette}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-medium transition-all"
            style={{ background: `${P.surface}88`, border: `1px solid ${P.border}`, color: P.muted }}
          >
            <span className="h-3 w-3 rounded-full" style={{ background: P.bg, border: `1.5px solid ${P.accent}` }} />
            {paletteKey === 'aegean' ? 'Aegean' : 'Terracotta'}
          </button>

          {/* Search pill (Ctrl+K) */}
          <button
            className="flex items-center gap-2 px-3 py-1.5 rounded-full text-[12px] transition-all"
            style={{ background: `${P.surface}88`, border: `1px solid ${P.border}`, color: P.dim }}
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <span className="hidden xl:inline">Search</span>
            <kbd className="hidden xl:inline px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ background: P.bg, color: P.dim }}>
              Ctrl+K
            </kbd>
          </button>

          {/* Notification bell */}
          <button className="relative h-8 w-8 rounded-lg flex items-center justify-center transition-colors" style={{ color: P.dim }}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
            <span className="absolute top-1 right-1 h-2 w-2 rounded-full" style={{ background: P.danger }} />
          </button>
        </div>
      </div>

      {/* ── Accent gradient bar ────────────────────────────────────────────── */}
      <div
        className="h-px shrink-0"
        style={{
          background: isHome
            ? `linear-gradient(90deg, transparent, rgba(${hexToRgb(P.accent)}, 0.2), transparent)`
            : `linear-gradient(90deg, transparent, rgba(${accentRgb}, 0.25), transparent)`,
        }}
      />
    </>
  );
}
