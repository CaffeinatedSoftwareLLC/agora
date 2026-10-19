import { AuxPanelControl } from '../shell/AuxPanelControl';
import { useDraftStore, sendDraft, type DraftKey } from '../../stores/draftStore';
import { useState, useRef, useEffect, useMemo } from 'react';
import { useThreadStore } from '../../stores/threadStore';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { MessageItem } from './MessageItem';
import { ProtocolBadge } from './ProtocolBadge';
import { latestProtocol } from './latestProtocol';
import { usePalette } from '../../theme';

export function ThreadPanel() {
  const P = usePalette();
  const openThreadId = useThreadStore(s => s.openThreadId);
  const openThreadChannelId = useThreadStore(s => s.openThreadChannelId);
  const repliesByThread = useThreadStore(s => s.repliesByThread);
  const sendReply = useThreadStore(s => s.sendReply);
  const closeThreadRemote = useThreadStore(s => s.closeThreadRemote);
  const reopenThread = useThreadStore(s => s.reopenThread);
  const activeThreads = useThreadStore(s => s.activeThreads);

  const user = useAuthStore(s => s.user);
  const byChannel = useMessageStore(s => s.byChannel);

  const draftKey: DraftKey = `thread:${openThreadId ?? ''}`;
  const content = useDraftStore(s => s.drafts[draftKey] ?? '');
  const setContent = (text: string) => useDraftStore.getState().setDraft(draftKey, text);
  const [sending, setSending] = useState(false);
  const nearBottom = useRef(true);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const replies = useMemo(() => openThreadId ? (repliesByThread.get(openThreadId) ?? []) : [], [openThreadId, repliesByThread]);

  useEffect(() => {
    nearBottom.current = true;
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [openThreadId]);
  useEffect(() => {
    if (listRef.current && nearBottom.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [replies]);
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [replies]);

  if (!openThreadId || !openThreadChannelId) return null;

  // Find parent message from channel messages
  const channelMessages = byChannel.get(openThreadChannelId) ?? [];
  const parentMessage = channelMessages.find(m => m.id === openThreadId);
  const threadClosedAt = parentMessage?.threadClosedAt;
  const isClosed = !!threadClosedAt;
  // Collab session state: latest protocol header across parent + replies
  const sessionProtocol = latestProtocol([...(parentMessage ? [parentMessage] : []), ...replies]);

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

  const handleSend = async () => {
    if (sending) return;
    const trimmed = content.trim();
    if (!trimmed || !user) return;
    nearBottom.current = true;
    setSending(true);
    await sendDraft(draftKey, () => sendReply(openThreadChannelId, openThreadId, trimmed, user.id, user.username));
    setSending(false);
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
        className="flex items-center justify-between gap-2 min-h-12 px-4 py-2 shrink-0"
        style={{ borderBottom: `1px solid ${P.border}` }}
      >
        <AuxPanelControl label="panel" />
        <h2 className="text-[15px] font-semibold flex-1 min-w-0" style={{ color: P.text }}>
          Thread
          {isClosed && <span className="ml-1.5 text-[11px] font-normal" style={{ color: P.muted }}>(Closed)</span>}
          {sessionProtocol && (
            <span className="ml-2 align-middle"><ProtocolBadge protocol={sessionProtocol} /></span>
          )}
        </h2>
        <div className="flex items-center gap-1">
          {canClose && (
            <button
              onClick={handleToggleClose}
              className="min-h-11 min-w-11 md:min-h-9 md:min-w-9 md:h-9 md:w-9 rounded-lg flex items-center justify-center transition-colors hover:bg-surface-hover"
              style={{ color: isClosed ? P.accent : P.muted }}
              title={isClosed ? 'Reopen thread' : 'Close thread'}
              aria-label={isClosed ? 'Reopen thread' : 'Close thread'}
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
        </div>
      </div>

      {/* Parent message preview */}
      {parentMessage && (
        <div
          className="px-4 py-3 shrink-0"
          style={{ borderBottom: `1px solid ${P.border}`, background: `${P.surface}80` }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[13px] font-semibold" style={{ color: P.text }}>
              {/* Task card and subtask threads start from a system line (docs/task-board.md) */}
              {parentMessage.authorUsername ?? (parentMessage.systemEvent ? 'Agora' : '')}
            </span>
            <span className="text-[11px]" style={{ color: P.muted }}>
              {new Date(parentMessage.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
          <p className="text-[13px] line-clamp-3" style={{ color: P.muted }}>
            {parentMessage.content}
          </p>
        </div>
      )}

      {/* Reply list */}
      <div ref={listRef} onScroll={e => {
        const el = e.currentTarget;
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 60;
      }} className="flex-1 overflow-y-auto px-2 py-2 min-h-0">
        {replies.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-[15px]" style={{ color: P.muted }}>No replies yet</p>
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
        <div className="shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1">
          <div
            className="flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[13px]"
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
        <div className="shrink-0 px-2.5 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:px-3 md:pb-3 md:pt-1">
          <div
            className="flex items-end gap-1.5 rounded-2xl px-2.5 py-1.5"
            style={{ background: P.surface, border: `1px solid ${P.border}` }}
          >
            <textarea
              ref={inputRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Reply..."
              rows={1}
              className="flex-1 resize-none bg-transparent outline-none text-[16px] md:text-[15px] leading-[1.4] py-2 md:py-1.5 px-1 placeholder:text-text-muted/70"
              style={{ color: P.text, maxHeight: '104px' }}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={!content.trim()}
              className="shrink-0 min-h-11 min-w-11 md:min-h-9 md:min-w-9 md:h-9 md:w-9 rounded-xl flex items-center justify-center transition-all disabled:cursor-not-allowed"
              style={{
                background: content.trim() ? P.primary : P.bg,
                color: content.trim() ? P.onPrimary : P.muted,
                opacity: content.trim() ? 1 : 0.5,
              }}
              title="Send reply"
              aria-label="Send reply"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
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
