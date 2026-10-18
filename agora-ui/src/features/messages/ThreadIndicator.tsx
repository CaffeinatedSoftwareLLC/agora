import { useUIStore } from '../../stores/uiStore';
import { usePalette } from '../../theme';
import { relativeTime } from '../../lib/relativeTime';

interface ThreadIndicatorProps {
  replyCount: number;
  lastReplyAt?: string;
  channelId: string;
  messageId: string;
  threadClosedAt?: string;
}

export function ThreadIndicator({ replyCount, lastReplyAt, channelId, messageId, threadClosedAt }: ThreadIndicatorProps) {
  const P = usePalette();
  const openThread = useUIStore(s => s.openThreadView);
  const isClosed = !!threadClosedAt;

  return (
    <button
      onClick={() => openThread(channelId, messageId)}
      className="flex items-center gap-2 mt-1 min-h-11 md:min-h-8 px-2.5 py-1.5 rounded-lg text-[13px] transition-colors cursor-pointer"
      style={{ color: isClosed ? P.muted : P.accent, background: isClosed ? `${P.muted}14` : `${P.accent}14` }}
      onMouseEnter={(e) => { e.currentTarget.style.background = isClosed ? `${P.muted}24` : `${P.accent}24`; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = isClosed ? `${P.muted}14` : `${P.accent}14`; }}
    >
      {isClosed ? (
        <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
      )}
      <span className="font-medium">
        {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
      </span>
      {isClosed && (
        <span style={{ color: P.muted }}>Closed</span>
      )}
      {!isClosed && lastReplyAt && (
        <span style={{ color: P.muted }}>
          Last reply {relativeTime(lastReplyAt)}
        </span>
      )}
    </button>
  );
}
