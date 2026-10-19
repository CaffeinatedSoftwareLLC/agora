import { useChannelStore } from '../../stores/channelStore';
import { useUIStore } from '../../stores/uiStore';
import { MessageList } from '../messages/MessageList';
import { FloatingMessageInput } from '../messages/FloatingMessageInput';
import { TypingIndicator } from '../live/TypingIndicator';
import { RunActivity } from '../agents/RunActivity';
import { ConsoleStrip } from '../agents/ConsoleStrip';
import { usePalette } from '../../theme';

// ─── Component ───────────────────────────────────────────────────────────────

export function ArcContentArea() {
  const P = usePalette();
  const paletteKey = useUIStore(s => s.paletteKey);
  const togglePalette = useUIStore(s => s.togglePalette);
  const paletteName = paletteKey === 'aegean' ? 'Aegean' : 'Terracotta';

  const activeChannelId = useChannelStore(s => s.activeChannelId);
  const channels = useChannelStore(s => s.channels);
  const channel = activeChannelId ? channels.get(activeChannelId) : null;
  const connectionStatus = useUIStore(s => s.connectionStatus);

  const membersOpen = useUIStore(s => s.aux === 'members');
  const toggleMembers = useUIStore(s => s.toggleAux);
  const filesOpen = useUIStore(s => s.aux === 'files');
  const toggleFiles = useUIStore(s => s.toggleAux);
  const projectOpen = useUIStore(s => s.aux === 'project');
  const tasksOpen = useUIStore(s => s.aux === 'tasks');
  const openThreadView = useUIStore(s => s.openThreadView);

  const accentColor = P.accent;

  // ── Empty state (no channel selected) ──────────────────────────────────
  if (!activeChannelId || !channel) {
    return (
      <div
        className="flex-1 flex items-center justify-center p-6"
        style={{ background: P.bg }}
      >
        <div className="text-center">
          <button
            className="md:hidden min-h-11 px-4 mb-4 rounded-xl border border-border text-[13px] font-semibold"
            style={{ background: P.surface, color: P.text }}
            onClick={() => useUIStore.getState().openNav()}
          >
            Open navigation
          </button>
          <div className="text-[22px] font-bold mb-2" style={{ color: P.text }}>
            Select a channel
          </div>
          <div className="text-[15px]" style={{ color: P.muted }}>
            Select a channel to start chatting
          </div>
        </div>
      </div>
    );
  }

  return (
    <main className="flex-1 flex flex-col min-w-0 min-h-0" style={{ background: P.bg }}>
      {/* ── Channel header (48px min-h-12 on phone) ───────────────────── */}
      <header
        className="flex items-center gap-2 md:gap-3 min-h-12 px-3 py-1.5 md:px-5 md:py-2 shrink-0"
        style={{
          borderBottom: `1px solid ${P.border}`,
          background: `${P.bg}ee`,
          backdropFilter: 'blur(12px)',
        }}
      >
        <button
          className="md:hidden shrink-0 min-h-11 min-w-11 rounded-lg flex items-center justify-center transition-colors hover:bg-surface-hover"
          style={{ color: P.text }}
          aria-label="Open navigation"
          onClick={() => useUIStore.getState().openNav()}
        >
          &#9776;
        </button>
        <span className="text-lg font-medium shrink-0" style={{ color: accentColor }}>
          #
        </span>
        <h1 className="text-[15px] font-semibold truncate" style={{ color: P.text }}>
          {channel.name}
        </h1>
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: connectionStatus === 'connected' ? P.online : connectionStatus === 'reconnecting' ? P.warn : P.danger }}
          title={connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'reconnecting' ? 'Reconnecting' : 'Disconnected'}
          role="img"
          aria-label={connectionStatus}
        />

        {/* Right controls */}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {/* Mobile palette toggle (since TabBar is hidden on <768px) */}
          <button
            onClick={togglePalette}
            className="md:hidden min-h-11 min-w-11 px-2.5 rounded-lg flex items-center justify-center gap-1.5 text-[11px] font-semibold transition-colors"
            style={{
              background: P.surface,
              border: `1px solid ${P.border}`,
              color: P.muted,
            }}
            title={`Theme: ${paletteName} (tap to switch)`}
            aria-label={`Switch theme from ${paletteName}`}
          >
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: P.primary }} />
            <span className="sr-only">{paletteName}</span>
          </button>

          {/* Project context panel toggle (docs/project-context.md) */}
          <button
            onClick={() => toggleFiles('project')}
            className="min-h-11 min-w-11 md:min-h-9 md:min-w-9 md:h-9 md:w-9 rounded-lg flex items-center justify-center transition-colors hover:bg-surface-hover"
            style={{
              color: projectOpen ? accentColor : P.muted,
              background: projectOpen ? `${accentColor}1f` : 'transparent',
            }}
            title="Project context for agents"
            aria-label="Project context for agents"
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
              <path d="M12 17v5" />
              <path d="M9 10.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V16a1 1 0 001 1h12a1 1 0 001-1v-.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V7a1 1 0 011-1 2 2 0 000-4H8a2 2 0 000 4 1 1 0 011 1z" />
            </svg>
          </button>

          {/* Task board toggle */}
          <button
            onClick={() => toggleFiles('tasks')}
            className="min-h-11 min-w-11 md:min-h-9 md:min-w-9 md:h-9 md:w-9 rounded-lg flex items-center justify-center transition-colors hover:bg-surface-hover"
            style={{
              color: tasksOpen ? accentColor : P.muted,
              background: tasksOpen ? `${accentColor}1f` : 'transparent',
            }}
            title="Task board"
            aria-label="Task board"
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
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18M15 3v18M5 8h2M11 8h2M11 12h2M17 8h2" />
            </svg>
          </button>

          {/* Files panel toggle */}
          <button
            onClick={() => toggleFiles('files')}
            className="min-h-11 min-w-11 md:min-h-9 md:min-w-9 md:h-9 md:w-9 rounded-lg flex items-center justify-center transition-colors hover:bg-surface-hover"
            style={{
              color: filesOpen ? accentColor : P.muted,
              background: filesOpen ? `${accentColor}1f` : 'transparent',
            }}
            title="Files in this channel"
            aria-label="Files in this channel"
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
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </button>

          {/* Members toggle button */}
          <button
            onClick={() => toggleMembers('members')}
            className="min-h-11 min-w-11 md:min-h-9 md:min-w-9 md:h-9 md:w-9 rounded-lg flex items-center justify-center transition-colors hover:bg-surface-hover"
            style={{
              color: membersOpen ? accentColor : P.muted,
              background: membersOpen ? `${accentColor}1f` : 'transparent',
            }}
            title="Toggle Members"
            aria-label="Toggle Members"
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
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 00-3-3.87" />
              <path d="M16 3.13a4 4 0 010 7.75" />
            </svg>
          </button>
        </div>
      </header>

      {/* ── Console Strip: agents + active collab threads ─────────────── */}
      <ConsoleStrip channelId={activeChannelId} onOpenThread={(tid) => openThreadView(activeChannelId, tid)} />

      {/* ── Messages + typing + input ─────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-h-0">
        <MessageList channelId={activeChannelId} channelName={channel.name} />
        <TypingIndicator channelId={activeChannelId} />
        <RunActivity key={`run-${activeChannelId}`} channelId={activeChannelId} />
        <FloatingMessageInput
          key={activeChannelId}
          channelId={activeChannelId}
          channelName={channel.name}
          accentColor={accentColor}
        />
      </div>
    </main>
  );
}
