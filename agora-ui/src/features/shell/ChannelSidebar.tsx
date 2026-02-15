import { useState } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useNavigate } from 'react-router-dom';
import { UserPanel } from './UserPanel';
import { InviteModal } from '../servers/InviteModal';
import { CreateChannelModal } from '../servers/CreateChannelModal';
import { NewDMModal } from '../servers/NewDMModal';

export function ChannelSidebar() {
  const activeServerId = useServerStore(s => s.activeServerId);
  const servers = useServerStore(s => s.servers);
  const byServer = useChannelStore(s => s.byServer);
  const dmChannels = useChannelStore(s => s.dmChannels);
  const activeChannelId = useChannelStore(s => s.activeChannelId);
  const setActiveChannel = useChannelStore(s => s.setActiveChannel);
  const navigate = useNavigate();

  const [showInvite, setShowInvite] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showNewDM, setShowNewDM] = useState(false);
  const server = activeServerId ? servers.get(activeServerId) : null;
  // Filter to text channels only (channelType 3) for now
  const channels = activeServerId
    ? byServer(activeServerId).filter(c => c.channelType === 3)
    : dmChannels();

  const handleChannelClick = (channelId: string) => {
    setActiveChannel(channelId);
    if (activeServerId) {
      navigate(`/app/${activeServerId}/${channelId}`);
    } else {
      navigate(`/app/dms/${channelId}`);
    }
  };

  return (
    <div className="w-60 bg-surface flex flex-col border-r border-border shrink-0">
      {/* Header */}
      <div className="h-12 px-4 flex items-center justify-between border-b border-border font-semibold text-text shrink-0">
        <span className="truncate">{server ? server.name : 'Direct Messages'}</span>
        {server ? (
          <button
            onClick={() => setShowInvite(true)}
            className="text-text-muted hover:text-text transition-colors ml-2 shrink-0"
            title="Create Invite"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <line x1="19" y1="8" x2="19" y2="14" />
              <line x1="22" y1="11" x2="16" y2="11" />
            </svg>
          </button>
        ) : (
          <button
            onClick={() => setShowNewDM(true)}
            className="text-text-muted hover:text-text transition-colors ml-2 shrink-0"
            title="New Message"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        )}
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto py-2">
        {activeServerId && (
          <div className="px-3 mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase text-text-dim">Text Channels</span>
            <button
              onClick={() => setShowCreateChannel(true)}
              className="text-text-dim hover:text-text transition-colors"
              title="Create Channel"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        )}
        {channels.length === 0 ? (
          <div className="px-4 py-8 text-center text-text-dim text-sm">
            No channels yet
          </div>
        ) : (
          channels.map((channel) => (
            <button
              key={channel.id}
              onClick={() => handleChannelClick(channel.id)}
              className={`w-full px-3 py-1.5 flex items-center gap-2 text-sm rounded-md mx-1 ${
                activeChannelId === channel.id
                  ? 'bg-surface-hover text-text font-medium'
                  : 'text-text-muted hover:text-text hover:bg-surface-hover/50'
              }`}
              style={{ width: 'calc(100% - 8px)' }}
            >
              <span className="text-text-dim">{activeServerId ? '#' : '@'}</span>
              <span className="truncate">{channel.name}</span>
            </button>
          ))
        )}
      </div>

      {/* User panel at bottom */}
      <UserPanel />

      {activeServerId && (
        <>
          <InviteModal
            serverId={activeServerId}
            isOpen={showInvite}
            onClose={() => setShowInvite(false)}
          />
          <CreateChannelModal
            serverId={activeServerId}
            isOpen={showCreateChannel}
            onClose={() => setShowCreateChannel(false)}
          />
        </>
      )}
      <NewDMModal isOpen={showNewDM} onClose={() => setShowNewDM(false)} />
    </div>
  );
}
