import { useState, useMemo } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { useMessageStore } from '../../stores/messageStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useMemberStore } from '../../stores/memberStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { usePalette, hexToRgb } from '../../theme';
import { ArcUserPanel } from './ArcUserPanel';
import { InviteModal } from '../servers/InviteModal';
import { CreateChannelModal } from '../servers/CreateChannelModal';
import { VoiceControlBar } from '../voice/VoiceControlBar';
import { VoiceChannelUsers } from '../voice/VoiceChannelUsers';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function serverColor(name: string): string {
  const colors = ['#0FA3B1', '#4ADE80', '#FBBF24', '#C77DFF', '#F97316', '#EF4444', '#3B82F6', '#EC4899', '#8B5CF6', '#10B981'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

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
      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg mb-0.5 transition-all duration-150 text-sm"
      style={{
        background: isActive ? `rgba(${accentRgb}, 0.12)` : 'transparent',
        boxShadow: isActive ? `inset 2px 0 0 ${accentColor}` : 'none',
        color: isActive ? P.text : hasUnread ? P.text : P.muted,
      }}
    >
      <span className="text-base leading-none" style={{ color: isActive ? accentColor : P.dim }}>#</span>
      <span className={`truncate ${hasUnread ? 'font-semibold' : isActive ? 'font-medium' : ''}`}>
        {channelName}
      </span>
      {badgeCount > 0 && !isActive && (
        <span
          className="ml-auto text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[16px] text-center shrink-0"
          style={{ background: accentColor, color: P.bg }}
        >
          {badgeCount}
        </span>
      )}
    </button>
  );
}

// ─── Voice Channel Item ─────────────────────────────────────────────────────

