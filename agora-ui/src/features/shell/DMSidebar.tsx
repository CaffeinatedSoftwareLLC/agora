import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePalette, hexToRgb } from '../../theme';
import { useChannelStore } from '../../stores/channelStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { ArcUserPanel } from './ArcUserPanel';
import { NewDMModal } from '../servers/NewDMModal';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Deterministic color from a name string. */
function nameColor(name: string): string {
  const colors = [
    '#0FA3B1', '#4ADE80', '#FBBF24', '#C77DFF', '#F97316',
    '#EF4444', '#3B82F6', '#EC4899', '#8B5CF6', '#10B981',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

// ─── Component ──────────────────────────────────────────────────────────────

export function DMSidebar() {
  const P = usePalette();
  const navigate = useNavigate();

  const dmChannels = useChannelStore(s => s.dmChannels);
  const setActiveChannel = useChannelStore(s => s.setActiveChannel);
  const activeChannelId = useChannelStore(s => s.activeChannelId);
  const byChannel = useUnreadStore(s => s.byChannel);

  const [search, setSearch] = useState('');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [showNewDM, setShowNewDM] = useState(false);

  const dms = dmChannels();

  const filtered = search
    ? dms.filter(dm => dm.name.toLowerCase().includes(search.toLowerCase()))
    : dms;

  const handleDmClick = useCallback((channelId: string) => {
    setActiveChannel(channelId);
    navigate(`/app/dms/${channelId}`);
  }, [setActiveChannel, navigate]);

  return (
    <aside
      className="w-[260px] shrink-0 flex flex-col"
      style={{ background: P.surface, borderRight: `1px solid ${P.border}` }}
    >
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="px-4 py-3.5 shrink-0" style={{ borderBottom: `1px solid ${P.border}` }}>
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold tracking-wide" style={{ color: P.text }}>
            Messages
          </h3>
          <button
            onClick={() => setShowNewDM(true)}
            className="h-6 w-6 rounded-md flex items-center justify-center transition-colors"
            style={{ color: P.muted }}
          >
            {/* Compose / edit icon */}
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </button>
        </div>

        {/* Search input */}
        <div
          className="flex items-center gap-2 mt-2.5 px-2.5 py-1.5 rounded-lg"
          style={{ background: P.bg, border: `1px solid ${P.border}` }}
        >
          <svg className="h-3.5 w-3.5 shrink-0" style={{ color: P.dim }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Find a conversation..."
            className="flex-1 bg-transparent text-[12px] outline-none min-w-0"
            style={{ color: P.text, caretColor: P.accent }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="p-0.5 rounded transition-colors"
              style={{ color: P.dim }}
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* ── DM list ───────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto py-2 px-2">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center">
            <p className="text-[12px]" style={{ color: P.dim }}>
              {search ? 'No conversations found' : 'No direct messages yet'}
            </p>
          </div>
        )}

        {filtered.map(dm => {
          const color = nameColor(dm.name);
          const entry = byChannel.get(dm.id);
          const unreadCount = entry ? entry.unreadCount + entry.mentionCount : 0;
          const hasUnread = unreadCount > 0;
          const isActive = activeChannelId === dm.id;
          const isHovered = hoveredId === dm.id;

          return (
            <button
              key={dm.id}
              onClick={() => handleDmClick(dm.id)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg mb-0.5 transition-all duration-150 group"
              style={{
                backgroundColor: isActive
                  ? `rgba(${hexToRgb(P.accent)}, 0.12)`
                  : isHovered
                    ? P.surfaceHover
                    : 'transparent',
              }}
              onMouseEnter={() => setHoveredId(dm.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              {/* Avatar */}
              <div className="relative shrink-0">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
                  style={{ background: `linear-gradient(135deg, ${color}, ${color}88)`, color: P.text }}
                >
                  {dm.name[0]?.toUpperCase() ?? '?'}
                </div>
              </div>

              {/* Name */}
              <div className="flex-1 min-w-0 text-left">
                <div className="flex items-center justify-between">
                  <span
                    className="text-[13px] font-semibold truncate"
                    style={{ color: hasUnread ? P.text : P.muted }}
                  >
                    {dm.name}
                  </span>
                </div>
              </div>

              {/* Unread badge */}
              {hasUnread && (
                <span
                  className="text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[18px] text-center shrink-0"
                  style={{ background: P.accent, color: P.bg }}
                >
                  {unreadCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── User panel ────────────────────────────────────────────────────── */}
      <ArcUserPanel />
      <NewDMModal isOpen={showNewDM} onClose={() => setShowNewDM(false)} />
    </aside>
  );
}
