import { useEffect, useRef, useCallback, useState, useLayoutEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { MessageItem } from './MessageItem';
import { NewMessagesPill } from './NewMessagesPill';
import { EmptyChannel } from './EmptyChannel';
import { shouldGroup, estimateMessageHeight, computePrependShift } from './grouping';

interface MessageListProps {
  channelId: string;
  channelName: string;
}

export function MessageList({ channelId, channelName }: MessageListProps) {
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

  const count = messages?.length ?? 0;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      if (!messages?.[index]) return 48;
      const prev = index > 0 ? messages[index - 1] : undefined;
      return estimateMessageHeight(prev, messages[index]);
    },
    overscan: 15,
    getItemKey: (index) => messages?.[index]?.id ?? String(index),
  });

  // Load messages on channel change
  useEffect(() => {
    loadMessages(channelId);
    setNewCount(0);
    setIsAtBottom(true);
    lastMessageIdRef.current = null;
    prevCountRef.current = 0;
    initialLoadRef.current = true;
  }, [channelId, loadMessages]);

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
        // The virtualizer has re-indexed: every existing item shifted down by
        // the cumulative estimated height of the new items.  Shift scrollTop
        // by the same amount so the viewport stays on the same content.
        const prependedCount = currentCount - prevCount;
        const el = parentRef.current;
        if (el) {
          el.scrollTop += computePrependShift(messages, prependedCount);
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

  // Track scroll position + trigger load-older
  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;

    const threshold = 50;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
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
    return <EmptyChannel channelName={channelName} />;
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
            return (
              <div
                key={msg.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <MessageItem
                  message={msg}
                  isGrouped={shouldGroup(prevMsg, msg)}
                  isOwn={msg.authorId === userId}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                />
              </div>
            );
          })}
        </div>
      </div>
      {loadingOlder && (
        <div className="absolute top-0 left-0 right-0 py-3 text-center text-text-dim text-sm bg-bg/80 backdrop-blur-sm z-10">
          Loading older messages...
        </div>
      )}
      <NewMessagesPill count={newCount} onClick={scrollToBottom} />
    </div>
  );
}
