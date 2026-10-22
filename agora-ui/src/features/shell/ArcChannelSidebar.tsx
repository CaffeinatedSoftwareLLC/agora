import { shellHistorySettled } from './shellHistory';
import { useUIStore } from '../../stores/uiStore';
import { useState, useMemo, useEffect } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useMemberStore } from '../../stores/memberStore';
import { useNavigate } from 'react-router-dom';
import { usePalette, hexToRgb } from '../../theme';
import { useServerAccess } from '../../hooks/useServerAccess';
import { ArcUserPanel } from './ArcUserPanel';
import { InviteModal } from '../servers/InviteModal';
import { CreateChannelModal } from '../servers/CreateChannelModal';

// ─── Channel Item ────────────────────────────────────────────────────────────

function ChannelItem({
  channelId,
  channelName,
  isActive,
  accentColor,
  onClick,
}: {
  channelId: string;
  channelName: string;
  isActive: boolean;
  accentColor: string;
  onClick: () => void;
}) {
  const P = usePalette();
  const unread = useUnreadStore(s => s.getUnread(channelId));
  const hasUnread = unread !== null && (unread.unreadCount > 0 || unread.mentionCount > 0);
  const badgeCount = unread ? unread.unreadCount + unread.mentionCount : 0;
  const accentRgb = hexToRgb(accentColor);

  return (
    <button
      onClick={onClick}
      className="w-full min-h-11 md:min-h-9 flex items-center gap-2 px-2.5 py-1.5 rounded-lg mb-0.5 transition-all duration-150 text-[13px]"
      style={{
        background: isActive ? `rgba(${accentRgb}, 0.14)` : 'transparent',
        boxShadow: isActive ? `inset 2px 0 0 ${accentColor}` : 'none',
        color: isActive ? P.text : hasUnread ? P.text : P.muted,
      }}
    >
      <span className="text-base leading-none" style={{ color: isActive ? accentColor : P.muted }}>#</span>
      <span className={`truncate ${hasUnread ? 'font-semibold' : isActive ? 'font-medium' : ''}`}>
        {channelName}
      </span>
      {badgeCount > 0 && !isActive && (
        <span
          className="ml-auto text-[11px] font-bold rounded-full px-1.5 py-0.5 min-w-[18px] text-center shrink-0"
          style={{ background: accentColor, color: P.onAccent }}
        >
          {badgeCount}
        </span>
      )}
    </button>
  );
}

// ─── Category ────────────────────────────────────────────────────────────────

