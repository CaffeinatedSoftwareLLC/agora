import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useNavigate } from 'react-router-dom';
import { UserPanel } from './UserPanel';

export function ChannelSidebar() {
  const activeServerId = useServerStore(s => s.activeServerId);
  const servers = useServerStore(s => s.servers);
  const byServer = useChannelStore(s => s.byServer);
  const dmChannels = useChannelStore(s => s.dmChannels);
  const activeChannelId = useChannelStore(s => s.activeChannelId);
  const setActiveChannel = useChannelStore(s => s.setActiveChannel);
  const navigate = useNavigate();

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
      <div className="h-12 px-4 flex items-center border-b border-border font-semibold text-text shrink-0">
        {server ? server.name : 'Direct Messages'}
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto py-2">
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
              <span className="text-text-dim">#</span>
              <span className="truncate">{channel.name}</span>
            </button>
          ))
        )}
      </div>

      {/* User panel at bottom */}
      <UserPanel />
    </div>
  );
}
