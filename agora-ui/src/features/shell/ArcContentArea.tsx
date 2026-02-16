import { useChannelStore } from '../../stores/channelStore';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { MessageList } from '../messages/MessageList';
import { FloatingMessageInput } from '../messages/FloatingMessageInput';
import { TypingIndicator } from '../live/TypingIndicator';
import { usePalette } from '../../theme';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function serverColor(name: string): string {
  const colors = ['#0FA3B1', '#4ADE80', '#FBBF24', '#C77DFF', '#F97316', '#EF4444', '#3B82F6', '#EC4899', '#8B5CF6', '#10B981'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ArcContentArea() {
  const P = usePalette();

  const activeChannelId = useChannelStore(s => s.activeChannelId);
  const channels = useChannelStore(s => s.channels);
  const channel = activeChannelId ? channels.get(activeChannelId) : null;

  const activeServerId = useServerStore(s => s.activeServerId);
  const servers = useServerStore(s => s.servers);
  const activeServer = activeServerId ? servers.get(activeServerId) : null;

  const membersOpen = useUIStore(s => s.membersOpen);
  const toggleMembers = useUIStore(s => s.toggleMembers);

  const accentColor = activeServer ? serverColor(activeServer.name) : P.accent;

  // ── Empty state (no channel selected) ──────────────────────────────────
  if (!activeChannelId || !channel) {
    return (
      <div
        className="flex-1 flex items-center justify-center"
        style={{ background: P.bg }}
      >
        <div className="text-center">
          <div className="text-4xl mb-4" style={{ color: P.text }}>
            Select a channel
          </div>
          <div className="text-lg" style={{ color: P.muted }}>
            Select a channel to start chatting
          </div>
        </div>
      </div>
    );
  }

  return (
    <main className="flex-1 flex flex-col min-w-0" style={{ background: P.bg }}>
      {/* ── Channel header ────────────────────────────────────────────── */}
      <header
        className="flex items-center gap-3 px-5 py-2.5 shrink-0"
        style={{
          borderBottom: `1px solid ${P.border}`,
          background: `${P.bg}ee`,
          backdropFilter: 'blur(12px)',
        }}
      >
        <span className="text-lg font-light" style={{ color: accentColor }}>
          #
        </span>
        <h1 className="text-[14px] font-semibold" style={{ color: P.text }}>
          {channel.name}
        </h1>
        <div className="h-4 w-px" style={{ background: P.border }} />
        <p className="text-[12px] truncate" style={{ color: P.dim }}>
          Channel description
        </p>

        {/* Right controls */}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {/* Search button */}
          <button
            className="h-8 w-8 rounded-lg flex items-center justify-center transition-colors"
            style={{ color: P.dim }}
            title="Search"
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
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>

          {/* Pin button */}
          <button
            className="h-8 w-8 rounded-lg flex items-center justify-center transition-colors"
            style={{ color: P.dim }}
            title="Pinned Messages"
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
              <line x1="12" y1="17" x2="12" y2="22" />
              <path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1V2H8v4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V17z" />
            </svg>
          </button>

          {/* Members toggle button */}
          {activeServerId && (
            <button
              onClick={toggleMembers}
              className="h-8 w-8 rounded-lg flex items-center justify-center transition-colors"
              style={{
                color: membersOpen ? accentColor : P.dim,
                background: membersOpen ? `${accentColor}15` : 'transparent',
              }}
              title="Toggle Members"
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
          )}
        </div>
      </header>

      {/* ── Messages + typing + input ─────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-h-0">
        <MessageList channelId={activeChannelId} channelName={channel.name} />
        <TypingIndicator channelId={activeChannelId} />
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
