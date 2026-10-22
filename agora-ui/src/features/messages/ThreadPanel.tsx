import { AuxPanelControl } from '../shell/AuxPanelControl';
import { useDraftStore, sendDraft, type DraftKey } from '../../stores/draftStore';
import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { useThreadStore } from '../../stores/threadStore';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { MessageItem } from './MessageItem';
import { computeNoticeRuns } from './systemNotices';
import { NoticeRunToggle } from './SystemNoticeRun';
import { useExpandedNoticeRuns } from './useExpandedNoticeRuns';
import { ProtocolBadge } from './ProtocolBadge';
import { latestProtocol } from './latestProtocol';
import { ThreadOwnerBadge } from '../agents/HandoffCard';
import { useThreadOwner } from '../agents/handoffs';
import { usePalette } from '../../theme';
import { MicButton } from '../voice/MicButton';
import { appendDictation } from '../voice/appendDictation';
import { useUploadStore } from '../../stores/uploadStore';
import { UploadPreview } from './UploadPreview';

export function ThreadPanel() {
  const P = usePalette();
  const openThreadId = useThreadStore(s => s.openThreadId);
  const openThreadChannelId = useThreadStore(s => s.openThreadChannelId);
  const repliesByThread = useThreadStore(s => s.repliesByThread);
  const sendReply = useThreadStore(s => s.sendReply);
  const editReply = useThreadStore(s => s.editReply);
  const deleteReply = useThreadStore(s => s.deleteReply);
  const closeThreadRemote = useThreadStore(s => s.closeThreadRemote);
  const reopenThread = useThreadStore(s => s.reopenThread);
  const activeThreads = useThreadStore(s => s.activeThreads);
  const loadOlder = useThreadStore(s => s.loadOlder);
  const loadReplies = useThreadStore(s => s.loadReplies);
  const hasOlder = useThreadStore(s => !!(openThreadId && s.hasMore.get(openThreadId)));
  const loadingReplies = useThreadStore(s => !!(openThreadId && s.loadingReplies.get(openThreadId)));
  const replyLoadError = useThreadStore(s => openThreadId ? s.replyLoadErrors.get(openThreadId) : undefined);

  const user = useAuthStore(s => s.user);
  const byChannel = useMessageStore(s => s.byChannel);

  const draftKey: DraftKey = `thread:${openThreadId ?? ''}`;
  const content = useDraftStore(s => s.drafts[draftKey] ?? '');
  const setContent = (text: string) => useDraftStore.getState().setDraft(draftKey, text);
  const [sending, setSending] = useState(false);
  const nearBottom = useRef(true);
  const [olderState, setOlderState] = useState({ threadId: '', loading: false, error: '' });
  const loadingOlder = olderState.threadId === openThreadId && olderState.loading;
  const olderError = olderState.threadId === openThreadId ? olderState.error : '';
  const olderRequest = useRef<symbol | null>(null);
  const prepend = useRef<{ threadId: string; firstId: string; height: number } | null>(null);
  const previousThread = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);
  const [dragging, setDragging] = useState(false);
  const allUploads = useUploadStore(s => s.uploads);
  const addUpload = useUploadStore(s => s.addUpload);
  const removeUpload = useUploadStore(s => s.removeUpload);
  const uploads = useMemo(() => Array.from(allUploads.values()).filter(u =>
    u.channelId === openThreadChannelId && u.threadId === openThreadId), [allUploads, openThreadChannelId, openThreadId]);
  const completed = uploads.filter(u => u.status === 'done' && u.result);
  const uploadsBlocked = uploads.some(u => u.status !== 'done');
  const canSend = !sending && !uploadsBlocked && (!!content.trim() || completed.length > 0);

  useEffect(() => { dragCounter.current = 0; setDragging(false); }, [openThreadId]);

  const replies = useMemo(() => openThreadId ? (repliesByThread.get(openThreadId) ?? []) : [], [openThreadId, repliesByThread]);
  const noticeRuns = useMemo(() => computeNoticeRuns(replies), [replies]);
  // The thread's task owner (#84): refetched whenever a handoff card in it changes state
  const handoffVersion = useMemo(() => replies.filter(r => r.systemEvent === 'agent_handoff')
    .map(r => `${r.id}:${(r.systemData as { status?: string } | undefined)?.status ?? ''}`).join(','), [replies]);
  const threadOwner = useThreadOwner(openThreadChannelId, openThreadId, handoffVersion);
  const { isExpanded: isRunExpanded, toggle: toggleRun } = useExpandedNoticeRuns(user?.id);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (previousThread.current !== openThreadId) {
      previousThread.current = openThreadId;
      nearBottom.current = true;
      prepend.current = null;
      olderRequest.current = null;
    }
    if (!el) return;
    const anchor = prepend.current;
    if (anchor?.threadId === openThreadId) {
      if (replies[0]?.id !== anchor.firstId) {
        el.scrollTop += el.scrollHeight - anchor.height;
        prepend.current = null;
        return;
      }
      // Live appends while the older GET is pending must not count as prepended height.
      anchor.height = el.scrollHeight;
      if (!loadingOlder) prepend.current = null;
    }
    if (nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [openThreadId, replies, loadingReplies, loadingOlder]);
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

  const handleLoadOlder = async () => {
    if (!openThreadId || !openThreadChannelId || !hasOlder || loadingReplies || olderRequest.current) return;
    const token = Symbol();
    olderRequest.current = token;
    const threadId = openThreadId;
    nearBottom.current = false;
    if (listRef.current && replies[0]) prepend.current = { threadId, firstId: replies[0].id, height: listRef.current.scrollHeight };
    setOlderState({ threadId, loading: true, error: '' });
    try {
      await loadOlder(openThreadChannelId, threadId);
    } catch {
      if (olderRequest.current === token) setOlderState({ threadId, loading: false, error: 'Could not load older replies. Try again.' });
    } finally {
      if (olderRequest.current === token) {
        olderRequest.current = null;
        setOlderState(state => ({ ...state, loading: false }));
      }
    }
  };

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
    if (!canSend || !user) return;
    nearBottom.current = true;
    setSending(true);
    const sentUploads = completed;
    const sent = await sendDraft(draftKey, () => sendReply(openThreadChannelId, openThreadId, trimmed, user.id, user.username,
      sentUploads.length ? sentUploads.map(u => u.result!.id) : undefined));
    if (sent) for (const upload of sentUploads) removeUpload(upload.id);
    setSending(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleEdit = (replyId: string, content: string) => {
    void editReply(openThreadChannelId, openThreadId, replyId, content);
  };
  const handleDelete = (replyId: string) => {
    void deleteReply(openThreadChannelId, openThreadId, replyId);
  };

  const handleFiles = (files: FileList | File[]) => {
    if (sending) return;
    for (const file of Array.from(files).slice(0, Math.max(0, 10 - uploads.length))) {
      addUpload(openThreadChannelId, file, openThreadId);
    }
  };

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
          {threadOwner && <ThreadOwnerBadge owner={threadOwner} />}
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
      <div ref={listRef} role="log" aria-label="Thread replies" style={{ overflowAnchor: 'none' }} onScroll={e => {
        const el = e.currentTarget;
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 60;
        if (el.scrollTop < 100) void handleLoadOlder();
      }} className="flex-1 overflow-y-auto px-2 py-2 min-h-0">
        {loadingReplies && <p role="status" className="px-2 py-2 text-[13px] text-text-muted">Loading replies…</p>}
        {replyLoadError && <div role="alert" className="px-2 py-2 text-[13px] text-text-muted">{replyLoadError}{' '}
          <button className="min-h-11 px-2 text-primary-text" onClick={() => void loadReplies(openThreadChannelId, openThreadId).catch(() => {})}>Retry</button>
        </div>}
        {hasOlder && !loadingReplies && <button type="button" disabled={loadingOlder} onClick={() => void handleLoadOlder()}
          className="min-h-11 w-full rounded px-2 text-[13px] text-primary-text hover:bg-surface-hover disabled:text-text-muted">
          {loadingOlder ? 'Loading older replies…' : 'Load older replies'}
        </button>}
        {olderError && <p role="alert" className="px-2 py-2 text-[13px] text-text-muted">{olderError}</p>}
        {replies.length === 0 && !loadingReplies && !replyLoadError && (
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
          const run = noticeRuns[i];
          const runExpanded = run ? isRunExpanded(run.key) : false;
          const item = (
            <MessageItem
              key={reply.id}
              message={reply}
              isGrouped={isGrouped}
              isOwn={reply.authorId === user?.id}
              onEdit={handleEdit}
              onDelete={handleDelete}
              channelId={openThreadChannelId}
            />
          );
          if (!run) return item;
          if (run.position === 0) {
            return (
              <div key={reply.id}>
                <NoticeRunToggle count={run.size} expanded={runExpanded} onToggle={() => toggleRun(run.key)} />
                {runExpanded && item}
              </div>
            );
          }
          return runExpanded ? item : null;
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
        <div className="relative shrink-0 px-2.5 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:px-3 md:pb-3 md:pt-1"
          onDragEnter={e => { e.preventDefault(); dragCounter.current++; setDragging(true); }}
          onDragOver={e => e.preventDefault()}
          onDragLeave={e => { e.preventDefault(); if (--dragCounter.current <= 0) { dragCounter.current = 0; setDragging(false); } }}
          onDrop={e => { e.preventDefault(); dragCounter.current = 0; setDragging(false); handleFiles(e.dataTransfer.files); }}>
          <input ref={fileInputRef} type="file" multiple className="hidden" aria-label="Thread attachments" disabled={sending}
            onChange={e => { if (e.target.files) handleFiles(e.target.files); e.target.value = ''; }} />
          {dragging && <div className="pointer-events-none absolute inset-0 rounded-xl border-2 border-dashed border-primary bg-surface/90 flex items-center justify-center z-10">Drop files to upload</div>}
          {uploads.length > 0 && <div className="flex flex-wrap gap-2 py-2">{uploads.map(upload => <UploadPreview key={upload.id} upload={upload} onRemove={removeUpload} />)}</div>}
          <div
            className="flex items-end gap-1.5 rounded-2xl px-2.5 py-1.5"
            style={{ background: P.surface, border: `1px solid ${P.border}` }}
          >
            <button type="button" className="shrink-0 min-h-11 min-w-11 md:min-h-9 md:min-w-9 rounded-xl text-text-muted hover:bg-surface-hover"
              aria-label="Attach file to reply" title="Attach file to reply" disabled={sending} onClick={() => fileInputRef.current?.click()}>+</button>
            <textarea
              ref={inputRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={e => { if (e.clipboardData.files.length) { e.preventDefault(); handleFiles(e.clipboardData.files); } }}
              placeholder="Reply..."
              rows={1}
              className="flex-1 min-w-0 resize-none bg-transparent outline-none text-[16px] md:text-[15px] leading-[1.4] py-2 md:py-1.5 px-1 placeholder:text-text-muted/70"
              style={{ color: P.text, maxHeight: '104px' }}
            />
            <MicButton
              channelId={openThreadChannelId}
              onText={(text) => {
                setContent(appendDictation(useDraftStore.getState().getDraft(draftKey), text));
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              className="shrink-0 min-h-11 min-w-11 md:min-h-9 md:min-w-9 md:h-9 md:w-9 rounded-xl flex items-center justify-center transition-all disabled:cursor-not-allowed"
              style={{
                background: canSend ? P.primary : P.bg,
                color: canSend ? P.onPrimary : P.muted,
                opacity: canSend ? 1 : 0.5,
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