function ChannelCategory({
  categoryName,
  channels,
  isExpanded,
  onToggle,
  activeChannelId,
  accentColor,
  onChannelClick,
  onCreateChannel,
  renderItem,
}: {
  categoryName: string;
  channels: { id: string; name: string }[];
  isExpanded: boolean;
  onToggle: () => void;
  activeChannelId: string | null;
  accentColor: string;
  onChannelClick: (channelId: string) => void;
  onCreateChannel: () => void;
  renderItem?: (ch: { id: string; name: string }) => React.ReactNode;
}) {
  const P = usePalette();

  // Check if any channel in this category has unreads (for collapsed dot)
  const hasUnread = channels.some((ch) => {
    const unread = useUnreadStore.getState().getUnread(ch.id);
    return unread !== null && (unread.unreadCount > 0 || unread.mentionCount > 0);
  });

  return (
    <div className="mb-1">
      {/* Category header */}
      <div className="flex items-center gap-1 px-2 py-0.5 group">
        <button
          onClick={onToggle}
          className="flex items-center gap-1.5 flex-1 min-w-0 min-h-11 md:min-h-8 text-left"
        >
          <svg
            className="h-3 w-3 transition-transform shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2.5"
            style={{
              color: P.muted,
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span
            className="text-[13px] font-semibold truncate"
            style={{ color: P.muted }}
          >
            {categoryName}
          </span>
          {!isExpanded && hasUnread && (
            <div
              className="w-2 h-2 rounded-full ml-auto shrink-0"
              style={{ background: accentColor }}
            />
          )}
        </button>
        <button
          onClick={onCreateChannel}
          className="transition-colors shrink-0 min-h-11 min-w-11 md:min-h-8 md:min-w-8 md:h-8 md:w-8 flex items-center justify-center rounded-lg hover:bg-surface-hover"
          style={{ color: P.muted }}
          title="Create Channel"
          aria-label="Create Channel"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* Channel list */}
      {isExpanded && (
        <div className="px-1.5">
          {channels.map((ch) =>
            renderItem ? renderItem(ch) : (
              <ChannelItem
                key={ch.id}
                channelId={ch.id}
                channelName={ch.name}
                isActive={activeChannelId === ch.id}
                accentColor={accentColor}
                onClick={() => onChannelClick(ch.id)}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Sidebar ────────────────────────────────────────────────────────────

export function ArcChannelSidebar() {
  const P = usePalette();
  const navigate = useNavigate();

  const instanceServerId = useServerStore(s => s.instanceServerId);
  const servers = useServerStore(s => s.servers);
  const byServer = useChannelStore(s => s.byServer);
  const activeChannelId = useChannelStore(s => s.activeChannelId);
  const setActiveChannel = useChannelStore(s => s.setActiveChannel);
  const { hasModerationAccess, hasServerAdminAccess } = useServerAccess(instanceServerId);

  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['Text channels']),
  );
  const [showInvite, setShowInvite] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);

  const server = instanceServerId ? servers.get(instanceServerId) : null;
  const accentColor = P.accent;
  const accentRgb = hexToRgb(accentColor);

  // Filter to text channels only (channelType 3)
  const textChannels = useMemo(() => {
    if (!instanceServerId) return [];
    return byServer(instanceServerId).filter(c => c.channelType === 3);
  }, [instanceServerId, byServer]);

  // Count online members for this server (reactive to presence + member changes)
  const members = useMemberStore(s => instanceServerId ? s.byServer.get(instanceServerId) : undefined);
  const loadMembers = useMemberStore(s => s.loadMembers);
  const presenceMap = usePresenceStore(s => s.status);
  // The count needs the member list, which otherwise loads only when the member panel opens
  useEffect(() => {
    if (instanceServerId && !members) void loadMembers(instanceServerId).catch(() => {});
  }, [instanceServerId, members, loadMembers]);
  const onlineCount = useMemo(() => {
    if (!members) return 0;
    return members.filter(m => presenceMap.get(m.id) === 'online').length;
  }, [members, presenceMap]);

  const toggleCategory = (name: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const handleChannelClick = async (channelId: string) => {
    useUIStore.getState().onChannelSelect(channelId);
    setActiveChannel(channelId);

    await shellHistorySettled();
    navigate(`/app/${channelId}`);
  };

  if (!instanceServerId || !server) return null;

  // Server initial for the badge icon
  const serverInitial = server.name[0]?.toUpperCase() ?? '?';

  return (
    <div
      className="w-60 flex flex-col shrink-0 h-full"
      style={{
        background: `linear-gradient(180deg, rgba(${accentRgb}, 0.05) 0%, ${P.surface} 40%)`,
        borderRight: `1px solid ${P.border}`,
      }}
    >
      {/* ── Server header ──────────────────────────────────────────────── */}
      <div
        className="px-3 py-2.5 shrink-0"
        style={{ borderBottom: `1px solid ${P.border}` }}
      >
        <div className="flex items-center gap-2">
          {/* Server icon */}
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold shrink-0"
            style={{
              background: P.primary,
              color: P.onPrimary,
            }}
          >
            {serverInitial}
          </div>

          {/* Server name + online count */}
          <div className="flex-1 min-w-0">
            <div
              className="text-[15px] font-semibold truncate"
              style={{ color: P.text }}
            >
              {server.name}
            </div>
            <div className="text-[11px] flex items-center gap-1.5 whitespace-nowrap" style={{ color: P.muted }}>
              <div
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: P.online }}
              />
              {onlineCount} online
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-0.5 shrink-0">
            {/* Invite button */}
            <button
              onClick={() => setShowInvite(true)}
              className="min-h-11 min-w-11 md:min-h-9 md:min-w-9 md:h-9 md:w-9 rounded-lg flex items-center justify-center transition-colors hover:bg-surface-hover"
              style={{ color: P.muted }}
              title="Invite People"
              aria-label="Invite People"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <line x1="19" y1="8" x2="19" y2="14" />
                <line x1="22" y1="11" x2="16" y2="11" />
              </svg>
            </button>

            {/* Moderation button (shield) */}
            {hasModerationAccess && (
              <button
                onClick={() => navigate('/moderation')}
                className="min-h-11 min-w-11 md:min-h-9 md:min-w-9 md:h-9 md:w-9 rounded-lg flex items-center justify-center transition-colors hover:bg-surface-hover"
                style={{ color: P.muted }}
                title="Moderation"
                aria-label="Moderation"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </button>
            )}

            {/* Server Settings (gear) */}
            {hasServerAdminAccess && (
              <button
                onClick={() => navigate('/settings')}
                className="min-h-11 min-w-11 md:min-h-9 md:min-w-9 md:h-9 md:w-9 rounded-lg flex items-center justify-center transition-colors hover:bg-surface-hover"
                style={{ color: P.muted }}
                title="Server Settings"
                aria-label="Server Settings"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Channel categories ─────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto py-2">
        <ChannelCategory
          categoryName="Text channels"
          channels={textChannels}
          isExpanded={expandedCategories.has('Text channels')}
          onToggle={() => toggleCategory('Text channels')}
          activeChannelId={activeChannelId}
          accentColor={accentColor}
          onChannelClick={handleChannelClick}
          onCreateChannel={() => setShowCreateChannel(true)}
        />
      </div>

      {/* ── User panel (compact) ───────────────────────────────────────── */}
      <ArcUserPanel compact />

      {/* ── Modals ─────────────────────────────────────────────────────── */}
      <InviteModal
        serverId={instanceServerId}
        isOpen={showInvite}
        onClose={() => setShowInvite(false)}
      />
      <CreateChannelModal
        serverId={instanceServerId}
        isOpen={showCreateChannel}
        onClose={() => setShowCreateChannel(false)}
      />
    </div>
  );
}
