import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useUIStore } from '../../stores/uiStore';
import { usePalette } from '../../theme';
import { TabBar } from './TabBar';
import { HomeView } from './HomeView';
import { DMSidebar } from './DMSidebar';
import { ArcChannelSidebar } from './ArcChannelSidebar';
import { ArcContentArea } from './ArcContentArea';
import { MembersSidebar } from '../servers/MembersSidebar';

export function AppShell() {
  const params = useParams();
  const navigate = useNavigate();
  const P = usePalette();
  const servers = useServerStore(s => s.servers);
  const activeServerId = useServerStore(s => s.activeServerId);
  const setActiveServer = useServerStore(s => s.setActiveServer);
  const byServer = useChannelStore(s => s.byServer);
  const setActiveChannel = useChannelStore(s => s.setActiveChannel);
  const connectionStatus = useUIStore(s => s.connectionStatus);
  const membersOpen = useUIStore(s => s.membersOpen);
  const addServerTab = useUIStore(s => s.addServerTab);

  // Extract stable primitives from params
  const urlServerId = params['*']?.split('/')[0] || null;
  const urlChannelId = params['*']?.split('/')[1] || null;

  // Sync URL → store (only when URL segments change)
  useEffect(() => {
    if (urlServerId && urlServerId !== 'dms') {
      setActiveServer(urlServerId);
      setActiveChannel(urlChannelId);
      // Auto-add server to tab bar when navigating to it
      addServerTab(urlServerId);
    } else if (urlServerId === 'dms') {
      setActiveServer(null);
      setActiveChannel(urlChannelId);
    } else {
      // Home view: /app with no subpath
      setActiveServer(null);
      setActiveChannel(null);
    }
  }, [urlServerId, urlChannelId, setActiveServer, setActiveChannel, addServerTab]);

  // Auto-select first channel when navigating to a server without a channel
  useEffect(() => {
    if (!urlServerId || urlServerId === 'dms' || urlChannelId) return;
    const serverChannels = byServer(urlServerId).filter(c => c.channelType === 3);
    if (serverChannels.length > 0) {
      navigate(`/app/${urlServerId}/${serverChannels[0].id}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlServerId, urlChannelId, servers.size]);

  // Show skeleton while connecting
  if (connectionStatus === 'disconnected' && servers.size === 0) {
    return (
      <div
        className="h-screen flex flex-col overflow-hidden"
        style={{ background: P.bg, color: P.text, fontFamily: "'Inter', 'Segoe UI', -apple-system, sans-serif" }}
      >
        {/* Skeleton tab bar */}
        <div className="flex items-center gap-2 px-3 pt-2 pb-0 shrink-0">
          <div className="h-8 w-20 rounded-xl animate-pulse" style={{ background: P.surface }} />
          <div className="h-8 w-24 rounded-xl animate-pulse" style={{ background: P.surface }} />
          <div className="h-8 w-24 rounded-xl animate-pulse" style={{ background: P.surface }} />
          <div className="flex-1" />
          <div className="h-8 w-16 rounded-full animate-pulse" style={{ background: P.surface }} />
        </div>
        <div className="h-px" style={{ background: P.border }} />
        {/* Skeleton content */}
        <div className="flex flex-1 min-h-0">
          <div className="w-[260px] shrink-0 flex flex-col p-3 gap-2" style={{ background: P.surface }}>
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-10 rounded-lg animate-pulse" style={{ background: P.surfaceHover }} />
            ))}
          </div>
          <div className="flex-1 flex items-center justify-center">
            <div className="animate-pulse" style={{ color: P.muted }}>Connecting...</div>
          </div>
        </div>
      </div>
    );
  }

  // Layout states: home, DM conversation, or server
  const isHome = !urlServerId || (urlServerId === 'dms' && !urlChannelId);
  const isDm = urlServerId === 'dms' && !!urlChannelId;

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{ background: P.bg, color: P.text, fontFamily: "'Inter', 'Segoe UI', -apple-system, sans-serif" }}
    >
      <TabBar />

      {/* Main content area */}
      {isHome ? (
        <HomeView />
      ) : isDm ? (
        <div className="flex flex-1 min-h-0">
          <DMSidebar />
          <ArcContentArea />
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          <ArcChannelSidebar />
          <ArcContentArea />
          {activeServerId && membersOpen && <MembersSidebar />}
        </div>
      )}
    </div>
  );
}
