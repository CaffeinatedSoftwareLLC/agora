import { useThreadStore } from '../../stores/threadStore';
import { usePalette } from '../../theme';
import { relativeTime } from '../../lib/relativeTime';

interface ThreadIndicatorProps {
  replyCount: number;
  lastReplyAt?: string;
  channelId: string;
  messageId: string;
}

export function ThreadIndicator({ replyCount, lastReplyAt, channelId, messageId }: ThreadIndicatorProps) {
  const P = usePalette();
  const openThread = useThreadStore(s => s.openThread);

  return (
    <button
      onClick={() => openThread(channelId, messageId)}
      className="flex items-center gap-2 mt-1 px-2 py-1 rounded text-xs transition-colors cursor-pointer"
      style={{ color: P.accent, background: `${P.accent}10` }}
      onMouseEnter={(e) => { e.currentTarget.style.background = `${P.accent}20`; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = `${P.accent}10`; }}
    >
      <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
      <span className="font-medium">
        {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
      </span>
      {lastReplyAt && (
        <span style={{ color: P.muted }}>
          Last reply {relativeTime(lastReplyAt)}
        </span>
      )}
    </button>
  );
}
