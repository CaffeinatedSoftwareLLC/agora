import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useUIStore } from '../../stores/uiStore';
import { usePalette } from '../../theme';
import { TabBar } from './TabBar';
import { DMSidebar } from './DMSidebar';
import { ArcChannelSidebar } from './ArcChannelSidebar';
import { ArcContentArea } from './ArcContentArea';
import { MembersSidebar } from '../servers/MembersSidebar';
import { ThreadPanel } from '../messages/ThreadPanel';
import { useThreadStore } from '../../stores/threadStore';
import { VoiceChannelProvider } from '../voice/VoiceChannelProvider';
import { IncomingCallOverlay } from '../calls/IncomingCallOverlay';
import { OutgoingCallOverlay } from '../calls/OutgoingCallOverlay';

export function AppShell() {
  const params = useParams();
  const navigate = useNavigate();
  const P = usePalette();
  const servers = useServerStore(s => s.servers);
  const instanceServerId = useServerStore(s => s.instanceServerId);
  const setActiveChannel = useChannelStore(s => s.setActiveChannel);
  const byServer = useChannelStore(s => s.byServer);
  const connectionStatus = useUIStore(s => s.connectionStatus);
  const membersOpen = useUIStore(s => s.membersOpen);
  const openThreadId = useThreadStore(s => s.openThreadId);

  // Sync palette → CSS custom properties so Tailwind classes follow the active theme
  useEffect(() => {
    const s = document.documentElement.style;
    s.setProperty('--color-bg', P.bg);
    s.setProperty('--color-surface', P.surface);
    s.setProperty('--color-surface-hover', P.surfaceHover);
    s.setProperty('--color-primary', P.primary);
    s.setProperty('--color-primary-hover', P.primaryHover);
    s.setProperty('--color-accent', P.accent);
    s.setProperty('--color-text', P.text);
    s.setProperty('--color-text-muted', P.muted);
    s.setProperty('--color-text-dim', P.dim);
    s.setProperty('--color-border', P.border);
    s.setProperty('--color-online', P.online);
    s.setProperty('--color-danger', P.danger);
    s.setProperty('--color-warn', P.warn);
  }, [P]);

  // URL: /app/dms/{channelId} or /app/{channelId} or /app
  const urlSegment1 = params['*']?.split('/')[0] || null;
  const urlSegment2 = params['*']?.split('/')[1] || null;

  const isDmRoute = urlSegment1 === 'dms';
  const urlChannelId = isDmRoute ? urlSegment2 : urlSegment1;

  // Sync URL → store
  useEffect(() => {
    setActiveChannel(urlChannelId);
  }, [urlChannelId, setActiveChannel]);

  // Auto-navigate to first text channel when at /app with no channel
  useEffect(() => {
    if (urlSegment1 || !instanceServerId) return;
    const serverChannels = byServer(instanceServerId).filter(c => c.channelType === 3);
    if (serverChannels.length > 0) {
      navigate(`/app/${serverChannels[0].id}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSegment1, instanceServerId, servers.size]);

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

  // Layout: DM view or channel view
  const isDm = isDmRoute;
  const showDmSidebar = isDmRoute;

  return (
    <VoiceChannelProvider>
      <div
        className="h-screen flex flex-col overflow-hidden"
        style={{ background: P.bg, color: P.text, fontFamily: "'Inter', 'Segoe UI', -apple-system, sans-serif" }}
      >
        <TabBar />

        {/* Main content area */}
        <div className="flex flex-1 min-h-0">
          {showDmSidebar ? <DMSidebar /> : <ArcChannelSidebar />}
          <ArcContentArea />
          {!isDm && membersOpen && <MembersSidebar />}
          {openThreadId && <ThreadPanel />}
        </div>
      </div>
      <IncomingCallOverlay />
      <OutgoingCallOverlay />
    </VoiceChannelProvider>
  );
}