function VoiceChannelItem({
  channelId,
  channelName,
  accentColor,
  serverId,
  onClick,
}: {
  channelId: string;
  channelName: string;
  accentColor: string;
  serverId: string;
  onClick: () => void;
}) {
  const P = usePalette();
  const currentChannel = useVoiceStore(s => s.currentChannel);
  const connectionState = useVoiceStore(s => s.connectionState);
  const isInChannel = currentChannel?.channelId === channelId;
  const isConnected = isInChannel && connectionState === 'connected';
  const accentRgb = hexToRgb(accentColor);
  const onlineRgb = hexToRgb(P.online);

  return (
    <div>
      <button
        onClick={onClick}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg mb-0.5 transition-all duration-150 text-sm"
        style={{
          background: isConnected ? `rgba(${onlineRgb}, 0.08)` : 'transparent',
          boxShadow: isConnected ? `inset 2px 0 0 ${P.online}` : 'none',
          color: isConnected ? P.text : P.muted,
        }}
      >
        {/* Speaker icon */}
        <svg
          className="h-4 w-4 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: isConnected ? P.online : P.dim }}
        >
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 010 7.07" />
          <path d="M19.07 4.93a10 10 0 010 14.14" />
        </svg>
        <span className={isConnected ? 'font-medium truncate' : 'truncate'}>
          {channelName}
        </span>
      </button>
      {/* Show participants in this voice channel (for everyone, not just connected users) */}
      <VoiceChannelUsers channelId={channelId} />
    </div>
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
      <div className="flex items-center gap-1 px-2 py-1 cursor-pointer group">
        <button
          onClick={onToggle}
          className="flex items-center gap-1 flex-1 min-w-0"
        >
          <svg
            className="h-2.5 w-2.5 transition-transform shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2.5"
            style={{
              color: P.dim,
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span
            className="text-[10px] font-semibold tracking-widest uppercase truncate"
            style={{ color: P.dim }}
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
          className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 h-4 w-4 flex items-center justify-center rounded"
          style={{ color: P.dim }}
          title="Create Channel"
        >
          <svg
            className="h-3.5 w-3.5"
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
  const joinVoiceChannel = useVoiceStore(s => s.joinChannel);
  const voiceConnectionState = useVoiceStore(s => s.connectionState);

  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['Text Channels', 'Voice Channels']),
  );
  const [showInvite, setShowInvite] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [createChannelDefaultType, setCreateChannelDefaultType] = useState<3 | 4>(3);

  const server = instanceServerId ? servers.get(instanceServerId) : null;
  const accentColor = server ? serverColor(server.name) : P.accent;
  const accentRgb = hexToRgb(accentColor);

  // Filter to text channels only (channelType 3)
  const textChannels = useMemo(() => {
    if (!instanceServerId) return [];
    return byServer(instanceServerId).filter(c => c.channelType === 3);
  }, [instanceServerId, byServer]);

  // Filter to voice channels (channelType 4)
  const voiceChannels = useMemo(() => {
    if (!instanceServerId) return [];
    return byServer(instanceServerId).filter(c => c.channelType === 4);
  }, [instanceServerId, byServer]);

  // Count online members for this server
  const onlineCount = useMemo(() => {
    if (!instanceServerId) return 0;
    const members = useMemberStore.getState().byServer.get(instanceServerId);
    if (!members) return 0;
    const presenceStore = usePresenceStore.getState();
    return members.filter(m => presenceStore.getStatus(m.id) === 'online').length;
  }, [instanceServerId]);

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

  const handleChannelClick = (channelId: string) => {
    setActiveChannel(channelId);

    // ACK immediately if messages loaded
    const messages = useMessageStore.getState().byChannel.get(channelId);
    if (messages && messages.length > 0) {
      const lastMsgId = messages[messages.length - 1].id;
      useUnreadStore.getState().markRead(channelId, lastMsgId);
      api.put(`/channels/${channelId}/ack`, { messageId: lastMsgId }).catch(() => {});
    }

    navigate(`/app/${channelId}`);
  };

  const openCreateChannel = (defaultType: 3 | 4) => {
    setCreateChannelDefaultType(defaultType);
    setShowCreateChannel(true);
  };

  const handleVoiceChannelClick = (channelId: string, channelName: string) => {
    if (!instanceServerId) return;
    joinVoiceChannel(channelId, instanceServerId, channelName);
  };

  if (!instanceServerId || !server) return null;

  // Server initial for the gradient icon
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
        className="px-3 py-3 shrink-0"
        style={{ borderBottom: `1px solid ${P.border}` }}
      >
        <div className="flex items-center gap-2.5">
          {/* Server icon (gradient initials) */}
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold shrink-0"
            style={{
              background: `linear-gradient(135deg, ${accentColor}, ${P.primary})`,
              color: P.text,
            }}
          >
            {serverInitial}
          </div>

          {/* Server name + online count */}
          <div className="flex-1 min-w-0">
            <div
              className="text-[14px] font-semibold truncate"
              style={{ color: P.text }}
            >
              {server.name}
            </div>
            <div className="text-[11px] flex items-center gap-1" style={{ color: P.dim }}>
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
              className="h-7 w-7 rounded-lg flex items-center justify-center transition-colors"
              style={{ color: P.dim }}
              title="Invite People"
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

            {/* More menu button → Server Settings */}
            <button
              onClick={() => navigate('/settings/bots')}
              className="h-7 w-7 rounded-lg flex items-center justify-center transition-colors"
              style={{ color: P.dim }}
              title="Server Settings"
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
                <circle cx="12" cy="12" r="1" />
                <circle cx="12" cy="5" r="1" />
                <circle cx="12" cy="19" r="1" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── Channel categories ─────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto py-2">
        <ChannelCategory
          categoryName="Text Channels"
          channels={textChannels}
          isExpanded={expandedCategories.has('Text Channels')}
          onToggle={() => toggleCategory('Text Channels')}
          activeChannelId={activeChannelId}
          accentColor={accentColor}
          onChannelClick={handleChannelClick}
          onCreateChannel={() => openCreateChannel(3)}
        />
        <ChannelCategory
          categoryName="Voice Channels"
          channels={voiceChannels}
          isExpanded={expandedCategories.has('Voice Channels')}
          onToggle={() => toggleCategory('Voice Channels')}
          activeChannelId={activeChannelId}
          accentColor={accentColor}
          onChannelClick={() => {}}
          onCreateChannel={() => openCreateChannel(4)}
          renderItem={(ch) => (
            <VoiceChannelItem
              key={ch.id}
              channelId={ch.id}
              channelName={ch.name}
              accentColor={accentColor}
              serverId={instanceServerId}
              onClick={() => handleVoiceChannelClick(ch.id, ch.name)}
            />
          )}
        />
      </div>

      {/* ── Voice control bar (when connected) ──────────────────────────── */}
      {voiceConnectionState !== 'disconnected' && <VoiceControlBar />}

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
        defaultType={createChannelDefaultType}
      />
    </div>
  );
}
