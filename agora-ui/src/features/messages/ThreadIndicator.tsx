import { useThreadStore } from '../../stores/threadStore';
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
  const openThread = useThreadStore(s => s.openThread);
  const isClosed = !!threadClosedAt;

  return (
    <button
      onClick={() => openThread(channelId, messageId)}
      className="flex items-center gap-2 mt-1 px-2 py-1 rounded text-xs transition-colors cursor-pointer"
      style={{ color: isClosed ? P.muted : P.accent, background: isClosed ? `${P.muted}10` : `${P.accent}10` }}
      onMouseEnter={(e) => { e.currentTarget.style.background = isClosed ? `${P.muted}20` : `${P.accent}20`; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = isClosed ? `${P.muted}10` : `${P.accent}10`; }}
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
