import { useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useUIStore } from '../../stores/uiStore';
import { usePalette } from '../../theme';
import { TabBar } from './TabBar';
import { ArcChannelSidebar } from './ArcChannelSidebar';
import { ArcContentArea } from './ArcContentArea';
import { MembersSidebar } from '../servers/MembersSidebar';
import { ThreadPanel } from '../messages/ThreadPanel';
import { FilesPanel } from '../messages/FilesPanel';
import { OverlayManager } from './OverlayManager';
import { useShellViewport } from './viewport';
import './shell.css';

export function AppShell() {
  const params = useParams();
  const navigate = useNavigate();
  const P = usePalette();
  const servers = useServerStore(s => s.servers);
  const instanceServerId = useServerStore(s => s.instanceServerId);
  const setActiveChannel = useChannelStore(s => s.setActiveChannel);
  const byServer = useChannelStore(s => s.byServer);
  const connectionStatus = useUIStore(s => s.connectionStatus);
  const navOpen = useUIStore(s => s.navOpen);
  const aux = useUIStore(s => s.aux);
  const overlay = useUIStore(s => s.activeOverlay);
  const { phone, compact } = useShellViewport();
  const navRef = useRef<HTMLElement>(null);
  const auxRef = useRef<HTMLElement>(null);
  const obscured = !!overlay || (compact && navOpen) || (phone && !!aux);

  // URL: /app/{channelId} or /app
  const urlSegment1 = params['*']?.split('/')[0] || null;
  const urlChannelId = urlSegment1;

  // Sync URL → store
  useEffect(() => {
    if (useChannelStore.getState().activeChannelId !== urlChannelId) {
      useUIStore.getState().onChannelSelect(urlChannelId);
      setActiveChannel(urlChannelId);
    }
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
        className="app-shell flex flex-col min-h-0 min-w-0 overflow-hidden"
        style={{ background: P.bg, color: P.text }}
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

  return (
    <div
      className="app-shell flex flex-col min-h-0 min-w-0 overflow-hidden"
      style={{ background: P.bg, color: P.text }}
    >
      <OverlayManager navRef={navRef} auxRef={auxRef} />
      <div className="shell-tabbar" inert={obscured}><TabBar /></div>
      <div className="shell-body flex flex-1 min-h-0 min-w-0">
        <div className="shell-rail" inert={!!overlay || !!aux}>
          <button aria-label="Open navigation" onClick={() => useUIStore.getState().openNav()}>&#9776;</button>
        </div>
        {compact && navOpen && <button className="shell-backdrop" aria-label="Close navigation" onClick={() => useUIStore.getState().closeNav()} />}
        <nav ref={navRef} tabIndex={-1} aria-label="Channels" aria-modal={compact && navOpen ? true : undefined}
          role={compact && navOpen ? 'dialog' : undefined}
          className={`shell-nav ${navOpen ? 'is-open' : ''}`} inert={!!overlay || (compact && !navOpen)}>
          <button className="shell-nav-close xl:hidden" onClick={() => useUIStore.getState().closeNav()}>Back</button>
          <ArcChannelSidebar />
        </nav>
        <div className="shell-channel flex flex-1 min-w-0 min-h-0" inert={obscured}>
          <ArcContentArea />
        </div>
        {aux && <>
          {compact && !phone && <button className="shell-backdrop" aria-label="Close inspector" onClick={() => useUIStore.getState().closeAux()} />}
          <aside ref={auxRef} tabIndex={-1} className="shell-aux" role={compact ? 'dialog' : 'complementary'}
            aria-label={aux} aria-modal={compact ? true : undefined} inert={!!overlay}>
            {aux === 'thread' && <ThreadPanel />}
            {aux === 'files' && <FilesPanel />}
            {aux === 'members' && <MembersSidebar />}
          </aside>
        </>}
      </div>
    </div>
  );
}
