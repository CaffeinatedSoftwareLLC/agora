import { useState, useRef, useEffect } from 'react';
import { useThreadStore } from '../../stores/threadStore';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { useChannelStore } from '../../stores/channelStore';
import { MessageItem } from './MessageItem';
import { usePalette } from '../../theme';

export function ThreadPanel() {
  const P = usePalette();
  const openThreadId = useThreadStore(s => s.openThreadId);
  const openThreadChannelId = useThreadStore(s => s.openThreadChannelId);
  const closeThread = useThreadStore(s => s.closeThread);
  const repliesByThread = useThreadStore(s => s.repliesByThread);
  const sendReply = useThreadStore(s => s.sendReply);
  const closeThreadRemote = useThreadStore(s => s.closeThreadRemote);
  const reopenThread = useThreadStore(s => s.reopenThread);
  const activeThreads = useThreadStore(s => s.activeThreads);

  const user = useAuthStore(s => s.user);
  const byChannel = useMessageStore(s => s.byChannel);

  const [content, setContent] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const replies = openThreadId ? (repliesByThread.get(openThreadId) ?? []) : [];

  // Auto-scroll to bottom when new replies arrive
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [replies.length]);

  if (!openThreadId || !openThreadChannelId) return null;

  // Find parent message from channel messages
  const channelMessages = byChannel.get(openThreadChannelId) ?? [];
  const parentMessage = channelMessages.find(m => m.id === openThreadId);
  const threadClosedAt = parentMessage?.threadClosedAt;
  const isClosed = !!threadClosedAt;

  // Determine canClose from active threads, author check, or closed-thread fallback.
  // For closed threads (not in activeThreads), show the button — the backend enforces
  // permissions on the PATCH endpoint, so unauthorized attempts are safely rejected.
  const threadSummary = (activeThreads.get(openThreadChannelId) ?? []).find(t => t.id === openThreadId);
  const isAuthor = parentMessage?.authorId === user?.id;
  const canClose = threadSummary?.canClose || isAuthor || isClosed;

  const handleToggleClose = async () => {
    if (isClosed) {
      await reopenThread(openThreadChannelId!, openThreadId!);
    } else {
      await closeThreadRemote(openThreadChannelId!, openThreadId!);
    }
  };

  const handleSend = () => {
    const trimmed = content.trim();
    if (!trimmed || !user) return;
    sendReply(openThreadChannelId, openThreadId, trimmed, user.id, user.username);
    setContent('');
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const noopEdit = () => {};
  const noopDelete = () => {};

  return (
    <div
      className="w-[380px] shrink-0 flex flex-col border-l"
      style={{ background: P.bg, borderColor: P.border }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: `1px solid ${P.border}` }}
      >
        <h2 className="text-sm font-semibold" style={{ color: P.text }}>
          Thread
          {isClosed && <span className="ml-1.5 text-xs font-normal" style={{ color: P.muted }}>(Closed)</span>}
        </h2>
        <div className="flex items-center gap-1">
          {canClose && (
            <button
              onClick={handleToggleClose}
              className="h-7 w-7 rounded flex items-center justify-center transition-colors"
              style={{ color: isClosed ? P.accent : P.muted }}
              title={isClosed ? 'Reopen thread' : 'Close thread'}
            >
              {isClosed ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 019.9-1" />
                </svg>
              )}
            </button>
          )}
          <button
            onClick={closeThread}
            className="h-7 w-7 rounded flex items-center justify-center transition-colors"
            style={{ color: P.muted }}
            title="Close panel"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Parent message preview */}
      {parentMessage && (
        <div
          className="px-4 py-3 shrink-0"
          style={{ borderBottom: `1px solid ${P.border}`, background: `${P.surface}80` }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium" style={{ color: P.text }}>
              {parentMessage.authorUsername}
            </span>
            <span className="text-xs" style={{ color: P.muted }}>
              {new Date(parentMessage.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
          <p className="text-xs line-clamp-3" style={{ color: P.dim }}>
            {parentMessage.content}
          </p>
        </div>
      )}

      {/* Reply list */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-2 min-h-0">
        {replies.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm" style={{ color: P.muted }}>No replies yet</p>
          </div>
        )}
        {replies.map((reply, i) => {
          const prev = i > 0 ? replies[i - 1] : null;
          const isGrouped = prev !== null
            && prev.authorId === reply.authorId
            && !prev.deletedAt
            && !reply.deletedAt
            && (new Date(reply.createdAt).getTime() - new Date(prev.createdAt).getTime()) < 300000;
          return (
            <MessageItem
              key={reply.id}
              message={reply}
              isGrouped={isGrouped}
              isOwn={reply.authorId === user?.id}
              onEdit={noopEdit}
              onDelete={noopDelete}
              channelId={openThreadChannelId}
            />
          );
        })}
      </div>

      {/* Reply input or closed banner */}
      {isClosed ? (
        <div className="shrink-0 px-3 pb-3 pt-1">
          <div
            className="flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm"
            style={{ background: P.surface, border: `1px solid ${P.border}`, color: P.muted }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
            Thread closed
          </div>
        </div>
      ) : (
        <div className="shrink-0 px-3 pb-3 pt-1">
          <div
            className="flex items-end gap-2 rounded-xl px-3 py-2"
            style={{ background: P.surface, border: `1px solid ${P.border}` }}
          >
            <textarea
              ref={inputRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Reply..."
              rows={1}
              className="flex-1 resize-none bg-transparent outline-none text-sm leading-5"
              style={{ color: P.text, maxHeight: '96px' }}
            />
            <button
              onClick={handleSend}
              disabled={!content.trim()}
              className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center transition-colors disabled:opacity-30"
              style={{ color: P.accent }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
