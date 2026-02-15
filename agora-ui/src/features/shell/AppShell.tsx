import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useUIStore } from '../../stores/uiStore';
import { ServerRail } from './ServerRail';
import { ChannelSidebar } from './ChannelSidebar';
import { ContentArea } from './ContentArea';
import { MembersSidebar } from '../servers/MembersSidebar';

export function AppShell() {
  const params = useParams();
  const navigate = useNavigate();
  const servers = useServerStore(s => s.servers);
  const activeServerId = useServerStore(s => s.activeServerId);
  const setActiveServer = useServerStore(s => s.setActiveServer);
  const byServer = useChannelStore(s => s.byServer);
  const setActiveChannel = useChannelStore(s => s.setActiveChannel);
  const connectionStatus = useUIStore(s => s.connectionStatus);
  const membersOpen = useUIStore(s => s.membersOpen);

  // Sync URL params to store on mount and URL changes
  useEffect(() => {
    const serverId = params['*']?.split('/')[0] || null;
    const channelId = params['*']?.split('/')[1] || null;

    if (serverId && serverId !== 'dms') {
      setActiveServer(serverId);
      setActiveChannel(channelId);
    } else if (serverId === 'dms') {
      setActiveServer(null);
      setActiveChannel(channelId);
    } else {
      setActiveChannel(null);
    }
  }, [params, setActiveServer, setActiveChannel]);

  // Auto-select first channel when server changes and no channel is in URL
  useEffect(() => {
    if (!activeServerId || !servers.has(activeServerId)) return;
    const channelId = params['*']?.split('/')[1];
    if (channelId) return; // Already have a channel in URL

    const serverChannels = byServer(activeServerId).filter(c => c.channelType === 3);
    if (serverChannels.length > 0) {
      setActiveChannel(serverChannels[0].id);
      navigate(`/app/${activeServerId}/${serverChannels[0].id}`, { replace: true });
    }
  }, [activeServerId, servers, byServer, setActiveChannel, navigate, params]);

  // Show skeleton/loading while connecting
  if (connectionStatus === 'disconnected' && servers.size === 0) {
    return (
      <div className="h-screen flex">
        {/* Skeleton server rail */}
        <div className="w-[72px] bg-bg flex flex-col items-center py-3 gap-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="w-12 h-12 rounded-2xl bg-surface animate-pulse" />
          ))}
        </div>
        {/* Skeleton sidebar */}
        <div className="w-60 bg-surface border-r border-border flex flex-col">
          <div className="h-12 px-4 flex items-center border-b border-border">
            <div className="h-4 w-32 bg-surface-hover rounded animate-pulse" />
          </div>
          <div className="p-3 space-y-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-6 bg-surface-hover rounded animate-pulse" />
            ))}
          </div>
        </div>
        {/* Skeleton content */}
        <div className="flex-1 bg-bg flex items-center justify-center">
          <div className="text-text-muted animate-pulse">Connecting...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex">
      <ServerRail />
      <ChannelSidebar />
      <ContentArea />
      {activeServerId && membersOpen && <MembersSidebar />}
    </div>
  );
}
