import { useUIStore } from '../../stores/uiStore';
import { useShellViewport } from '../shell/viewport';
import { useEffect, useRef, useCallback, useState, useLayoutEffect, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { api } from '../../lib/api';
import { MessageItem } from './MessageItem';
import { NewMessagesPill } from './NewMessagesPill';
import { EmptyChannel } from './EmptyChannel';
import { shouldGroup, estimateMessageHeight, computePrependShift, computeScrollCorrection } from './grouping';
import { isHiddenInRun } from './systemNotices';
import { computeMessageRuns, resizeChangedRunRows } from './messageRuns';
import { AgentMessageRunToggle, AgentRunCollapse } from './AgentMessageRun';
import { useExpandedNoticeRuns } from './useExpandedNoticeRuns';

interface MessageListProps {
  channelId: string;
  channelName: string;
  isDm?: boolean;
}

export function MessageList({ channelId, channelName, isDm }: MessageListProps) {
  const { phone, compact } = useShellViewport();
  const blocked = useUIStore(s => !!s.activeOverlay || (compact && s.navOpen) || (phone && s.aux !== null));
  const messages = useMessageStore(s => s.byChannel.get(channelId));
  const hasMore = useMessageStore(s => s.hasMore.get(channelId) ?? false);
  const loadMessages = useMessageStore(s => s.loadMessages);
  const loadOlder = useMessageStore(s => s.loadOlder);
  const editMessage = useMessageStore(s => s.editMessage);
  const deleteMessage = useMessageStore(s => s.deleteMessage);
  const userId = useAuthStore(s => s.user?.id);

  const parentRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  const lastMessageIdRef = useRef<string | null>(null);
  const prevCountRef = useRef(0);
  const initialLoadRef = useRef(true);
  const nearBottomRef = useRef(true);
  const pendingCorrectionRef = useRef<{ anchorIndex: number; estimatedOffset: number } | null>(null);

  const count = messages?.length ?? 0;
  const hasMessages = count > 0;

  // Consecutive bot posts, notices and resolved cards share one activity section (2+).
  // Every message keeps its own virtual row; hidden members of a collapsed run render empty (0px).
  const noticeRuns = useMemo(() => computeMessageRuns(messages ?? []), [messages]);
  const { isExpanded: isRunExpanded, toggle: toggleRun, keys: expandedKeys } = useExpandedNoticeRuns(userId);
  const estimateAt = (index: number): number => {
    if (!messages?.[index]) return 48;
    const run = noticeRuns[index];
    if (run) {
      const expanded = isRunExpanded(run.key, run.aliases);
      if (isHiddenInRun(run, expanded)) return 0;
      if (run.position === 0) {
        return expanded ? 48 + estimateMessageHeight(undefined, messages[index]) : 48;
      }
    }
    const prev = index > 0 ? messages[index - 1] : undefined;
    return estimateMessageHeight(prev, messages[index]) + (run && isRunExpanded(run.key, run.aliases) && run.position === run.size - 1 ? 48 : 0);
  };

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: estimateAt,
    overscan: 15,
    getItemKey: (index) => messages?.[index]?.id ?? String(index),
  });

  // Toggles and live arrivals/deletions can change a row's role; clear offscreen caches too.
  const prevExpandedRef = useRef(expandedKeys);
  const runRows = useMemo(() => (messages ?? []).map((message, index) => ({ id: message.id, run: noticeRuns[index] })), [messages, noticeRuns]);
  const prevRunRowsRef = useRef(runRows);
  useLayoutEffect(() => {
    const prev = prevExpandedRef.current;
    prevExpandedRef.current = expandedKeys;
    const changed = new Set([...prev, ...expandedKeys].filter(k => prev.includes(k) !== expandedKeys.includes(k)));
    resizeChangedRunRows(virtualizer, prevRunRowsRef.current, runRows, changed, estimateAt);
    prevRunRowsRef.current = runRows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedKeys, runRows]);

  // Load messages on channel change
  useEffect(() => {
    loadMessages(channelId);
    setNewCount(0);
    setIsAtBottom(true);
    lastMessageIdRef.current = null;
    prevCountRef.current = 0;
    initialLoadRef.current = true;
    nearBottomRef.current = true;
    pendingCorrectionRef.current = null;
    lastAckRef.current = null;
  }, [channelId, loadMessages]);

  // Send server ACK when messages first load for this channel
  const lastAckRef = useRef<string | null>(null);
  useEffect(() => {
    if (blocked || !isAtBottom || !messages?.length) return;
    const lastMessage = [...messages].reverse().find(m => !m.pending && !m.failed);
    if (!lastMessage || lastAckRef.current === lastMessage.id) return;
    lastAckRef.current = lastMessage.id;
    useUnreadStore.getState().markRead(channelId, lastMessage.id);
    api.put(`/channels/${channelId}/ack`, { messageId: lastMessage.id }).catch(() => {});
  }, [channelId, messages, blocked, isAtBottom]);

  // Scroll positioning: initial scroll-to-bottom, prepend anchor, auto-scroll on new message
  useLayoutEffect(() => {
    if (!messages || messages.length === 0) return;

    const lastMsg = messages[messages.length - 1];
    const prevCount = prevCountRef.current;
    const currentCount = messages.length;

    if (initialLoadRef.current) {
      // Initial load: scroll to bottom immediately (no smooth — avoid visible travel)
      virtualizer.scrollToIndex(currentCount - 1, { align: 'end' });
      lastMessageIdRef.current = lastMsg.id;
      prevCountRef.current = currentCount;
      initialLoadRef.current = false;
      return;
    }

    if (currentCount > prevCount && prevCount > 0) {
      if (lastMsg.id === lastMessageIdRef.current) {
        // Prepend — older messages loaded at the start of the array.
        // The virtualizer re-indexed every existing item downward by the
        // cumulative estimated height of the new items.  Apply the same
        // estimate-based shift now (self-consistent with the virtualizer's
        // positioning) and schedule a measurement-based correction for
        // after the browser has painted and measured the new items.
        const prependedCount = currentCount - prevCount;
        const el = parentRef.current;
        if (el) {
          const shift = computePrependShift(messages, prependedCount, estimateAt);
          el.scrollTop += shift;
          pendingCorrectionRef.current = {
            anchorIndex: prependedCount,
            estimatedOffset: shift,
          };
        }
      } else {
        // Append — new message arrived at the end
        const isFromSelf = lastMsg.authorId === userId;
        if (isAtBottom || isFromSelf) {
          virtualizer.scrollToIndex(currentCount - 1, { align: 'end', behavior: 'smooth' });
        } else {
          setNewCount(c => c + 1);
        }
      }
    }

    lastMessageIdRef.current = lastMsg.id;
    prevCountRef.current = currentCount;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, isAtBottom, userId]);

  // Post-measurement scroll correction for prepended items.
  // The useLayoutEffect above uses estimate-based sizes (self-consistent with
  // the virtualizer's initial positioning).  Once ResizeObserver measures the
  // actual heights and the virtualizer re-renders, the anchor item's position
  // may shift.  Double-rAF waits for paint → ResizeObserver → re-render, then
  // reads the anchor's measured position and applies the delta.
  useEffect(() => {
    if (!pendingCorrectionRef.current) return;
    const { anchorIndex, estimatedOffset } = pendingCorrectionRef.current;
    pendingCorrectionRef.current = null;

    const el = parentRef.current;
    if (!el) return;

    let id2: number | undefined;
    const id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(() => {
        const anchor = el.querySelector<HTMLElement>(
          `[data-index="${anchorIndex}"]`
        );
        if (!anchor) return;
        const delta = computeScrollCorrection(
          anchor.getBoundingClientRect(),
          el.getBoundingClientRect(),
          el.scrollTop,
          estimatedOffset,
        );
        if (delta !== 0) {
          el.scrollTop += delta;
        }
      });
    });

    return () => {
      cancelAnimationFrame(id1);
      if (id2 !== undefined) cancelAnimationFrame(id2);
    };
  }, [messages]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
      });
    });
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [channelId, hasMessages]);

  // Track scroll position + trigger load-older
  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;

    const threshold = 60;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    nearBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
    if (atBottom && newCount > 0) setNewCount(0);

    // Load older when scrolled near top
    if (el.scrollTop < 200 && hasMore && !loadingOlderRef.current) {
      loadingOlderRef.current = true;
      setLoadingOlder(true);
      loadOlder(channelId)
        .finally(() => {
          loadingOlderRef.current = false;
          setLoadingOlder(false);
        });
    }
  }, [hasMore, channelId, loadOlder, newCount]);

  const scrollToBottom = useCallback(() => {
    if (messages && messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end', behavior: 'smooth' });
    }
    setNewCount(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages?.length, virtualizer]);

  const handleEdit = useCallback((msgId: string, content: string) => {
    editMessage(channelId, msgId, content);
  }, [channelId, editMessage]);

  const handleDelete = useCallback((msgId: string) => {
    deleteMessage(channelId, msgId);
  }, [channelId, deleteMessage]);

  if (!messages) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-text-muted animate-pulse">Loading messages...</div>
      </div>
    );
  }

  if (messages.length === 0) {
    return <EmptyChannel channelName={channelName} isDm={isDm} />;
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="flex-1 relative overflow-hidden flex flex-col">
      <div
        ref={parentRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualItems.map((virtualRow) => {
            const msg = messages[virtualRow.index];
            const prevMsg = virtualRow.index > 0 ? messages[virtualRow.index - 1] : undefined;
            const run = noticeRuns[virtualRow.index];
            const runExpanded = run ? isRunExpanded(run.key, run.aliases) : false;
            return (
              <div
                key={msg.id}
                data-index={virtualRow.index}
                data-agent-hidden={isHiddenInRun(run, runExpanded) || undefined}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {run?.position === 0 && (
                  <AgentMessageRunToggle count={run.size} names={run.names} noticeCount={run.noticeCount} expanded={runExpanded} onToggle={() => toggleRun(run.key, run.aliases)} />
                )}
                {(!run || runExpanded) && (
                  <div data-agent-run={run?.key} data-agent-run-end={run?.position === (run?.size ?? 0) - 1 || undefined}
                    className={run ? `mx-4 border-l-2 border-primary/40 bg-surface/30 ${run.position === run.size - 1 ? 'rounded-b-lg border-b border-border' : ''}` : undefined}>
                  <MessageItem
                    message={msg}
                    isGrouped={shouldGroup(run?.position === 0 ? undefined : prevMsg, msg)}
                    isOwn={msg.authorId === userId}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    channelId={channelId}
                  />
                  {run && run.position === run.size - 1 && <AgentRunCollapse count={run.size} onCollapse={() => toggleRun(run.key, run.aliases)} />}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {loadingOlder && (
        <div className="absolute top-0 left-0 right-0 py-3 text-center text-text-muted text-[13px] bg-bg/80 backdrop-blur-sm z-10">
          Loading older messages...
        </div>
      )}
      <NewMessagesPill count={newCount} onClick={scrollToBottom} />
    </div>
  );
}
