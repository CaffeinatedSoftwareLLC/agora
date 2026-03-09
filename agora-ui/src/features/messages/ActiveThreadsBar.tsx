import { useEffect, useState } from 'react';
import { useThreadStore, type ThreadSummary } from '../../stores/threadStore';
import { usePalette } from '../../theme';
import { relativeTime } from '../../lib/relativeTime';

interface ActiveThreadsBarProps {
  channelId: string;
}

export function ActiveThreadsBar({ channelId }: ActiveThreadsBarProps) {
  const P = usePalette();
  const activeThreads = useThreadStore(s => s.activeThreads);
  const loadActiveThreads = useThreadStore(s => s.loadActiveThreads);
  const loadMoreThreads = useThreadStore(s => s.loadMoreThreads);
  const hasMoreThreads = useThreadStore(s => s.hasMoreThreads);
  const openThread = useThreadStore(s => s.openThread);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    loadActiveThreads(channelId);
  }, [channelId, loadActiveThreads]);

  const threads: ThreadSummary[] = (activeThreads.get(channelId) ?? []).filter(t => !t.threadClosedAt);

  if (threads.length === 0) return null;

  return (
    <div
      className="shrink-0 px-4 py-2"
      style={{ borderBottom: `1px solid ${P.border}` }}
    >
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-1.5 text-xs font-medium mb-1 transition-colors"
        style={{ color: P.muted }}
      >
        <svg
          className={`w-3 h-3 transition-transform ${collapsed ? '' : 'rotate-90'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        Active Threads ({threads.length})
      </button>

      {!collapsed && (
        <div className="flex flex-col gap-1">
          {threads.map((thread) => (
            <button
              key={thread.id}
              onClick={() => openThread(channelId, thread.id)}
              className="flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors w-full"
              style={{ color: P.text }}
              onMouseEnter={(e) => { e.currentTarget.style.background = P.surfaceHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke={P.accent} viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
              <span className="text-xs truncate flex-1" style={{ color: P.text }}>
                {thread.content ? thread.content.slice(0, 60) + (thread.content.length > 60 ? '...' : '') : '(deleted)'}
              </span>
              <span className="text-xs shrink-0" style={{ color: P.muted }}>
                {thread.replyCount} {thread.replyCount === 1 ? 'reply' : 'replies'}
              </span>
              <span className="text-xs shrink-0" style={{ color: P.dim }}>
                {relativeTime(thread.lastReplyAt)}
              </span>
            </button>
          ))}
          {hasMoreThreads.get(channelId) && (
            <button
              onClick={() => loadMoreThreads(channelId)}
              className="flex items-center justify-center px-2 py-1 rounded text-xs transition-colors"
              style={{ color: P.accent }}
              onMouseEnter={(e) => { e.currentTarget.style.background = P.surfaceHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              Show more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
