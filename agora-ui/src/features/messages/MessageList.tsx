import { useEffect, useRef, useCallback, useState } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { MessageItem } from './MessageItem';
import { NewMessagesPill } from './NewMessagesPill';
import { EmptyChannel } from './EmptyChannel';

interface MessageListProps {
  channelId: string;
  channelName: string;
}

const GROUP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function shouldGroup(
  prev: { authorId: string; createdAt: string; deletedAt?: string } | undefined,
  curr: { authorId: string; createdAt: string; deletedAt?: string },
): boolean {
  if (!prev) return false;
  if (prev.deletedAt || curr.deletedAt) return false;
  if (prev.authorId !== curr.authorId) return false;
  const diff = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return diff < GROUP_THRESHOLD_MS;
}

export function MessageList({ channelId, channelName }: MessageListProps) {
  const messages = useMessageStore(s => s.byChannel.get(channelId));
  const hasMore = useMessageStore(s => s.hasMore.get(channelId) ?? false);
  const loadMessages = useMessageStore(s => s.loadMessages);
  const loadOlder = useMessageStore(s => s.loadOlder);
  const editMessage = useMessageStore(s => s.editMessage);
  const deleteMessage = useMessageStore(s => s.deleteMessage);
  const userId = useAuthStore(s => s.user?.id);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const lastMessageIdRef = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);
  const initialLoadRef = useRef(true);

  // Load messages on mount / channel change
  useEffect(() => {
    loadMessages(channelId);
    setNewCount(0);
    setIsAtBottom(true);
    lastMessageIdRef.current = null;
    initialLoadRef.current = true;
  }, [channelId, loadMessages]);

  // Scroll to bottom on initial load, track new messages at the bottom
  useEffect(() => {
    if (!messages || messages.length === 0) return;

    const lastMsg = messages[messages.length - 1];

    // Initial load: scroll to bottom
    if (initialLoadRef.current) {
      bottomRef.current?.scrollIntoView();
      lastMessageIdRef.current = lastMsg.id;
      initialLoadRef.current = false;
      return;
    }

    // If the last message ID changed, a new message was appended (not prepended)
    if (lastMsg.id !== lastMessageIdRef.current) {
      const isFromSelf = lastMsg.authorId === userId;
      if (isAtBottom || isFromSelf) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      } else {
        setNewCount(c => c + 1);
      }
      lastMessageIdRef.current = lastMsg.id;
    }
  }, [messages, isAtBottom, userId]);

  // Track scroll position
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 50;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    setIsAtBottom(atBottom);
    if (atBottom && newCount > 0) setNewCount(0);

    // Load older when scrolled near top
    if (el.scrollTop < 200 && hasMore && !loadingOlderRef.current) {
      loadingOlderRef.current = true;
      const prevScrollHeight = el.scrollHeight;
      loadOlder(channelId).then(() => {
        // Preserve scroll position after prepending older messages
        requestAnimationFrame(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight - prevScrollHeight;
          }
          loadingOlderRef.current = false;
        });
      }).catch(() => { loadingOlderRef.current = false; });
    }
  }, [hasMore, channelId, loadOlder, newCount]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setNewCount(0);
  }, []);

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

  return (
    <div className="flex-1 relative overflow-hidden flex flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {hasMore && (
          <div className="py-4 text-center text-text-dim text-sm">Loading older messages...</div>
        )}
        {messages.map((msg, i) => (
          <MessageItem
            key={msg.id}
            message={msg}
            isGrouped={shouldGroup(messages[i - 1], msg)}
            isOwn={msg.authorId === userId}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      <NewMessagesPill count={newCount} onClick={scrollToBottom} />
    </div>
  );
}
